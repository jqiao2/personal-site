// Owner-only writes for gear and its components — everything /activities/gear
// and /activities/gear/:id can change, in one route.
//
// One file rather than four (gear create/patch, component create/patch/delete)
// because the bodies are small and the auth check is identical; `target` picks
// which of the two tables the call is about. Reads aren't here at all — the
// pages are server-rendered and query src/lib/gear.ts directly.
import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import {
	createComponent,
	createGear,
	deleteComponent,
	isComponentKind,
	updateComponent,
	updateGear,
	type ComponentInput,
	type GearInput,
} from '../../../lib/gear';
import type { GearKind } from '../../../lib/activities';

export const prerender = false;

const GEAR_KINDS: readonly GearKind[] = ['bike', 'shoes', 'skis', 'board', 'other'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A date field that is allowed to be cleared: a valid 'YYYY-MM-DD', or null.
 * Returns `undefined` for "the value is not acceptable" so the caller can tell
 * that apart from a deliberate null. */
function dateOrNull(v: unknown): string | null | undefined {
	if (v == null || v === '') return null;
	return typeof v === 'string' && DATE_RE.test(v) ? v : undefined;
}

/**
 * A replacement window: a two-element `[due, overdue]` array, or null to clear
 * the override. `undefined` means "not an acceptable value" so the caller can
 * tell that apart from a deliberate null — the same contract as dateOrNull.
 *
 * The DB has these rules too (0037's check constraints); repeating them here
 * turns a 500 with a constraint name in it into a sentence.
 */
function windowOrNull(v: unknown): [number, number] | null | undefined {
	if (v == null || (Array.isArray(v) && v.length === 0)) return null;
	if (!Array.isArray(v) || v.length !== 2) return undefined;
	const lo = Number(v[0]);
	const hi = Number(v[1]);
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined;
	if (!(lo > 0 && hi >= lo)) return undefined;
	return [Math.round(lo), Math.round(hi)];
}

function textOrNull(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const trimmed = v.trim();
	return trimmed === '' ? null : trimmed;
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
	try {
		return (await request.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// POST — create a piece of gear, or fit a component to one.
// { target: 'gear', kind, name, … } | { target: 'component', gearId, kind, installedOn, … }
export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const b = await body(request);
	if (!b) return apiError('expected JSON body', 400);

	try {
		if (b.target === 'gear') {
			const kind = b.kind as GearKind;
			if (!GEAR_KINDS.includes(kind)) return apiError('kind must be one of ' + GEAR_KINDS.join(', '), 400);
			const name = textOrNull(b.name);
			if (!name) return apiError('name is required', 400);
			const patch = gearPatch(b);
			if (patch instanceof Response) return patch;
			const id = await createGear({ ...patch, kind, name });
			return json({ id }, 201);
		}

		if (b.target === 'component') {
			const input = componentInput(b);
			if (input instanceof Response) return input;
			const id = await createComponent(input);
			return json({ id }, 201);
		}

		return apiError("target must be 'gear' or 'component'", 400);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to create', 500);
	}
};

// PATCH — amend gear or a component. Only the fields present are touched, so
// "mark replaced" is { target: 'component', id, removedOn: '2026-08-22' }.
export const PATCH: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const b = await body(request);
	if (!b) return apiError('expected JSON body', 400);

	const id = Number(b.id);
	if (!Number.isInteger(id) || id <= 0) return apiError('bad id', 400);

	try {
		if (b.target === 'gear') {
			const patch = gearPatch(b);
			if (patch instanceof Response) return patch;
			if ('kind' in b) {
				if (!GEAR_KINDS.includes(b.kind as GearKind)) return apiError('bad kind', 400);
				patch.kind = b.kind as GearKind;
			}
			if ('name' in b) {
				const name = textOrNull(b.name);
				if (!name) return apiError('name cannot be blank', 400);
				patch.name = name;
			}
			await updateGear(id, patch);
			return json({ ok: true });
		}

		if (b.target === 'component') {
			const patch: Partial<Omit<ComponentInput, 'gearId'>> = {};
			if ('kind' in b) {
				if (!isComponentKind(b.kind)) return apiError('bad component kind', 400);
				patch.kind = b.kind;
			}
			if ('label' in b) patch.label = textOrNull(b.label);
			if ('installedOn' in b) {
				const d = dateOrNull(b.installedOn);
				if (!d) return apiError('installedOn must be YYYY-MM-DD', 400);
				patch.installedOn = d;
			}
			if ('removedOn' in b) {
				const d = dateOrNull(b.removedOn);
				if (d === undefined) return apiError('removedOn must be YYYY-MM-DD or null', 400);
				patch.removedOn = d;
			}
			if ('baselineMiles' in b) {
				const mi = Number(b.baselineMiles ?? 0);
				if (!Number.isFinite(mi) || mi < 0) return apiError('baselineMiles must be a positive number', 400);
				patch.baselineMiles = mi;
			}
			if ('lifeMiles' in b) {
				const w = windowOrNull(b.lifeMiles);
				if (w === undefined) return apiError('lifeMiles must be [due, overdue] in order, or null', 400);
				patch.lifeMiles = w;
			}
			if ('lifeMonths' in b) {
				const w = windowOrNull(b.lifeMonths);
				if (w === undefined) return apiError('lifeMonths must be [due, overdue] in order, or null', 400);
				patch.lifeMonths = w;
			}
			if ('condition' in b) patch.condition = textOrNull(b.condition);
			if ('notes' in b) patch.notes = textOrNull(b.notes);
			await updateComponent(id, patch);
			return json({ ok: true });
		}

		return apiError("target must be 'gear' or 'component'", 400);
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to update', 500);
	}
};

// DELETE — remove a component row entered by mistake. Gear is never deleted
// here: activities point at it, and a bike you no longer own is retired, not
// erased. { target: 'component', id }
export const DELETE: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const b = await body(request);
	if (!b) return apiError('expected JSON body', 400);
	if (b.target !== 'component') return apiError('only components can be deleted', 400);
	const id = Number(b.id);
	if (!Number.isInteger(id) || id <= 0) return apiError('bad id', 400);
	try {
		await deleteComponent(id);
		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to delete', 500);
	}
};

/** The gear fields shared by create and amend. Returns a Response on a bad
 * date so the caller can hand it straight back. */
function gearPatch(b: Record<string, unknown>): GearInput | Response {
	const patch: GearInput = {};
	if ('brand' in b) patch.brand = textOrNull(b.brand);
	if ('model' in b) patch.model = textOrNull(b.model);
	if ('nickname' in b) patch.nickname = textOrNull(b.nickname);
	if ('firstUsedOn' in b) {
		const d = dateOrNull(b.firstUsedOn);
		if (d === undefined) return apiError('firstUsedOn must be YYYY-MM-DD or null', 400);
		patch.firstUsedOn = d;
	}
	if ('retiredOn' in b) {
		const d = dateOrNull(b.retiredOn);
		if (d === undefined) return apiError('retiredOn must be YYYY-MM-DD or null', 400);
		patch.retiredOn = d;
	}
	return patch;
}

/** A whole component from a create body. */
function componentInput(b: Record<string, unknown>): ComponentInput | Response {
	const gearId = Number(b.gearId);
	if (!Number.isInteger(gearId) || gearId <= 0) return apiError('bad gearId', 400);
	if (!isComponentKind(b.kind)) return apiError('bad component kind', 400);

	const installedOn = dateOrNull(b.installedOn);
	if (!installedOn) return apiError('installedOn must be YYYY-MM-DD', 400);
	const removedOn = dateOrNull(b.removedOn);
	if (removedOn === undefined) return apiError('removedOn must be YYYY-MM-DD or null', 400);
	// The DB has this check too (gear_components_dates_ordered); catching it
	// here turns a 500 with a constraint name in it into a sentence.
	if (removedOn && removedOn < installedOn) return apiError('removedOn is before installedOn', 400);

	const baselineMiles = Number(b.baselineMiles ?? 0);
	if (!Number.isFinite(baselineMiles) || baselineMiles < 0) {
		return apiError('baselineMiles must be a positive number', 400);
	}

	const lifeMiles = windowOrNull(b.lifeMiles);
	if (lifeMiles === undefined) return apiError('lifeMiles must be [due, overdue] in order, or null', 400);
	const lifeMonths = windowOrNull(b.lifeMonths);
	if (lifeMonths === undefined) return apiError('lifeMonths must be [due, overdue] in order, or null', 400);

	return {
		gearId,
		kind: b.kind,
		label: textOrNull(b.label),
		installedOn,
		removedOn,
		baselineMiles,
		lifeMiles,
		lifeMonths,
		condition: textOrNull(b.condition),
		notes: textOrNull(b.notes),
	};
}
