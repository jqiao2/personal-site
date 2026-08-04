import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { json, apiError } from '../../../lib/http';
import { searchBooks } from '../../../lib/openlibrary';

export const prerender = false;

// GET /api/reading/openlibrary?q=power+broker+caro → (owner) match candidates.
//
// Owner-only, though the data behind it is public: this is a proxy, and an open
// one would let anyone use the site to hammer a volunteer-run service.

export const GET: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	const q = (url.searchParams.get('q') ?? '').trim();
	if (q.length < 2) return json({ results: [] });

	try {
		return json({ results: await searchBooks(q) });
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'Open Library search failed', 502);
	}
};
