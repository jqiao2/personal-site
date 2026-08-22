// Gear and its lifecycle — the queries behind /activities/gear and
// /activities/gear/:id. The arithmetic and the component vocabulary live in
// gear-wear.ts (pure, no DB client, so a plain-node test can import it); this
// module is the reads and writes, and re-exports that one so pages only ever
// import from here.
//
// Schema: supabase/migrations/0036_gear_lifecycle.sql. Reads go through the
// anon client (publicly readable, like the rest of the activity log); the
// writes take the service-role client and are only called after requireOwner()
// at the API-route layer — same convention as activities.ts's setFavoriteRank.
//
// WHY EVERY TOTAL HERE IS DERIVED. activity_gear.distance_m is a denormalised
// lifetime figure that 0034 keeps in sync on write. It cannot answer the only
// question a component has ("how far since it was fitted"), because it has no
// dates in it. Rather than run two sources of truth — a denormalised one for
// the gear and a derived one for its parts, which will disagree the first time
// an old ride is re-tagged — everything on these pages is summed from the
// activities themselves. PostgREST has no GROUP BY over a view, so the sum
// happens here in JS over a paged read, exactly as listActivityFacets does.
import { supabaseAdmin, supabasePublic } from './supabase';
import type { ActivityGear, GearKind } from './activities';
import {
	COMPONENT_ORDER,
	METERS_PER_MILE,
	sumRides,
	wearOf,
	type ComponentKind,
	type ComponentWear,
	type GearComponent,
	type GearRide,
	type GearUse,
} from './gear-wear';

export * from './gear-wear';

const PAGE = 1000;

