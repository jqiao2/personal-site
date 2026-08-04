import type { APIRoute } from 'astro';
import { requireOwner } from '../../../lib/auth';
import { updateBook } from '../../../lib/book-queries';
import { json, apiError } from '../../../lib/http';
import { getWork } from '../../../lib/openlibrary';
import { supabaseAdmin } from '../../../lib/supabase';

export const prerender = false;

// POST /api/books/to-read  { title, authors?, olKey?, pages?, year?, coverUrl? }
//   → (owner) a book on the to-read pile.
//
// The one thing PATCH /api/books/book cannot do: that route patches a row that
// already exists, and every book here reaches the database by being read. A book
// you intend to read has never been opened, so nothing has created it.
//
// Two ways in, and the difference between them is how much is known:
//
//   MATCHED. Picked out of Open Library, so it arrives with a cover, a page
//   count, a publication year, subjects and a blurb — the same payload the book
//   page's match dialog sends, because it is the same picker.
//
//   TYPED IN. A title and an author, because the book is not in Open Library or
//   is not worth the search. This is a permanent state, not a stub to be filled
//   in later: the pile renders it as its own kind of row.
//
// `md5` stays null either way. That is what makes this a book with no file, and
// it is why the Kindle cannot recognise it later without the merge in 0025.

interface Body {
	title?: unknown;
	authors?: unknown;
	olKey?: unknown;
	pages?: unknown;
	year?: unknown;
	coverUrl?: unknown;
}

function text(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t.length > 0 ? t : null;
}

export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await requireOwner(cookies))) return apiError('unauthorized', 401);

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		return apiError('expected JSON body', 400);
	}

	const title = text(body.title);
	if (!title) return apiError('title is required', 400);

	const authors = text(body.authors);
	const olKey = text(body.olKey);
	const now = new Date().toISOString();

	// A book already in the database keeps its row. The Open Library key is the
	// only identifier both sides can be sure of — matching on title would fold
	// together two books that share a name — so an unmatched add is always an
	// insert, and adding the same typed-in book twice is the owner's own doing.
	if (olKey) {
		const { data: existing, error } = await supabaseAdmin
			.from('books')
			.select('id, added_at, finished_at')
			.eq('ol_key', olKey)
			.limit(1)
			.maybeSingle();
		if (error) return apiError(`lookup failed: ${error.message}`, 500);

		if (existing) {
			// Putting a finished book back on the pile is a re-read, and clearing the
			// finish is not this route's decision to make: the book page has an
			// action for that and says what it is doing.
			await updateBook(existing.id as number, { added_at: now });
			return json({ ok: true, id: existing.id, existing: true });
		}
	}

	// The blurb and subjects need a second Open Library request; the picker's
	// result does not carry them. A work that 404s or times out still produces a
	// usable book — the cover, year and page count are already in hand.
	let work = {
		description: [] as string[],
		genres: [] as string[],
		kind: null as string | null,
		firstPublished: null as string | null,
	};
	if (olKey) {
		try {
			work = await getWork(olKey);
		} catch {
			// Metadata is a nice-to-have; the book is the point.
		}
	}

	const year = Number(body.year);
	const pages = Number(body.pages);
	// The picker asks Open Library for -M, which is right for a 38px thumbnail
	// and would be upscaled by the book page's 236px rail. Same image, same id.
	const cover = text(body.coverUrl)?.replace(/-M\.jpg$/, '-L.jpg') ?? null;

	const { data, error } = await supabaseAdmin
		.from('books')
		.insert({
			// md5 is null: this book is not a file. The unique index allows many
			// nulls, so the pile can hold as many unopened books as it likes.
			title,
			authors,
			added_at: now,
			ol_key: olKey,
			cover_url: cover,
			total_pages: Number.isInteger(pages) && pages > 0 ? pages : null,
			first_published: work.firstPublished ?? (Number.isFinite(year) ? String(year) : null),
			description: work.description,
			genres: work.genres,
			kind: work.kind,
		})
		.select('id')
		.single();

	if (error) return apiError(`could not add the book: ${error.message}`, 500);

	return json({ ok: true, id: data.id });
};
