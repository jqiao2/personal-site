// Order a line-drawing graph into a single rideable sequence with the least
// possible backtracking — the open Route Inspection (Chinese Postman) problem.
//
// A country outline is one simple closed loop: every vertex has degree 2, so it
// is already Eulerian and you trace it once with no retracing. A line drawing
// (a sketch, a logo, Snoopy) is instead a *graph* — strokes meet at junctions
// (degree ≥ 3) and stop at endpoints (degree 1). Such a graph usually has no way
// to cover every stroke exactly once (the Seven Bridges of Königsberg result:
// an Eulerian trail exists only when 0 or 2 vertices are odd-degree). Wherever it
// doesn't, some strokes must be ridden twice. This picks *which* to double so the
// doubled mileage is minimal, then emits one ordered path over the whole drawing.
//
// Method (Edmonds–Johnson, open variant):
//   1. bridge disconnected pieces by their nearest nodes (they get ridden twice),
//   2. find odd-degree nodes; shortest path between every pair of them,
//   3. min-weight matching of the odd nodes — but leave two unmatched to be the
//      path's ends (open trail: those two need no doubling), so we duplicate the
//      least total length,
//   4. duplicate the matched shortest paths → a graph with 0 or 2 odd nodes,
//   5. Hierholzer's algorithm walks it into a single Eulerian trail.
//
// Coordinates are plain [x, y] in whatever frame the caller uses (this runs in
// the normalized stencil frame, before placement). Weights are Euclidean length,
// so the matching is scale-invariant — solve it once per drawing, independent of
// where on the map it lands.

export type Pt = [number, number];

/** One stroke between two nodes. `pts` is the full polyline including both
 *  endpoints: `pts[0]` is `nodes[a]`, `pts[last]` is `nodes[b]`. */
export interface Edge {
	a: number;
	b: number;
	pts: Pt[];
}

export interface Graph {
	nodes: Pt[];
	edges: Edge[];
}

