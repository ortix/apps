import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { downsample, extractFit, FitParseError, parseFit } from "../src/garmin/fit";
import { SYNTHETIC_RUN_FIT } from "./fixtures/synthetic-run";

describe("extractFit", () => {
	it("finds the .fit inside Garmin's ZIP", () => {
		const zip = zipSync({ "123_ACTIVITY.fit": SYNTHETIC_RUN_FIT, "notes.txt": new Uint8Array([1]) });
		expect(extractFit(zip)).toEqual(SYNTHETIC_RUN_FIT);
	});
	it("returns null for non-FIT uploads", () => {
		expect(extractFit(zipSync({ "123.gpx": new Uint8Array([1, 2]) }))).toBeNull();
	});
	it("reports a body that is not a ZIP", () => {
		expect(() => extractFit(new Uint8Array([1, 2, 3, 4]))).toThrow(FitParseError);
	});
});

describe("parseFit (runs inside workerd)", () => {
	const parsed = parseFit(SYNTHETIC_RUN_FIT);

	it("extracts the session and every record", () => {
		expect(parsed.sport).toBe("running");
		expect(parsed.start_utc).toBe("2026-01-15T07:00:00.000Z");
		expect(parsed.series.t).toHaveLength(120);
		expect(parsed.series.t[119]).toBe(119);
		expect(parsed.series.distance_m[100]).toBeCloseTo(300);
		expect(parsed.series.power_w[0]).toBe(250);
	});

	it("reports running cadence in steps per minute", () => {
		expect(parsed.cadence_unit).toBe("steps_per_min");
		expect(parsed.series.cadence[0]).toBe(171);
		expect(parsed.laps[0]?.avg_cadence).toBe(171);
	});

	it("returns laps with pace", () => {
		expect(parsed.laps).toHaveLength(2);
		expect(parsed.laps[1]).toMatchObject({ index: 2, duration_s: 60, distance_m: 180, avg_hr_bpm: 145, pace: "5:33", trigger: "distance" });
		expect(parsed.laps[0]?.pace_min_km).toBeCloseTo(5.56, 2);
	});

	it("never exposes position data", () => {
		expect(JSON.stringify(parsed)).not.toMatch(/position|latitude|longitude|lat\b|long\b/i);
	});

	it("rejects bytes that are not FIT", () => {
		expect(() => parseFit(new Uint8Array(64))).toThrow(FitParseError);
	});
});

describe("downsample", () => {
	const { series } = parseFit(SYNTHETIC_RUN_FIT);

	it("buckets to the requested resolution", () => {
		const result = downsample(series, 10);
		expect(result.rows).toHaveLength(12);
		const t = result.columns.indexOf("t_s");
		expect(result.rows[1]?.[t]).toBe(10);
	});

	it("averages rates and keeps cumulative distance", () => {
		const result = downsample(series, 10);
		const col = (name: string) => result.columns.indexOf(name);
		expect(result.rows[0]?.[col("hr_bpm")]).toBe(145); // mean of 140..149, rounded
		expect(result.rows[0]?.[col("distance_m")]).toBeCloseTo(27); // last sample in the bucket
		expect(result.rows[0]?.[col("pace_min_km")]).toBeCloseTo(5.56, 2);
	});

	it("omits columns with no data, such as power on older devices", () => {
		const result = downsample({ ...series, power_w: series.power_w.map(() => null) }, 10);
		expect(result.columns).not.toContain("power_w");
		expect(result.rows[0]).toHaveLength(result.columns.length);
	});

	it("gives a null pace when standing still", () => {
		const result = downsample({ ...series, speed_mps: series.speed_mps.map((v, i) => (i < 10 ? 0 : v)) }, 10);
		expect(result.rows[0]?.[result.columns.indexOf("pace_min_km")]).toBeNull();
	});
});
