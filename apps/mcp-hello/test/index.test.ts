import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

function context(withAccess: boolean): ExecutionContext {
	return {
		waitUntil: () => {},
		passThroughOnException: () => {},
		props: {},
		...(withAccess ? { access: { aud: "test-aud", getIdentity: async () => ({ email: "me@example.com" }) } } : {}),
	} as unknown as ExecutionContext;
}

const rpc = (body: unknown, withAccess = true) =>
	worker.fetch(
		new Request("https://mcp.test/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
			body: JSON.stringify(body),
		}),
		env as unknown as Env,
		context(withAccess),
	);

/** Reads a JSON-RPC result from either a JSON or an SSE response. */
async function result(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	const json = text.trimStart().startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? "{}");
	return JSON.parse(json) as Record<string, unknown>;
}

describe("Access", () => {
	it("refuses requests that Access did not authenticate", async () => {
		expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, false)).status).toBe(403);
	});
});

describe("MCP", () => {
	it("initializes", async () => {
		const response = await rpc({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
		});
		expect(response.status).toBe(200);
		const body = await result(response);
		expect((body.result as { serverInfo: { name: string } }).serverInfo.name).toBe("mcp-hello");
	});

	it("runs the echo tool", async () => {
		const body = await result(await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }));
		const content = (body.result as { content: { text: string }[] }).content;
		expect(JSON.parse(content[0]?.text ?? "{}")).toEqual({ text: "hi" });
	});
});
