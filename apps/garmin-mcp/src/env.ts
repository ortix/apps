export interface AppEnv {
	/** Garmin Personal API key (secret). */
	GARMIN_API_KEY: string;
	/** The exact URL clients connect to, including /mcp. */
	MCP_SERVER_URL: string;
	/** Garmin access token and immutable activity data. */
	GARMIN_CACHE: KVNamespace;
}
