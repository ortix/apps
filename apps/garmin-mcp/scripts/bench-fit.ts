// Times FIT parsing on a real activity. Prints timings only, never data.
import { GarminClient } from "../src/garmin/client";
import { GarminTokenProvider } from "../src/garmin/token";
import { extractFit, parseFit, downsample } from "../src/garmin/fit";
const memory = new Map<string, string>();
const apiKey = process.env.GARMIN_API_KEY ?? process.env.GARMIN_TOKEN;
if (!apiKey) throw new Error("Set GARMIN_API_KEY or GARMIN_TOKEN");
const client = new GarminClient({ tokens: new GarminTokenProvider({ apiKey, store: { get: async (k) => memory.get(k) ?? null, put: async (k, v) => void memory.set(k, v) } }) });
const day = (o: number) => new Date(Date.now() - o * 864e5).toISOString().slice(0, 10);
const list = await client.getJson<{ activityId: number }[]>("/activitylist-service/activities/search/activities", { startDate: day(14), endDate: day(0), limit: 1 });
const zip = await client.downloadActivityZip(String(list![0]!.activityId));
for (let i = 0; i < 4; i++) {
	const a = performance.now(); const fit = extractFit(zip)!;
	const b = performance.now(); const parsed = parseFit(fit);
	const c = performance.now(); const d = downsample(parsed.series, 10);
	const e = performance.now();
	console.log(`run ${i}: unzip ${(b-a).toFixed(1)}ms parse ${(c-b).toFixed(1)}ms downsample ${(e-c).toFixed(1)}ms | records ${parsed.series.t.length} laps ${parsed.laps.length} rows ${d.rows.length} columns ${d.columns.join(",")} cachedJSON ${JSON.stringify(parsed).length} chars response ${JSON.stringify(d).length} chars cadence ${parsed.cadence_unit}`);
}
