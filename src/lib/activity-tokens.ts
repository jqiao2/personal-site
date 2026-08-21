// Design tokens for "Jason's activity log" — the fourth section, and the first
// one whose records arrive from machines rather than from typing (see
// ACTIVITIES.md §0). That changes what the screen is allowed to look like.
//
// WHY LIGHT WHERE THE FILM LOG IS DARK. The film log's near-black room and the
// book log's near-black paper are both about a controlled reading light — a
// lamp on, the rest of the room down, one object held up to look at. An
// activity isn't held up, it's looked out at: the reference point here is a
// clear day above the treeline, the kind of light that made you squint and
// reach for sunglasses on the ride. Rendering that in a dark theme is a night
// photo of a mountain — technically the same subject, but it has thrown away
// the one fact ("cold, bright, a lot of it") that the whole section exists to
// carry. So this section is the outlier on purpose: sky fading to snow, ink
// dark enough to read but never black, because black would be a room light and
// this isn't a room.
//
// WHY EXACTLY ONE SATURATED BLUE, EVER. A route line, a PR, an active tab, a
// water fill, an elevation profile — a conventional dashboard would give each
// of those its own hue and let the page argue with itself. Every one of those
// signals is trying to say "this is the important part," so if all of them are
// loud, none of them is. `lake` is rationed to the single most important mark
// in whatever view it's on — the route line on a card, the route on the map,
// nothing else — so when it appears the eye has nowhere else to go. Everything
// that isn't the answer to "where did the effort go" sits in granite or
// graniteSoft, which is what makes the blue legible as an answer instead of as
// decoration.
//
// WHY A SPORT IS A MARK AND A WORD, NOT A COLOUR. Strava's own history is the
// warning here: give every sport family its own chip colour and by the time
// you've added gravel rides, virtual rides and indoor trainers to cycling
// alone, the legend is longer than the map. Colour in this palette is reserved
// for *meaning* — water is glacier, land effort is fir, danger-zone exertion is
// alpenglow — so it stays a small, memorable vocabulary instead of growing one
// swatch per taxonomy entry. A sport says what it is with an icon and a label,
// the same way a page number says what page it is: legible, not decorative.
//
// WHY ELEVATION IS TERRAIN, NOT A CHART. A line chart of altitude over time
// asks the reader to do arithmetic — rise over run, translated back into "was
// that steep." A filled silhouette in `fir` over a `scree` ground reads the
// way the actual climb felt: a shape you recognise as a hill before you've
// consciously parsed a single axis. Fills over lines, everywhere elevation
// appears, for the same reason a topo map shades slope instead of labelling it.
export const ALPINE = {
	sky: '#dceaf4', // the page's ground — a washed high-altitude blue-white
	skyDeep: '#9fc4dd', // the gradient's far end, top of frame
	snow: '#f8fbfd', // cards, the paper things are printed on
	granite: '#3d4a55', // body text, the rock the whole palette is built on
	graniteSoft: '#6b7b88', // secondary text, axis labels, the "off" state
	lake: '#1c6e8c', // THE accent. Route lines, links, active states.
	lakeDeep: '#12495e', // hover/pressed, and the deep end of a gradient
	glacier: '#8fd0d8', // a second cold tone: water fills, swim sports
	fir: '#3f6b52', // subalpine fir — hikes, trails, elevation fills
	larch: '#d99a3a', // the one warm note. Autumn larch. PRs, favourites, peaks.
	scree: '#c9d4dc', // hairlines, borders, empty grid cells
	alpenglow: '#c96f5e', // reserved for maximum-exertion marks only
} as const;

export type AlpineColor = (typeof ALPINE)[keyof typeof ALPINE];

// Exertion is a TSS-equivalent score (ACTIVITIES.md §3): an hour at functional
// threshold scores 100, regardless of which of the five cascade methods got it
// there. These breakpoints read that same scale visually — the same way a power
// meter's zone chart is calibrated to threshold rather than to a fixed wattage,
// so the label means the same thing for a four-hour endurance ride and a
// forty-minute threshold interval.
export const EXERTION_SCALE = [
	{ max: 50, label: 'easy' as const, ink: 'graniteSoft' as const },
	{ max: 100, label: 'steady' as const, ink: 'lake' as const },
	{ max: 200, label: 'hard' as const, ink: 'lakeDeep' as const },
	{ max: Infinity, label: 'brutal' as const, ink: 'alpenglow' as const },
];

/** The visual weight for an exertion score: a colour from ALPINE. */
export function exertionInk(score: number | null | undefined): AlpineColor {
	const bucket = EXERTION_SCALE.find((b) => (score ?? 0) < b.max) ?? EXERTION_SCALE[EXERTION_SCALE.length - 1];
	return ALPINE[bucket.ink];
}

/** The word for an exertion score: 'easy' | 'steady' | 'hard' | 'brutal'. */
export function exertionLabel(score: number | null | undefined): 'easy' | 'steady' | 'hard' | 'brutal' {
	const bucket = EXERTION_SCALE.find((b) => (score ?? 0) < b.max) ?? EXERTION_SCALE[EXERTION_SCALE.length - 1];
	return bucket.label;
}

// One string so ActivityLayout and any future share card (the month-in-review
// family FilmLayout's siblings already use) request the exact same font set —
// two requests for the same stylesheet cost nothing, but two *different*
// weight/style subsets do, and drift apart the moment someone edits one copy.
export const FONT_LINK =
	'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:ital,wght@0,400..700;1,400..700&display=swap';
