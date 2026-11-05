/**
 * Turns Garmin's activity download (a ZIP holding a .fit file) into compact
 * columnar data. GPS fields are never read, so they can't reach a cache or a
 * tool response.
 */
import { Decoder, Stream } from "@garmin/fitsdk";
import { unzipSync } from "fflate";
import { paceMinKm, paceMmss, round } from "../units";

export class FitParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FitParseError";
	}
}

export interface Series {
	/** Seconds since the first record, including pauses. */
	t: number[];
	distance_m: (number | null)[];
	speed_mps: (number | null)[];
	hr_bpm: (number | null)[];
	cadence: (number | null)[];
	altitude_m: (number | null)[];
	power_w: (number | null)[];
}

export interface Lap {
	index: number;
	start_utc?: string;
	duration_s?: number;
	elapsed_s?: number;
	distance_m?: number;
	speed_mps?: number;
	pace_min_km?: number;
	pace?: string;
	avg_hr_bpm?: number;
	max_hr_bpm?: number;
	avg_cadence?: number;
	avg_power_w?: number;
	ascent_m?: number;
	descent_m?: number;
	intensity?: string;
	trigger?: string;
}

export interface ParsedFit {
	sport: string | null;
	sub_sport: string | null;
	start_utc: string | null;
	cadence_unit: "steps_per_min" | "rpm";
	series: Series;
	laps: Lap[];
}

type Mesg = Record<string, unknown>;

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);

/** Returns the FIT bytes from Garmin's ZIP, or null for non-FIT uploads (GPX, TCX). */
export function extractFit(zip: Uint8Array): Uint8Array | null {
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(zip, { filter: (file) => file.name.toLowerCase().endsWith(".fit") });
	} catch {
		throw new FitParseError("Garmin's activity download was not a readable ZIP file.");
	}
	return Object.values(files)[0] ?? null;
}

export function parseFit(bytes: Uint8Array): ParsedFit {
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	const decoder = new Decoder(Stream.fromArrayBuffer(buffer));
	if (!decoder.isFIT()) throw new FitParseError("Garmin's activity file is not a valid FIT file.");

	const { messages, errors } = decoder.read({
		includeUnknownData: false,
		// Merges 1 Hz HR from separate messages; not needed since we read record HR.
		mergeHeartRates: false,
	});
	const all = messages as Record<string, Mesg[] | undefined>;
	const records = all.recordMesgs ?? [];
	if (errors.length > 0 && records.length === 0) {
		throw new FitParseError("Garmin's activity file could not be decoded.");
	}

	const session = all.sessionMesgs?.[0];
	const sport = str(session?.sport) ?? str(all.sportMesgs?.[0]?.sport);
	// FIT stores running cadence per leg with a fractional part; report steps/min.
	const onFoot = sport === "running" || sport === "walking" || sport === "hiking";

	const start = records.find((r) => r.timestamp instanceof Date)?.timestamp as Date | undefined;
	const series: Series = { t: [], distance_m: [], speed_mps: [], hr_bpm: [], cadence: [], altitude_m: [], power_w: [] };
	for (const record of records) {
		if (!(record.timestamp instanceof Date) || !start) continue;
		series.t.push(Math.round((record.timestamp.getTime() - start.getTime()) / 1000));
		series.distance_m.push(num(record.distance));
		series.speed_mps.push(num(record.enhancedSpeed) ?? num(record.speed));
		series.hr_bpm.push(num(record.heartRate));
		series.altitude_m.push(num(record.enhancedAltitude) ?? num(record.altitude));
		series.power_w.push(num(record.power));
		const cadence = num(record.cadence);
		series.cadence.push(cadence === null ? null : onFoot ? (cadence + (num(record.fractionalCadence) ?? 0)) * 2 : cadence);
	}

	return {
		sport,
		sub_sport: str(session?.subSport),
		start_utc: iso(start ?? session?.startTime),
		cadence_unit: onFoot ? "steps_per_min" : "rpm",
		series,
		laps: (all.lapMesgs ?? []).map((lap, index) => toLap(lap, index, onFoot)),
	};
}

function toLap(lap: Mesg, index: number, onFoot: boolean): Lap {
	const speed = num(lap.enhancedAvgSpeed) ?? num(lap.avgSpeed);
	const cadence = num(lap.avgCadence);
	return dropEmpty({
		index: index + 1,
		start_utc: iso(lap.startTime),
		duration_s: round(num(lap.totalTimerTime), 1),
		elapsed_s: round(num(lap.totalElapsedTime), 1),
		distance_m: round(num(lap.totalDistance), 1),
		speed_mps: round(speed, 2),
		pace_min_km: paceMinKm(speed),
		pace: paceMmss(speed),
		avg_hr_bpm: num(lap.avgHeartRate),
		max_hr_bpm: num(lap.maxHeartRate),
		avg_cadence: cadence === null ? null : round(onFoot ? (cadence + (num(lap.avgFractionalCadence) ?? 0)) * 2 : cadence, 0),
		avg_power_w: num(lap.avgPower),
		ascent_m: num(lap.totalAscent),
		descent_m: num(lap.totalDescent),
		intensity: str(lap.intensity),
		trigger: str(lap.lapTrigger),
	}) as Lap;
}

export function dropEmpty<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

const COLUMNS = ["t_s", "distance_m", "speed_mps", "pace_min_km", "hr_bpm", "cadence", "altitude_m", "power_w"] as const;

export interface Downsampled {
	resolution_s: number;
	columns: string[];
	rows: (number | null)[][];
}

function mean(values: (number | null)[], from: number, to: number): number | null {
	let sum = 0;
	let count = 0;
	for (let i = from; i < to; i++) {
		const value = values[i];
		if (value !== null && value !== undefined) {
			sum += value;
			count++;
		}
	}
	return count === 0 ? null : sum / count;
}

/**
 * Averages samples into fixed time buckets. Averaging keeps short surges visible
 * in the mean, unlike picking every Nth sample. Distance takes the bucket's last
 * value because it is cumulative. Columns with no data at all are omitted.
 */
export function downsample(series: Series, resolutionS: number): Downsampled {
	const rows: (number | null)[][] = [];
	let from = 0;
	while (from < series.t.length) {
		const bucket = Math.floor((series.t[from] as number) / resolutionS);
		let to = from + 1;
		while (to < series.t.length && Math.floor((series.t[to] as number) / resolutionS) === bucket) to++;

		let distance: number | null = null;
		for (let i = to - 1; i >= from && distance === null; i--) distance = series.distance_m[i] ?? null;
		const speed = mean(series.speed_mps, from, to);
		rows.push([
			bucket * resolutionS,
			round(distance, 1),
			round(speed, 2),
			paceMinKm(speed),
			round(mean(series.hr_bpm, from, to), 0),
			round(mean(series.cadence, from, to), 0),
			round(mean(series.altitude_m, from, to), 1),
			round(mean(series.power_w, from, to), 0),
		]);
		from = to;
	}

	const keep = COLUMNS.map((_, column) => column).filter((column) => rows.some((row) => row[column] !== null));
	return {
		resolution_s: resolutionS,
		columns: keep.map((column) => COLUMNS[column] as string),
		rows: rows.map((row) => keep.map((column) => row[column] as number | null)),
	};
}
