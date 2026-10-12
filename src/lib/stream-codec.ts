// How `activity_streams` stores a stream (migration 0070). Each numeric stream
// is a fixed-point integer array of DELTAS: sample N holds round(v * scale)
// minus the previous non-null sample's. JSONB text (`[47.612345, ...]`) and raw
// floats both compress badly; consecutive deltas are small and repeat (time_s
// is almost all 1s), so Postgres' TOAST compression takes the table to about a
// third of its JSONB size. The scales are the precision `trimFloatNoise`
// already stores at, so packing loses nothing. A null sample stays null and
// does not reset the running sum.
//
// Plain functions, no imports: the seed script runs this under bare node.

/** Integer units per stored unit, per stream. latlng is split into lat/lng. */
export const STREAM_SCALE = {
	time_s: 1,
	lat: 1e6,
	lng: 1e6,
	altitude_m: 10,
	distance_m: 10,
	heartrate: 1,
	cadence: 1,
	power_w: 1,
	speed_ms: 100,
	temp_c: 10,
	grade: 100,
} as const;

type StreamKey = keyof typeof STREAM_SCALE;

type Samples = (number | null)[];

/** The stream arrays as callers see them: plain values, latlng as pairs. */
export interface PlainStreams {
	time_s?: number[] | null;
	latlng?: [number, number][] | null;
	altitude_m?: number[] | null;
	distance_m?: number[] | null;
	heartrate?: number[] | null;
	cadence?: number[] | null;
	power_w?: number[] | null;
	speed_ms?: number[] | null;
	temp_c?: number[] | null;
	grade?: number[] | null;
	moving?: boolean[] | null;
}

/** An `activity_streams` row minus its key: `<stream>_packed` int[] columns. */
export type PackedStreams = { [K in StreamKey as `${K}_packed`]: Samples | null } & {
	moving: boolean[] | null;
};

export function packSamples(values: Samples | null | undefined, scale: number): Samples | null {
	if (!values) return null;

	let prev = 0;

	return values.map((v) => {
		if (v === null || v === undefined || !Number.isFinite(v)) return null;

		const q = Math.round(v * scale);
		const d = q - prev;
		prev = q;

		return d;
	});
}

export function unpackSamples(deltas: Samples | null | undefined, scale: number): Samples | null {
	if (!deltas) return null;

	let acc = 0;

	return deltas.map((d) => (d === null ? null : (acc += d) / scale));
}

export function packStreams(s: PlainStreams): PackedStreams {
	const pairs = s.latlng ?? null;

	return {
		time_s_packed: packSamples(s.time_s, STREAM_SCALE.time_s),
		lat_packed: packSamples(pairs && pairs.map((p) => p?.[0] ?? null), STREAM_SCALE.lat),
		lng_packed: packSamples(pairs && pairs.map((p) => p?.[1] ?? null), STREAM_SCALE.lng),
		altitude_m_packed: packSamples(s.altitude_m, STREAM_SCALE.altitude_m),
		distance_m_packed: packSamples(s.distance_m, STREAM_SCALE.distance_m),
		heartrate_packed: packSamples(s.heartrate, STREAM_SCALE.heartrate),
		cadence_packed: packSamples(s.cadence, STREAM_SCALE.cadence),
		power_w_packed: packSamples(s.power_w, STREAM_SCALE.power_w),
		speed_ms_packed: packSamples(s.speed_ms, STREAM_SCALE.speed_ms),
		temp_c_packed: packSamples(s.temp_c, STREAM_SCALE.temp_c),
		grade_packed: packSamples(s.grade, STREAM_SCALE.grade),
		moving: s.moving ?? null,
	};
}

export function unpackStreams(row: PackedStreams): Required<PlainStreams> {
	// SAFETY: a decoded array holds null only where the source had a null
	// sample. The JSONB columns held the same nulls under this same number[]
	// type, so callers see exactly what they did before packing.
	const get = (key: StreamKey) => unpackSamples(row[`${key}_packed`], STREAM_SCALE[key]) as number[] | null;
	const lat = get('lat');
	const lng = get('lng');

	return {
		time_s: get('time_s'),
		latlng: lat && lng ? lat.map((v, i): [number, number] => [v, lng[i]]) : null,
		altitude_m: get('altitude_m'),
		distance_m: get('distance_m'),
		heartrate: get('heartrate'),
		cadence: get('cadence'),
		power_w: get('power_w'),
		speed_ms: get('speed_ms'),
		temp_c: get('temp_c'),
		grade: get('grade'),
		moving: row.moving,
	};
}
