/**
 * Tool logic, independent of MCP so it can be unit tested with a mocked fetch.
 * Everything returned here is reduced to fields a model needs: no GPS
 * coordinates, owner names, profile images or internal Garmin ids.
 */
import { GarminApiError, type GarminClient } from "./garmin/client";
import { downsample, dropEmpty, extractFit, parseFit, type ParsedFit } from "./garmin/fit";
import { paceMinKm, paceMmss, round } from "./units";
import { type ActivityWorkoutRaw, compactWorkouts, compactZones, type HeartRateZonesRaw } from "./workouts";

/** claude.ai caps tool results near 150k characters; stay well below that. */
export const MAX_RESPONSE_CHARS = 100_000;
export const MAX_HEALTH_RANGE_DAYS = 92;
const MAX_ACTIVITIES = 500;
const ACTIVITY_PAGE_SIZE = 100;
const DAY_MS = 86_400_000;
const ACTIVITY_TTL_S = 7 * 86_400; // Names and elevation correction can still change.
const FIT_TTL_S = 90 * 86_400; // The original file never changes.
// Bump a version when its cached shape or meaning changes.
const FIT_CACHE_VERSION = "v1";
const ACTIVITY_CACHE_VERSION = "v3";
const WORKOUT_CACHE_VERSION = "v1";

export class ToolInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolInputError";
	}
}

export interface CacheStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface Deps {
	client: GarminClient;
	cache: CacheStore;
}

