import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { authHandler, SCOPE_READ, SCOPES } from "./auth";
import type { AppEnv } from "./env";
import { mcpApiHandler } from "./mcp";

const { MCP_SERVER_URL } = env as unknown as AppEnv;

export default new OAuthProvider<AppEnv>({
	apiRoute: "/mcp",
	apiHandler: mcpApiHandler,
	defaultHandler: authHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/oauth/token",
	clientRegistrationEndpoint: "/oauth/register",
	scopesSupported: SCOPES,
	requiredScopes: [SCOPE_READ],
	resourceMetadata: {
		// Must equal the URL pasted into claude.ai, because tokens are bound to it.
		resource: MCP_SERVER_URL,
		authorization_servers: [new URL(MCP_SERVER_URL).origin],
	},
	clientIdMetadataDocumentEnabled: true,
});
