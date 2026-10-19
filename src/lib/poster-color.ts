// The background colour of a TMDB poster — what the closet prints a disc's spine
// in. Kept free of the site's other modules so the backfill script can import
// it straight from Node.

/** Smallest TMDB poster; plenty to find the background colour of. */
const THUMB = 'https://image.tmdb.org/t/p/w92';

/** How many pixels in from each edge count as the poster's frame. */
const BAND = 4;

/**
 * The most common colour along the poster's top and side edges. Sampling the
 * frame rather than the whole image keeps a big central figure from winning
 * over the background it sits on; the bottom edge is left out because it is
 * usually the billing block or a dark vignette, not the background. Colours
 * are bucketed at 4 bits a channel so a soft
 * gradient still reads as one colour, and the winning bucket's mean is returned.
 */
export function frameColor(px: Uint8Array, width: number, height: number, channels: number): string {
	const buckets = new Map<number, [number, number, number, number]>();

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (x >= BAND && x < width - BAND && y >= BAND) continue;
			const i = (y * width + x) * channels;
			const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
			const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
			const s = buckets.get(key) ?? [0, 0, 0, 0];
			s[0] += r;
			s[1] += g;
			s[2] += b;
			s[3]++;
			buckets.set(key, s);
		}
	}

	const [r, g, b, n] = [...buckets.values()].reduce((a, s) => (s[3] > a[3] ? s : a));

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
