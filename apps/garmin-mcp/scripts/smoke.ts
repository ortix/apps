/**
 * Local check of the Garmin client against real data. Prints SHAPES ONLY
 * (field names, types, counts), never values, tokens or the API key.
 * Usage: GARMIN_API_KEY=... npm run smoke  (falls back to GARMIN_TOKEN)
 */
import { GarminClient } from "../src/garmin/client";
import { GarminTokenProvider, type TokenStore } from "../src/garmin/token";
import { unzipSync } from "fflate";
import { Decoder, Stream } from "@garmin/fitsdk";

const apiKey = process.env.GARMIN_API_KEY ?? process.env.GARMIN_TOKEN;
if (!apiKey) throw new Error("Set GARMIN_API_KEY or GARMIN_TOKEN");

const memory = new Map<string, string>();
const store: TokenStore = {
	get: async (k) => memory.get(k) ?? null,
	put: async (k, v) => void memory.set(k, v),
};
const client = new GarminClient({ tokens: new GarminTokenProvider({ apiKey, store }) });

const day = (offset: number) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);
const end = day(0);
const start = day(14);

function shape(value: unknown, depth = 0): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return `[${value.length}]${value.length ? " of " + shape(value[0], depth) : ""}`;
	if (value instanceof Date) return "Date";
	if (typeof value !== "object") return typeof value;
	if (depth >= 2) return "{…}";
	const entries = Object.entries(value).filter(([, v]) => v !== null);
	return `{ ${entries.map(([k, v]) => `${k}: ${shape(v, depth + 1)}`).join(", ")} }`;
}

async function probe<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
	const started = Date.now();
	try {
		const result = await run();
		console.log(`\nOK  ${name} (${Date.now() - started}ms)\n${shape(result).slice(0, 3500)}`);
		return result;
	} catch (error) {
		console.log(`\nERR ${name}: ${(error as Error).message}`);
		return undefined;
	}
}

type Summary = { activityId: number };
const list = await probe("activities", () =>
	client.getJson<Summary[]>("/activitylist-service/activities/search/activities", { startDate: start, endDate: end, limit: 20 }),
);
const id = list?.[0]?.activityId;
if (id !== undefined) {
	const detail = await probe("activity", () => client.getJson<{ splitSummaries?: { splitType?: string }[] }>(`/activity-service/activity/${id}`));
	console.log("splitTypes:", detail?.splitSummaries?.map((s) => s.splitType));
	const zip = await probe("download", async () => {
		const files = unzipSync(await client.downloadActivityZip(String(id)));
		return Object.fromEntries(Object.entries(files).map(([n, b]) => [n.replace(/^.*\./, "*."), b.length]));
	});
	if (zip) {
		const files = unzipSync(await client.downloadActivityZip(String(id)));
		const fit = Object.entries(files).find(([n]) => n.toLowerCase().endsWith(".fit"))?.[1];
		if (fit) {
			const decoder = new Decoder(Stream.fromByteArray(Array.from(fit)));
			console.log("isFIT:", decoder.isFIT(), "integrity:", decoder.checkIntegrity());
			const { messages, errors } = decoder.read();
			console.log("errors:", errors.length, "message counts:", Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, (v as unknown[]).length])));
			console.log("record:", shape((messages.recordMesgs as unknown[] | undefined)?.[10]));
			console.log("lap:", shape((messages.lapMesgs as unknown[] | undefined)?.[0]).slice(0, 2000));
		}
	}
}
await probe("dailysummaries", () => client.getJson("/usersummary-service/v2/dailysummaries", { startDate: start, endDate: end }));
await probe("sleep", () => client.getJson("/sleep-service/sleep/dailySleepSummariesByDate", { startDate: start, endDate: end }));
await probe("hrv", () => client.getJson(`/hrv-service/hrv/daily/${start}/${end}`));
await probe("hrv 60d", () => client.getJson(`/hrv-service/hrv/daily/${day(60)}/${end}`));