function dist(p: Pt, q: Pt): number {
	return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

function polyLen(pts: Pt[]): number {
	let s = 0;
	for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
	return s;
}

// --- union-find over nodes, to find and bridge disconnected pieces ----------

function components(graph: Graph): number[] {
	const parent = graph.nodes.map((_, i) => i);
	const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
	for (const e of graph.edges) parent[find(e.a)] = find(e.b);
	return graph.nodes.map((_, i) => find(i));
}

/** Connect a disconnected drawing into one piece by repeatedly adding a straight
 *  bridge between the nearest pair of nodes in two different components. A bridge
 *  is a real (short) edge, so the trail rides it — twice, since it dead-ends the
 *  degree count — which is the unavoidable transfer mileage between separate
 *  strokes. Returns a new edge list; `graph.edges` is left untouched. */
function bridgeComponents(graph: Graph): Edge[] {
	const edges = graph.edges.slice();
	let comp = components({ nodes: graph.nodes, edges });
	let distinct = new Set(comp).size;
	while (distinct > 1) {
		let bu = -1, bv = -1, bd = Infinity;
		for (let u = 0; u < graph.nodes.length; u++) {
			for (let v = u + 1; v < graph.nodes.length; v++) {
				if (comp[u] === comp[v]) continue;
				const d = dist(graph.nodes[u], graph.nodes[v]);
				if (d < bd) { bd = d; bu = u; bv = v; }
			}
		}
		if (bu < 0) break; // no cross-component pair (isolated node with no edges)
		edges.push({ a: bu, b: bv, pts: [graph.nodes[bu], graph.nodes[bv]] });
		comp = components({ nodes: graph.nodes, edges });
		distinct = new Set(comp).size;
	}
	return edges;
}

// --- shortest paths between nodes (for matching odd vertices) ---------------

interface ShortestPaths {
	cost: number[][]; // cost[i][j] = shortest distance between node i and j
	next: number[][]; // next hop node from i toward j, or -1
	edgeVia: (number | null)[][]; // index (into `edges`) of the edge used for that hop
}

/** Floyd–Warshall over the node graph. The drawing has a handful of nodes, so
 *  O(n³) is nothing, and we get every odd-pair distance in one shot plus the
 *  hop table to reconstruct which edges a matched pair's path doubles. Parallel
 *  edges between the same nodes: the lightest wins. */
function shortestPaths(nodes: Pt[], edges: Edge[]): ShortestPaths {
	const n = nodes.length;
	const cost = Array.from({ length: n }, () => Array(n).fill(Infinity));
	const next = Array.from({ length: n }, () => Array(n).fill(-1));
	const edgeVia: (number | null)[][] = Array.from({ length: n }, () => Array(n).fill(null));
	for (let i = 0; i < n; i++) { cost[i][i] = 0; next[i][i] = i; }
	edges.forEach((e, idx) => {
		const w = polyLen(e.pts);
		if (w < cost[e.a][e.b]) {
			cost[e.a][e.b] = cost[e.b][e.a] = w;
			next[e.a][e.b] = e.b; next[e.b][e.a] = e.a;
			edgeVia[e.a][e.b] = edgeVia[e.b][e.a] = idx;
		}
	});
	for (let k = 0; k < n; k++)
		for (let i = 0; i < n; i++)
			for (let j = 0; j < n; j++)
				if (cost[i][k] + cost[k][j] < cost[i][j]) {
					cost[i][j] = cost[i][k] + cost[k][j];
					next[i][j] = next[i][k];
				}
	return { cost, next, edgeVia };
}

/** The edges (by index) along the shortest path from `i` to `j`. */
function pathEdges(sp: ShortestPaths, i: number, j: number): number[] {
	const out: number[] = [];
	let cur = i;
	while (cur !== j) {
		const nx = sp.next[cur][j];
		if (nx < 0) break;
		const via = sp.edgeVia[cur][nx];
		if (via != null) out.push(via);
		cur = nx;
	}
	return out;
}

// --- min-weight matching of odd nodes, leaving two as trail ends ------------
//
// Odd nodes must be paired and their connecting path doubled to make the graph
// traceable — except two, which stay odd and become the open trail's start and
// end (an open Eulerian trail wants exactly two odd nodes). So we minimize the
// doubled length while leaving up to two odd nodes unmatched. Odd counts are
// small (a drawing has maybe a dozen junctions), so exact recursion with memo
// over the bitmask beats pulling in a Blossom matching dependency.
// ponytail: exponential in odd-node count; a drawing with >~22 odd nodes would
// crawl. Cap + greedy fallback if that ever shows up — it hasn't.

function matchOdd(odd: number[], cost: number[][]): [number, number][] {
	const m = odd.length;
	const memo = new Map<string, { c: number; pairs: [number, number][] }>();
	function solve(mask: number, skips: number): { c: number; pairs: [number, number][] } {
		if (mask === 0) return { c: 0, pairs: [] };
		const key = `${mask},${skips}`;
		const hit = memo.get(key);
		if (hit) return hit;
		let i = 0;
		while (!(mask & (1 << i))) i++;
		const rest = mask & ~(1 << i);
		let best: { c: number; pairs: [number, number][] } = { c: Infinity, pairs: [] };
		// leave i as a trail end (free), if we still may
		if (skips > 0) {
			const sub = solve(rest, skips - 1);
			if (sub.c < best.c) best = sub;
		}
		// or pair i with some j
		for (let j = i + 1; j < m; j++) {
			if (!(mask & (1 << j))) continue;
			const sub = solve(rest & ~(1 << j), skips);
			const c = cost[odd[i]][odd[j]] + sub.c;
			if (c < best.c) best = { c, pairs: [[odd[i], odd[j]], ...sub.pairs] };
		}
		memo.set(key, best);
		return best;
	}
	return solve((1 << m) - 1, 2).pairs;
}

// --- Hierholzer: walk the Eulerian (multi)graph into one trail --------------

/** One directed use of an edge, `pts` already oriented to start at `from`. */
interface HalfEdge { to: number; pts: Pt[]; id: number; }

function eulerTrail(nodes: Pt[], edges: Edge[], start: number): Pt[] {
	const adj: HalfEdge[][] = nodes.map(() => []);
	const used: boolean[] = [];
	edges.forEach((e) => {
		const id = used.length;
		used.push(false);
		adj[e.a].push({ to: e.b, pts: e.pts, id });
		adj[e.b].push({ to: e.a, pts: e.pts.slice().reverse(), id });
	});
	// Hierholzer with an explicit stack; emit edges in reverse-finish order.
	const nodeStack: number[] = [start];
	const edgeStack: (HalfEdge | null)[] = [null];
	const trail: HalfEdge[] = [];
	while (nodeStack.length) {
		const v = nodeStack[nodeStack.length - 1];
		let he: HalfEdge | undefined;
		while ((he = adj[v].pop()) && used[he.id]) { /* skip spent half-edge */ }
		if (he && !used[he.id]) {
			used[he.id] = true;
			nodeStack.push(he.to);
			edgeStack.push(he);
		} else {
			nodeStack.pop();
			const done = edgeStack.pop();
			if (done) trail.push(done);
		}
	}
	trail.reverse();
	// Stitch the oriented polylines, dropping each shared join point.
	if (trail.length === 0) return [nodes[start]];
	const out: Pt[] = trail[0].pts.slice();
	for (let i = 1; i < trail.length; i++) out.push(...trail[i].pts.slice(1));
	return out;
}

// --- entry point ------------------------------------------------------------

export interface EulerResult {
	/** The whole drawing as one ordered polyline, ready to place + route. */
	path: Pt[];
	/** Total length doubled (bridges + matched paths) — the backtracking the
	 *  drawing forces, in the same units as the node coordinates. */
	doubled: number;
}

/**
 * Order a line-drawing graph into a single continuous polyline that covers every
 * stroke, doubling the least possible length. Bridges disconnected pieces, solves
 * the open route-inspection matching, and returns the Eulerian trail.
 */
export function eulerRoute(graph: Graph): EulerResult {
	if (graph.edges.length === 0) throw new Error('The drawing has no lines to route.');
	// 1. one connected piece.
	let edges = bridgeComponents(graph);
	const bridged = edges.length - graph.edges.length;
	// 2–3. odd nodes → matching that leaves two ends free.
	const deg = graph.nodes.map(() => 0);
	for (const e of edges) { deg[e.a]++; deg[e.b]++; }
	const odd = graph.nodes.map((_, i) => i).filter((i) => deg[i] % 2 === 1);
	const sp = shortestPaths(graph.nodes, edges);
	let doubled = 0;
	if (odd.length > 2) {
		for (const [u, v] of matchOdd(odd, sp.cost)) {
			for (const idx of pathEdges(sp, u, v)) {
				edges.push(edges[idx]); // 4. duplicate the doubled stroke
				doubled += polyLen(edges[idx].pts);
			}
		}
	}
	// bridges are ridden out-and-back, so count their length as doubled too.
	for (let i = graph.edges.length; i < graph.edges.length + bridged; i++) doubled += polyLen(edges[i].pts);
	// 5. start at an odd node if the trail is open, else anywhere.
	const finalDeg = graph.nodes.map(() => 0);
	for (const e of edges) { finalDeg[e.a]++; finalDeg[e.b]++; }
	const startOdd = graph.nodes.findIndex((_, i) => finalDeg[i] % 2 === 1);
	const start = startOdd >= 0 ? startOdd : edges[0].a;
	return { path: eulerRoute0(graph.nodes, edges, start), doubled };
}

// split out so the trail walk is testable on a prepared multigraph.
function eulerRoute0(nodes: Pt[], edges: Edge[], start: number): Pt[] {
	return eulerTrail(nodes, edges, start);
}
