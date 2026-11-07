/**
 * Decodes Garmin's compact workout and heart-rate-zone formats into plain units.
 * Encodings follow Garmin's Personal API reference (WorkoutStepDTO):
 * heart rate is % of max HR, or bpm + 100; power is % of FTP, or watts + 1000;
 * a non-zero targetValue selects a zone instead of a custom range.
 */
import { dropEmpty } from "./garmin/fit";
import { paceMmss, round } from "./units";

export interface WorkoutStepRaw {
	stepIndex?: number;
	name?: string | null;
	intensity?: string | null;
	durationType?: string | null;
	durationValue?: number | null;
	targetType?: string | null;
	targetValue?: number | null;
	targetValueLow?: number | null;
	targetValueHigh?: number | null;
	notes?: string | null;
	exerciseCategory?: string | null;
	exerciseName?: string | null;
	exerciseWeightValue?: number | null;
}

export interface ActivityWorkoutRaw {
	index?: number;
	workoutName?: string | null;
	sport?: string | null;
	workoutPhrase?: string | null;
	steps?: WorkoutStepRaw[];
}

export interface HeartRateZonesRaw {
	sport?: string;
	trainingMethod?: string;
	restingHeartRateUsed?: number;
	lactateThresholdHeartRateUsed?: number;
	maxHeartRateUsed?: number;
	zone1Floor?: number;
	zone2Floor?: number;
	zone3Floor?: number;
	zone4Floor?: number;
	zone5Floor?: number;
}

const MAX_NOTE_CHARS = 300;
const lower = (value: string | null | undefined) => (value ? value.toLowerCase() : null);

/** Heart rate: values above 100 are bpm + 100, otherwise % of max HR. */
function heartRate(value: number | null | undefined): { bpm?: number; pct_max_hr?: number } | null {
	if (value === null || value === undefined) return null;
	return value > 100 ? { bpm: value - 100 } : { pct_max_hr: value };
}

/** Power: values above 1000 are watts + 1000, otherwise % of FTP. */
function power(value: number | null | undefined): { watts?: number; pct_ftp?: number } | null {
	if (value === null || value === undefined) return null;
	return value > 1000 ? { watts: value - 1000 } : { pct_ftp: value };
}

function prefixed<T extends Record<string, number | undefined>>(prefix: string, value: T | null): Record<string, number> {
	if (!value) return {};
	return Object.fromEntries(Object.entries(value).map(([k, v]) => [`${prefix}_${k}`, v as number]));
}

function decodeDuration(step: WorkoutStepRaw): Record<string, unknown> {
	const value = step.durationValue ?? null;
	switch (step.durationType) {
		case "TIME":
			return { duration_s: value };
		case "DISTANCE":
			return { distance_m: value };
		case "REPS":
			return { reps: value };
		case "CALORIES":
			return { calories_kcal: value };
		case "HR_LESS_THAN":
			return { until: "heart rate below", ...prefixed("until", heartRate(value)) };
		case "HR_GREATER_THAN":
			return { until: "heart rate above", ...prefixed("until", heartRate(value)) };
		case "POWER_LESS_THAN":
			return { until: "power below", ...prefixed("until", power(value)) };
		case "POWER_GREATER_THAN":
			return { until: "power above", ...prefixed("until", power(value)) };
		case "OPEN":
			return { duration: "open (lap button)" };
		default:
			return { duration_type: lower(step.durationType), duration_value: value };
	}
}

function decodeTarget(step: WorkoutStepRaw): Record<string, unknown> | null {
	const type = step.targetType;
	if (!type || type === "OPEN") return null;
	const zone = step.targetValue ? step.targetValue : null;
	const low = step.targetValueLow ?? null;
	const high = step.targetValueHigh ?? null;
	if (zone) return { type: lower(type), zone };

	switch (type) {
		case "HEART_RATE":
			return { type: "heart_rate", ...prefixed("low", heartRate(low)), ...prefixed("high", heartRate(high)) };
		case "POWER":
			return { type: "power", ...prefixed("low", power(low)), ...prefixed("high", power(high)) };
		case "SPEED":
			// The lower speed is the slower pace, so the pace range runs high-to-low speed.
			return dropEmpty({
				type: "speed",
				low_mps: round(low, 2),
				high_mps: round(high, 2),
				pace_range: low && high ? `${paceMmss(high)}-${paceMmss(low)} /km` : null,
			});
		case "CADENCE":
			return { type: "cadence", low, high };
		default:
			return { type: lower(type), low, high };
	}
}

function decodeStep(step: WorkoutStepRaw) {
	const type = step.durationType ?? "";
	if (type.startsWith("REPEAT_UNTIL")) {
		// For repeats, durationValue names the step to go back to and targetValue the count or limit.
		return dropEmpty({
			step: step.stepIndex,
			repeat_from_step: step.durationValue,
			times: type === "REPEAT_UNTIL_STEPS_CMPLT" ? step.targetValue : null,
			until: type === "REPEAT_UNTIL_STEPS_CMPLT" ? null : `${lower(type.replace("REPEAT_UNTIL_", ""))} ${step.targetValue ?? ""}`.trim(),
		});
	}
	return dropEmpty({
		step: step.stepIndex,
		name: step.name?.trim() || null,
		intensity: lower(step.intensity),
		...decodeDuration(step),
		target: decodeTarget(step),
		exercise: step.exerciseName ? lower(step.exerciseName) : lower(step.exerciseCategory),
		weight_kg: step.exerciseWeightValue,
		notes: step.notes?.trim() ? step.notes.trim().slice(0, MAX_NOTE_CHARS) : null,
	});
}

export function compactWorkouts(raw: ActivityWorkoutRaw[] | null) {
	if (!raw?.length) return null;
	return raw.map((workout) =>
		dropEmpty({
			name: workout.workoutName,
			sport: lower(workout.sport),
			coaching_phrase: workout.workoutPhrase,
			steps: (workout.steps ?? []).map(decodeStep),
		}),
	);
}

/** Each zone runs from its floor up to the next zone's floor; zone 5 ends at max HR. */
export function compactZones(raw: HeartRateZonesRaw[] | null) {
	return (raw ?? []).map((z) => {
		const floors = [z.zone1Floor, z.zone2Floor, z.zone3Floor, z.zone4Floor, z.zone5Floor];
		return dropEmpty({
			sport: lower(z.sport),
			method: lower(z.trainingMethod),
			max_hr_bpm: z.maxHeartRateUsed,
			resting_hr_bpm: z.restingHeartRateUsed,
			lactate_threshold_hr_bpm: z.lactateThresholdHeartRateUsed,
			zones: floors.map((floor, i) =>
				dropEmpty({
					zone: i + 1,
					from_bpm: floor,
					to_bpm: i < 4 ? floors[i + 1] : z.maxHeartRateUsed,
				}),
			),
		});
	});
}
