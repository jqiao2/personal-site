// Delivery for stored photographs.
//
// Uploads are capped at a 1600 px long edge (see `prepare()` in MealEditor),
// which is the right size for the largest thing the site draws and far too big
// for everything else: the diary lists photographs at 38×30, the contact sheet
// at 124 px tall, a tile at 106. Serving one file to all of them means the
// diary — the page with the most photographs on it by an order of magnitude —
// downloads a full-size frame for every 38 px thumbnail it shows.
//
// So the bucket URL stops being what a page renders and becomes the SOURCE an
// optimiser reads. Vercel's `/_vercel/image` resizes and re-encodes it, and
// each `<img>` carries a `srcset` of the widths it might actually need plus a
// `sizes` telling the browser which to take.
//
// WHY VERCEL AND NOT THE BUCKET ITSELF. R2 has no built-in image transform
// (that's a separate Cloudflare product, Images, with its own bill). Vercel's
// optimiser is already part of the deployment at no extra cost, and it works
// on the photographs already in the bucket rather than only on new ones.
//
// WHAT IT COSTS. Vercel meters image transformations. The bill is bounded by
// the CATALOGUE, not by traffic: a transformation is cached and reused, so the
// ceiling is (photographs × widths actually requested), a few hundred, once —
// not one per page view. `minimumCacheTTL` in astro.config.mjs is set to a
// year to keep it that way.

/**
 * The widths the optimiser is allowed to produce, smallest first.
 *
 * This is a contract with `imagesConfig.sizes` in astro.config.mjs, which
 * imports this very list rather than restating it: `/_vercel/image` refuses a
 * `w` that the deployment did not declare, and two lists that have to agree
 * are two lists that will eventually disagree.
 *
 * The rungs are picked off what the site actually renders, each roughly
 * doubling: 160 for the diary's thumbnails, 320 for the contact sheet and for
 * those same thumbnails on a 3× phone, 640 and 1080 for tiles and for a wall
 * of several, 1600 — the stored size, so a passthrough — for a lone
 * photograph given the full column.
 */
export const PHOTO_WIDTHS = [160, 320, 640, 1080, 1600];

/**
 * 75 because it is the one quality every version of this API has accepted
 * without being told about it in advance. Newer Vercel deployments validate
 * `q` against a `qualities` allowlist, whose default is exactly [75], and the
 * adapter's `imagesConfig` type has no field to widen it with. The encoder is
 * also re-encoding an image already compressed at upload, so the number that
 * matters for how it looks was chosen there, not here.
 */
const QUALITY = 75;

/**
 * True when there is no optimiser to talk to.
 *
 * `/_vercel/image` is served by the deployment, so it exists on preview and
 * production builds and does not exist under `astro dev` — where a request to
 * it would 404 and leave the page with broken images instead of unoptimised
 * ones. Local development therefore keeps the plain bucket URL, which is the
 * behaviour this module replaced and is correct, just heavier.
 */
const RAW = import.meta.env.DEV;

/**
 * One optimised URL, big enough to be painted `width` CSS pixels wide.
 *
 * The width is SNAPPED UP to a declared rung rather than passed through. A
 * caller naturally reaches for the number in the stylesheet — 38, 124, 780 —
 * and none of those are rungs; `/_vercel/image` refuses a `w` the deployment
 * did not declare, so passing one through would turn a layout constant into a
 * broken image. Snapping here means every call site can say what it means and
 * none of them can produce a URL the optimiser will reject.
 */
export function photoSrc(url: string, width: number): string {
	if (RAW) return url;
	const rung = PHOTO_WIDTHS.find((w) => w >= width) ?? PHOTO_WIDTHS[PHOTO_WIDTHS.length - 1];
	return `/_vercel/image?url=${encodeURIComponent(url)}&w=${rung}&q=${QUALITY}`;
}

/**
 * The rungs worth offering for an `<img>` painted at most `cssWidth` wide:
 * everything below 2× that, plus the first rung at or above it so a retina
 * screen is served exactly rather than from the rung beneath.
 *
 * Trimming the top matters more than trimming the bottom. A photograph the
 * layout never paints wider than 456 px has no use for a 1600 px rendition on
 * any screen, whereas a small rung left in the ladder is simply never picked —
 * renditions are produced on demand, so an unrequested rung costs nothing.
 */
export function photoWidthsFor(cssWidth: number): number[] {
	const target = cssWidth * 2;
	const under = PHOTO_WIDTHS.filter((w) => w < target);
	const first = PHOTO_WIDTHS.find((w) => w >= target);
	if (first !== undefined) under.push(first);
	// Painted wider than the largest rung: the ladder tops out at the stored
	// size, which is all there ever was to give.
	return under.length > 0 ? under : [PHOTO_WIDTHS[PHOTO_WIDTHS.length - 1]];
}

/**
 * A `srcset` over `widths`, or undefined when there is nothing to offer —
 * under `astro dev`, or when a caller passes an empty ladder. Undefined rather
 * than an empty string because an empty `srcset` attribute is not ignored by
 * every browser, and `src` alone is the honest fallback.
 *
 * Widths are given as `w` descriptors, which is what lets the browser combine
 * them with `sizes` and the device's pixel ratio. Only rungs the optimiser
 * knows about are emitted; anything else would be a request it refuses.
 */
export function photoSrcSet(url: string, widths: number[]): string | undefined {
	if (RAW) return undefined;
	const rungs = widths.filter((w) => PHOTO_WIDTHS.includes(w)).sort((a, b) => a - b);
	if (rungs.length === 0) return undefined;
	return rungs.map((w) => `${photoSrc(url, w)} ${w}w`).join(', ');
}
