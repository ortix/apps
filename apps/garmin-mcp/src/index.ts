import type { AppEnv } from "./env";
import { log, requestId } from "./log";
import { mcpApiHandler } from "./mcp";

/**
 * Cloudflare Access signs the user in before any request reaches this Worker:
 * claude.ai through Access Managed OAuth, a browser through the GitHub login,
 * and CI's smoke test through a service token limited to /healthz. Only the
 * owner's GitHub account passes the Access policy.
 *
 * Checking ctx.access here is the second lock: the Worker answers nothing that
 * Access didn't authenticate, even if it were ever reachable another way.
 */
export default {
	fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Response | Promise<Response> {
		if (!ctx.access) {
			log({ rid: requestId(), event: "auth", outcome: "denied", status: 403 });
			return new Response("Forbidden\n", { status: 403 });
		}
		const { pathname } = new URL(request.url);
		if (pathname === "/mcp") return mcpApiHandler.fetch(request, env, ctx);
		if (pathname === "/healthz") return new Response("ok\n");
		return new Response("Not found\n", { status: 404 });
	},
} satisfies ExportedHandler<AppEnv>;
