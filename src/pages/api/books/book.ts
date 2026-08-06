import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { getBook, mergeBook, updateBook } from '../../../lib/book-queries';
import { json, apiError } from '../../../lib/http';
import { getWork, lookupIsbn } from '../../../lib/openlibrary';

export const prerender = false;

// PATCH /api/books/book  { id, action, … }  → (owner) the six things about a
// book that are decisions rather than readings.
//
// Everything else on the page is derived from page turns. These are not:
//
//   to-read   put it on / take it off the pile
//   start     began it with nothing syncing, so no page turn will prove it
//   unstart   undo that
//   finish    call it done before the last page — endnotes, sources, appendices
//   unfinish  undo that
//   give-up   stop on purpose, which is not the same as drifting away from it
//   resume    undo that (a page turn does it too, and usually first)
//   private   hide it from the public shelf without losing the reading
//   match     link it to an Open Library work and fix the displayed title
//   isbn      the same, resolved from an ISBN — the stored one, or one sent
//   merge     the Kindle filed this book twice; fold its row into this one
//
// One route rather than ten: they are all a patch of one row, and the shapes
// differ only in which columns they null out. `merge` is the exception that
// proves it — it touches two rows and so hands off to SQL (migration 0025).

type Action =
	| 'to-read'
	| 'start'
	| 'unstart'
	| 'finish'
	| 'unfinish'
	| 'give-up'
	| 'resume'
	| 'private'
	| 'match'
	| 'isbn'
	| 'merge';

const ACTIONS: Action[] = [
	'to-read',
	'start',
	'unstart',
	'finish',
	'unfinish',
	'give-up',
	'resume',
	'private',
	'match',
	'isbn',
	'merge',
];

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
			case 'to-read': {
				// A toggle, so the current state decides. A book with sessions is
				// past the pile — the pile is for books that have not been opened.
				//
				// `addedAt` is the undo path: the pile page hands back the timestamp it
				// rendered, so putting a book back does not relabel a June intention as
				// today's. Owner-only and bounded to the past — a future date would
				// sort above everything and describe a decision not yet made.
				const restore = text(body.addedAt);
				const parsed = restore ? Date.parse(restore) : NaN;
				const addedAt =
					!book.added_at && Number.isFinite(parsed) && parsed <= Date.now()
						? new Date(parsed).toISOString()
						: now;
				await updateBook(id, { added_at: book.added_at ? null : addedAt });
				break;
			}

			case 'start':
				// A decision, like gave_up_at, and only meaningful while there are no
				// page turns: the first synced session answers the same question with
				// evidence, and book_manual_reads drops the book at that point.
				await updateBook(id, { started_at: now, gave_up_at: null });
				break;

			case 'unstart':
				await updateBook(id, { started_at: null });
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

			case 'merge': {
				const sourceId = Number(body.sourceId);
				if (!Number.isInteger(sourceId) || sourceId <= 0) {
					return apiError('sourceId is required', 400);
				}
				if (sourceId === id) return apiError('cannot merge a book into itself', 400);

				// Owner view: the source is a row the sync created and may well be
				// private. A missing one means the page is stale, not that anything is
				// wrong with the request.
				const source = await getBook(sourceId, true);
				if (!source) return apiError('source book not found', 404);

				await mergeBook(id, sourceId);
				break;
			}

			case 'isbn': {
				// The metadata a match gives, without the picker and without the
				// search endpoint — which is the point: Open Library's search is a
				// Solr cluster that falls over regularly, while the key lookups this
				// uses stay up through those outages.
				// An ISBN in the body replaces the stored one. The import records
				// whichever edition was logged, which is sometimes an audiobook or a
				// foreign printing that Open Library files somewhere else entirely —
				// so the number has to be correctable, and correcting it is the same
				// gesture as matching on it.
				const supplied = text(body.isbn);
				const isbn = supplied ? supplied.replace(/[^0-9Xx]/g, '').toUpperCase() : book.isbn;
				if (!isbn) return apiError('no ISBN on file for this book', 400);
				if (supplied && isbn.length !== 10 && isbn.length !== 13) {
					return apiError('an ISBN is 10 or 13 digits', 400);
				}

				let edition;
				try {
					edition = await lookupIsbn(isbn);
				} catch (e) {
					return apiError(e instanceof Error ? e.message : 'Open Library lookup failed', 502);
				}

				if (!edition) {
					// The number is still worth keeping: it is a fact about the book that
					// was just asserted by hand, and Open Library's catalogue grows. What
					// failed was the lookup, and the message says so rather than implying
					// the ISBN was rejected.
					if (supplied && isbn !== book.isbn) await updateBook(id, { isbn });
					return apiError('Open Library has no record of that ISBN', 404);
				}

				await updateBook(id, {
					...(isbn === book.isbn ? {} : { isbn }),
					ol_key: edition.key,
					// Titles are deliberately untouched. Open Library's are often
					// miscased ("The power broker: Robert Moses and the fall of New
					// York"), and the title already stored came either from a human or
					// from an export that had it right — neither is worth overwriting
					// automatically. The match dialog is where a title gets corrected.
					cover_url: edition.coverUrl,
					first_published: edition.firstPublished,
					description: edition.description,
					genres: edition.genres,
					kind: edition.kind,
					...(book.subtitle || !edition.subtitle ? {} : { subtitle: edition.subtitle }),
					// The printed length always; the working denominator only if absent.
					// See the note in `match` and migration 0026.
					...(edition.pages ? { ol_pages: edition.pages } : {}),
					...(book.total_pages || !edition.pages ? {} : { total_pages: edition.pages }),
				});
				break;
			}

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
					// Two page counts, two jobs. `ol_pages` is the printed edition's and
					// is what the spine is drawn from, so it is always refreshed;
					// `total_pages` is the denominator every percentage on the page is
					// measured against, so it is only ever filled when missing —
					// overwriting KOReader's with a median across editions would move
					// every number on the page at once (migration 0026).
					...(Number.isInteger(pages) && pages > 0 ? { ol_pages: pages } : {}),
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
