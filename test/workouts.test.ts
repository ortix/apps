import { describe, expect, it } from "vitest";
import { compactWorkouts, compactZones } from "../src/workouts";

describe("compactWorkouts", () => {
	it("decodes an interval workout with repeats and every target encoding", () => {
		const [workout] = compactWorkouts([
			{
				workoutName: "6x800m",
				sport: "RUNNING",
				workoutPhrase: "VO2MAX_INTERVALS",
				steps: [
					{ stepIndex: 0, intensity: "WARMUP", durationType: "TIME", durationValue: 600, targetType: "HEART_RATE", targetValue: 2 },
					{ stepIndex: 1, intensity: "ACTIVE", durationType: "DISTANCE", durationValue: 800, targetType: "SPEED", targetValue: 0, targetValueLow: 4, targetValueHigh: 4.3478 },
					{ stepIndex: 2, intensity: "RECOVERY", durationType: "HR_LESS_THAN", durationValue: 230, targetType: "OPEN" },
					{ stepIndex: 3, durationType: "REPEAT_UNTIL_STEPS_CMPLT", durationValue: 1, targetValue: 6 },
					{ stepIndex: 4, intensity: "ACTIVE", durationType: "TIME", durationValue: 300, targetType: "HEART_RATE", targetValue: 0, targetValueLow: 250, targetValueHigh: 270 },
					{ stepIndex: 5, intensity: "ACTIVE", durationType: "TIME", durationValue: 300, targetType: "POWER", targetValue: 0, targetValueLow: 1250, targetValueHigh: 95 },
					{ stepIndex: 6, intensity: "COOLDOWN", durationType: "OPEN", notes: "  easy  " },
				],
			},
		]) ?? [];

		expect(workout).toMatchObject({ name: "6x800m", sport: "running", coaching_phrase: "VO2MAX_INTERVALS" });
		const steps = workout?.steps ?? [];
		expect(steps[0]).toEqual({ step: 0, intensity: "warmup", duration_s: 600, target: { type: "heart_rate", zone: 2 } });
		expect(steps[1]).toMatchObject({ distance_m: 800, target: { type: "speed", low_mps: 4, high_mps: 4.35, pace_range: "3:50-4:10 /km" } });
		expect(steps[2]).toEqual({ step: 2, intensity: "recovery", until: "heart rate below", until_bpm: 130 });
		expect(steps[3]).toEqual({ step: 3, repeat_from_step: 1, times: 6 });
		expect(steps[4]).toMatchObject({ target: { type: "heart_rate", low_bpm: 150, high_bpm: 170 } });
		expect(steps[5]).toMatchObject({ target: { type: "power", low_watts: 250, high_pct_ftp: 95 } });
		expect(steps[6]).toEqual({ step: 6, intensity: "cooldown", duration: "open (lap button)", notes: "easy" });
	});

	it("returns null when no workout was used", () => {
		expect(compactWorkouts([])).toBeNull();
		expect(compactWorkouts(null)).toBeNull();
	});
});

describe("compactZones", () => {
	it("turns floors into ranges ending at max HR", () => {
		const [zones] = compactZones([
			{ sport: "DEFAULT", trainingMethod: "LACTATE_THRESHOLD", maxHeartRateUsed: 190, restingHeartRateUsed: 48, lactateThresholdHeartRateUsed: 170, zone1Floor: 110, zone2Floor: 135, zone3Floor: 150, zone4Floor: 162, zone5Floor: 172 },
		]);
		expect(zones).toMatchObject({ sport: "default", method: "lactate_threshold", max_hr_bpm: 190, lactate_threshold_hr_bpm: 170 });
		expect(zones?.zones?.[0]).toEqual({ zone: 1, from_bpm: 110, to_bpm: 135 });
		expect(zones?.zones?.[4]).toEqual({ zone: 5, from_bpm: 172, to_bpm: 190 });
	});
});
