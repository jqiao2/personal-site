import type { APIRoute } from 'astro';
import { z } from 'astro/zod';
import { supabaseAdmin } from '../../../lib/supabase';
import { cleanListQuery, nextPosition } from '../../../lib/film-lists';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';

export const prerender = false;

// POST   /api/films/lists { name, description?, query? }      → (owner) create; a query makes it smart.
// PATCH  /api/films/lists { id, name?, description?, query? } → (owner) edit one list.
// PATCH  /api/films/lists { order: [id, …] }                  → (owner) reorder the lists.
// DELETE /api/films/lists?id=1                                → (owner) delete a list and its items.

const id = z.coerce.number().int().positive();

const name = z.string().trim().min(1).max(200);

// A blank description clears it; a query string is stored without paging params.
const description = z
	.string()
	.nullable()
	.transform((d) => d?.trim() || null);

const query = z
	.string()
	.nullable()
	.transform((q) => (q == null ? null : cleanListQuery(q)));

const create = z.object({ name, description: description.optional(), query: query.optional() });

const edit = z.object({ id, name: name.optional(), description: description.optional(), query: query.optional() });

const reorder = z.object({ order: z.array(id).max(1000) });

export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const b = create.safeParse(await request.json().catch(() => null));

	if (!b.success) return apiError('expected { name, description?, query? }', 400);

	const { data, error } = await supabaseAdmin
		.from('film_lists')
		.insert({ ...b.data, position: await nextPosition('film_lists') })
		.select('id')
		.single();

	if (error) return apiError(error.message, 500);

	return json({ id: data.id }, 201);
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const raw = await request.json().catch(() => null);
	const order = reorder.safeParse(raw);

	if (order.success) {
		// ponytail: one update per list; fine for tens of lists.
		const results = await Promise.all(
			order.data.order.map((listId, position) =>
				supabaseAdmin.from('film_lists').update({ position }).eq('id', listId),
			),
		);

		const failed = results.find((r) => r.error);

		if (failed?.error) return apiError(failed.error.message, 500);

		return json({ ok: true });
	}

	const b = edit.safeParse(raw);

	if (!b.success) return apiError('expected { id, name?, description?, query? } or { order }', 400);
	const { id: listId, ...row } = b.data;

	const { data, error } = await supabaseAdmin
		.from('film_lists')
		.update({ ...row, updated_at: new Date().toISOString() })
		.eq('id', listId)
		.select('id')
		.maybeSingle();

	if (error) return apiError(error.message, 500);

	if (!data) return apiError('no such list', 404);

	return json({ ok: true });
};

export const DELETE: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const b = id.safeParse(url.searchParams.get('id'));

	if (!b.success) return apiError('id is required', 400);

	const { data, error } = await supabaseAdmin.from('film_lists').delete().eq('id', b.data).select('id').maybeSingle();

	if (error) return apiError(error.message, 500);

	if (!data) return apiError('no such list', 404);

	return json({ ok: true });
};
