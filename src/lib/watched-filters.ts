import { mediumLabel, starText } from './format';

/**
 * The active filters on the "All films" grid, in the shape the summary sentence
 * needs: every list is what's selected, and every bound is null when that end
 * isn't narrowed. The page's script builds one from its live filter state and the
 * server builds one from the query string, so both render the same sentence for
 * the same URL — the server's copy is what the page paints before its script runs.
 */
export interface FilterSummary {
	/** Films matching — the number the sentence opens on. */
	total: number;
	rewatched: boolean;
	liked: boolean;
	unrated: boolean;
	/** Inclusive star bounds, in half steps. */
	ratingMin: number | null;
	ratingMax: number | null;
	/** Release-decade span, as each decade's first year. */
	decadeMin: number | null;
	decadeMax: number | null;
	releaseYears: number[];
	/** Inclusive calendar-year bounds on when the films were logged. */
	diaryYearMin: number | null;
	diaryYearMax: number | null;
	tags: string[];
	directors: string[];
	actors: string[];
	genres: string[];
	languages: string[];
	countries: string[];
	friends: string[];
	friendMode: 'any' | 'all';
	mediums: string[];
	/** Theaters as their stored "Name, City". */
	venues: string[];
	/** Shortened theater names keyed by the value above; falls back to the value,
	 * which is what happens before the facets that carry the labels have loaded. */
	venueLabels?: Map<string, string>;
	formats: string[];
}

/** One run of the sentence. `em` marks the values, which are drawn highlighted. */
export interface SentencePart {
	t: string;
	em: boolean;
}

/** Join names as "a", "a and b", "a, b, and c" — conjunction configurable so the
 * any/all toggles can read "or" vs "and". */
export function andList(items: string[], conj = 'and'): string {
	if (items.length <= 1) return items.join('');
	if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
	return `${items.slice(0, -1).join(', ')}, ${conj} ${items[items.length - 1]}`;
}

/** Each medium reads with its own natural preposition. */
const MEDIUM_PHRASE: Record<string, string> = {
	theater: 'in a theater',
	tv: 'on TV',
	computer: 'on a computer',
	plane: 'on a plane',
	tablet: 'on an iPad',
	ipad: 'on an iPad',
};

/**
 * A plain-English summary of every active filter, e.g. "You have rewatched 3
 * criterion films directed by … rated between ★★★★ and ★★★★★ … with Maya or Dana
 * seen at the Metrograph or in 70mm."
 *
 * Split into parts rather than returned as a string so each value can be
 * highlighted; the caller wraps them in whatever element it draws with.
 */
export function filterSentence(s: FilterSummary): SentencePart[] {
	const parts: SentencePart[] = [];
	const lit = (t: string) => parts.push({ t, em: false });
	const em = (t: string) => parts.push({ t, em: true });

	const venuePhrase = (v: string) => {
		const label = s.venueLabels?.get(v) ?? v;
		// Names that already lead with "The" don't want a second article.
		return /^the\s/i.test(label) ? `at ${label}` : `at the ${label}`;
	};

	lit(s.rewatched ? 'You have rewatched ' : 'You have watched ');
	em(s.total.toLocaleString('en-US'));
	lit(s.total === 1 ? ' film' : ' films');
	if (s.tags.length) {
		lit(' tagged ');
		em(andList(s.tags));
	}
	if (s.directors.length) {
		lit(' directed by ');
		em(andList(s.directors));
	}
	if (s.actors.length) {
		lit(' starring ');
		em(andList(s.actors));
	}
	if (s.unrated) {
		lit(' that are ');
		em('unrated');
	} else if (s.ratingMin != null || s.ratingMax != null) {
		const lo = s.ratingMin ?? 0.5;
		const hi = s.ratingMax ?? 5;
		if (lo === hi) {
			lit(' rated ');
			em(starText(lo)!);
		} else {
			lit(' rated between ');
			em(`${starText(lo)} and ${starText(hi)}`);
		}
	}
	if (s.liked) {
		lit(' that you ');
		em('liked');
	}
	if (s.decadeMin != null || s.decadeMax != null) {
		const lo = s.decadeMin ?? s.decadeMax!;
		const hi = s.decadeMax ?? s.decadeMin!;
		if (lo === hi) {
			lit(' released in the ');
			em(`${lo}s`);
		} else {
			lit(' released between ');
			em(`${lo}s and ${hi}s`);
		}
	}
	if (s.releaseYears.length) {
		lit(' released in ');
		em(andList([...s.releaseYears].sort((a, b) => a - b).map(String), 'or'));
	}
	if (s.genres.length) {
		lit(' in the ');
		em(andList(s.genres));
		lit(s.genres.length === 1 ? ' genre' : ' genres');
	}
	if (s.languages.length) {
		lit(' in ');
		em(andList(s.languages));
	}
	if (s.countries.length) {
		lit(' from ');
		em(andList(s.countries));
	}
	if (s.diaryYearMin != null || s.diaryYearMax != null) {
		const lo = s.diaryYearMin ?? s.diaryYearMax!;
		const hi = s.diaryYearMax ?? s.diaryYearMin!;
		if (lo === hi) {
			lit(' logged in ');
			em(String(lo));
		} else {
			lit(' logged between ');
			em(`${lo} and ${hi}`);
		}
	}
	if (s.friends.length) {
		lit(' with ');
		em(andList(s.friends, s.friendMode === 'all' ? 'and' : 'or'));
	}
	// Medium, theater and format each carry their own preposition and are
	// emphasized on their own; the phrases simply stack ("at the Metrograph in
	// IMAX 70mm"), no lead-in or connector. A named theater or a format both
	// already imply a theater, so drop the redundant theater medium when either
	// is set.
	const mediums =
		s.venues.length > 0 || s.formats.length > 0
			? s.mediums.filter((m) => m !== 'theater')
			: s.mediums;
	const whereItems = [
		...s.venues.map(venuePhrase),
		...s.formats.map((f) => `in ${f}`),
		...mediums.map((m) => MEDIUM_PHRASE[m] ?? `on ${mediumLabel(m)}`),
	];
	for (const item of whereItems) {
		lit(' ');
		em(item);
	}
	lit('.');

	return parts;
}
