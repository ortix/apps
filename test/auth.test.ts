import { exports as workerExports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedUser } from "../src/auth";
import { mcpApiHandler } from "../src/mcp";

const ORIGIN = "https://mcp.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const ALLOWED_ID = 1493849;
const worker = (workerExports as unknown as { default: { fetch: typeof fetch } }).default;
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }));

afterEach(() => vi.unstubAllGlobals());

describe("no authless access", () => {
	it("answers /mcp without a token with a 401 pointing at the metadata", async () => {
		for (const method of ["GET", "POST"]) {
			const response = await call("/mcp", { method, ...(method === "POST" ? { body: "{}", headers: { "Content-Type": "application/json" } } : {}) });
			expect(response.status).toBe(401);
			expect(response.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
		}
	});

	it("rejects a made-up token", async () => {
		const response = await call("/mcp", { method: "POST", body: "{}", headers: { Authorization: "Bearer made:up:token", "Content-Type": "application/json" } });
		expect(response.status).toBe(401);
	});
});

describe("discovery for claude.ai", () => {
	it("publishes resource metadata matching the connector URL exactly", async () => {
		const meta = (await (await call("/.well-known/oauth-protected-resource/mcp")).json()) as { resource: string; authorization_servers: string[] };
		expect(meta.resource).toBe(`${ORIGIN}/mcp`);
		expect(meta.authorization_servers[0]).toBe(ORIGIN);
	});

	it("advertises S256, registration and refresh", async () => {
		const meta = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
		expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
		expect(meta.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
		expect(meta.grant_types_supported).toContain("refresh_token");
		expect(meta.scopes_supported).toContain("garmin:read");
	});
});

describe("isAllowedUser", () => {
	it("matches only the configured numeric id", () => {
		expect(isAllowedUser(ALLOWED_ID, String(ALLOWED_ID))).toBe(true);
		expect(isAllowedUser(String(ALLOWED_ID), String(ALLOWED_ID))).toBe(true);
		expect(isAllowedUser(42, String(ALLOWED_ID))).toBe(false);
	});
	it("fails closed when the allowlist is missing or malformed", () => {
		for (const allowed of [undefined, "", "ortix", "*", "undefined"]) {
			expect(isAllowedUser(ALLOWED_ID, allowed)).toBe(false);
			expect(isAllowedUser(undefined, allowed)).toBe(false);
		}
	});
});

describe("API handler defence in depth", () => {
	const env = { ALLOWED_GITHUB_USER_ID: String(ALLOWED_ID) } as never;

	it("refuses a valid token whose user is no longer allowed", async () => {
		const ctx = { props: { githubUserId: "42" }, auth: { scope: ["garmin:read"] } } as never;
		const response = await mcpApiHandler.fetch(new Request(`${ORIGIN}/mcp`), env, ctx);
		expect(response.status).toBe(403);
	});

	it("refuses a token without the read scope", async () => {
		const ctx = { props: { githubUserId: String(ALLOWED_ID) }, auth: { scope: [], token: "t", audience: `${ORIGIN}/mcp` } } as never;
		const response = await mcpApiHandler.fetch(new Request(`${ORIGIN}/mcp`), env, ctx);
		expect(response.status).toBe(403);
		expect(response.headers.get("WWW-Authenticate")).toContain("insufficient_scope");
	});
});

/** Walks the browser flow against the real provider with GitHub mocked. */
async function loginAs(githubId: number) {
	const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("client-verifier"));
	const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(challenge))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

	const registered = await call("/oauth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
	});
	expect(registered.status).toBe(201);
	const { client_id: clientId } = (await registered.json()) as { client_id: string };

	const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "garmin:read offline_access", state: "client-state", code_challenge: codeChallenge, code_challenge_method: "S256", resource: `${ORIGIN}/mcp` });
	const consent = await call(`/authorize?${query}`);
	expect(consent.status).toBe(200);
	const html = await consent.text();
	expect(html).toContain("claude.ai");
	const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] as string;
	const cookies = new Map<string, string>();
	const keep = (response: Response) => {
		for (const raw of response.headers.getSetCookie()) {
			const pair = raw.split(";")[0] as string;
			const at = pair.indexOf("=");
			cookies.set(pair.slice(0, at), pair.slice(at + 1));
		}
	};
	const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
	keep(consent);

	const approved = await call("/authorize", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader(), Origin: ORIGIN },
		body: new URLSearchParams({ handle, decision: "approve" }),
	});
	expect(approved.status).toBe(302);
	keep(approved);
	const github = new URL(approved.headers.get("Location") as string);
	expect(github.origin).toBe("https://github.com");
	expect(github.searchParams.get("code_challenge_method")).toBe("S256");
	expect(github.searchParams.has("scope")).toBe(false);

	const realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.href === "https://github.com/login/oauth/access_token") {
			const body = JSON.parse(String(init?.body)) as { code_verifier?: string };
			expect(body.code_verifier).toBeTruthy();
			return Response.json({ access_token: "gh-token" });
		}
		if (url.href === "https://api.github.com/user") return Response.json({ id: githubId, login: "someone" });
		return realFetch(input, init);
	});

	const callback = await call(`/callback?code=gh-code&state=${encodeURIComponent(github.searchParams.get("state") as string)}`, { headers: { Cookie: cookieHeader() } });
	return { callback, clientId };
}

describe("GitHub login flow", () => {
	it("rejects any other GitHub account after login and issues no code", async () => {
		const { callback } = await loginAs(42);
		expect(callback.status).toBe(403);
		expect(callback.headers.get("Location")).toBeNull();
		expect(await callback.text()).toContain("isn't allowed");
	});

	it("issues a working grant to the allowlisted account, without storing the GitHub token", async () => {
		const { callback, clientId } = await loginAs(ALLOWED_ID);
		expect(callback.status).toBe(302);
		const redirect = new URL(callback.headers.get("Location") as string);
		expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
		expect(redirect.searchParams.get("state")).toBe("client-state");

		const tokenResponse = await call("/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "authorization_code", code: redirect.searchParams.get("code") as string, client_id: clientId, redirect_uri: REDIRECT, code_verifier: "client-verifier", resource: `${ORIGIN}/mcp` }),
		});
		expect(tokenResponse.status).toBe(200);
		const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token?: string; scope: string };
		expect(tokens.refresh_token).toBeTruthy();
		expect(tokens.scope).toContain("garmin:read");

		const list = await call("/mcp", {
			method: "POST",
			headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		expect(list.status).toBe(200);
		const text = await list.text();
		for (const name of ["list_activities", "get_activity", "get_activity_streams", "get_daily_health"]) expect(text).toContain(name);
		expect(text).toContain('"readOnlyHint":true');
	});
});
