import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					GARMIN_API_KEY: "test-api-key",
					GITHUB_CLIENT_ID: "test-client-id",
					GITHUB_CLIENT_SECRET: "test-client-secret",
				},
			},
		}),
	],
});
