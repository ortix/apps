/**
 * Browser side of the OAuth flow: consent page, GitHub sign-in, allowlist.
 * Tokens are issued only after GitHub confirms the allowlisted numeric user id.
 * The GitHub token is used once to read the user id, then dropped.
 */
import {
	AuthorizationError,
	authorizationErrorRedirect,
	type ConsentDescription,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { AppEnv, AuthProps } from "./env";
import { log, requestId } from "./log";

export const SCOPE_READ = "garmin:read";
export const SCOPES = [SCOPE_READ, "offline_access"];

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const PAGE_STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
button{font:inherit;padding:.5rem 1.25rem;border-radius:.4rem;border:1px solid #888;background:#fff;cursor:pointer;margin-right:.5rem}
button[value=approve]{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
@media(prefers-color-scheme:dark){body{background:#161616;color:#eee}button{background:#222;color:#eee}button[value=approve]{background:#eee;color:#161616}}`;

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
	headers.set("Content-Type", "text/html; charset=utf-8");
	const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style><h1>${escapeHtml(title)}</h1>${body}</html>`;
	return new Response(html, { status, headers });
}

function consentPage(details: ConsentDescription, handle: string, headers: Headers): Response {
	const client = escapeHtml(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: "This app registered itself, so its name is not verified.";
	const loopback = details.redirectIsLoopback
		? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
		: "";
	return page(
		`Allow ${details.clientName}?`,
		`<p><strong>${client}</strong> is asking for read-only access to your Garmin data. ${origin}</p>
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>${loopback}
<p>Next you'll sign in with GitHub to confirm it's you.</p>
<form method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button name="decision" value="approve">Continue</button><button name="decision" value="deny">Deny</button></form>`,
		200,
		headers,
	);
}

/** Fails closed: a missing or malformed allowlist matches nobody. */
export function isAllowedUser(githubUserId: unknown, allowed: string | undefined): boolean {
	return typeof allowed === "string" && /^\d+$/.test(allowed) && String(githubUserId) === allowed;
}

async function sha256Base64Url(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const callbackUrl = (request: Request) => new URL("/callback", request.url).toString();

async function handleAuthorizeGet(request: Request, oauth: OAuthHelpers): Promise<Response> {
	try {
		const authRequest = await oauth.parseAuthRequest(request);
		const details = await oauth.describeConsent(authRequest);
		const consent = await oauth.beginConsent(authRequest);
		return consentPage(details, consent.handle, consent.headers);
	} catch (error) {
		return authorizationFailure(error);
	}
}

async function handleAuthorizePost(request: Request, env: AppEnv, oauth: OAuthHelpers): Promise<Response> {
	try {
		const form = await request.formData();
		const handle = String(form.get("handle"));
		if (form.get("decision") !== "approve") {
			const denied = await oauth.denyConsent(request, handle);
			return new Response(null, { status: 302, headers: denied.headers });
		}

		const approved = await oauth.approveConsent(request, handle, { scope: SCOPES });
		const verifier = crypto.randomUUID() + crypto.randomUUID();
		const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });

		const github = new URL("https://github.com/login/oauth/authorize");
		github.search = new URLSearchParams({
			client_id: env.GITHUB_CLIENT_ID,
			redirect_uri: callbackUrl(request),
			state,
			code_challenge: await sha256Base64Url(verifier),
			code_challenge_method: "S256",
			allow_signup: "false",
		}).toString();
		headers.set("Location", github.toString());
		return new Response(null, { status: 302, headers });
	} catch (error) {
		return authorizationFailure(error);
	}
}

async function handleCallback(request: Request, env: AppEnv, oauth: OAuthHelpers): Promise<Response> {
	const rid = requestId();
	let resumed: Awaited<ReturnType<OAuthHelpers["finishUpstream"]>>;
	try {
		resumed = await oauth.finishUpstream(request);
	} catch (error) {
		return authorizationFailure(error);
	}
	const { request: original, data, headers } = resumed;
	const params = new URL(request.url).searchParams;

	const code = params.get("code");
	if (params.get("error") || !code) {
		headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
		return new Response(null, { status: 302, headers });
	}

	let userId: number;
	try {
		userId = await fetchGithubUserId(code, (data as { verifier: string }).verifier, callbackUrl(request), env);
	} catch {
		log({ rid, event: "auth", outcome: "error" });
		return page("GitHub sign-in failed", "<p>Couldn't confirm your GitHub identity. Please try connecting again.</p>", 502, headers);
	}

	if (!isAllowedUser(userId, env.ALLOWED_GITHUB_USER_ID)) {
		log({ rid, event: "auth", outcome: "denied", status: 403 });
		return page("Access denied", "<p>This GitHub account isn't allowed to use this server.</p>", 403, headers);
	}

	const props: AuthProps = { githubUserId: String(userId) };
	const { redirectTo } = await oauth.completeAuthorization({
		request: original,
		userId: String(userId),
		metadata: {},
		scope: original.scope,
		props,
	});
	log({ rid, event: "auth", outcome: "ok" });
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
}

async function fetchGithubUserId(code: string, verifier: string, redirectUri: string, env: AppEnv): Promise<number> {
	const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		}),
	});
	const token = (await tokenResponse.json()) as { access_token?: string };
	if (!tokenResponse.ok || !token.access_token) throw new Error("GitHub token exchange failed");

	const userResponse = await fetch("https://api.github.com/user", {
		headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token.access_token}`, "User-Agent": "garmin-mcp" },
	});
	const user = (await userResponse.json()) as { id?: number };
	if (!userResponse.ok || typeof user.id !== "number") throw new Error("GitHub user lookup failed");
	return user.id;
}

function authorizationFailure(error: unknown): Response {
	if (error instanceof AuthorizationError) {
		if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
		return page("Sign-in request refused", `<p>${escapeHtml(error.description)}</p>`, 400);
	}
	throw error;
}

export const authHandler = {
	async fetch(request: Request, env: AppEnv): Promise<Response> {
		const { pathname } = new URL(request.url);
		const oauth = env.OAUTH_PROVIDER;
		if (pathname === "/authorize" && request.method === "GET") return handleAuthorizeGet(request, oauth);
		if (pathname === "/authorize" && request.method === "POST") return handleAuthorizePost(request, env, oauth);
		if (pathname === "/callback" && request.method === "GET") return handleCallback(request, env, oauth);
		if (pathname === "/" && request.method === "GET") {
			return new Response("Private Garmin MCP server. Connect an MCP client to /mcp.\n", { headers: { "Content-Type": "text/plain" } });
		}
		return new Response("Not found\n", { status: 404 });
	},
};
