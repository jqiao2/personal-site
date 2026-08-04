import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { getBook, updateBook } from '../../../lib/book-queries';
import { json, apiError } from '../../../lib/http';
import { getWork } from '../../../lib/openlibrary';

export const prerender = false;

// PATCH /api/books/book  { id, action, … }  → (owner) the six things about a
// book that are decisions rather than readings.
//
// Everything else on the page is derived from page turns. These are not:
//
//   to-read   put it on / take it off the pile
//   finish    call it done before the last page — endnotes, sources, appendices
//   unfinish  undo that
//   give-up   stop on purpose, which is not the same as drifting away from it
//   resume    undo that (a page turn does it too, and usually first)
//   private   hide it from the public shelf without losing the reading
//   match     link it to an Open Library work and fix the displayed title
//
// One route rather than seven: they are all a patch of one row, and the shapes
// differ only in which columns they null out.

type Action = 'to-read' | 'finish' | 'unfinish' | 'give-up' | 'resume' | 'private' | 'match';

const ACTIONS: Action[] = ['to-read', 'finish', 'unfinish', 'give-up', 'resume', 'private', 'match'];

interface MatchBody {
	olKey?: unknown;
	title?: unknown;
	authors?: unknown;
	pages?: unknown;
	year?: unknown;
	coverUrl?: unknown;
}

function text(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t.length > 0 ? t : null;
}

export const PATCH: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return apiError('expected JSON body', 400);
	}

	const id = Number(body.id);
	if (!Number.isInteger(id) || id <= 0) return apiError('id is required', 400);

	const action = String(body.action ?? '') as Action;
	if (!ACTIONS.includes(action)) return apiError(`action must be one of ${ACTIONS.join(', ')}`, 400);

	// Owner view: a private book is still patchable by the person hiding it.
	const book = await getBook(id, true);
	if (!book) return apiError('book not found', 404);

	const now = new Date().toISOString();

	try {
		switch (action) {
			case 'to-read':
				// A toggle, so the current state decides. A book with sessions is
				// past the pile — the pile is for books that have not been opened.
				await updateBook(id, { added_at: book.added_at ? null : now });
				break;

			case 'finish':
				// finished_by_hand is what lets the page say "stopped at page 310 of
				// 604" rather than implying the last page was reached, and it is also
				// what makes the finish undoable: an automatic finish has nothing to
				// undo, it just recomputes.
				await updateBook(id, { finished_at: now, finished_by_hand: true, gave_up_at: null });
				break;

			case 'unfinish':
				await updateBook(id, { finished_at: null, finished_by_hand: false });
				break;

			case 'give-up':
				await updateBook(id, { gave_up_at: now, finished_at: null, finished_by_hand: false });
				break;

			case 'resume':
				await updateBook(id, { gave_up_at: null });
				break;

			case 'private':
				await updateBook(id, { is_public: !book.is_public });
				break;

			case 'match': {
				const m = body as MatchBody;
				const olKey = text(m.olKey);
				if (!olKey) return apiError('olKey is required', 400);

				// The blurb and subjects need a second request — search returns
				// neither. A work that 404s or times out still produces a usable
				// match: cover, page count and year are already in hand, and the page
				// renders the absences as omissions.
				let work = { description: [] as string[], genres: [] as string[], kind: null as string | null, firstPublished: null as string | null };
				try {
					work = await getWork(olKey);
				} catch {
					// Metadata is a nice-to-have; the link is the point.
				}

				const year = Number(m.year);
				const pages = Number(m.pages);
				const title = text(m.title);

				// The picker asks for -M, which is 180px wide and right for a 38px
				// thumbnail. The rail renders the cover at 236 and would upscale it,
				// so the size stored is the large one. Same image, same id — Open
				// Library serves the variants off one path.
				const cover = text(m.coverUrl)?.replace(/-M\.jpg$/, '-L.jpg') ?? null;

				await updateBook(id, {
					ol_key: olKey,
					// display_* rather than title/authors: sync overwrites those on
					// every push (0022), and this correction has to survive it.
					display_title: title,
					display_authors: text(m.authors),
					cover_url: cover,
					first_published: work.firstPublished ?? (Number.isFinite(year) ? String(year) : null),
					description: work.description,
					genres: work.genres,
					kind: work.kind,
					// Only fill a page count we don't have. KOReader's is the one the
					// progress bar is measured against, and Open Library's median
					// across editions would silently move every percentage on the page.
					...(book.total_pages || !Number.isInteger(pages) || pages <= 0 ? {} : { total_pages: pages }),
				});
				break;
			}
		}
	} catch (e) {
		return apiError(e instanceof Error ? e.message : 'update failed', 500);
	}

	return json({ ok: true });
};
