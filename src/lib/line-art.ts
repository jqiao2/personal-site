// Turn a line-drawing image into a routable graph.
//
// The bike-outline tool traces a *shape* as a road route. A country is one clean
// closed ring; a hand drawing is messier — a raster of dark strokes on light
// paper. This file sanitizes that raster and vectorizes its strokes into the
// { nodes, edges } graph that `postman.ts` orders and the stencil draws.
//
// Pipeline: ImageData → binary ink mask (threshold + despeckle) → centreline
// polylines (skeleton tracing, injected so the WASM stays out of this module and
// the graph maths below is testable) → snap shared endpoints into a graph →
// normalize into the same centred unit box the country stencil uses.
//
// Coordinates here are image pixels until `normalizeGraph`, which mirrors
// `normalizeShape` in bike-route.ts so a drawing and a country place identically.

import { simplify } from './route-shape';
import type { Graph, Pt } from './postman';

export interface Mask {
	w: number;
	h: number;
	ink: Uint8Array; // 1 where the pixel is a stroke, 0 elsewhere
}

/**
 * Binary ink mask from an image: a pixel is ink when it is dark enough and not
 * transparent. Then despeckle — drop connected blobs smaller than `minBlob`
 * pixels, the specks and JPEG noise that would otherwise trace into hairs. This
 * is the "sanitize" step; threshold and minBlob are the two knobs the page
 * exposes.
 */
export function imageToMask(img: ImageData, threshold = 128, minBlob = 12): Mask {
	const { width: w, height: h, data } = img;
	const ink = new Uint8Array(w * h);
	for (let i = 0; i < w * h; i++) {
		const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
		const lum = 0.299 * r + 0.587 * g + 0.114 * b;
		ink[i] = a > 32 && lum < threshold ? 1 : 0;
	}
	despeckle(ink, w, h, minBlob);
	return { w, h, ink };
}

/** Zero out 8-connected ink blobs below `minBlob` pixels. Iterative flood fill. */
function despeckle(ink: Uint8Array, w: number, h: number, minBlob: number): void {
	const seen = new Uint8Array(w * h);
	const stack: number[] = [];
	for (let s = 0; s < w * h; s++) {
		if (!ink[s] || seen[s]) continue;
		const blob: number[] = [];
		stack.push(s); seen[s] = 1;
		while (stack.length) {
			const p = stack.pop()!;
			blob.push(p);
			const x = p % w, y = (p / w) | 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
					const q = ny * w + nx;
					if (ink[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
				}
		}
		if (blob.length < minBlob) for (const p of blob) ink[p] = 0;
	}
}

/** The skeleton tracer's contract — matches skeleton-tracing-wasm's
 *  `fromBoolArray(arr, w, h)`, injected so this module never imports the WASM. */
export interface Tracer {
	fromBoolArray(arr: ArrayLike<number>, w: number, h: number): { polylines: Pt[][] };
}

/**
 * Snap a set of stroke polylines into a graph. Skeleton tracing already splits
 * strokes at junctions, so two strokes that meet share an endpoint — cluster
 * endpoints within `snapDist` pixels into one node and each polyline becomes an
 * edge between its two nodes. Each polyline is simplified first (RDP, the site's
 * own `simplify`) to shed tracing jitter. Degenerate strokes (a single point,
 * or a loop shorter than snapDist) are dropped.
 */
export function buildGraph(polylines: Pt[][], snapDist = 4, simplifyTol = 1.5): Graph {
	const nodes: Pt[] = [];
	const snapDist2 = snapDist * snapDist;
	const nodeAt = (p: Pt): number => {
		for (let i = 0; i < nodes.length; i++) {
			const dx = nodes[i][0] - p[0], dy = nodes[i][1] - p[1];
			if (dx * dx + dy * dy <= snapDist2) return i;
		}
		nodes.push(p);
		return nodes.length - 1;
	};
	const edges: Graph['edges'] = [];
	for (const raw of polylines) {
		if (raw.length < 2) continue;
		const pts = simplify(raw, simplifyTol);
		if (pts.length < 2) continue;
		const a = nodeAt(pts[0]);
		const b = nodeAt(pts[pts.length - 1]);
		// Re-anchor the endpoints onto their canonical node positions so shared
		// junctions are exactly coincident (the graph relies on it).
		const geo = pts.slice();
		geo[0] = nodes[a];
		geo[geo.length - 1] = nodes[b];
		const len = geo.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - geo[i - 1][0], p[1] - geo[i - 1][1]) : 0), 0);
		if (a === b && len <= snapDist) continue; // a tiny self-loop is noise
		edges.push({ a, b, pts: geo });
	}
	return { nodes, edges };
}

/**
 * Fit a pixel-space graph into the centred unit box the stencil draws in — the
 * longer axis spans [-0.5, 0.5], y already points down (image rows do too), so
 * no latitude negation is needed here. Returns a new graph; the input is
 * untouched. `paths` (the edge polylines) is what the SVG stencil renders.
 */
export function normalizeGraph(graph: Graph): { graph: Graph; paths: Pt[][] } {
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (const n of graph.nodes) {
		if (n[0] < minX) minX = n[0];
		if (n[0] > maxX) maxX = n[0];
		if (n[1] < minY) minY = n[1];
		if (n[1] > maxY) maxY = n[1];
	}
	const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
	const span = Math.max(maxX - minX, maxY - minY) || 1;
	const f = (p: Pt): Pt => [(p[0] - cx) / span, (p[1] - cy) / span];
	const nodes = graph.nodes.map(f);
	const edges = graph.edges.map((e) => ({ a: e.a, b: e.b, pts: e.pts.map(f) }));
	return { graph: { nodes, edges }, paths: edges.map((e) => e.pts) };
}

/** The whole browser-side path: sanitize → trace → graph → normalize. Kept thin;
 *  the caller supplies the ImageData and a loaded tracer. */
export function imageToGraph(
	img: ImageData,
	tracer: Tracer,
	opts: { threshold?: number; minBlob?: number; snapDist?: number } = {},
): { graph: Graph; paths: Pt[][] } {
	const mask = imageToMask(img, opts.threshold, opts.minBlob);
	const { polylines } = tracer.fromBoolArray(mask.ink, mask.w, mask.h);
	const graph = buildGraph(polylines, opts.snapDist);
	if (graph.edges.length === 0) throw new Error('No strokes found — try a cleaner line drawing or a lower threshold.');
	return normalizeGraph(graph);
}
