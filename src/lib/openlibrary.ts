// Open Library, which is where a book's cover, blurb, page count and subjects
// come from. Films have TMDB; this is the shelf's equivalent, with one large
// difference: it is never called automatically.
//
// KOReader derives its metadata from the EPUB, which for a sideloaded file
// means the filename — "Martian_ A Novel, The - Andy Weir" (see migration
// 0022). Searching that string returns either nothing or the wrong book, and a
// wrong cover is worse than no cover, so matching is a thing the owner does by
// hand from the book's own page and this module only ever answers questions the
// owner asked.
//
// No API key, no rate limit worth the name, but it is a volunteer-run service:
// requests carry a User-Agent identifying the site, which is what their docs
// ask for.
const UA = 'jqiao-personal-site/1.0 (reading log; https://jqiao.vercel.app)';

/** How many subjects to keep. Open Library returns dozens, most of them noise. */
const MAX_GENRES = 4;

export interface OpenLibraryMatch {
	/** Work key, "/works/OL45804W". The identifier we store. */
	key: string;
	title: string;
	author: string;
	year: number | null;
	pages: number | null;
	coverUrl: string | null;
}

export interface OpenLibraryWork {
	description: string[];
	genres: string[];
	kind: 'Fiction' | 'Nonfiction' | null;
	firstPublished: string | null;
	/** Cover image id, for a work whose editions have none of their own. */
	coverId: number | null;
}

/**
 * Everything a match needs, resolved from an ISBN alone.
 *
 * The same payload the picker produces, assembled without ever asking the
 * search endpoint — which matters more than it sounds. Open Library's search is
 * a Solr cluster that falls over regularly (503 "No server is available"), while
 * `/isbn/…` and `/works/…` are key lookups against a different backend that
 * stays up through it. A book with an ISBN never needs the flaky half.
 */
export interface OpenLibraryEdition {
	/** Work key, the identifier stored on the book. */
	key: string;
	title: string;
	subtitle: string | null;
	pages: number | null;
	coverUrl: string | null;
	firstPublished: string | null;
	description: string[];
	genres: string[];
	kind: 'Fiction' | 'Nonfiction' | null;
}

/**
 * How long to wait before giving up on Open Library.
 *
 * Not a nicety: a search that hangs never resolves, and the caller on the other
 * end is a picker with a spinner in it. Observed in the wild — the same query
 * that 503s in a second one minute will hold the connection open indefinitely
 * the next. Better a clean failure the UI can offer to type around.
 */
const TIMEOUT_MS = 8000;

async function getJson(url: string): Promise<unknown> {
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { accept: 'application/json', 'user-agent': UA },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (e) {
		// TimeoutError is what an aborted signal raises; anything else is DNS or a
		// dropped connection. They read the same to a caller: no answer.
		throw new Error(
			e instanceof Error && e.name === 'TimeoutError'
				? `Open Library did not answer within ${TIMEOUT_MS / 1000}s`
				: 'Open Library could not be reached',
		);
	}
	if (!res.ok) throw new Error(`Open Library returned ${res.status}`);
	return res.json();
}

/**
 * Search works by title and author.
 *
 * The fields list is not an optimisation: the default response is enormous, and
 * `number_of_pages_median` and `first_publish_year` are the two values that let
 * you tell a 1974 original from a 1998 reissue in the picker.
 */
export async function searchBooks(query: string, limit = 8): Promise<OpenLibraryMatch[]> {
	const params = new URLSearchParams({
		q: query,
		fields: 'key,title,author_name,first_publish_year,number_of_pages_median,cover_i',
		limit: String(limit),
	});
	const data = (await getJson(`https://openlibrary.org/search.json?${params}`)) as {
		docs?: Record<string, unknown>[];
	};

	return (data.docs ?? []).map((doc) => ({
		key: String(doc.key ?? ''),
		title: String(doc.title ?? 'Untitled'),
		author: Array.isArray(doc.author_name) ? (doc.author_name as string[]).join(' & ') : '',
		year: typeof doc.first_publish_year === 'number' ? doc.first_publish_year : null,
		pages: typeof doc.number_of_pages_median === 'number' ? doc.number_of_pages_median : null,
		coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
	}));
}

