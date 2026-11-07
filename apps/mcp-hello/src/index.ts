import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./server";

const mcpHandler = createMcpHandler(() => createServer());

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
		// Access authenticates every request before it reaches the Worker: a
		// browser cookie, claude.ai's Managed OAuth token, or CI's service token.
		// This is the second lock, in case the Worker is ever reachable another way.
		if (!ctx.access) return new Response("Forbidden\n", { status: 403 });

		const { pathname } = new URL(request.url);
		if (pathname === "/healthz") return new Response("ok\n");
		if (pathname === "/mcp") return mcpHandler(request, env, ctx);
		return new Response("Not found\n", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
