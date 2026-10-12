// "Paradiso" button — owner only. Paradiso keys films by its own id, so this
// searches its API by title, picks the candidate whose tmdb_id is ours, and
// redirects to paradiso-film.app/movies/<id>. That domain is a universal link
// (its AASA matches every path), so on iPhone/iPad the tap opens the app.
// Resolved on click, not on the movie page's render, to keep that render free
// of two extra round trips. No match → Paradiso's own NYC page.
import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { apiError } from '../../../lib/http';

export const prerender = false;

const API = 'https://api.paradiso-film.app/api';

const NYC_IDS = '2215,29956,24738,4370,4026,30301'; // from /api/cities, short "NYC"

const APP = 'https://paradiso-film.app';

type Suggestion = { id: string; type: string };

async function getJson<T>(url: string): Promise<T | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(4000) });

		return res.ok ? await res.json() : null; // untyped JSON; callers only read optional fields
	} catch {
		return null;
	}
}

export const GET: APIRoute = async ({ url, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);
	const tmdb = url.searchParams.get('tmdb') ?? '';
	const title = url.searchParams.get('title') ?? '';
	const query = new URLSearchParams({ query: title, city_ids: NYC_IDS, limit: '10' });

	const hits = (await getJson<Suggestion[]>(`${API}/search/autocomplete?${query}`)) ?? [];

	const ids = hits.filter((h) => h.type === 'movie').map((h) => h.id);

	const movies = await Promise.all(
		ids.map((id) => getJson<{ id: string; tmdb_id?: string }>(`${API}/v2/movies/${id}`)),
	);

	const match = movies.find((m) => m?.tmdb_id === tmdb);

	const location = match ? `${APP}/movies/${match.id}?city=NYC` : `${APP}/?city=NYC`;

	return new Response(null, { status: 302, headers: { location } });
};