async function cached<T>(cache: CacheStore, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
	const hit = await cache.get(key);
	if (hit !== null) return JSON.parse(hit) as T;
	const value = await load();
	await cache.put(key, JSON.stringify(value), { expirationTtl: ttl });
	return value;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Garmin's "yyyy-MM-dd HH:mm:ss" or ISO without an offset, in UTC. */
function utc(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	return `${value.replace(" ", "T").replace(/\.\d+$/, "")}Z`;
}
const local = (value: unknown): string | null =>
	typeof value === "string" && value ? value.replace(" ", "T").replace(/\.\d+$/, "") : null;

// ---- list_activities -------------------------------------------------------

interface ActivityListItem {
	activityId: number;
	activityName?: string;
	startTimeLocal?: string;
	startTimeGMT?: string;
	activityType?: { typeKey?: string };
	eventType?: { typeKey?: string };
	distance?: number;
	duration?: number;
	movingDuration?: number;
	elevationGain?: number;
	elevationLoss?: number;
	averageSpeed?: number;
	averageHR?: number;
	maxHR?: number;
	avgPower?: number;
	calories?: number;
	activityTrainingLoad?: number;
}

export async function listActivities(deps: Deps, input: { start_date: string; end_date: string; type?: string | undefined }) {
	assertRange(input.start_date, input.end_date);
	const items: ActivityListItem[] = [];
	let more = true;
	while (more && items.length < MAX_ACTIVITIES) {
		const page = await deps.client.getJson<ActivityListItem[]>("/activitylist-service/activities/search/activities", {
			start: items.length,
			limit: ACTIVITY_PAGE_SIZE,
			startDate: input.start_date,
			endDate: input.end_date,
			activityType: input.type,
		});
		items.push(...(page ?? []));
		more = (page?.length ?? 0) === ACTIVITY_PAGE_SIZE;
	}

	const activities = items.map((a) =>
		dropEmpty({
			id: String(a.activityId),
			name: a.activityName,
			type: a.activityType?.typeKey,
			start_local: local(a.startTimeLocal),
			start_utc: utc(a.startTimeGMT),
			distance_m: round(a.distance, 1),
			duration_s: round(a.duration, 1),
			moving_s: round(a.movingDuration, 1),
			speed_mps: round(a.averageSpeed, 2),
			pace_min_km: paceMinKm(a.averageSpeed),
			pace: paceMmss(a.averageSpeed),
			avg_hr_bpm: round(a.averageHR, 0),
			max_hr_bpm: round(a.maxHR, 0),
			elevation_gain_m: round(a.elevationGain, 1),
			avg_power_w: round(a.avgPower, 0),
			training_load: round(a.activityTrainingLoad, 1),
		}),
	);

	const capped = capArray(activities);
	const hitLimit = more || capped.dropped > 0;
	return dropEmpty({
		count: capped.items.length,
		activities: capped.items,
		truncated: hitLimit || null,
		note: hitLimit
			? "Results were truncated to fit the response limit; the newest activities are shown. Narrow the date range to see the rest."
			: null,
	});
}

// ---- get_activity ----------------------------------------------------------

interface SplitSummary {
	splitType?: string;
	noOfSplits?: number;
	distance?: number;
	duration?: number;
	averageSpeed?: number;
	averageHR?: number;
	maxHR?: number;
	elevationGain?: number;
	elevationLoss?: number;
	averagePower?: number;
}

interface ActivityDetail {
	activityId: number;
	activityName?: string;
	description?: string;
	locationName?: string;
	activityTypeDTO?: { typeKey?: string };
	eventTypeDTO?: { typeKey?: string };
	timeZoneUnitDTO?: { timeZone?: string };
	summaryDTO?: Record<string, unknown>;
	splitSummaries?: SplitSummary[];
}

async function loadFit(deps: Deps, id: string): Promise<ParsedFit | null> {
	const result = await cached(deps.cache, `${FIT_CACHE_VERSION}:fit:${id}`, FIT_TTL_S, async () => {
		const fit = extractFit(await deps.client.downloadActivityZip(id));
		return { fit: fit ? parseFit(fit) : null };
	});
	return result.fit;
}

export async function getActivity(deps: Deps, id: string) {
	const summary = await cached(deps.cache, `${ACTIVITY_CACHE_VERSION}:activity:${id}`, ACTIVITY_TTL_S, async () => {
		const detail = await deps.client.getJson<ActivityDetail>(`/activity-service/activity/${id}`);
		if (!detail) throw new GarminApiError("Garmin has no such activity.", 404);
		return compactDetail(detail);
	});

	const notes: string[] = [];
	const [fit, workouts] = await Promise.allSettled([
		loadFit(deps, id),
		// The planned workout never changes once recorded. Failures are not cached.
		cached(deps.cache, `${WORKOUT_CACHE_VERSION}:workouts:${id}`, FIT_TTL_S, async () =>
			compactWorkouts(await deps.client.getJson<ActivityWorkoutRaw[]>(`/activity-service/activity/${id}/workouts`)),
		),
	]);

	// Per-lap data exists only in the FIT file. The summary is still useful without it.
	let laps: unknown[] | null = null;
	if (fit.status === "rejected") notes.push(`Per-lap data is unavailable: ${(fit.reason as Error).message}`);
	else if (fit.value) laps = fit.value.laps;
	else notes.push("This activity's original file is not FIT, so per-lap data is unavailable.");

	if (workouts.status === "rejected") notes.push(`The planned workout is unavailable: ${(workouts.reason as Error).message}`);
	const planned = workouts.status === "fulfilled" ? workouts.value : null;

	return dropEmpty({ ...summary, planned_workout: planned, laps, note: notes.length ? notes.join(" ") : null });
}

function compactDetail(detail: ActivityDetail) {
	const s = detail.summaryDTO ?? {};
	const speed = num(s.averageSpeed);
	return dropEmpty({
		id: String(detail.activityId),
		name: detail.activityName,
		description: detail.description,
		type: detail.activityTypeDTO?.typeKey,
		event_type: detail.eventTypeDTO?.typeKey,
		location: detail.locationName,
		time_zone: detail.timeZoneUnitDTO?.timeZone,
		start_local: local(s.startTimeLocal),
		start_utc: utc(s.startTimeGMT),
		distance_m: round(num(s.distance), 1),
		duration_s: round(num(s.duration), 1),
		moving_s: round(num(s.movingDuration), 1),
		elapsed_s: round(num(s.elapsedDuration), 1),
		speed_mps: round(speed, 2),
		max_speed_mps: round(num(s.maxSpeed), 2),
		pace_min_km: paceMinKm(speed),
		pace: paceMmss(speed),
		grade_adjusted_pace_min_km: paceMinKm(num(s.avgGradeAdjustedSpeed)),
		avg_hr_bpm: round(num(s.averageHR), 0),
		max_hr_bpm: round(num(s.maxHR), 0),
		avg_cadence: round(num(s.averageRunCadence) ?? num(s.averageBikeCadence), 0),
		elevation_gain_m: round(num(s.elevationGain), 1),
		elevation_loss_m: round(num(s.elevationLoss), 1),
		avg_power_w: round(num(s.averagePower), 0),
		normalized_power_w: round(num(s.normalizedPower), 0),
		avg_temperature_c: round(num(s.averageTemperature), 1),
		calories_kcal: round(num(s.calories), 0),
		aerobic_training_effect: round(num(s.trainingEffect), 1),
		anaerobic_training_effect: round(num(s.anaerobicTrainingEffect), 1),
		training_effect_label: s.trainingEffectLabel,
		training_load: round(num(s.activityTrainingLoad), 1),
		// Reported exactly as Garmin returns it (directWorkoutRpe); no rescaling.
		perceived_effort_rpe: round(num(s.directWorkoutRpe), 1),
		split_summaries_by_type: detail.splitSummaries?.map((split) =>
			dropEmpty({
				split_type: split.splitType,
				count: split.noOfSplits,
				distance_m: round(split.distance, 1),
				duration_s: round(split.duration, 1),
				pace_min_km: paceMinKm(split.averageSpeed),
				avg_hr_bpm: round(split.averageHR, 0),
				elevation_gain_m: round(split.elevationGain, 1),
				avg_power_w: round(split.averagePower, 0),
			}),
		),
	});
}

// ---- get_activity_streams --------------------------------------------------

export const DEFAULT_RESOLUTION_S = 10;
const MAX_RESOLUTION_S = 3600;

export async function getActivityStreams(deps: Deps, id: string, resolution: number = DEFAULT_RESOLUTION_S) {
	const fit = await loadFit(deps, id);
	if (!fit) throw new ToolInputError("This activity's original file is not FIT, so time series are unavailable.");

	let resolutionUsed = resolution;
	let result = downsample(fit.series, resolutionUsed);
	while (JSON.stringify(result).length > MAX_RESPONSE_CHARS - 500 && resolutionUsed < MAX_RESOLUTION_S) {
		resolutionUsed *= 2;
		result = downsample(fit.series, resolutionUsed);
	}

	return dropEmpty({
		id,
		sport: fit.sport,
		sub_sport: fit.sub_sport,
		start_utc: fit.start_utc,
		cadence_unit: result.columns.includes("cadence") ? fit.cadence_unit : null,
		resolution_s: result.resolution_s,
		points: result.rows.length,
		note:
			resolutionUsed === resolution
				? null
				: `Requested resolution ${resolution}s would exceed the response limit, so ${resolutionUsed}s was used instead.`,
		columns: result.columns,
		rows: result.rows,
	});
}

// ---- get_heart_rate_zones --------------------------------------------------

export async function getHeartRateZones(deps: Deps) {
	const zones = compactZones(await deps.client.getJson<HeartRateZonesRaw[]>("/biometric-service/heartRateZones/v2"));
	return { count: zones.length, zone_sets: zones };
}

// ---- get_daily_health ------------------------------------------------------

interface DailySummaryV2 {
	calendarDate: string;
	movement?: { steps?: { value?: number } };
	calories?: { burnedTotal?: number };
	heartRate?: { restingValue?: number; minValue?: number; maxValue?: number };
	intensityMinutes?: { moderate?: number; vigorous?: number };
	stress?: { avgLevel?: number; maxLevel?: number; qualifier?: string };
	bodyBattery?: { minValue?: number; maxValue?: number; chargedValue?: number; drainedValue?: number; latestValue?: number };
	respiration?: { avgValue?: number };
	pulseOx?: { avgValue?: number };
}

interface SleepDay {
	calendarDate: string;
	sleepTimeSeconds?: number;
	napTimeSeconds?: number;
	deepSleepSeconds?: number;
	lightSleepSeconds?: number;
	remSleepSeconds?: number;
	awakeSleepSeconds?: number;
	awakeCount?: number;
	sleepStartTimestampGMT?: number | string;
	sleepEndTimestampGMT?: number | string;
	avgHeartRate?: number;
	averageSpO2Value?: number;
	averageRespirationValue?: number;
	avgSleepStress?: number;
	sleepScores?: { overall?: { value?: number; qualifierKey?: string } };
}

interface HrvDay {
	calendarDate: string;
	lastNightAvg?: number;
	lastNight5MinHigh?: number;
	weeklyAvg?: number;
	status?: string;
	baseline?: { balancedLow?: number; balancedUpper?: number };
}

const timestamp = (value: unknown): string | null => {
	if (typeof value === "number") return new Date(value).toISOString();
	return utc(value);
};

async function inWindows<T>(start: string, end: string, maxDays: number, fetchWindow: (from: string, to: string) => Promise<T[]>): Promise<T[]> {
	const results: Promise<T[]>[] = [];
	const last = Date.parse(end);
	for (let from = Date.parse(start); from <= last; from += maxDays * DAY_MS) {
		const to = Math.min(from + (maxDays - 1) * DAY_MS, last);
		results.push(fetchWindow(isoDate(from), isoDate(to)));
	}
	return (await Promise.all(results)).flat();
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function getDailyHealth(deps: Deps, input: { start_date: string; end_date?: string | undefined }) {
	const start = input.start_date;
	const end = input.end_date ?? start;
	const days = assertRange(start, end);
	if (days > MAX_HEALTH_RANGE_DAYS) {
		throw new ToolInputError(`The date range is ${days} days; the maximum is ${MAX_HEALTH_RANGE_DAYS}. Request a shorter range.`);
	}

	const { client } = deps;
	const sources = await Promise.allSettled([
		client
			.getJson<{ data?: DailySummaryV2[] }>("/usersummary-service/v2/dailysummaries", { startDate: start, endDate: end })
			.then((r) => r?.data ?? []),
		inWindows(start, end, 31, async (startDate, endDate) => {
			const rows = await client.getJson<SleepDay[]>("/sleep-service/sleep/dailySleepSummariesByDate", { startDate, endDate });
			return rows ?? [];
		}),
		// Garmin documents no limit for this range; 31 days is a conservative window.
		inWindows(start, end, 31, async (from, to) => {
			const rows = await client.getJson<{ hrvSummaries?: HrvDay[] }>(`/hrv-service/hrv/daily/${from}/${to}`);
			return rows?.hrvSummaries ?? [];
		}),
	]);

	const failed = sources.filter((s): s is PromiseRejectedResult => s.status === "rejected");
	if (failed.length === sources.length) throw failed[0]?.reason;

	const names = ["daily summary", "sleep", "HRV"];
	const warnings = sources.flatMap((s, i) => (s.status === "rejected" ? [`${names[i]} is missing: ${(s.reason as Error).message}`] : []));
	const value = <T>(s: PromiseSettledResult<T[]> | undefined): T[] => (s?.status === "fulfilled" ? s.value : []);

	const byDate = new Map<string, Record<string, unknown>>();
	const row = (date: string | null | undefined) => {
		// Garmin sometimes returns a row with a null calendarDate. Comparing null to
		// a string is false both ways, so it would slip past the range check below.
		if (typeof date !== "string" || date < start || date > end) return null;
		let entry = byDate.get(date);
		if (!entry) byDate.set(date, (entry = { date }));
		return entry;
	};

	for (const d of value(sources[0] as PromiseSettledResult<DailySummaryV2[]>)) {
		const entry = row(d.calendarDate);
		if (!entry) continue;
		Object.assign(
			entry,
			dropEmpty({
				resting_hr_bpm: d.heartRate?.restingValue,
				min_hr_bpm: d.heartRate?.minValue,
				max_hr_bpm: d.heartRate?.maxValue,
				steps: d.movement?.steps?.value,
				calories_kcal: d.calories?.burnedTotal,
				intensity_minutes: d.intensityMinutes ? dropEmpty({ moderate: d.intensityMinutes.moderate, vigorous: d.intensityMinutes.vigorous }) : null,
				stress: d.stress ? dropEmpty({ avg: d.stress.avgLevel, max: d.stress.maxLevel, qualifier: d.stress.qualifier }) : null,
				body_battery: d.bodyBattery
					? dropEmpty({
							min: d.bodyBattery.minValue,
							max: d.bodyBattery.maxValue,
							charged: d.bodyBattery.chargedValue,
							drained: d.bodyBattery.drainedValue,
							latest: d.bodyBattery.latestValue,
						})
					: null,
				avg_respiration_brpm: d.respiration?.avgValue,
				avg_spo2_pct: d.pulseOx?.avgValue,
			}),
		);
	}

	for (const s of value(sources[1] as PromiseSettledResult<SleepDay[]>)) {
		const entry = row(s.calendarDate);
		if (!entry || !s.sleepTimeSeconds) continue;
		entry.sleep = dropEmpty({
			duration_s: s.sleepTimeSeconds,
			nap_s: s.napTimeSeconds || null,
			deep_s: s.deepSleepSeconds,
			light_s: s.lightSleepSeconds,
			rem_s: s.remSleepSeconds,
			awake_s: s.awakeSleepSeconds,
			awake_count: s.awakeCount,
			score: s.sleepScores?.overall?.value,
			quality: s.sleepScores?.overall?.qualifierKey,
			start_utc: timestamp(s.sleepStartTimestampGMT),
			end_utc: timestamp(s.sleepEndTimestampGMT),
			avg_hr_bpm: round(s.avgHeartRate, 0),
			avg_spo2_pct: round(s.averageSpO2Value, 1),
			avg_respiration_brpm: round(s.averageRespirationValue, 1),
			avg_stress: round(s.avgSleepStress, 0),
		});
	}

	for (const h of value(sources[2] as PromiseSettledResult<HrvDay[]>)) {
		const entry = row(h.calendarDate);
		if (!entry) continue;
		entry.hrv = dropEmpty({
			last_night_avg_ms: h.lastNightAvg,
			last_night_5min_high_ms: h.lastNight5MinHigh,
			weekly_avg_ms: h.weeklyAvg,
			status: h.status,
			balanced_low_ms: h.baseline?.balancedLow,
			balanced_high_ms: h.baseline?.balancedUpper,
		});
	}

	const sorted = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
	const capped = capArray(sorted);
	return dropEmpty({
		count: capped.items.length,
		days: capped.items,
		warnings: warnings.length ? warnings : null,
		note: capped.dropped ? `Truncated to fit the response limit: the last ${capped.dropped} days were dropped. Request a shorter range.` : null,
	});
}

// ---- shared ----------------------------------------------------------------

/** Validates an inclusive range and returns its length in days. */
function assertRange(start: string, end: string): number {
	const from = Date.parse(start);
	const to = Date.parse(end);
	if (Number.isNaN(from) || Number.isNaN(to)) throw new ToolInputError("Dates must be real calendar dates in YYYY-MM-DD format.");
	if (to < from) throw new ToolInputError("end_date must not be before start_date.");
	return Math.round((to - from) / DAY_MS) + 1;
}

function capArray<T>(items: T[]): { items: T[]; dropped: number } {
	const budget = MAX_RESPONSE_CHARS - 500;
	let total = 2;
	for (let i = 0; i < items.length; i++) {
		total += JSON.stringify(items[i]).length + 1;
		if (total > budget) return { items: items.slice(0, i), dropped: items.length - i };
	}
	return { items, dropped: 0 };
}
