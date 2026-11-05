/** Below this a pace is meaningless (standing still gives absurd values). */
const MIN_SPEED_FOR_PACE_MPS = 0.2;

export function round(value: number | null | undefined, digits: number): number | null {
	if (value === null || value === undefined || !Number.isFinite(value)) return null;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

/** Pace in decimal minutes per kilometre: 5.5 means 5:30/km. */
export function paceMinKm(speedMps: number | null | undefined): number | null {
	if (!speedMps || speedMps < MIN_SPEED_FOR_PACE_MPS) return null;
	return round(1000 / speedMps / 60, 2);
}

/** Pace as "m:ss" per kilometre. */
export function paceMmss(speedMps: number | null | undefined): string | null {
	if (!speedMps || speedMps < MIN_SPEED_FOR_PACE_MPS) return null;
	const total = Math.round(1000 / speedMps);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
