export class MemoryStore {
	readonly data = new Map<string, string>();
	readonly puts: { key: string; ttl: number | undefined }[] = [];
	gets = 0;
	async get(key: string): Promise<string | null> {
		this.gets++;
		return this.data.get(key) ?? null;
	}
	async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
		this.data.set(key, value);
		this.puts.push({ key, ttl: options?.expirationTtl });
	}
}

/** An unsigned JWT-shaped token with the given exp claim. */
export function fakeJwt(exp: number, marker = "x"): string {
	const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
	return `${encode({ alg: "none" })}.${encode({ exp, marker })}.sig`;
}

export type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch mock that records calls; nothing here reaches the network. */
export function mockFetch(route: Route) {
	const calls: { url: URL; headers: Headers }[] = [];
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push({ url, headers: new Headers(init?.headers) });
		return route(url, init);
	}) as typeof fetch;
	return { fn, calls };
}
