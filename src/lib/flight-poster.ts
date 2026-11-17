// The flight poster's settings and status, as the admin page shows them. Pure:
// the database side is flight-poster-db.ts.
//
// `PosterConfig` is the behaviour half of the board's config.json, in the same
// shape, so the board feeds the site's reply straight into its own parser
// (parseConfig in jqiao2/flight-poster src/config.cpp). Field names must stay
// in step with that file, and the defaults with its config.example.json.
import { z } from 'astro/zod';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A stored config: every field optional, missing ones filled with the board's defaults. */
export const posterConfig = z.object({
	home: z
		.object({
			lat: z.number().min(-90).max(90).default(40.754),
			lon: z.number().min(-180).max(180).default(-74.002),
			radius_nm: z.number().int().min(1).max(250).default(25),
		})
		.prefault({}),
	active_hours: z
		.object({
			start: z.string().regex(HHMM).default('07:00'),
			end: z.string().regex(HHMM).default('23:00'),
		})
		.prefault({}),
	poll_minutes: z.number().int().min(1).max(120).default(5),
	min_hold_minutes: z.number().int().min(0).max(1440).default(60),
	filter: z
		.object({
			min_altitude_ft: z.number().int().min(0).max(50000).default(1500),
			airline_callsigns_only: z.boolean().default(true),
			drop_categories: z.array(z.string()).default(['A1', 'A7', 'B1', 'B2', 'B3', 'B4', 'B6', 'B7', 'C1', 'C2', 'C3']),
			exclude_callsign_prefixes: z.array(z.string()).default(['EJA', 'LXJ', 'VJA']),
		})
		.prefault({}),
	selection: z
		.object({
			distance_exponent: z.number().min(0).max(4).default(1),
			min_distance_km: z.number().int().min(0).max(20000).default(150),
			prefer_cities_with_posters: z.boolean().default(true),
		})
		.prefault({}),
	use_fallback_posters: z.boolean().default(false),
});

export type PosterConfig = z.infer<typeof posterConfig>;

export const DEFAULT_CONFIG: PosterConfig = posterConfig.parse({});

// The settings form posts flat strings; an unticked checkbox is simply absent.
const num = (min: number, max: number) =>
	z.string().trim().min(1, 'required').pipe(z.coerce.number<string>().min(min).max(max));

const int = (min: number, max: number) => num(min, max).transform(Math.round);

const box = z
	.string()
	.optional()
	.transform((v) => v !== undefined);

const codes = z
	.string()
	.default('')
	.transform((s) =>
		s
			.split(/[\s,]+/)
			.map((c) => c.toUpperCase())
			.filter(Boolean),
	);

const configForm = z
	.object({
		lat: num(-90, 90),
		lon: num(-180, 180),
		radius_nm: int(1, 250),
		start: z.string().regex(HHMM, 'must be HH:MM'),
		end: z.string().regex(HHMM, 'must be HH:MM'),
		poll_minutes: int(1, 120),
		min_hold_minutes: int(0, 1440),
		min_altitude_ft: int(0, 50000),
		airline_callsigns_only: box,
		drop_categories: codes,
		exclude_callsign_prefixes: codes,
		distance_exponent: num(0, 4),
		min_distance_km: int(0, 20000),
		prefer_cities_with_posters: box,
		use_fallback_posters: box,
	})
	.transform(
		(f): PosterConfig => ({
			home: { lat: f.lat, lon: f.lon, radius_nm: f.radius_nm },
			active_hours: { start: f.start, end: f.end },
			poll_minutes: f.poll_minutes,
			min_hold_minutes: f.min_hold_minutes,
			filter: {
				min_altitude_ft: f.min_altitude_ft,
				airline_callsigns_only: f.airline_callsigns_only,
				drop_categories: f.drop_categories,
				exclude_callsign_prefixes: f.exclude_callsign_prefixes,
			},
			selection: {
				distance_exponent: f.distance_exponent,
				min_distance_km: f.min_distance_km,
				prefer_cities_with_posters: f.prefer_cities_with_posters,
			},
			use_fallback_posters: f.use_fallback_posters,
		}),
	);

