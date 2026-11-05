/**
 * Thin read-only client for the Garmin Personal API.
 * Paths come from Garmin's published OpenAPI document (see README).
 */
import { GARMIN_BASE_URL, type GarminTokenProvider } from "./token";

export class GarminApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "GarminApiError";
	}
}

type Query = Record<string, string | number | boolean | undefined>;

export interface GarminClientOptions {
	tokens: GarminTokenProvider;
	fetch?: typeof fetch;
}

export class GarminClient {
	readonly #tokens: GarminTokenProvider;
	readonly #fetch: typeof fetch;

	constructor(options: GarminClientOptions) {
		this.#tokens = options.tokens;
		this.#fetch = options.fetch ?? ((...args) => fetch(...args));
	}

	/** Returns parsed JSON, or null when Garmin has no data (204 or empty body). */
	async getJson<T>(path: string, query?: Query): Promise<T | null> {
		const response = await this.#request(path, "application/json", query);
		if (response.status === 204) return null;
		const text = await response.text();
		return text ? (JSON.parse(text) as T) : null;
	}

	/** Original activity file: a ZIP archive, usually holding one .fit file. */
	async downloadActivityZip(activityId: string): Promise<Uint8Array> {
		const response = await this.#request(
			`/download-service/files/activity/${activityId}`,
			"application/zip, application/x-zip-compressed, application/octet-stream",
		);
		return new Uint8Array(await response.arrayBuffer());
	}

	async #request(path: string, accept: string, query?: Query): Promise<Response> {
		const url = new URL(path, GARMIN_BASE_URL);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}

		let response = await this.#send(url, accept, await this.#tokens.getToken());
		if (response.status === 401) {
			// The cached token can be revoked before its exp; retry once with a new one.
			await response.body?.cancel();
			response = await this.#send(url, accept, await this.#tokens.getToken({ forceRefresh: true }));
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new GarminApiError(describeStatus(response.status), response.status);
		}
		return response;
	}

	#send(url: URL, accept: string, token: string): Promise<Response> {
		return this.#fetch(url, {
			headers: { Accept: accept, Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(30_000),
		});
	}
}

/** Response bodies are deliberately left out: they could carry personal data. */
function describeStatus(status: number): string {
	switch (status) {
		case 400:
			return "Garmin rejected the request as invalid (HTTP 400). Check the id or date range.";
		case 401:
			return "Garmin rejected the access token even after a refresh (HTTP 401).";
		case 403:
			return "Garmin refused access to this resource (HTTP 403).";
		case 404:
			return "Garmin has no such resource (HTTP 404).";
		case 429:
			return "Garmin is rate limiting requests (HTTP 429). Wait a minute and try again.";
		default:
			return `Garmin returned HTTP ${status}.`;
	}
}
