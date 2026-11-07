import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { accessContext, GITHUB_USER } from "./helpers";

const get = (path: string, identity: Record<string, unknown> | null | undefined) =>
	app.fetch(new Request(`https://app.test${path}`), env as unknown as Env, accessContext(identity));

describe("Access", () => {
	it("refuses requests that Access did not authenticate", async () => {
		expect((await get("/", null)).status).toBe(403);
		expect((await get("/healthz", null)).status).toBe(403);
	});

	it("greets the signed-in user", async () => {
		const response = await get("/", GITHUB_USER);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Signed in as Me");
	});

	it("lets a service token through without an identity", async () => {
		const response = await get("/", undefined);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("a service token");
	});
});

describe("health check", () => {
	it("answers ok", async () => {
		const response = await get("/healthz", undefined);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok\n");
	});
});
