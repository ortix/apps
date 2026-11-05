/**
 * Runs the tool logic against real data. Prints shapes and sizes only, never
 * values. Usage: GARMIN_API_KEY=... npx tsx scripts/smoke-tools.ts
 */
import { GarminClient } from "../src/garmin/client";
import { GarminTokenProvider } from "../src/garmin/token";
import { getActivity, getActivityStreams, getDailyHealth, listActivities } from "../src/service";

const apiKey = process.env.GARMIN_API_KEY ?? process.env.GARMIN_TOKEN;
if (!apiKey) throw new Error("Set GARMIN_API_KEY or GARMIN_TOKEN");
const memory = new Map<string, string>();
const cache = { get: async (k: string) => memory.get(k) ?? null, put: async (k: string, v: string) => void memory.set(k, v) };
const deps = { client: new GarminClient({ tokens: new GarminTokenProvider({ apiKey, store: cache }) }), cache };

function shape(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return `[${value.length}]${value.length ? ` of ${shape(value[0])}` : ""}`;
	if (typeof value !== "object") return typeof value;
	return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${shape(v)}`).join(", ")} }`;
}
const show = (name: string, result: unknown) => console.log(`\n${name} (${JSON.stringify(result).length} chars)\n${shape(result)}`);

const day = (o: number) => new Date(Date.now() - o * 864e5).toISOString().slice(0, 10);
const list = await listActivities(deps, { start_date: day(30), end_date: day(0) });
show("list_activities", list);
const id = (list.activities?.[0] as { id: string } | undefined)?.id as string;
show("get_activity", await getActivity(deps, id));
show("get_activity_streams", await getActivityStreams(deps, id));
show("get_activity_streams 1s", await getActivityStreams(deps, id, 1));
show("get_daily_health 1d", await getDailyHealth(deps, { start_date: day(1) }));
const range = await getDailyHealth(deps, { start_date: day(92 - 1), end_date: day(0) });
console.log(`\nget_daily_health 92d: ${JSON.stringify(range).length} chars, ${range.count} days, warnings: ${range.warnings?.length ?? 0}`);