// Mirrors activities.ts's isDegraded — a not-yet-applied 0036 must render an
// empty gear page, not a 500.
function isDegraded(err: { code?: string; message?: string } | null): boolean {
	if (!err) return false;
	const msg = (err.message ?? '').toLowerCase();
	return (
		err.code === '42703' ||
		err.code === 'PGRST204' ||
		err.code === '42P01' ||
		err.code === 'PGRST200' ||
		msg.includes('does not exist') ||
		msg.includes('schema cache')
	);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every activity that is tagged to some gear, bucketed by gear id. One paged
 * read for the whole index page; pass `gearId` to narrow it to one bike.
 *
 * Child legs are included on purpose (no `parent_id is null` filter, unlike
 * listActivityFacets): the bike leg of a triathlon put miles on the bike, and
 * a multisport parent carries the whole day's distance, so counting parents
 * would charge the bike for the swim.
 */
async function readRides(gearId?: number): Promise<Map<number, GearRide[]>> {
	const byGear = new Map<number, GearRide[]>();
	for (let offset = 0; ; offset += PAGE) {
		let req = supabasePublic
			.from('activity_list')
			.select('gear_id, local_date, distance_m, moving_seconds, elevation_gain_m')
			.not('gear_id', 'is', null);
		if (gearId != null) req = req.eq('gear_id', gearId);
		const { data, error } = await req.range(offset, offset + PAGE - 1);
		if (error) {
			if (isDegraded(error)) return byGear;
			throw new Error(`readRides failed: ${error.message}`);
		}
		const rows = (data ?? []) as (GearRide & { gear_id: number | null })[];
		for (const row of rows) {
			if (row.gear_id == null) continue;
			const list = byGear.get(row.gear_id) ?? [];
			list.push({
				local_date: row.local_date,
				distance_m: row.distance_m ?? 0,
				moving_seconds: row.moving_seconds ?? 0,
				elevation_gain_m: row.elevation_gain_m ?? 0,
			});
			byGear.set(row.gear_id, list);
		}
		if (rows.length < PAGE) break;
	}
	return byGear;
}

export interface GearWithUse extends ActivityGear {
	use: GearUse;
}

/** All gear with its real totals — the /activities/gear index. Active first
 * (that's listGearRows' order), each carrying what it has actually done. */
export async function listGearWithUse(): Promise<GearWithUse[]> {
	const [gear, rides] = await Promise.all([listGearRows(), readRides()]);
	return gear.map((g) => ({ ...g, use: sumRides(rides.get(g.id) ?? []) }));
}

/** activity_gear, active first then by kind/name. (activities.ts's listGear()
 * runs the same query; this copy exists so the gear pages don't pull in the
 * 1,000-line activities module for one select.) */
async function listGearRows(): Promise<ActivityGear[]> {
	const { data, error } = await supabasePublic
		.from('activity_gear')
		.select('*')
		.order('retired_at', { ascending: true, nullsFirst: true })
		.order('kind', { ascending: true })
		.order('name', { ascending: true });
	if (error) {
		if (isDegraded(error)) return [];
		throw new Error(`listGearRows failed: ${error.message}`);
	}
	return (data ?? []) as ActivityGear[];
}

export interface GearDetail {
	gear: ActivityGear;
	use: GearUse;
	/** Currently fitted, in COMPONENT_ORDER. */
	fitted: ComponentWear[];
	/** Removed parts, newest-installed first — the service history. */
	history: ComponentWear[];
}

/** One piece of gear, its totals, and its parts past and present. Null if
 * there's no such gear. */
export async function getGearDetail(id: number): Promise<GearDetail | null> {
	const [gearRes, componentsRes, ridesByGear] = await Promise.all([
		supabasePublic.from('activity_gear').select('*').eq('id', id).maybeSingle(),
		supabasePublic
			.from('gear_components')
			.select('*')
			.eq('gear_id', id)
			.order('installed_on', { ascending: false }),
		readRides(id),
	]);

	if (gearRes.error) {
		if (isDegraded(gearRes.error)) return null;
		throw new Error(`getGearDetail failed: ${gearRes.error.message}`);
	}
	if (!gearRes.data) return null;
	// A missing gear_components table (0036 not applied) shows the bike with an
	// empty parts list rather than a 500 — the totals above it are still true.
	if (componentsRes.error && !isDegraded(componentsRes.error)) {
		throw new Error(`getGearDetail components failed: ${componentsRes.error.message}`);
	}

	const gear = gearRes.data as ActivityGear;
	const rides = ridesByGear.get(id) ?? [];
	const components = ((componentsRes.data ?? []) as GearComponent[]).map((c) => wearOf(c, rides));

	const rank = (c: ComponentWear) => COMPONENT_ORDER.indexOf(c.component.kind);
	return {
		gear,
		use: sumRides(rides),
		fitted: components.filter((c) => !c.component.removed_on).sort((a, b) => rank(a) - rank(b)),
		history: components.filter((c) => c.component.removed_on),
	};
}

// ---------------------------------------------------------------------------
// Writes — owner only. The API route checks requireOwner() before calling.
// ---------------------------------------------------------------------------

export interface ComponentInput {
	gearId: number;
	kind: ComponentKind;
	label?: string | null;
	installedOn: string;
	removedOn?: string | null;
	baselineMiles?: number;
	condition?: string | null;
	notes?: string | null;
}

export async function createComponent(input: ComponentInput): Promise<number> {
	const { data, error } = await supabaseAdmin
		.from('gear_components')
		.insert({
			gear_id: input.gearId,
			kind: input.kind,
			label: input.label ?? null,
			installed_on: input.installedOn,
			removed_on: input.removedOn ?? null,
			baseline_distance_m: (input.baselineMiles ?? 0) * METERS_PER_MILE,
			condition: input.condition ?? null,
			notes: input.notes ?? null,
		})
		.select('id')
		.single();
	if (error) throw new Error(`createComponent failed: ${error.message}`);
	return (data as { id: number }).id;
}

/** Amend a component. Only the keys present are touched, so "mark replaced"
 * sends removedOn alone. */
export async function updateComponent(
	id: number,
	patch: Partial<Omit<ComponentInput, 'gearId'>>,
): Promise<void> {
	const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
	if ('kind' in patch) row.kind = patch.kind;
	if ('label' in patch) row.label = patch.label ?? null;
	if ('installedOn' in patch) row.installed_on = patch.installedOn;
	if ('removedOn' in patch) row.removed_on = patch.removedOn ?? null;
	if ('baselineMiles' in patch) row.baseline_distance_m = (patch.baselineMiles ?? 0) * METERS_PER_MILE;
	if ('condition' in patch) row.condition = patch.condition ?? null;
	if ('notes' in patch) row.notes = patch.notes ?? null;
	const { error } = await supabaseAdmin.from('gear_components').update(row).eq('id', id);
	if (error) throw new Error(`updateComponent failed: ${error.message}`);
}

/** Hard delete — for a row entered by mistake. Replacing a part is
 * updateComponent with removedOn, which is what keeps the history. */
export async function deleteComponent(id: number): Promise<void> {
	const { error } = await supabaseAdmin.from('gear_components').delete().eq('id', id);
	if (error) throw new Error(`deleteComponent failed: ${error.message}`);
}

export interface GearInput {
	kind?: GearKind;
	name?: string;
	brand?: string | null;
	model?: string | null;
	nickname?: string | null;
	firstUsedOn?: string | null;
	/** 'YYYY-MM-DD' to retire on that date, null to un-retire. */
	retiredOn?: string | null;
}

export async function createGear(input: GearInput & { kind: GearKind; name: string }): Promise<number> {
	const { data, error } = await supabaseAdmin
		.from('activity_gear')
		.insert(gearRow(input))
		.select('id')
		.single();
	if (error) throw new Error(`createGear failed: ${error.message}`);
	return (data as { id: number }).id;
}

export async function updateGear(id: number, patch: GearInput): Promise<void> {
	const { error } = await supabaseAdmin
		.from('activity_gear')
		.update({ ...gearRow(patch), updated_at: new Date().toISOString() })
		.eq('id', id);
	if (error) throw new Error(`updateGear failed: ${error.message}`);
}

function gearRow(input: GearInput): Record<string, unknown> {
	const row: Record<string, unknown> = {};
	if ('kind' in input) row.kind = input.kind;
	if ('name' in input) row.name = input.name;
	if ('brand' in input) row.brand = input.brand ?? null;
	if ('model' in input) row.model = input.model ?? null;
	if ('nickname' in input) row.nickname = input.nickname ?? null;
	if ('firstUsedOn' in input) row.first_used_on = input.firstUsedOn ?? null;
	// retired_at is a timestamptz from 0034 and a date everywhere it's said out
	// loud, so a date in becomes midnight UTC — the only reading that survives
	// the round trip back through retiredDate() unchanged.
	if ('retiredOn' in input) row.retired_at = input.retiredOn ? `${input.retiredOn}T00:00:00Z` : null;
	return row;
}
