/**
 * Garmin access-token lifecycle.
 *
 * The token endpoint returns a raw JWT as text/plain; expiry is the JWT `exp`
 * claim. There are no refresh tokens: renewing means exchanging the API key
 * again. The KV key is derived from a hash of the API key, so a rotated key
 * misses the cache automatically and the key itself is never stored.
 */

export const GARMIN_BASE_URL = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";

/** Refresh when less than this much lifetime remains. */
export const REFRESH_WINDOW_SECONDS = 60 * 60;
/** Workers KV rejects expiration TTLs below 60 seconds. */
const KV_MIN_TTL_SECONDS = 60;

/** The subset of KVNamespace used here, so a local script can supply a Map. */
export interface TokenStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export class GarminAuthError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "GarminAuthError";
	}
}

interface CachedToken {
	token: string;
	expiresAt: number;
}

export interface TokenProviderOptions {
	apiKey: string;
	store: TokenStore;
	fetch?: typeof fetch;
	now?: () => number;
}

export class GarminTokenProvider {
	readonly #apiKey: string;
	readonly #store: TokenStore;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;

	constructor(options: TokenProviderOptions) {
		this.#apiKey = options.apiKey;
		this.#store = options.store;
		this.#fetch = options.fetch ?? ((...args) => fetch(...args));
		this.#now = options.now ?? (() => Date.now() / 1000);
	}

	/** Return a usable bearer token. `forceRefresh` skips the cache (after a 401). */
	async getToken({ forceRefresh = false }: { forceRefresh?: boolean } = {}): Promise<string> {
		const cacheKey = await this.#cacheKey();
		if (!forceRefresh) {
			const cached = parseCached(await this.#store.get(cacheKey));
			if (cached && cached.expiresAt - this.#now() > REFRESH_WINDOW_SECONDS) {
				return cached.token;
			}
		}

		const token = await this.#exchange();
		const expiresAt = jwtExpiry(token);
		const ttl = Math.floor(expiresAt - this.#now());
		if (ttl >= KV_MIN_TTL_SECONDS) {
			const value: CachedToken = { token, expiresAt };
			await this.#store.put(cacheKey, JSON.stringify(value), { expirationTtl: ttl });
		}
		return token;
	}

	async #exchange(): Promise<string> {
		const response = await this.#fetch(`${GARMIN_BASE_URL}${TOKEN_PATH}`, {
			method: "POST",
			headers: { Accept: "*/*", Authorization: `ApiKey ${this.#apiKey}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (response.status === 401 || response.status === 403) {
			throw new GarminAuthError(
				"Garmin rejected the Personal API key. It has probably expired or been deleted; rotate GARMIN_API_KEY.",
				response.status,
			);
		}
		if (!response.ok) {
			throw new GarminAuthError(`Garmin token exchange failed (HTTP ${response.status}).`, response.status);
		}
		return (await response.text()).trim();
	}

	async #cacheKey(): Promise<string> {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.#apiKey));
		const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
		return `garmin:token:${hex}`;
	}
}

function parseCached(raw: string | null): CachedToken | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<CachedToken>;
		if (typeof value.token === "string" && typeof value.expiresAt === "number") {
			return { token: value.token, expiresAt: value.expiresAt };
		}
	} catch {
		// A corrupt entry is treated as a miss and overwritten.
	}
	return null;
}

/** Read the `exp` claim without verifying the signature (Garmin verifies it). */
export function jwtExpiry(token: string): number {
	const payload = token.split(".")[1];
	if (!payload) throw new GarminAuthError("Garmin token endpoint did not return a JWT.");
	try {
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as { exp?: unknown };
		if (typeof claims.exp === "number") return claims.exp;
	} catch {
		// Fall through to the shared error; never include the token in it.
	}
	throw new GarminAuthError("Garmin token has no readable exp claim.");
}
