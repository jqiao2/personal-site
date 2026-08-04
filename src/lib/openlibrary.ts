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
}

async function getJson(url: string): Promise<unknown> {
	const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
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
 * Subjects, thinned to something printable.
 *
 * Open Library subjects run from "Fiction" to "New York (N.Y.) -- Politics and
 * government -- 1951-" and there are often fifty of them. Anything with a
 * subdivision dash or an accession-style number is catalogue apparatus rather
 * than a genre, and the bare "Fiction"/"Nonfiction" pair is displayed as the
 * kind chip instead, so it is dropped from this list.
 */
function subjects(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of raw as unknown[]) {
		if (typeof value !== 'string') continue;
		const s = value.trim();
		if (!s || s.length > 32 || s.includes('--') || /\d{3}/.test(s)) continue;
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
	if (/non-?fiction|biography|history|essays|memoir/.test(all)) return 'Nonfiction';
	if (/fiction|novel|stories|poetry/.test(all)) return 'Fiction';
	return null;
}

/** The blurb and subjects for one work. */
export async function getWork(key: string): Promise<OpenLibraryWork> {
	const path = key.startsWith('/') ? key : `/works/${key}`;
	const data = (await getJson(`https://openlibrary.org${path}.json`)) as Record<string, unknown>;

	const published = data.first_publish_date;
	return {
		description: paragraphs(data.description),
		genres: subjects(data.subjects),
		kind: classify(data.subjects),
		firstPublished: typeof published === 'string' ? published : null,
	};
}