/**
 * Open Library's description is either a bare string or `{ type, value }`, and
 * frequently ends with a provenance footer under a rule of hyphens. Both shapes
 * are normalised to paragraphs here so the page can slice them without knowing
 * any of that.
 */
function paragraphs(raw: unknown): string[] {
	const text = typeof raw === 'string' ? raw : typeof (raw as { value?: unknown })?.value === 'string' ? (raw as { value: string }).value : '';
	if (!text) return [];
	return text
		.split(/-{4,}/)[0]
		.split(/\r?\n\s*\r?\n/)
		.map((p) => p.replace(/\s+/g, ' ').trim())
		.filter((p) => p.length > 0);
}

/**
 * Subjects, thinned to the few that read as genres.
 *
 * Open Library's subject list is a library catalogue, not a shelf label. The
 * real list for The Power Broker is fourteen entries and includes
 * "Na9085.m68 c37 1974", "974.7/04/0924 b", "Moses, robert, 1888-1981" and
 * "New york (n.y.), history" — call numbers, a person as a heading, and
 * compound subject headings with their subdivisions comma-joined.
 *
 * So the test is well-formedness rather than meaning: a genre chip is a short
 * phrase, and anything carrying a comma, a parenthesis, a subdivision dash or a
 * number is apparatus that only reads as a genre if you are a cataloguer. Some
 * noise still gets through ("Group processes") — the alternative is a
 * hand-maintained vocabulary, which is a bigger promise than four chips are
 * worth. The bare Fiction/Nonfiction pair is dropped because it is displayed
 * separately as the kind.
 */
function subjects(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of raw as unknown[]) {
		if (typeof value !== 'string') continue;
		const s = value.trim();
		if (!s || s.length > 28) continue;
		if (/[,()[\]/]|--|\d/.test(s)) continue;
		if (/^(fiction|non-?fiction)$/i.test(s)) continue;
		const key = s.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(s[0].toUpperCase() + s.slice(1));
		if (out.length >= MAX_GENRES) break;
	}
	return out;
}

/**
 * Fiction or not, from the subject list.
 *
 * A guess, and a correctable one — it is a single chip on the page and the
 * alternative is asking a question at match time that is right nine times in
 * ten. "Nonfiction" is checked first because "Nonfiction, Biography, Fiction
 * writing" is a real subject list.
 */
function classify(raw: unknown): 'Fiction' | 'Nonfiction' | null {
	if (!Array.isArray(raw)) return null;
	const all = (raw as unknown[]).filter((s): s is string => typeof s === 'string').join(' | ').toLowerCase();
	if (!all) return null;
	// Order matters, and it is not the obvious one. A novel's catalogue subjects
	// are full of nonfiction-looking words — Emma is shelved under "Historical
	// Fiction" and "England, fiction", Foundation under "Psychohistory" — so a
	// history/biography test that runs first calls half the classics nonfiction.
	// Only an explicit "nonfiction" outranks a fiction marker; the softer words
	// decide nothing until no fiction marker is present at all.
	if (/non-?fiction/.test(all)) return 'Nonfiction';
	if (/fiction|novel|stories|poetry/.test(all)) return 'Fiction';
	if (/biography|history|essays|memoir/.test(all)) return 'Nonfiction';
	return null;
}

/** The blurb and subjects for one work. */
export async function getWork(key: string): Promise<OpenLibraryWork> {
	const path = key.startsWith('/') ? key : `/works/${key}`;
	const data = (await getJson(`https://openlibrary.org${path}.json`)) as Record<string, unknown>;

	const published = data.first_publish_date;
	const covers = Array.isArray(data.covers) ? (data.covers as unknown[]) : [];
	const coverId = covers.find((c) => typeof c === 'number' && c > 0);
	return {
		description: paragraphs(data.description),
		genres: subjects(data.subjects),
		kind: classify(data.subjects),
		firstPublished: typeof published === 'string' ? published : null,
		coverId: typeof coverId === 'number' ? coverId : null,
	};
}

