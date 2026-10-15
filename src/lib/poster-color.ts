// The dominant colour of a TMDB poster — what the closet prints a disc's spine
// in. Kept free of the site's other modules so the backfill script can import
// it straight from Node.

/** Smallest TMDB poster; plenty to find the dominant colour of. */
const THUMB = 'https://image.tmdb.org/t/p/w92';

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

		const { dominant } = await sharp(new Uint8Array(await res.arrayBuffer())).stats();

		return `#${[dominant.r, dominant.g, dominant.b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
	} catch {
		return null;
	}
}
