import type { APIRoute } from 'astro';
import { z } from 'astro/zod';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import { getMarks, replaceMarks, setMark } from '../../../lib/subway-log';

export const prerender = false;

// GET  /api/subway/log                          → (owner) { st: [...], seg: [...] }
// POST /api/subway/log { kind, ref, on }        → (owner) mark or unmark one
// PUT  /api/subway/log { st: [...], seg: [...] } → (owner) replace the whole log

const ref = z.string().min(1).max(63);

const one = z.object({ kind: z.enum(['station', 'segment']), ref, on: z.boolean() });

// the network has ~1,200 ids; anything much bigger is not a log
const all = z.object({ st: z.array(ref).max(5000), seg: z.array(ref).max(5000) });

export const GET: APIRoute = async ({ cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	try {
		return json(await getMarks(), 200, { 'cache-control': 'no-store' });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to load', 500);
	}
};

export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const b = one.safeParse(await request.json().catch(() => null));

	if (!b.success) return apiError('expected { kind: "station" | "segment", ref, on }', 400);

	try {
		await setMark(b.data.kind, b.data.ref, b.data.on);

		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to save', 500);
	}
};

export const PUT: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const b = all.safeParse(await request.json().catch(() => null));

	if (!b.success) return apiError('expected { st: string[], seg: string[] }', 400);

	try {
		await replaceMarks(b.data);

		return json({ ok: true });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'failed to save', 500);
	}
};
