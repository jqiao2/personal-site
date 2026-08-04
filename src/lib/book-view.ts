// Presentation layer for the book detail page.
//
// Same contract as reading-view.ts: no database, nothing async, every field a
// finished string or a number of pixels, so the .astro stays markup and the
// reasoning is testable arithmetic. Days are "YYYY-MM-DD" strings throughout —
// see the note at the top of reading-view.ts for why they are never Dates.
import {
	addDays,
	daysBetween,
	formatDay,
	formatDuration,
	formatMonth,
	formatNumber,
	heatLevel,
	splitTitle,
	today,
	zonedDay,
} from './reading-view';
import { VOCABULARY, type BookDay, type BookRow, type HighlightRow, type ReviewRow } from './book-queries';

/**
 * How far through counts as finished on its own.
 *
 * Matches reading-view.ts, and for the same reason: the last pages of an EPUB
 * are acknowledgements and an index, and KOReader's repagination means the
 * final recorded page is only approximately the real one. A book finished by
 * hand wins regardless.
 */
const FINISHED_PROGRESS = 0.97;

/** Days of silence before a book stops counting as in progress and starts as drift. */
const SET_ASIDE_DAYS = 30;

/** Days apart before two sittings belong to different stretches. Matches buildSpells. */
const STRETCH_GAP_DAYS = 3;

/** The window the projection is drawn from. Older sittings describe a different life. */
const PACE_WINDOW_DAYS = 35;

/** Sittings needed before a projection is a rhythm rather than a guess. */
const PACE_MIN_SITTINGS = 4;

const HIGHLIGHT_PREVIEW = 4;
const CHIP_PREVIEW = 8;
const MONTHS_LONG = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
];

export type Shelf = 'reading' | 'aside' | 'gaveup' | 'finished' | 'toread' | 'none';

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function ordinal(n: number): string {
	return ['First', 'Second', 'Third', 'Fourth', 'Fifth'][n - 1] ?? `${n}th`;
}

/** "2026-03-12" → "12 March 2026". The long form, for the one date that earns it. */
function formatDayLong(day: string): string {
	const [y, m, d] = day.split('-').map(Number);
	return `${d} ${MONTHS_LONG[m - 1]} ${y}`;
}

/**
 * Percentages carry a decimal only where one is informative: "8.4%" early on
 * and a clean "100%" at the end, nothing in between.
 */
function formatPercent(pct: number): string {
	if (pct >= 99.5) return '100%';
	if (pct < 10) return `${pct.toFixed(1)}%`;
	return `${Math.round(pct)}%`;
}

/** "3 days ago" / "4 months ago" — the vaguer the older, which is how it's remembered. */
function ago(day: string, todayDay: string): string {
	const n = daysBetween(day, todayDay);
	if (n <= 0) return 'today';
	if (n === 1) return 'yesterday';
	if (n < 30) return `${n} days ago`;
	if (n < 365) return `${Math.round(n / 30.4)} months ago`;
	return `${(n / 365).toFixed(1).replace(/\.0$/, '')} years ago`;
}

/** Half-star rating as text, the way the film log prints it. */
function stars(rating: number): string {
	return '★'.repeat(Math.floor(rating)) + (rating % 1 >= 0.5 ? '½' : '');
}

/**
 * A colour for the book, derived from its title.
 *
 * Real books have no cover colour on file, and the hero wash needs one. Hashing
 * the title means the same book is the same colour on every render and two
 * books are rarely the same — decorative, but consistently so.
 */
function bookHue(title: string): string {
	const palette = [
		'#6d4a2a',
		'#5b4a6b',
		'#4a5a4a',
		'#6b3a4a',
		'#3f5560',
		'#3f4a5e',
		'#4a5240',
		'#7a4a3a',
		'#5a4a2a',
		'#43566b',
	];
	let hash = 0;
	for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) % 100_000;
	return palette[hash % palette.length];
}

export interface Fact {
	k: string;
	v: string;
}

export interface Stat {
	value: string;
	label: string;
}

export interface Chip {
	label: string;
	/** Pacing and focus are scales, and are set apart from the mood/tone chips. */
	scale: boolean;
}

export interface ActivityCell {
	title: string;
	level: number;
	read: boolean;
}