/** Read the settings form; a failure names the first bad field. */
export function parseConfigForm(form: FormData): { config: PosterConfig } | { error: string } {
	const r = configForm.safeParse(Object.fromEntries(form));

	if (r.success) return { config: r.data };
	const [issue] = r.error.issues;

	return { error: `${issue.path.join('.')}: ${issue.message}` };
}

const city = z.object({ slug: z.string(), name: z.string() });

export type PosterCity = z.infer<typeof city>;

/** What the board reports (App::statusJson). Loose: unread fields are kept and stored. */
const boardStatus = z.looseObject({
	firmware: z.string().optional(),
	sd_mounted: z.boolean().optional(),
	index_error: z.string().optional(),
	last_api_error: z.string().optional(),
	wifi: z.looseObject({ rssi: z.number().optional() }).optional(),
	current: z
		.looseObject({
			slug: z.string().optional(),
			name: z.string().optional(),
			shown_at: z.number().optional(),
			flight: z
				.looseObject({
					callsign: z.string().optional(),
					airline: z.string().optional(),
					type: z.string().optional(),
					alt_ft: z.number().optional(),
					origin: z.string().optional(),
					origin_city: z.string().optional(),
					destination: z.string().optional(),
					dest_city: z.string().optional(),
					distance_km: z.number().optional(),
					manual: z.boolean().optional(),
				})
				.optional(),
		})
		.optional(),
	log: z.array(z.looseObject({ at: z.number(), text: z.string() })).optional(),
});

export type BoardStatus = z.infer<typeof boardStatus>;

/** The board's sync body. A malformed city is dropped rather than failing the sync. */
export const syncBody = z.object({
	status: boardStatus,
	cities: z.array(z.unknown()).transform((list) =>
		list.flatMap((c) => {
			const r = city.safeParse(c);

			return r.success ? [r.data] : [];
		}),
	),
});

/** The one row of `flight_poster`, as read back from the database. */
export const posterRow = z.object({
	config: posterConfig,
	pending_show: z.string().nullable(),
	status: boardStatus.nullable(),
	cities: z.array(city),
	synced_at: z.string().nullable(),
});

export type PosterRow = z.infer<typeof posterRow>;

const clock = new Intl.DateTimeFormat('en-US', {
	timeZone: 'America/New_York',
	month: 'short',
	day: 'numeric',
	hour: 'numeric',
	minute: '2-digit',
});

/** Unix seconds (the board's clock) → "Nov 16, 3:04 PM" in New York. */
export function boardTime(unix: number | undefined): string {
	return unix ? clock.format(unix * 1000) : '—';
}

function ago(ms: number): string {
	const min = Math.round(ms / 60000);

	if (min < 1) return 'just now';

	if (min < 90) return `${min} min ago`;

	const h = Math.round(min / 60);

	return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export function adminView(row: PosterRow, now = Date.now()) {
	const status = row.status ?? {};

	const synced = row.synced_at ? Date.parse(row.synced_at) : null;

	const cur = status.current;

	const pendingCity = row.cities.find((c) => c.slug === row.pending_show);

	return {
		config: row.config,
		/** Never heard from the board: the page leads with setup. */
		unsetup: synced === null,
		/** Heard from, but not within three polls. */
		offline: synced !== null && now - synced > 3 * row.config.poll_minutes * 60000,
		syncedAgo: synced === null ? 'never' : ago(now - synced),
		status,
		current: cur?.name
			? { slug: cur.slug ?? '', name: cur.name, shownAt: boardTime(cur.shown_at), flight: cur.flight ?? null }
			: null,
		cities: row.cities.map((c) => ({ ...c, current: c.slug === cur?.slug, pending: c.slug === row.pending_show })),
		pending: row.pending_show ? (pendingCity?.name ?? row.pending_show) : null,
	};
}
