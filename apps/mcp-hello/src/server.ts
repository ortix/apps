import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Only messages written by this codebase reach the model; anything else is generic. */
export class ToolInputError extends Error {}

export async function run(work: () => Promise<unknown> | unknown) {
	try {
		const result = await work();
		return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
	} catch (error) {
		const message = error instanceof ToolInputError ? error.message : "Unexpected error. Try again shortly.";
		console.log(JSON.stringify({ event: "tool_error", error: error instanceof Error ? error.name : "unknown" }));
		return { isError: true, content: [{ type: "text" as const, text: message }] };
	}
}

/** Replace the example tool with the server's real tools. */
export function createServer(): McpServer {
	const server = new McpServer(
		{ name: "mcp-hello", title: "MCP Hello", version: "0.1.0" },
		{ instructions: "Test server for the tsutsu.dev platform. Use the echo tool to check the connector works." },
	);

	server.registerTool(
		"echo",
		{
			title: "Echo",
			description: "Returns the text it was given. Use it to check that the connector works.",
			inputSchema: { text: z.string().min(1).max(1000).describe("Text to echo back.") },
			annotations: READ_ONLY,
		},
		({ text }) => run(() => ({ text })),
	);

	return server;
}
