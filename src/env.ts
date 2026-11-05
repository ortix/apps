import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface AppEnv {
	/** Garmin Personal API key (secret). */
	GARMIN_API_KEY: string;
	GITHUB_CLIENT_ID: string;
	/** Secret. */
	GITHUB_CLIENT_SECRET: string;
	/** Numeric GitHub user id; the only account allowed through login. */
	ALLOWED_GITHUB_USER_ID: string;
	/** The exact URL clients connect to, including /mcp. */
	MCP_SERVER_URL: string;
	/** Owned by the OAuth library. */
	OAUTH_KV: KVNamespace;
	/** Garmin access token and immutable activity data. */
	GARMIN_CACHE: KVNamespace;
	/** Injected by OAuthProvider. */
	OAUTH_PROVIDER: OAuthHelpers;
}

export interface AuthProps extends Record<string, unknown> {
	githubUserId: string;
}
