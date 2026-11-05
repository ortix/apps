import { describe, expect, it } from "vitest";
import { GarminClient, GarminApiError } from "../src/garmin/client";
import { GarminAuthError, GarminTokenProvider, jwtExpiry, REFRESH_WINDOW_SECONDS } from "../src/garmin/token";
import { fakeJwt, MemoryStore, mockFetch } from "./helpers";

const NOW = 1_800_000_000;
const DAY = 86_400;

function setup(route: Parameters<typeof mockFetch>[0], apiKey = "key-1") {
	const store = new MemoryStore();
	const mock = mockFetch(route);
	const provider = new GarminTokenProvider({ apiKey, store, fetch: mock.fn, now: () => NOW });
	return { store, mock, provider };
}

describe("GarminTokenProvider", () => {
	it("exchanges the key with the documented header and caches until exp", async () => {
		const token = fakeJwt(NOW + DAY);
		const { provider, mock, store } = setup(() => new Response(`${token}\n`));
		expect(await provider.getToken()).toBe(token);
		expect(mock.calls[0]?.headers.get("Authorization")).toBe("ApiKey key-1");
		expect(store.puts[0]?.ttl).toBe(DAY);
		expect(await provider.getToken()).toBe(token);
		expect(mock.calls).toHaveLength(1);
	});

	it("never stores the API key, even in the cache key", async () => {
		const { provider, store } = setup(() => new Response(fakeJwt(NOW + DAY)), "very-secret-key");
		await provider.getToken();
		const [key, value] = [...store.data.entries()][0] as [string, string];
		expect(key).toMatch(/^garmin:token:[0-9a-f]{64}$/);
		expect(value).not.toContain("very-secret-key");
	});

	it("refreshes when under the refresh window, not before", async () => {
		let exp = NOW + REFRESH_WINDOW_SECONDS + 60;
		const { provider, mock } = setup(() => new Response(fakeJwt(exp)));
		await provider.getToken();
		await provider.getToken();
		expect(mock.calls).toHaveLength(1);

		const nearExpiry = setup(() => new Response(fakeJwt(NOW + DAY)));
		await nearExpiry.store.put(await keyFor("key-1"), JSON.stringify({ token: "old", expiresAt: NOW + REFRESH_WINDOW_SECONDS - 60 }));
		expect(await nearExpiry.provider.getToken()).not.toBe("old");
		expect(nearExpiry.mock.calls).toHaveLength(1);
		exp = 0;
	});

	it("uses a different cache entry after key rotation", async () => {
		const first = setup(() => new Response(fakeJwt(NOW + DAY, "old-key")), "key-1");
		await first.provider.getToken();
		const mock = mockFetch(() => new Response(fakeJwt(NOW + DAY, "new-key")));
		const rotated = new GarminTokenProvider({ apiKey: "key-2", store: first.store, fetch: mock.fn, now: () => NOW });
		await rotated.getToken();
		expect(mock.calls).toHaveLength(1);
	});

	it("treats a corrupt cache entry as a miss", async () => {
		const { provider, store, mock } = setup(() => new Response(fakeJwt(NOW + DAY)));
		await store.put(await keyFor("key-1"), "not json");
		await provider.getToken();
		expect(mock.calls).toHaveLength(1);
	});

	it("explains a rejected key without echoing it", async () => {
		const { provider } = setup(() => new Response("nope", { status: 401 }), "very-secret-key");
		const error = await provider.getToken().catch((e: unknown) => e as Error);
		expect(error).toBeInstanceOf(GarminAuthError);
		expect((error as Error).message).toMatch(/rotate/i);
		expect((error as Error).message).not.toContain("very-secret-key");
	});

	it("rejects tokens that are not JWTs without echoing them", () => {
		expect(() => jwtExpiry("opaque-token")).toThrow(GarminAuthError);
		try {
			jwtExpiry("opaque-token");
		} catch (error) {
			expect((error as Error).message).not.toContain("opaque-token");
		}
	});
});

describe("GarminClient", () => {
	function clientWith(apiRoute: (token: string, attempt: number) => Response) {
		let exchanges = 0;
		let attempts = 0;
		const mock = mockFetch((url, init) => {
			if (url.pathname.includes("personal-api-key/token")) {
				exchanges++;
				return new Response(fakeJwt(NOW + DAY, `token-${exchanges}`));
			}
			attempts++;
			const auth = new Headers(init?.headers).get("Authorization") ?? "";
			return apiRoute(auth.replace("Bearer ", ""), attempts);
		});
		const tokens = new GarminTokenProvider({ apiKey: "k", store: new MemoryStore(), fetch: mock.fn, now: () => NOW });
		return { client: new GarminClient({ tokens, fetch: mock.fn }), mock, stats: () => ({ exchanges, attempts }) };
	}

	it("retries once with a fresh token on 401", async () => {
		const seen: string[] = [];
		const { client, stats } = clientWith((token, attempt) => {
			seen.push(token);
			return attempt === 1 ? new Response(null, { status: 401 }) : Response.json({ ok: true });
		});
		expect(await client.getJson("/x")).toEqual({ ok: true });
		expect(stats()).toEqual({ exchanges: 2, attempts: 2 });
		expect(seen[0]).not.toBe(seen[1]);
	});

	it("gives up after the single retry", async () => {
		const { client, stats } = clientWith(() => new Response(null, { status: 401 }));
		await expect(client.getJson("/x")).rejects.toMatchObject({ status: 401 });
		expect(stats().attempts).toBe(2);
	});

	it("maps 204 to null and sends query parameters", async () => {
		const { client, mock } = clientWith(() => new Response(null, { status: 204 }));
		expect(await client.getJson("/x", { a: 1, b: undefined })).toBeNull();
		const call = mock.calls.at(-1);
		expect(call?.url.searchParams.get("a")).toBe("1");
		expect(call?.url.searchParams.has("b")).toBe(false);
	});

	it("keeps response bodies out of error messages", async () => {
		const { client } = clientWith(() => new Response("sensitive health payload", { status: 500 }));
		const error = await client.getJson("/x").catch((e: unknown) => e as GarminApiError);
		expect(error).toBeInstanceOf(GarminApiError);
		expect((error as Error).message).not.toContain("sensitive");
	});
});

async function keyFor(apiKey: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
	return `garmin:token:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