export interface StretchRow {
	kind: 'stretch' | 'gap';
	/** "2–13 Apr 2026" for a stretch, "4 months untouched" for a gap. */
	label: string;
	meta: string;
	cells: ActivityCell[];
	/** "Second read" / "Gave up here", when this stretch is one. */
	readLabel: string | null;
}

export interface ReviewView {
	id: number;
	/** "Second read" — only shown when there is more than one. */
	readLabel: string | null;
	dates: string;
	rating: number | null;
	stars: string | null;
	loved: boolean;
	/** "Loved" spelled out when there are no stars for the heart to sit beside. */
	lovedWord: string | null;
	ending: string | null;
	readStats: string;
	text: string | null;
	/** What to print instead of a review that was never written. */
	emptyLine: string;
	chips: Chip[];
	hiddenChips: Chip[];
	editLabel: string;
	/** Values the dialog reopens this review with. */
	seed: ReviewSeed;
}

export interface ReviewSeed {
	id: number | null;
	readFrom: string;
	readTo: string;
	rating: number;
	loved: boolean;
	text: string;
	pacing: string;
	focus: string;
	moods: string[];
	tones: string[];
}

export interface QuietAction {
	label: string;
	hint: string;
	action: string;
}

export interface BookPageView {
	id: number;
	shelf: Shelf;
	title: string;
	subtitle: string | null;
	series: string | null;
	authors: string[];
	authorLine: string;
	sourceTitle: string;
	matched: boolean;
	coverUrl: string | null;
	hue: string;
	isPublic: boolean;
	pageTitle: string;

	/** Hero */
	heroStatus: string;
	heroDotClass: string;

	/** Meta row / tags / blurb */
	metaBits: string[];
	/** The unmatched notice, naming only what is genuinely absent. */
	missingLine: string;
	kind: string | null;
	genres: string[];
	description: string[];
	descriptionPreview: string[];

	/** Rail */
	badge: string | null;
	statusLabel: string | null;
	statusNote: string | null;
	knowsTotal: boolean;
	percent: string | null;
	barWidth: number;
	spineFill: number;
	railPageLine: string;
	railFacts: Fact[];
	autoNote: string | null;
	finishedLong: string | null;
	byHand: boolean;
	stoppedLine: string | null;
	addedLine: string | null;
	lovedAny: boolean;
	primaryLabel: string | null;
	primaryAction: string | null;
	quietActions: QuietAction[];

	/** Your reading */
	hasActivity: boolean;
	lifetimeScope: string;
	progressIsHero: boolean;
	pageLine: string;
	pagesLeftLine: string;
	stats: Stat[];
	pace: { value: string; unit: string; projection: string; basis: string } | null;
	noPaceLine: string | null;

	/** When you read it */
	activityMeta: string;
	stretches: StretchRow[];

	/** Highlights */
	highlights: { page: number; text: string }[];
	highlightPreview: { page: number; text: string }[];
	highlightMeta: string;

	/** Reviews */
	showReviews: boolean;
	reviewsHeading: string;
	readsMeta: string | null;
	reviews: ReviewView[];
	noReadsLine: string | null;

	/** Review dialog */
	newRead: { from: string; to: string; label: string };
	latestReadTitle: string | null;
	attachOnBody: string;
	attachOffBody: string;
	priorReads: number;
}

export interface BookPageInput {
	book: BookRow;
	days: BookDay[];
	reviews: ReviewRow[];
	highlights: HighlightRow[];
	isOwner: boolean;
	todayDay?: string;
}

/**
 * Which shelf a book is on.
 *
 * Only two of the six are ever written down. Finished is normally inferred from
 * progress, set-aside entirely from silence, and reading is what a book is when
 * none of the other answers apply — which is why nothing on the page asks you
 * to declare it. The two that are recorded, `gave_up_at` and a hand-set
 * `finished_at`, are decisions the reading data cannot imply.
 *
 * A session after `gave_up_at` supersedes it, so picking a book back up needs
 * no undo: the page turn is the undo.
 */
