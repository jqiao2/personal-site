// Preparing a photograph for upload, in the browser, before it is ever sent.
// Pulled out of MealEditor.astro so the composer's script is DOM wiring and this
// is the pixel work — decode, measure, shrink, encode. Browser-only (it uses
// createImageBitmap, canvas and URL), so it is imported by the editor's client
// <script>, never by anything server-side.
//
// MEASURED here because the mixed-orientation wall needs each photo's aspect
// ratio and the browser has to decode the image to show the thumbnail anyway —
// measuring it again on the server would mean decoding every upload twice.
//
// SHRUNK here because a phone photograph does not fit through the door. A modern
// iPhone writes 5–12 MB per frame; Vercel refuses a serverless request body over
// 4.5 MB with a platform-level 413, so the full-size original could never reach
// the endpoint no matter what the endpoint permitted.
//
// The size is chosen against what the page actually paints, because the bucket is
// served raw — there is no CDN transform and no srcset behind these URLs, so
// whatever is stored is what every reader downloads. The largest render on the
// site is a lone photograph at `min(64vh, 520px)` tall, about 780 px wide at 3:2;
// the widest is a phone's 360 px column. A 1600 px long edge covers the first at
// 2× and the second at 3×, and is half the pixels — a quarter of the area — of
// the 2200 px this used to keep. Instagram stores 1080 px for the same job, so
// this is still the generous end of reasonable.

/** A photograph chosen in the browser, decoded/measured/shrunk, ready to send. */
export interface PreparedPhoto {
	file: File;
	/** An object URL for the preview thumbnail; the caller owns revoking it. */
	url: string;
	width: number;
	height: number;
}

/** Long edge, in pixels, of a stored photograph. */
export const MAX_EDGE = 1600;
/**
 * Re-encode anything above this, even when its dimensions are fine.
 *
 * Low enough to catch a correctly-sized frame that is merely encoded at camera
 * quality: at MAX_EDGE this encoder lands around 200–400 KB, so anything
 * meaningfully above that has headroom left in it. Below the line the file the
 * camera wrote is kept rather than paying a second lossy pass to save a few
 * kilobytes.
 */
const REENCODE_OVER = 600 * 1024;
/** Encoder quality, for either format. */
const QUALITY = 0.82;

/**
 * Encode a canvas, preferring WebP — roughly a quarter smaller than JPEG at
 * matching quality, and every browser that can run this editor can display it.
 *
 * The result's own type is what decides, not a feature test, because `toBlob`
 * does not report an unsupported format: it silently encodes a PNG instead,
 * which for a photograph is several times larger than the JPEG it was standing
 * in for. Asking the blob what it came out as is the only answer that cannot be
 * wrong.
 */
async function encode(canvas: HTMLCanvasElement): Promise<Blob | null> {
	const webp = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, 'image/webp', QUALITY),
	);
	if (webp?.type === 'image/webp') return webp;
	return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
}

/** Decode, measure and (when it helps) shrink a picked file into an uploadable. */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
	// `from-image` so a portrait held sideways is stored the way up it was taken:
	// the EXIF rotation a phone records is applied to the pixels here, and canvas
	// would otherwise drop it on re-encoding.
	let bitmap: ImageBitmap | null = null;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	} catch {
		// A format this browser cannot decode still goes up as it arrived,
		// unmeasured. Refusing it here would be guessing on the server's behalf
		// about what it can store.
		return { file, url: URL.createObjectURL(file), width: 0, height: 0 };
	}

	const { width, height } = bitmap;
	const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
	// Small enough already: keep the file the camera wrote rather than paying a
	// second lossy encode for nothing.
	if (scale === 1 && file.size <= REENCODE_OVER) {
		bitmap.close();
		return { file, url: URL.createObjectURL(file), width, height };
	}

	const w = Math.round(width * scale);
	const h = Math.round(height * scale);
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);
	bitmap.close();
	const blob = await encode(canvas);
	if (!blob) return { file, url: URL.createObjectURL(file), width, height };

	// An image that was already within MAX_EDGE can come out of the encoder
	// bigger than it went in — something compressed harder than this by whoever
	// made it, or a flat graphic that JPEG handles worse than the PNG it arrived
	// as. Keep whichever is actually smaller. When the dimensions did change the
	// new file wins regardless: those pixels are the point, and `width`/`height`
	// below have to describe the file being sent.
	if (scale === 1 && blob.size >= file.size) {
		return { file, url: URL.createObjectURL(file), width, height };
	}

	// The extension has to follow the re-encode: the server derives the stored
	// object's name from this one, and a JPEG called .heic would be served with
	// the wrong type for the rest of its life.
	const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
	const name = `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.${ext}`;
	const shrunk = new File([blob], name, { type: blob.type });
	return { file: shrunk, url: URL.createObjectURL(shrunk), width: w, height: h };
}