/**
 * The median page count across a work's editions.
 *
 * The fallback for an edition record that carries no length of its own, which is
 * common — and the same statistic Open Library's own search exposes as
 * `number_of_pages_median`. A median rather than a first-found because the
 * editions of one book disagree by a hundred pages (The Power Broker's run
 * 1,246 to 1,312) and the outliers are usually omnibus or large-print printings.
 */
async function editionsMedian(workKey: string): Promise<number | null> {
	const data = (await getJson(`https://openlibrary.org${workKey}/editions.json?limit=50`)) as {
		entries?: { number_of_pages?: unknown }[];
	};
	const counts = (data.entries ?? [])
		.map((e) => e.number_of_pages)
		.filter((n): n is number => typeof n === 'number' && n > 0)
		.sort((a, b) => a - b);
	return counts.length ? counts[Math.floor(counts.length / 2)] : null;
}

/** Digits and a possible trailing X, which is all an ISBN ever is. */
function normalizeIsbn(raw: string): string {
	return raw.replace(/[^0-9Xx]/g, '').toUpperCase();
}

/**
 * The book an ISBN names, or null when Open Library has never heard of it.
 *
 * Two requests: the edition (`/isbn/…`, which redirects to `/books/OL…M`) for
 * the physical facts, then its work for the blurb and subjects. Both are key
 * lookups — see OpenLibraryEdition for why that is the point.
 *
 * Missing edition data falls through to the work rather than failing: plenty of
 * editions carry no cover and no date while the work has both.
 */
export async function lookupIsbn(isbn: string): Promise<OpenLibraryEdition | null> {
	const clean = normalizeIsbn(isbn);
	if (clean.length !== 10 && clean.length !== 13) return null;

	let edition: Record<string, unknown>;
	try {
		edition = (await getJson(`https://openlibrary.org/isbn/${clean}.json`)) as Record<string, unknown>;
	} catch (e) {
		// A 404 is an answer — this ISBN is not in their catalogue — while a 503 or
		// a timeout is not, and the caller has to be able to tell them apart to
		// know whether retrying is worth anything.
		if (e instanceof Error && e.message.includes('404')) return null;
		throw e;
	}

	const works = Array.isArray(edition.works) ? (edition.works as { key?: unknown }[]) : [];
	const workKey = typeof works[0]?.key === 'string' ? (works[0].key as string) : null;
	if (!workKey) return null;

	let work: OpenLibraryWork = {
		description: [],
		genres: [],
		kind: null,
		firstPublished: null,
		coverId: null,
	};
	try {
		work = await getWork(workKey);
	} catch {
		// The edition alone is a usable match; the blurb is a nice-to-have.
	}

	// The edition's own cover is the one you are holding; the work's is the
	// series' or the first edition's. Prefer the specific, accept the general.
	const editionCovers = Array.isArray(edition.covers) ? (edition.covers as unknown[]) : [];
	const editionCover = editionCovers.find((c) => typeof c === 'number' && c > 0);
	const coverId = typeof editionCover === 'number' ? editionCover : work.coverId;

	// The edition's own length first; the work's editions decide it when this
	// record has none, which is the difference between drawing a spine and not.
	let pages = typeof edition.number_of_pages === 'number' ? edition.number_of_pages : null;
	if (!pages) {
		try {
			pages = await editionsMedian(workKey);
		} catch {
			// A spine at the fallback width is a smaller loss than no match at all.
		}
	}
	const published = edition.publish_date;

	return {
		key: workKey,
		title: typeof edition.title === 'string' ? edition.title : '',
		subtitle: typeof edition.subtitle === 'string' ? edition.subtitle : null,
		pages: pages && pages > 0 ? pages : null,
		coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : null,
		// The work's date is the book's; the edition's is this printing's. For "first
		// published" the work wins, and the edition stands in when it has none.
		firstPublished: work.firstPublished ?? (typeof published === 'string' ? published : null),
		description: work.description,
		genres: work.genres,
		kind: work.kind,
	};
}
