// Geometry for the exploded view on /projects/flight-poster. Each layer is drawn
// flat (W × H, y down) and sheared into isometric by one SVG matrix: the panel's
// width runs down-right at 30°, its height straight up, and the layers spread
// back along the depth axis, up and to the right.

export const W = 150;

export const H = 200;

const COS = Math.cos(Math.PI / 6);

const SIN = 0.5;

/** Screen position of the front layer's top-left corner, and the gap between layers. */
const ORIGIN = { x: 230, y: 300 };

const GAP = 92;

export interface Point {
	x: number;
	y: number;
}

export interface Layer {
	key: 'frame' | 'glass' | 'mat' | 'panel' | 'board' | 'back';
	name: string;
	spec: string;
}

/** Front to back. */
export const LAYERS: Layer[] = [
	{ key: 'frame', name: 'Frame', spec: 'portrait, 3 : 4' },
	{ key: 'glass', name: 'Glazing', spec: 'clear, in front of the ink' },
	{ key: 'mat', name: 'Mat', spec: 'hides the panel border' },
	{ key: 'panel', name: 'E-ink panel', spec: '13.3″ Spectra 6 · 1200 × 1600 · six inks' },
	{ key: 'board', name: 'Driver board', spec: 'ESP32-S3 · 16 MB PSRAM · microSD' },
	{ key: 'back', name: 'Back board', spec: 'USB-C out to the wall' },
];

function corner(depth: number): Point {
	return { x: ORIGIN.x + depth * GAP * COS, y: ORIGIN.y - depth * GAP * SIN };
}

/** The SVG transform that lays layer `depth` (0 = front) into the scene. */
export function layerMatrix(depth: number): string {
	const c = corner(depth);

	return `matrix(${COS.toFixed(4)} ${SIN} 0 1 ${c.x.toFixed(1)} ${c.y.toFixed(1)})`;
}

/** Where a layer's leader line ends: a point just inside its top-left corner.
 *  Every layer's corner is above every layer in front of it, so a horizontal
 *  leader from the left margin crosses nothing. */
export function leaderEnd(depth: number): Point {
	const c = corner(depth);

	return { x: c.x + 10 * COS, y: c.y + 10 * SIN + 6 };
}

export const VIEWBOX = '0 62 760 530';
