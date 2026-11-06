// The background colour of a TMDB poster — what the closet prints a disc's spine
// in. Kept free of the site's other modules so the backfill script can import
// it straight from Node.

/** Smallest TMDB poster; plenty to find the background colour of. */
const THUMB = 'https://image.tmdb.org/t/p/w92';

/** How many pixels in from each edge count as the poster's frame. */
const BAND = 4;

/** Share of the frame, then of the whole poster, a colour needs to count as the poster's. */
const MIN_FRAME_SHARE = 0.05;

const MIN_POSTER_SHARE = 0.005;

/** Summed r, g, b and the pixel count of one colour bucket. */
type Bucket = [number, number, number, number];

/** A region's buckets, biggest first, and how many pixels they hold. */
interface Tally {
	buckets: Bucket[];
	total: number;
}

/** Black, white or grey: too dark, too pale or too little spread between channels. */
function isNeutral(r: number, g: number, b: number): boolean {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);

	return max < 72 || min > 215 || max - min < 40;
}

/** Colours bucketed at 4 bits a channel, so a soft gradient reads as one colour; biggest first. */
function bucketsOf(px: Uint8Array, width: number, height: number, channels: number, keep: (x: number, y: number) => boolean): Tally {
	const buckets = new Map<number, Bucket>();
	let total = 0;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (!keep(x, y)) continue;
			const i = (y * width + x) * channels;
			const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
			const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
			const s = buckets.get(key) ?? [0, 0, 0, 0];
			s[0] += r;
			s[1] += g;
			s[2] += b;
			s[3]++;
			total++;
			buckets.set(key, s);
		}
	}

	return { buckets: [...buckets.values()].sort((a, b) => b[3] - a[3]), total };
}

/** The biggest bucket that isn't neutral and holds at least `share` of the pixels. */
function colourful({ buckets, total }: Tally, share: number): Bucket | undefined {
	return buckets.find(([r, g, b, n]) => n >= total * share && !isNeutral(r / n, g / n, b / n));
}

/**
 * The poster's spine colour, biased away from black and white. The top and side
 * edges are tried first: sampling the frame rather than the whole image keeps a
 * big central figure from winning over the background it sits on, and the
 * bottom edge is left out because it is usually the billing block or a dark
 * vignette. A black or white frame gives way to the poster's main colour, and
 * only a poster with no real colour anywhere keeps its neutral frame.
 */
export function frameColor(px: Uint8Array, width: number, height: number, channels: number): string {
	const frame = bucketsOf(px, width, height, channels, (x, y) => x < BAND || x >= width - BAND || y < BAND);

	const [r, g, b, n] =
		colourful(frame, MIN_FRAME_SHARE) ??
		colourful(bucketsOf(px, width, height, channels, () => true), MIN_POSTER_SHARE) ??
		frame.buckets[0];

	return `#${[r, g, b].map((c) => Math.round(c / n).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * "#rrggbb", or null when there is no poster or it can't be read. sharp is
 * loaded on demand and a failure is swallowed: a missing colour only means the
 * spine falls back to a stock one.
 */
export async function posterColor(posterPath: string | null): Promise<string | null> {
	if (!posterPath) return null;

	try {
		const res = await fetch(`${THUMB}${posterPath}`);

		if (!res.ok) return null;
		const { default: sharp } = await import('sharp');

		const { data, info } = await sharp(new Uint8Array(await res.arrayBuffer()))
			.removeAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });

		return frameColor(data, info.width, info.height, info.channels);
	} catch {
		return null;
	}
}