export function resolveShelf(book: BookRow, todayDay: string): Shelf {
	const lastDay = book.last_read_at ? zonedDay(book.last_read_at) : null;
	if (!lastDay) return book.added_at ? 'toread' : 'none';

	if (book.gave_up_at && zonedDay(book.gave_up_at) >= lastDay) return 'gaveup';

	const progress = book.total_pages ? Math.min(1, book.furthest_page / book.total_pages) : null;
	if (book.finished_at || (progress !== null && progress >= FINISHED_PROGRESS)) return 'finished';

	return daysBetween(lastDay, todayDay) > SET_ASIDE_DAYS ? 'aside' : 'reading';
}

/** Sittings grouped into stretches, oldest first. */
function clusters(days: BookDay[]): BookDay[][] {
	if (!days.length) return [];
	const out: BookDay[][] = [[days[0]]];
	for (let i = 1; i < days.length; i++) {
		if (daysBetween(days[i - 1].day, days[i].day) <= STRETCH_GAP_DAYS) out[out.length - 1].push(days[i]);
		else out.push([days[i]]);
	}
	return out;
}

/** "2–13 Apr 2026", collapsing to one date or opening out across months. */
function rangeLabel(from: string, to: string): string {
	if (from === to) return formatDay(from);
	if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${formatDay(to)}`;
	return `${formatDay(from)} → ${formatDay(to)}`;
}

/** The heading over a review: "April 2026", "Jan–Mar 2026", or two full dates. */
function readDates(from: string, to: string): string {
	const sameYear = from.slice(0, 4) === to.slice(0, 4);
	if (sameYear && from.slice(5, 7) === to.slice(5, 7)) {
		return `${MONTHS_LONG[Number(to.slice(5, 7)) - 1]} ${to.slice(0, 4)}`;
	}
	if (sameYear) return `${formatMonth(from).slice(0, 3)}–${formatMonth(to)}`;
	return `${formatDay(from)} → ${formatDay(to)}`;
}

export function buildBookPage(input: BookPageInput): BookPageView {
	const { book, days, highlights, isOwner } = input;
	const todayDay = input.todayDay ?? today();
	const reviews = [...input.reviews].sort((a, b) => (a.read_from < b.read_from ? 1 : -1));

	const shelf = resolveShelf(book, todayDay);
	const inProgress = shelf === 'reading' || shelf === 'aside' || shelf === 'gaveup';
	const isFinished = shelf === 'finished';

	const total = book.total_pages;
	const knowsTotal = !!total && total > 0;
	const furthest = book.furthest_page;
	const pctNum = knowsTotal ? Math.min(100, (furthest / total!) * 100) : 0;
	const percent = knowsTotal ? formatPercent(pctNum) : null;
	const left = knowsTotal ? Math.max(0, total! - furthest) : 0;

	const firstDay = days.length ? days[0].day : null;
	const lastDay = days.length ? days[days.length - 1].day : null;
	const totalSeconds = days.reduce((sum, d) => sum + d.seconds, 0);
	const totalPagesTurned = days.reduce((sum, d) => sum + d.pages, 0);
	const maxPages = Math.max(1, ...days.map((d) => d.pages));

	const { main, sub } = splitTitle(book.title);
	const title = main;
	const subtitle = book.subtitle ?? sub;
	const authors = (book.authors ?? '')
		.split(/\s*(?:&|,| and )\s*/)
		.map((a) => a.trim())
		.filter(Boolean);
	const matched = !!book.ol_key;
	const lovedAny = reviews.some((r) => r.loved);

	// ---- pace and projection -------------------------------------------------
	// Drawn from the last five weeks only. A book picked up again after a year
	// has an old pace on file and it is a fact about last year, not about the
	// evenings you are actually spending on it now.
	const recent = days.filter((d) => daysBetween(d.day, todayDay) <= PACE_WINDOW_DAYS);
	const recentPages = recent.reduce((sum, d) => sum + d.pages, 0);
	const recentSeconds = recent.reduce((sum, d) => sum + d.seconds, 0);
	const pagesPerHour = recentSeconds > 0 ? recentPages / (recentSeconds / 3600) : 0;
	const hoursLeft = pagesPerHour > 0 ? left / pagesPerHour : 0;
	const lifetimePph = totalSeconds > 0 ? totalPagesTurned / (totalSeconds / 3600) : 0;

	let sessionsPerWeek = 0;
	let averageMinutes = 0;
	let weeksLeft = 0;
	if (recent.length >= 2) {
		const span = Math.max(1, daysBetween(recent[0].day, recent[recent.length - 1].day) + 1);
		sessionsPerWeek = recent.length / (span / 7);
		averageMinutes = recentSeconds / 60 / recent.length;
		// Guard the divisor: a fortnight of one-minute sittings would otherwise
		// project a finish date somewhere in the next century.
		weeksLeft = hoursLeft / Math.max(0.2, (sessionsPerWeek * averageMinutes) / 60);
	}

	const hasPace = shelf === 'reading' && knowsTotal && recent.length >= PACE_MIN_SITTINGS && pagesPerHour > 0;
	const rhythm =
		weeksLeft >= 2
			? `about ${Math.round(weeksLeft)} weeks at your recent rhythm`
			: `about ${Math.max(1, Math.round(weeksLeft * 7))} days at your recent rhythm`;

	let noPaceLine: string | null = null;
	if (inProgress && !hasPace) {
		if (shelf === 'gaveup') {
			noPaceLine = `No projection. You stopped on purpose at page ${formatNumber(furthest)} — the arithmetic stopped being interesting before the book did.`;
		} else if (shelf === 'aside') {
			const month = lastDay ? MONTHS_LONG[Number(lastDay.slice(5, 7)) - 1] : 'then';
			noPaceLine = `Untouched since ${month}. The old pace — ${Math.round(lifetimePph)} pages an hour — is a fact about ${month}, not about now.`;
		} else if (days.length <= 1) {
			noPaceLine = `One sitting so far — ${formatDuration(totalSeconds)} on the first ${formatNumber(furthest)} pages. Nothing to project from until there is a second.`;
		} else if (!knowsTotal) {
			noPaceLine = `You are ${formatNumber(furthest)} pages in at roughly ${Math.round(lifetimePph)} pages an hour, but without a page count there is nothing to count down to.`;
		} else {
			noPaceLine = `${days.length} sittings, spread too thin to be a rhythm. A projection here would be a guess with a decimal point on it.`;
		}
	}

	// ---- stats ---------------------------------------------------------------
	const stats: Stat[] = [];
	if (isFinished) {
		stats.push({ value: formatDuration(totalSeconds), label: 'Time read' });
		stats.push({ value: String(days.length), label: 'Days read' });
		stats.push({ value: formatNumber(totalPagesTurned), label: 'Pages turned' });
		stats.push({
			value: book.finished_at
				? formatMonth(zonedDay(book.finished_at))
				: lastDay
					? formatMonth(lastDay)
					: '—',
			label: 'Finished',
		});
	} else if (inProgress) {
		stats.push({ value: formatDuration(totalSeconds), label: 'Time read' });
		stats.push({ value: String(days.length), label: 'Days read' });
		stats.push({ value: firstDay ? formatDay(firstDay) : '—', label: 'First opened' });
		stats.push({ value: lastDay ? ago(lastDay, todayDay) : '—', label: 'Last read' });
	}

	// ---- stretches -----------------------------------------------------------
	// Newest first, with the silences between them named rather than drawn. A
	// book read across two winters two years apart should read as two winters.
	const byDay = new Map(days.map((d) => [d.day, d]));
	const groups = clusters(days);
	const stretches: StretchRow[] = [];
	const ordered = [...groups].reverse();

	ordered.forEach((cluster, i) => {
		const from = cluster[0].day;
		const to = cluster[cluster.length - 1].day;
		const cells: ActivityCell[] = [];
		for (let offset = 0; offset <= daysBetween(from, to); offset++) {
			const day = addDays(from, offset);
			const record = byDay.get(day);
			cells.push({
				title:
					formatDay(day) +
					(record
						? ` · ${formatNumber(record.pages)} pages · ${formatDuration(record.seconds)}`
						: ' · nothing read'),
				level: record ? heatLevel(record.pages, maxPages) : 0,
				read: !!record,
			});
		}

		const pages = cluster.reduce((sum, d) => sum + d.pages, 0);
		const seconds = cluster.reduce((sum, d) => sum + d.seconds, 0);
		// Reviews carry their own date range, so a stretch can say which read it
		// was — but only once there is more than one, or the label is noise.
		const matchingRead = reviews.find((r) => r.read_from <= to && r.read_to >= from);
		const indexFromStart = groups.length - 1 - i;
		const isLatest = i === 0;

		stretches.push({
			kind: 'stretch',
			label: rangeLabel(from, to),
			meta: `${plural(cluster.length, 'day')} · ${formatNumber(pages)} pages · ${formatDuration(seconds)}`,
			cells,
			readLabel:
				shelf === 'gaveup' && isLatest
					? 'Gave up here'
					: matchingRead && groups.length > 1
						? `${ordinal(indexFromStart + 1)} read`
						: null,
		});

		const older = ordered[i + 1];
		if (older) {
			const gap = daysBetween(older[older.length - 1].day, from);
			stretches.push({
				kind: 'gap',
				label: gap >= 60 ? `${Math.round(gap / 30.4)} months untouched` : `${gap} days untouched`,
				meta: '',
				cells: [],
				readLabel: null,
			});
		}
	});

	// ---- reviews -------------------------------------------------------------
	const reviewViews: ReviewView[] = reviews.map((r, i) => {
		const inRead = days.filter((d) => d.day >= r.read_from && d.day <= r.read_to);
		const readSeconds = inRead.reduce((sum, d) => sum + d.seconds, 0);
		const readPages = inRead.reduce((sum, d) => sum + d.pages, 0);
		const pph = readSeconds > 0 ? Math.round(readPages / (readSeconds / 3600)) : 0;
		const attributes = VOCABULARY.filter(
			(v) => v === r.pacing || v === r.focus || r.moods.includes(v) || r.tones.includes(v),
		).map((label) => ({ label, scale: label === r.pacing || label === r.focus }));

		return {
			id: r.id,
			readLabel: reviews.length > 1 ? `${ordinal(reviews.length - i)} read` : null,
			dates: readDates(r.read_from, r.read_to),
			rating: r.rating,
			stars: r.rating ? stars(r.rating) : null,
			loved: r.loved,
			lovedWord: r.loved && !r.rating ? 'Loved' : null,
			ending: r.gave_up ? `gave up at page ${formatNumber(furthest)}` : null,
			readStats: inRead.length
				? `${plural(inRead.length, 'day')} · ${formatDuration(readSeconds)}${pph ? ` · ${pph} pages/hr` : ''}`
				: '',
			text: r.review_text || null,
			emptyLine: r.rating ? 'Rated, never written up.' : 'Marked as read. No rating, no review.',
			chips: attributes.slice(0, CHIP_PREVIEW),
			hiddenChips: attributes.slice(CHIP_PREVIEW),
			editLabel: r.review_text || r.rating ? 'Edit' : 'Add review',
			seed: {
				id: r.id,
				readFrom: r.read_from,
				readTo: r.read_to,
				rating: r.rating ?? 0,
				loved: r.loved,
				text: r.review_text ?? '',
				pacing: r.pacing ?? '',
				focus: r.focus ?? '',
				moods: r.moods,
				tones: r.tones,
			},
		};
	});

	// The read a new review attaches to when "Re-read" is off: the most recent
	// stretch of sessions, which is what you have just put the book down from.
	const latest = groups.length ? groups[groups.length - 1] : null;
	const newFrom = latest ? latest[0].day : (firstDay ?? todayDay);
	const newTo = latest ? latest[latest.length - 1].day : (lastDay ?? todayDay);

	// ---- rail ----------------------------------------------------------------
	const railFacts: Fact[] = [];
	if (inProgress) {
		railFacts.push({ k: 'Last read', v: lastDay ? ago(lastDay, todayDay) : '—' });
		railFacts.push({ k: 'Time on it', v: formatDuration(totalSeconds) });
	} else if (isFinished) {
		railFacts.push({ k: 'Time read', v: formatDuration(totalSeconds) });
		railFacts.push({ k: 'Days read', v: plural(days.length, 'day') });
		if (reviews.length > 1) railFacts.push({ k: 'Reads', v: String(reviews.length) });
	}

	const quietActions: QuietAction[] = [];
	if (isOwner) {
		if (shelf === 'reading' || shelf === 'aside') {
			quietActions.push({
				label: 'Mark finished',
				hint: 'For books that end before the last page',
				action: 'finish',
			});
			quietActions.push({ label: 'Give up on it', hint: 'An ending, not a failure', action: 'give-up' });
		} else if (shelf === 'gaveup') {
			quietActions.push({
				label: 'Picked it back up',
				hint: 'A page turn would do this on its own',
				action: 'resume',
			});
		} else if (isFinished && book.finished_by_hand) {
			quietActions.push({
				label: 'Put it back in progress',
				hint: 'Undo a premature finish',
				action: 'unfinish',
			});
		}
	}

	const statusLabel =
		shelf === 'reading' ? 'Reading now' : shelf === 'aside' ? 'Set aside' : shelf === 'gaveup' ? 'Gave up' : null;

	const baseStatus =
		shelf === 'reading'
			? knowsTotal
				? `Reading · ${percent}`
				: 'Reading'
			: shelf === 'aside'
				? `Set aside · ${percent ?? '—'}`
				: shelf === 'gaveup'
					? `Gave up · ${percent ?? '—'}`
					: isFinished
						? `Finished ${book.finished_at ? formatDay(zonedDay(book.finished_at)) : lastDay ? formatDay(lastDay) : ''}`.trim()
						: shelf === 'toread'
							? 'On the to-read pile'
							: 'Not on the shelf';

	const primaryLabel = !isOwner
		? null
		: shelf === 'none'
			? '+ Add to to-read pile'
			: shelf === 'toread'
				? '✓  On to-read pile'
				: isFinished || shelf === 'gaveup'
					? reviews.length && reviews[0].review_text
						? 'Edit review'
						: 'Write a review'
					: null;

	// The identity row, and only for a matched book: an unmatched one has no
	// publication date and no language, and its page count is KOReader's
	// repagination rather than a fact about the edition. One number on its own
	// under the title reads as a claim the page cannot support.
	const metaBits = (
		matched ? [knowsTotal ? `${formatNumber(total!)} pages` : null, book.first_published, book.language] : []
	).filter(Boolean) as string[];

	// What the unmatched notice apologises for, listed from what is actually
	// absent. A fixed sentence would tell you there is no page count on the same
	// screen as the progress bar counting down from one.
	const missing = [
		!book.cover_url ? 'no cover' : null,
		!knowsTotal ? 'no page count' : null,
		!book.first_published ? 'no publication date' : null,
		!book.genres.length ? 'no subjects' : null,
	].filter(Boolean) as string[];

	return {
		id: book.id,
		shelf,
		title,
		subtitle,
		series: book.series,
		authors,
		authorLine: authors.join(' & '),
		sourceTitle: book.source_title,
		matched,
		coverUrl: book.cover_url,
		hue: bookHue(book.title),
		isPublic: book.is_public,
		pageTitle: `${title} — Jason's reading`,

		heroStatus: book.is_public ? baseStatus : `Private · ${baseStatus}`,
		heroDotClass: `dot--${shelf}`,

		metaBits,
		missingLine: `It came in as a sideloaded EPUB, so all this page has is what the Kindle reported and what you read${missing.length ? `: ${missing.join(', ')}` : ''}.`,
		kind: book.kind,
		genres: book.genres,
		description: book.description,
		descriptionPreview: book.description.slice(0, 2),

		badge:
			shelf === 'reading'
				? 'Reading'
				: shelf === 'aside'
					? 'Set aside'
					: shelf === 'gaveup'
						? 'Gave up'
						: isFinished
							? 'Finished'
							: shelf === 'toread'
								? 'To read'
								: null,
		statusLabel,
		statusNote:
			shelf === 'aside'
				? `Untouched since ${lastDay ? formatDay(lastDay) : ''}. The site set this itself after thirty quiet days — it is drift, not a decision.`
				: shelf === 'gaveup'
					? `Stopped on purpose${book.gave_up_at ? ` on ${formatDay(zonedDay(book.gave_up_at))}` : ''}. One page turn puts it back in progress by itself.`
					: null,
		knowsTotal,
		percent,
		barWidth: Math.max(1.5, pctNum),
		spineFill: knowsTotal ? Math.round((pctNum / 100) * 280) : 0,
		railPageLine: !knowsTotal
			? `page ${formatNumber(furthest)} · total unknown`
			: `${shelf === 'gaveup' ? 'Gave up at page ' : 'page '}${formatNumber(furthest)} of ${formatNumber(total!)} · ${percent}`,
		railFacts,
		autoNote:
			shelf === 'reading'
				? 'Logged automatically by the Kindle, one page turn at a time.'
				: shelf === 'aside'
					? 'Nothing was decided here — the Kindle simply stopped sending page turns.'
					: shelf === 'toread'
						? 'It moves itself to reading the first time the Kindle sends a page turn.'
						: null,
		finishedLong: isFinished
			? book.finished_at
				? formatDayLong(zonedDay(book.finished_at))
				: lastDay
					? formatDayLong(lastDay)
					: null
			: null,
		byHand: book.finished_by_hand,
		stoppedLine:
			book.finished_by_hand && knowsTotal
				? `Stopped at page ${formatNumber(furthest)} of ${formatNumber(total!)}.`
				: null,
		addedLine:
			shelf === 'toread' && book.added_at
				? `Added ${formatDay(zonedDay(book.added_at))} · ${ago(zonedDay(book.added_at), todayDay)}`
				: null,
		lovedAny,
		primaryLabel,
		primaryAction:
			shelf === 'none' || shelf === 'toread' ? 'to-read' : primaryLabel ? 'review' : null,
		quietActions,

		hasActivity: days.length > 0,
		lifetimeScope: reviews.length > 1 ? `across ${reviews.length} reads` : inProgress ? 'so far' : '',
		progressIsHero: inProgress && knowsTotal,
		pageLine: knowsTotal
			? `${shelf === 'gaveup' ? 'reached page ' : 'page '}${formatNumber(furthest)} of ${formatNumber(total!)}`
			: `page ${formatNumber(furthest)}`,
		pagesLeftLine: shelf === 'gaveup' ? `${formatNumber(left)} never read` : `${formatNumber(left)} to go`,
		stats,
		pace: hasPace
			? {
					value: String(Math.round(pagesPerHour)),
					unit: 'pages an hour',
					projection: `Roughly ${formatDuration(hoursLeft * 3600)} of reading left — ${rhythm}.`,
					basis: `Based on the last ${recent.length} sittings only: about ${sessionsPerWeek.toFixed(1).replace(/\.0$/, '')} a week, ${Math.round(averageMinutes)} minutes each. It moves every time you pick the book up.`,
				}
			: null,
		noPaceLine,

		activityMeta:
			`${plural(days.length, 'day')}` + (groups.length > 1 ? ` in ${groups.length} stretches` : ''),
		stretches,

		highlights: highlights.map((h) => ({ page: h.page, text: h.text })),
		highlightPreview: highlights.slice(0, HIGHLIGHT_PREVIEW).map((h) => ({ page: h.page, text: h.text })),
		highlightMeta: `${plural(highlights.length, 'passage')} saved on the Kindle`,

		showReviews: isFinished || shelf === 'gaveup' || reviews.length > 0,
		reviewsHeading: reviews.length > 1 ? 'Your reviews' : 'Your review',
		readsMeta: reviews.length > 1 ? `${reviews.length} reads · newest first` : null,
		reviews: reviewViews,
		noReadsLine:
			(isFinished || shelf === 'gaveup') && reviews.length === 0
				? isOwner
					? shelf === 'gaveup'
						? 'Gave up, and nothing written down yet.'
						: 'Finished, and nothing written down yet.'
					: 'No review written.'
				: null,

		newRead: { from: newFrom, to: newTo, label: `${ordinal(reviews.length + 1)} read · ${rangeLabel(newFrom, newTo)}` },
		latestReadTitle: reviews.length ? `${ordinal(reviews.length)} read · ${reviewViews[0].dates}` : null,
		attachOnBody: reviews.length
			? `Dated from your most recent stretch on the Kindle, ${rangeLabel(newFrom, newTo)}. Your ${ordinal(reviews.length).toLowerCase()} read keeps the review it already has.`
			: '',
		attachOffBody: reviews.length
			? 'Anything you write replaces the review already on that read. If you have just finished the book again, turn on Re-read instead.'
			: '',
		priorReads: reviews.length,
	};
}
