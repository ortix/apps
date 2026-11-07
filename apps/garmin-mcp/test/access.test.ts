import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import worker from "../src/index";

/** An ExecutionContext as Cloudflare Access populates it, or without Access. */
function context(withAccess: boolean): ExecutionContext {
	return {
		waitUntil: () => {},
		passThroughOnException: () => {},
		props: {},
		...(withAccess ? { access: { aud: "test-aud", getIdentity: async () => ({ email: "me@example.com" }) } } : {}),
	} as unknown as ExecutionContext;
}

const call = (path: string, init: RequestInit = {}, withAccess = true) =>
	worker.fetch(new Request(`https://garmin.test${path}`, init), env as unknown as AppEnv, context(withAccess));

const rpc = (body: unknown, withAccess = true) =>
	call(
		"/mcp",
		{
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
			body: JSON.stringify(body),
		},
		withAccess,
	);

async function result(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	const json = text.trimStart().startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? "{}");
	return JSON.parse(json) as Record<string, unknown>;
}

describe("only requests Access authenticated get in", () => {
	it("refuses /mcp, /healthz and everything else without Access", async () => {
		for (const path of ["/mcp", "/healthz", "/", "/authorize"]) {
			expect((await call(path, {}, false)).status).toBe(403);
		}
		expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, false)).status).toBe(403);
	});

	it("no longer serves its own OAuth endpoints", async () => {
		for (const path of ["/authorize", "/callback", "/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server"]) {
			expect((await call(path)).status).toBe(404);
		}
	});

	it("answers the health check", async () => {
		const response = await call("/healthz");
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok\n");
	});
});

describe("MCP through Access", () => {
	it("lists the same five read-only tools", async () => {
		const body = await result(await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
		const tools = (body.result as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }).tools;
		expect(tools.map((t) => t.name).sort()).toEqual(["get_activity", "get_activity_streams", "get_daily_health", "get_heart_rate_zones", "list_activities"]);
		expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
	});
});
