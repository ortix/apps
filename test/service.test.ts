import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { GarminClient } from "../src/garmin/client";
import { GarminTokenProvider } from "../src/garmin/token";
import { getActivity, getActivityStreams, getDailyHealth, listActivities, MAX_RESPONSE_CHARS, ToolInputError } from "../src/service";
import { SYNTHETIC_RUN_FIT } from "./fixtures/synthetic-run";
import { fakeJwt, MemoryStore, mockFetch, type Route } from "./helpers";

function deps(route: Route) {
	const mock = mockFetch((url, init) => {
		if (url.pathname.includes("personal-api-key/token")) return new Response(fakeJwt(Date.now() / 1000 + 86_400));
		return route(url, init);
	});
	const cache = new MemoryStore();
	const tokens = new GarminTokenProvider({ apiKey: "k", store: cache, fetch: mock.fn });
	const apiCalls = () => mock.calls.filter((c) => !c.url.pathname.includes("personal-api-key/token"));
	return { client: new GarminClient({ tokens, fetch: mock.fn }), cache, apiCalls };
}

const ZIP = zipSync({ "1_ACTIVITY.fit": SYNTHETIC_RUN_FIT });

describe("listActivities", () => {
	const raw = {
		activityId: 42,
		activityName: "Morning Run",
		startTimeLocal: "2026-01-15 08:00:00",
		startTimeGMT: "2026-01-15 07:00:00",
		activityType: { typeKey: "running" },
		distance: 10000,
		duration: 3000,
		averageSpeed: 3.333,
		averageHR: 150.4,
		elevationGain: 50,
		startLatitude: 52.1,
		startLongitude: 4.3,
		ownerFullName: "Private Name",
	};

	it("returns compact summaries with pace, without GPS or owner details", async () => {
		const d = deps(() => Response.json([raw]));
		const result = await listActivities(d, { start_date: "2026-01-01", end_date: "2026-01-31", type: "running" });
		expect(result.activities?.[0]).toMatchObject({
			id: "42",
			type: "running",
			start_local: "2026-01-15T08:00:00",
			start_utc: "2026-01-15T07:00:00Z",
			pace: "5:00",
			pace_min_km: 5,
			avg_hr_bpm: 150,
		});
		expect(JSON.stringify(result)).not.toMatch(/Private Name|52\.1|atitude/);
		expect(d.apiCalls()[0]?.url.searchParams.get("activityType")).toBe("running");
	});

	it("paginates until a short page", async () => {
		const d = deps((url) => {
			const start = Number(url.searchParams.get("start"));
			return Response.json(Array.from({ length: start === 0 ? 100 : 7 }, (_, i) => ({ ...raw, activityId: start + i })));
		});
		const result = await listActivities(d, { start_date: "2026-01-01", end_date: "2026-01-31" });
		expect(result.count).toBe(107);
		expect(result.truncated).toBeUndefined();
		expect(d.apiCalls()).toHaveLength(2);
	});

	it("caps the payload with a clear note", async () => {
		const big = { ...raw, activityName: "x".repeat(2000) };
		const d = deps((url) => Response.json(Number(url.searchParams.get("start")) === 0 ? Array.from({ length: 99 }, () => big) : []));
		const result = await listActivities(d, { start_date: "2026-01-01", end_date: "2026-01-31" });
		expect(result.truncated).toBe(true);
		expect(result.note).toMatch(/Narrow the date range/);
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
	});

	it("rejects reversed and impossible ranges", async () => {
		const d = deps(() => Response.json([]));
		await expect(listActivities(d, { start_date: "2026-02-01", end_date: "2026-01-01" })).rejects.toThrow(ToolInputError);
		await expect(listActivities(d, { start_date: "2026-13-45", end_date: "2026-13-46" })).rejects.toThrow(ToolInputError);
	});
});

describe("getActivity", () => {
	const detail = {
		activityId: 42,
		activityName: "Run",
		activityTypeDTO: { typeKey: "running" },
		summaryDTO: { startTimeGMT: "2026-01-15T07:00:00.0", distance: 360, duration: 120, averageSpeed: 3, startLatitude: 52.1, directWorkoutRpe: 30 },
		splitSummaries: [{ splitType: "INTERVAL_ACTIVE", noOfSplits: 2, distance: 360, duration: 120, averageSpeed: 3 }],
	};

	it("joins the summary with FIT laps and caches both", async () => {
		const d = deps((url) => (url.pathname.includes("download-service") ? new Response(ZIP) : Response.json(detail)));
		const first = await getActivity(d, "42");
		expect(first).toMatchObject({ id: "42", type: "running", start_utc: "2026-01-15T07:00:00Z", pace: "5:33", perceived_effort_rpe: 3 });
		expect(first.laps).toHaveLength(2);
		expect(JSON.stringify(first)).not.toContain("52.1");
		expect(d.apiCalls()).toHaveLength(2);

		const second = await getActivity(d, "42");
		expect(second).toEqual(first);
		expect(d.apiCalls()).toHaveLength(2);
	});

	it("still returns the summary when the file is not FIT", async () => {
		const d = deps((url) => (url.pathname.includes("download-service") ? new Response(zipSync({ "a.gpx": new Uint8Array([1]) })) : Response.json(detail)));
		const result = await getActivity(d, "42");
		expect(result.laps).toBeUndefined();
		expect(result.note).toMatch(/not FIT/);
	});

	it("does not cache failures", async () => {
		let fail = true;
		const d = deps(() => (fail ? new Response(null, { status: 500 }) : Response.json(detail)));
		await expect(getActivity(d, "42")).rejects.toThrow();
		fail = false;
		expect(await getActivity(d, "42")).toMatchObject({ id: "42" });
	});
});

describe("getActivityStreams", () => {
	it("returns columnar data and re-uses the parsed FIT on a second call", async () => {
		const d = deps(() => new Response(ZIP));
		const result = await getActivityStreams(d, "42");
		expect(result).toMatchObject({ id: "42", sport: "running", resolution_s: 10, points: 12, cadence_unit: "steps_per_min" });
		expect(result.columns).toEqual(["t_s", "distance_m", "speed_mps", "pace_min_km", "hr_bpm", "cadence", "altitude_m", "power_w"]);

		await getActivityStreams(d, "42", 30);
		expect(d.apiCalls()).toHaveLength(1);
	});

	it("coarsens automatically to fit the cap, and says so", async () => {
		const d = deps(() => new Response(ZIP));
		await getActivityStreams(d, "42", 1); // populates the cache
		const key = "v1:fit:42";
		const cached = JSON.parse((await d.cache.get(key)) as string);
		const n = 40_000;
		const fill = <T>(value: T) => Array.from({ length: n }, () => value);
		cached.fit.series = {
			t: Array.from({ length: n }, (_, i) => i),
			distance_m: fill(12345.6),
			speed_mps: fill(3.33),
			hr_bpm: fill(150),
			cadence: fill(170),
			altitude_m: fill(100.5),
			power_w: fill(250),
		};
		await d.cache.put(key, JSON.stringify(cached));

		const result = await getActivityStreams(d, "42", 1);
		expect(result.resolution_s).toBeGreaterThan(1);
		expect(result.note).toMatch(/exceed the response limit/);
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
	});

	it("explains non-FIT activities", async () => {
		const d = deps(() => new Response(zipSync({ "a.tcx": new Uint8Array([1]) })));
		await expect(getActivityStreams(d, "42")).rejects.toThrow(/not FIT/);
	});
});

describe("getDailyHealth", () => {
	const routes: Route = (url) => {
		if (url.pathname.includes("dailysummaries")) {
			return Response.json({
				data: [{ calendarDate: "2026-01-15", heartRate: { restingValue: 48 }, stress: { avgLevel: 25, maxLevel: 90 }, bodyBattery: { minValue: 20, maxValue: 90, latestValue: 60 } }],
			});
		}
		if (url.pathname.includes("sleep-service")) {
			return Response.json([
				{ calendarDate: "2026-01-14", sleepTimeSeconds: 100 },
				{ calendarDate: "2026-01-15", sleepTimeSeconds: 27000, deepSleepSeconds: 5000, sleepStartTimestampGMT: 1768431600000, sleepScores: { overall: { value: 81, qualifierKey: "GOOD" } } },
			]);
		}
		return Response.json({ hrvSummaries: [{ calendarDate: "2026-01-15", lastNightAvg: 62, weeklyAvg: 60, status: "BALANCED" }] });
	};

	it("merges sources by date and filters out-of-range rows", async () => {
		const result = await getDailyHealth(deps(routes), { start_date: "2026-01-15" });
		expect(result.count).toBe(1);
		expect(result.days?.[0]).toMatchObject({
			date: "2026-01-15",
			resting_hr_bpm: 48,
			stress: { avg: 25, max: 90 },
			body_battery: { min: 20, max: 90, latest: 60 },
			sleep: { duration_s: 27000, deep_s: 5000, score: 81, quality: "GOOD", start_utc: "2026-01-14T23:00:00.000Z" },
			hrv: { last_night_avg_ms: 62, weekly_avg_ms: 60, status: "BALANCED" },
		});
	});

	it("splits long ranges into Garmin's per-request windows", async () => {
		const d = deps((url) => (url.pathname.includes("dailysummaries") ? Response.json({ data: [] }) : url.pathname.includes("sleep") ? Response.json([]) : Response.json({ hrvSummaries: [] })));
		await getDailyHealth(d, { start_date: "2026-01-01", end_date: "2026-03-31" });
		const sleep = d.apiCalls().filter((c) => c.url.pathname.includes("sleep"));
		expect(sleep).toHaveLength(3);
		expect(sleep[0]?.url.searchParams.get("endDate")).toBe("2026-01-31");
		expect(sleep[1]?.url.searchParams.get("startDate")).toBe("2026-02-01");
		expect(sleep[2]?.url.searchParams.get("endDate")).toBe("2026-03-31");
	});

	it("rejects ranges over the maximum", async () => {
		await expect(getDailyHealth(deps(routes), { start_date: "2026-01-01", end_date: "2026-12-31" })).rejects.toThrow(/maximum/);
	});

	it("returns partial data with a warning when one source fails", async () => {
		const d = deps((url, init) => (url.pathname.includes("hrv") ? new Response(null, { status: 500 }) : routes(url, init)));
		const result = await getDailyHealth(d, { start_date: "2026-01-15" });
		expect(result.days?.[0]).toHaveProperty("sleep");
		expect(result.warnings?.[0]).toMatch(/HRV is missing/);
	});

	it("fails outright when every source fails", async () => {
		await expect(getDailyHealth(deps(() => new Response(null, { status: 503 })), { start_date: "2026-01-15" })).rejects.toThrow(/503/);
	});
});
