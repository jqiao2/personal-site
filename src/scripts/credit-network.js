// Client for the film credit collaboration network (/projects/credit-network).
//
// Renders public/data/credit-network.json — a pre-filtered, pre-laid-out graph
// from scripts/credit-graph/build.mjs — with Sigma (WebGL). The layout arrives
// already settled by ForceAtlas2, so the page paints a readable graph on first
// frame; the same FA2 can be re-run live in a worker to re-settle it.
//
// Nodes are drawn by @sigma/node-piechart, one slice per role the person is
// shown as, so an actor-director is exactly half red / half blue. Which roles
// those are comes from the build's `roleMask` and is NOT re-derived here — the
// build applies a share floor (a 120-film actor who directed 5 is just an
// actor) that the raw per-role counts don't capture.
//
// Readability note: 25,236 nodes cannot all be legible at once. Fitting the
// visible subset's bounding box to a 960px-wide canvas (what frameVisible does)
// and taking the median nearest-neighbour distance gives 2.6px for the full set,
// 7.1px at the 1,600 default and 9.8px at 600. So the "Show top" control is the
// real lever, and it defaults well below the full set.
//
// Those are the shipped positions, which are a *subset* of one layout solved for
// everybody — so the survivors keep the gaps the full graph left them. Pressing
// Re-settle solves the subset on its own and roughly halves the crowding again:
// 7.1px becomes 10.8px at the 1,600 default. That is the whole reason the live
// layout exists, and why filter changes trigger it.
//
// Cost note: nothing here may repaint the whole graph on an interaction. Sigma
// re-runs a reducer per element named in a refresh, and at this size a pass over
// every edge is ~370ms — so hover, filtering and the live layout each touch only
// what can actually have changed. `repaint`/`reindex` below are the two doors.

import Graph from 'graphology';
import Sigma from 'sigma';
import { createNodePiechartProgram } from '@sigma/node-piechart';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import forceAtlas2 from 'graphology-layout-forceatlas2';

const $ = (sel) => document.querySelector(sel);

/** Node radius range in pixels — deliberately small, and a narrow span.
 * The structure worth reading here is the mesh of edges, so nodes are joints in
 * a web rather than a field of discs; a wide size span just returns the canvas
 * to a mass of dots and hides the lines behind them. Prominence still reads,
 * but as a subtle weighting rather than the dominant visual. */
const MIN_R = 1.3;
const MAX_R = 6;
/** Edge thickness from collaboration count, flattened and capped. Kept near
 * hairline so dense regions stay legible as strands. */
const edgeSize = (weight) => Math.min(0.22 + Math.log2(weight) * 0.3, 1.8);
/** How many nodes to show by default. Smaller nodes mean more fit legibly. */
const DEFAULT_TOP_N = 1600;

/** Dimming colours. These have to follow the colour scheme: a light grey on a
 * dark background reads as a *highlight*, which made hovering flash the rest of
 * the graph white. Edges stay alpha-blended so a dense field fades rather than
 * turning into a solid mat. */
const THEME = {
	dark: { node: '#3c3c3c', edge: 'rgba(120,120,120,0.07)', idle: 'rgba(150,160,175,0.22)', halo: '#111' },
	light: { node: '#dcdcdc', edge: 'rgba(90,90,90,0.05)', idle: 'rgba(70,80,95,0.20)', halo: '#fff' },
};
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
let theme = prefersDark.matches ? THEME.dark : THEME.light;

/** Draw a node's name with a halo in the page background colour.
 *
 * Sigma's default label is plain fillText, which over a mesh of tens of
 * thousands of edges lands on top of whatever happens to be behind it and
 * becomes unreadable. Stroking the text in the surface colour first knocks a
 * small gap out of the graph behind each glyph. Geometry matches sigma's
 * default (drawDiscNodeLabel) so labels sit where they always did. */
function drawLabelWithHalo(context, data, settings) {
	if (!data.label) return;
	const size = settings.labelSize;
	const x = data.x + data.size + 3;
	const y = data.y + size / 3;

	context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
	context.lineWidth = 3.5;
	context.lineJoin = 'round';
	context.miterLimit = 2;
	context.strokeStyle = theme.halo;
	context.strokeText(data.label, x, y);
	context.fillStyle = settings.labelColor.color ?? '#111';
	context.fillText(data.label, x, y);
}

/** Fold case and strip diacritics so "toshiro mifune" finds "Toshirō Mifune". */
const foldName = (s) =>
	s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function main() {
	const container = $('#graph');
	const res = await fetch('/data/credit-network.json');
	if (!res.ok) throw new Error(`could not load graph data (${res.status})`);
	const payload = await res.json();
	const { roles, metrics, colorModes, nodes, edges, meta } = payload;

	// --- Decode -------------------------------------------------------------
	// Positional arrays; indices come from nodeFields so the two files can't
	// silently drift apart when a column is added.
	const at = (field) => payload.nodeFields.indexOf(field);
	const iId = at('tmdbId'), iName = at('name'), iX = at('x'), iY = at('y');
	const iFilms = at('films'), iMask = at('roleMask'), iGrossFilms = at('grossFilms');
	const bucketAt = Object.fromEntries(colorModes.filter((m) => m.field).map((m) => [m.key, at(m.field)]));
	// A dimension can colour by one field and filter on another: country paints
	// the dominant one but matches on every country the person has worked in.
	const memberAt = Object.fromEntries(
		colorModes.filter((m) => m.filterField).map((m) => [m.key, at(m.filterField)]),
	);
	const roleAt = roles.map((r) => at(`n_${r.role}`));
	const metricAt = Object.fromEntries(metrics.map((m) => [m.key, at(m.key)]));

	const graph = new Graph({ type: 'undirected' });
	nodes.forEach((n, i) => {
		const held = roles.map((_r, ri) => Boolean(n[iMask] & (1 << ri)));
		const attrs = {
			label: n[iName],
			tmdbId: n[iId],
			x: n[iX],
			y: n[iY],
			films: n[iFilms],
			grossFilms: n[iGrossFilms],
			counts: roles.map((_r, ri) => n[roleAt[ri]]),
			metricValues: Object.fromEntries(metrics.map((m) => [m.key, n[metricAt[m.key]]])),
			buckets: Object.fromEntries(Object.entries(bucketAt).map(([k, idx]) => [k, n[idx]])),
			members: Object.fromEntries(Object.entries(memberAt).map(([k, idx]) => [k, n[idx]])),
			held,
			type: 'piechart',
			color: roles[held.findIndex(Boolean)].color,
		};
		roles.forEach((r, ri) => {
			// s_* is the slice's share (equal wedges for every role shown);
			// c_* is its colour, filled in by applyColors below.
			attrs[`s_${r.role}`] = held[ri] ? 1 : 0;
			attrs[`c_${r.role}`] = r.color;
		});
		graph.addNode(String(i), attrs);
	});
	for (const [s, t, weight] of edges) {
		graph.addUndirectedEdge(String(s), String(t), { weight, size: edgeSize(weight) });
	}

	// --- Sizing -------------------------------------------------------------
	// Each metric has its own distribution (films 1..138, prominence 0..108, hit
	// size 0..0.9), so map onto the radius range by position within the metric's
	// own span. sqrt keeps the long tail from swamping everything.
	const metricRange = {};
	for (const m of metrics) {
		const vals = graph.mapNodes((_k, a) => a.metricValues[m.key]);
		metricRange[m.key] = { min: Math.min(...vals), max: Math.max(...vals) };
	}
	function applySizes(metricKey) {
		const { min, max } = metricRange[metricKey];
		const span = max - min || 1;
		graph.forEachNode((key, a) => {
			const t = Math.sqrt(Math.max(0, (a.metricValues[metricKey] - min) / span));
			graph.setNodeAttribute(key, 'size', MIN_R + (MAX_R - MIN_R) * t);
		});
	}

	// --- Colour --------------------------------------------------------------
	/** Paint the pie slices for the active colour dimension.
	 *
	 * Only `role` is multi-valued, and it's the reason nodes are pies at all:
	 * its slices differ, so a hyphenate reads half-and-half. Region and era are
	 * single-valued, so every slice gets the same colour and the node renders as
	 * a plain disc — no separate node program needed. */
	const isDark = () => theme === THEME.dark;
	function applyColors() {
		const mode = colorModes.find((m) => m.key === state.colorBy) ?? colorModes[0];
		graph.forEachNode((key, a) => {
			if (mode.key === 'role') {
				roles.forEach((r) => graph.setNodeAttribute(key, `c_${r.role}`, r.color));
				graph.setNodeAttribute(key, 'color', roles[a.held.findIndex(Boolean)].color);
				return;
			}
			const entry = mode.legend[a.buckets[mode.key]] ?? mode.legend[mode.legend.length - 1];
			const hex = isDark() ? entry.dark : entry.light;
			roles.forEach((r) => graph.setNodeAttribute(key, `c_${r.role}`, hex));
			graph.setNodeAttribute(key, 'color', hex);
		});
	}

	/** The label a node carries in the current colour dimension, for the panel. */
	/** Where a person sits in every non-role dimension, named in text. Shown
	 * regardless of what the graph is currently coloured by — the countries
	 * someone works in are worth reading even while looking at roles — and it's
	 * the secondary encoding that keeps identity off hue alone. Multi-valued
	 * dimensions list all their buckets, the coloured one first. */
	function dimensionLabels(attrs) {
		return colorModes
			.filter((m) => m.field)
			.map((m) => {
				const dominant = attrs.buckets[m.key];
				const rest = bucketsOf(attrs, m).filter((b) => b !== dominant);
				const names = [dominant, ...rest].map((i) => m.legend[i]?.label).filter(Boolean);
				return names.length ? `${m.label}: ${names.join(', ')}` : null;
			})
			.filter(Boolean);
	}

	/** Node keys ranked by the current metric, best first. Drives "Show top N". */
	let ranked = [];
	function applyRanking(metricKey) {
		ranked = graph
			.nodes()
			.sort((a, b) => graph.getNodeAttribute(b, 'metricValues')[metricKey] - graph.getNodeAttribute(a, 'metricValues')[metricKey]);
	}

	// --- Renderer ------------------------------------------------------------
	const NodePiechartProgram = createNodePiechartProgram({
		slices: roles.map((r) => ({
			color: { attribute: `c_${r.role}`, defaultValue: r.color },
			value: { attribute: `s_${r.role}` },
		})),
		// A node program's own drawLabel wins over the renderer's default, so the
		// halo has to be handed to the program rather than set in settings.
		drawLabel: drawLabelWithHalo,
	});

	const state = {
		metric: metrics[0].key,
		colorBy: colorModes[0].key,
		topN: Math.min(DEFAULT_TOP_N, nodes.length),
		minWeight: meta.minEdge,
		minFilms: 0,
		// One enabled-bucket set per dimension, all on to start. Filters combine as
		// OR within a dimension and AND across them, so unticking everything but
		// Actor and United States leaves exactly the US actors.
		enabled: Object.fromEntries(
			colorModes.map((m) => [m.key, new Set(m.legend.map((_l, i) => i))]),
		),
		hovered: null,
		selected: null,
		neighbors: null,
	};

	applySizes(state.metric);
	applyRanking(state.metric);

	const renderer = new Sigma(graph, container, {
		nodeProgramClasses: { piechart: NodePiechartProgram },
		defaultEdgeColor: theme.idle,
		labelFont: 'system-ui, sans-serif',
		labelSize: 12,
		labelWeight: '600',
		labelColor: { color: getComputedStyle(document.body).color || '#111' },
		// Only the larger (i.e. more prominent) nodes earn a label. Scaled to the
		// small node radii above — at the old threshold nothing would qualify.
		labelRenderedSizeThreshold: 4.6,
		zIndex: true,
		minCameraRatio: 0.02,
		maxCameraRatio: 3,
		// A collapsed container (a very short window, or the page rendered while
		// hidden) otherwise throws and takes the whole sidebar down with it. The
		// graph is worth degrading; the controls are not worth losing.
		allowInvalidContainer: true,
	});

	// --- Visibility ----------------------------------------------------------
	// Seeded with the whole graph, because that is what Sigma indexed when it was
	// constructed — before the first filter pass hides anything.
	let visibleNodes = new Set(graph.nodes());
	let visibleEdges = graph.edges();
	/** The same edges as a set, for the reducer to test membership against. */
	let visibleEdgeSet = new Set(visibleEdges);
	/** Edges touching the focused node, or null when nothing is focused. Kept here
	 * rather than derived per edge for the same reason as `visibleEdgeSet`. */
	let focusEdgeSet = null;
	/** Bumped whenever the visible subset changes, so the physics can tell when its
	 * cached copy of that subset has gone stale. */
	let visibilityGeneration = 0;

	/** Repaint what's on screen: appearance changed, geometry didn't.
	 *
	 * Sigma decides `fullRefresh = !opts.partialGraph`, so `refresh({ skipIndexation:
	 * true })` on its own does the opposite of what it reads like — it clears every
	 * node and edge index and rebuilds them from scratch. At 25,236 nodes and 126,660
	 * edges that measured ~750ms, and it ran on every hover. Naming the elements is
	 * what actually makes a repaint cheap.
	 *
	 * Only what's on screen can look different: both reducers test visibility before
	 * they look at the focus, so a filtered-out element renders identically whatever
	 * is hovered and doesn't need the visit. */
	function repaint() {
		renderer.refresh({
			partialGraph: { nodes: [...visibleNodes], edges: visibleEdges },
			skipIndexation: true,
		});
	}

	/** Rebuild the spatial index, re-running the reducers for the elements named.
	 *
	 * Needed whenever the frame or the visible set moves, since that invalidates the
	 * label grid, the hover quadtree and the normalisation. Moving nodes *within* an
	 * unchanged frame does not need this: `updateNode` re-normalises each node it
	 * touches, so a layout tick can go through `repaint` instead. */
	function reindex(nodes = [], edges = []) {
		renderer.refresh({ partialGraph: { nodes, edges }, skipIndexation: false });
	}

	/** Two collections as one array, without duplicates. */
	function merged(a, b) {
		const all = new Set(a);
		for (const key of b) all.add(key);
		return [...all];
	}

	/** Which buckets of a dimension a node belongs to. Role is the only
	 * multi-valued one — a hyphenate is in two at once; country and era are a
	 * single bucket each. */
	function bucketsOf(attrs, mode) {
		if (mode.key === 'role') return attrs.held.flatMap((h, i) => (h ? [i] : []));
		return attrs.members[mode.key] ?? [attrs.buckets[mode.key]];
	}

	/** A node passes when it's in the top-N for the current metric, clears the
	 * film floor, and has at least one enabled bucket in EVERY dimension.
	 * Within a dimension that's an OR (a composer-director survives hiding
	 * composers); across dimensions it's an AND, which is what lets you ask for
	 * US actors specifically. */
	function passesNodeFilters(key, attrs, topSet) {
		if (!topSet.has(key)) return false;
		if (attrs.films < state.minFilms) return false;
		return colorModes.every((m) => bucketsOf(attrs, m).some((b) => state.enabled[m.key].has(b)));
	}

	/** Recompute what survives. A node must also keep at least one edge —
	 * raising the shared-films floor otherwise strands a drift of disconnected
	 * dots, which in a collaboration graph say nothing. Single pass: a node
	 * dropped for having no edges takes no edges with it. */
	function recomputeVisible() {
		const topSet = new Set(ranked.slice(0, state.topN));
		const candidates = new Set();
		graph.forEachNode((key, attrs) => {
			if (passesNodeFilters(key, attrs, topSet)) candidates.add(key);
		});

		const wereVisible = visibleNodes;
		const hadEdges = visibleEdges;
		visibleNodes = new Set();
		visibleEdges = [];
		graph.forEachUndirectedEdge((key, attrs, s, t) => {
			if (attrs.weight < state.minWeight || !candidates.has(s) || !candidates.has(t)) return;
			visibleEdges.push(key);
			visibleNodes.add(s);
			visibleNodes.add(t);
		});
		visibleEdgeSet = new Set(visibleEdges);
		// A selected node stays on screen even if the filters would drop it, so
		// clicking a search result never shows an empty canvas.
		if (state.selected) visibleNodes.add(state.selected);
		visibilityGeneration++;
		frameVisible();
		updateCounts();
		// Everything that was on screen or is now. One that dropped out has to be
		// told it's hidden, and one that survived can still look different, since a
		// focus dims the whole visible set rather than just the focused node.
		reindex(merged(wereVisible, visibleNodes), merged(hadEdges, visibleEdges));
	}

	/** Point the camera's reference frame at the visible nodes only.
	 *
	 * Sigma derives its scale from the extent of every node in the graph, and
	 * hidden ones keep their full-graph coordinates — so without this, filtering
	 * down to a few hundred people leaves them huddled in a corner of a frame
	 * sized for all 25,236. Setting a custom bbox makes whatever survives the
	 * filters fill the canvas. */
	function frameVisible() {
		if (!visibleNodes.size) return;
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (const key of visibleNodes) {
			const { x, y } = graph.getNodeAttributes(key);
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
		// A little padding so nodes at the extremes aren't clipped by their radius.
		const padX = (maxX - minX) * 0.04 || 1;
		const padY = (maxY - minY) * 0.04 || 1;
		renderer.setCustomBBox({ x: [minX - padX, maxX + padX], y: [minY - padY, maxY + padY] });
	}

	renderer.setSetting('nodeReducer', (key, attrs) => {
		if (!visibleNodes.has(key)) return { ...attrs, hidden: true };
		const focus = state.hovered ?? state.selected;
		if (focus && key !== focus && !state.neighbors?.has(key)) {
			// Recolour every slice to the theme's dim grey, leaving wedge geometry
			// alone, so an unrelated node fades back without changing shape.
			const dimmed = { ...attrs, color: theme.node, label: '', zIndex: 0 };
			for (const r of roles) dimmed[`c_${r.role}`] = theme.node;
			return dimmed;
		}
		if (focus) return { ...attrs, zIndex: 2, forceLabel: true };
		return attrs;
	});

	// Membership rather than a recomputed predicate: this runs once per edge per
	// repaint, and at 25,236 people that is 126,660 calls. Resolving the edge's
	// endpoints here — `graph.extremities` allocates an array every time — was
	// measurably the most expensive thing on the hover path.
	renderer.setSetting('edgeReducer', (key, attrs) => {
		if (!visibleEdgeSet.has(key)) return { ...attrs, hidden: true };
		if (!focusEdgeSet) return attrs;
		return focusEdgeSet.has(key)
			? { ...attrs, color: theme.node === THEME.dark.node ? '#9aa7b4' : '#4a5560', zIndex: 1, size: attrs.size + 0.5 }
			: { ...attrs, color: theme.edge, zIndex: 0 };
	});

	prefersDark.addEventListener('change', (e) => {
		theme = e.matches ? THEME.dark : THEME.light;
		renderer.setSetting('defaultEdgeColor', theme.idle);
		renderer.setSetting('labelColor', { color: getComputedStyle(document.body).color || '#111' });
		// Region and era carry per-mode steps, so re-paint rather than letting the
		// light values sit on a dark surface.
		applyColors();
		renderGroups();
		repaint();
	});

	// --- Node dragging -------------------------------------------------------
	let dragged = null;
	let isDragging = false;
	/** The subgraph the physics simulates — the visible subset. Kept between runs;
	 * see `simulationGraph`. */
	let pinned = null;

	renderer.on('downNode', ({ node }) => {
		isDragging = true;
		dragged = node;
		graph.setNodeAttribute(node, 'highlighted', true);
		// Pin it in the simulation so the layout can't drag it back out from
		// under the cursor while the user is holding it.
		if (pinned?.hasNode(node)) pinned.setNodeAttribute(node, 'fixed', true);
	});
	renderer.on('moveBody', ({ event }) => {
		if (!isDragging || !dragged) return;
		const pos = renderer.viewportToGraph(event);
		graph.setNodeAttribute(dragged, 'x', pos.x);
		graph.setNodeAttribute(dragged, 'y', pos.y);
		// Feed the drag back into the simulation so neighbours follow along.
		if (pinned?.hasNode(dragged)) pinned.mergeNodeAttributes(dragged, { x: pos.x, y: pos.y });
		event.preventSigmaDefault();
		event.original.preventDefault();
		event.original.stopPropagation();
	});
	const endDrag = () => {
		if (dragged) {
			graph.removeNodeAttribute(dragged, 'highlighted');
			if (pinned?.hasNode(dragged)) pinned.removeNodeAttribute(dragged, 'fixed');
		}
		dragged = null;
		isDragging = false;
	};
	renderer.on('upNode', endDrag);
	renderer.on('upStage', endDrag);

	// --- Hover / selection ---------------------------------------------------
	const neighborsOf = (key) => new Set(graph.neighbors(key));

	/** Point the highlight at a node, or at nothing, refreshing what the reducers
	 * consult so neither of them has to work it out per element. */
	function setFocus(node) {
		state.neighbors = node ? neighborsOf(node) : null;
		focusEdgeSet = node ? new Set(graph.edges(node)) : null;
	}

	/** Move the focus, repainting only what the move can have changed.
	 *
	 * Arriving at a focus from nothing, or leaving one for nothing, changes how every
	 * element on screen is drawn — the whole field dims or undims. Moving *between*
	 * two focused nodes does not: everything unrelated to either was dimmed before
	 * and stays dimmed, so only the two stars need redrawing. That distinction is
	 * what makes tracking the cursor across a dense graph viable — at 25,236 people
	 * the narrow path is tens of elements against 126,660. */
	function moveFocus(previous, next) {
		setFocus(next);
		if (!previous || !next) {
			repaint();
			return;
		}
		renderer.refresh({
			partialGraph: {
				nodes: [previous, next, ...graph.neighbors(previous), ...graph.neighbors(next)],
				edges: [...graph.edges(previous), ...graph.edges(next)],
			},
			skipIndexation: true,
		});
	}

	renderer.on('enterNode', ({ node }) => {
		if (isDragging) return;
		const previous = state.hovered ?? state.selected;
		state.hovered = node;
		moveFocus(previous, node);
	});
	renderer.on('leaveNode', () => {
		if (isDragging) return;
		const previous = state.hovered;
		state.hovered = null;
		moveFocus(previous, state.selected);
	});
	renderer.on('clickNode', ({ node }) => selectNode(node));
	renderer.on('clickStage', () => selectNode(null));

	function selectNode(node) {
		state.selected = node;
		// Mirrors what the reducers treat as the focus: a hover outranks a selection,
		// so clicking through from a search result focuses the result, while clicking
		// the node under the cursor leaves the hover in charge.
		setFocus(state.hovered ?? state.selected);
		// recomputeVisible repaints the whole visible set, which is what a change of
		// focus needs — the dimming reaches every node, not just this one.
		recomputeVisible();
		renderDetails(node);
	}

	function focusNode(node) {
		const { x, y } = graph.getNodeAttributes(node);
		renderer.getCamera().animate({ x, y, ratio: 0.1 }, { duration: 500 });
	}

	/** Relax whichever filters are hiding this node, so picking a search result
	 * always ends with the person on screen rather than silently filtered out. */
	function revealNode(key) {
		const a = graph.getNodeAttributes(key);
		const changes = [];
		// Re-enable one of the person's own buckets in any dimension that would
		// otherwise exclude them — enough to make them visible without discarding
		// the rest of the filter.
		let regroup = false;
		for (const m of colorModes) {
			const mine = bucketsOf(a, m);
			if (mine.some((b) => state.enabled[m.key].has(b))) continue;
			for (const b of mine) state.enabled[m.key].add(b);
			regroup = true;
			changes.push(`re-enabled ${m.label.toLowerCase()}`);
		}
		if (regroup) renderGroups();
		if (a.films < state.minFilms) {
			state.minFilms = a.films;
			const el = $('#min-films');
			el.value = String(state.minFilms);
			$('#min-films-out').textContent = state.minFilms;
			changes.push(`lowered the film floor to ${a.films}`);
		}
		const rank = ranked.indexOf(key) + 1;
		if (rank > state.topN) {
			state.topN = Math.min(nodes.length, Math.ceil(rank / 100) * 100);
			const el = $('#top-n');
			el.value = String(state.topN);
			$('#top-n-out').textContent = state.topN.toLocaleString();
			changes.push(`widened to the top ${state.topN.toLocaleString()}`);
		}
		const weights = graph.edges(key).map((e) => graph.getEdgeAttribute(e, 'weight'));
		const best = weights.length ? Math.max(...weights) : 0;
		if (best && best < state.minWeight) {
			state.minWeight = best;
			const el = $('#min-weight');
			el.value = String(best);
			$('#min-weight-out').textContent = best;
			changes.push(`lowered shared films to ${best}`);
		}
		return changes;
	}

	// --- Details panel -------------------------------------------------------
	const details = $('#details');

	function renderDetails(node) {
		if (!node) {
			details.innerHTML = '<p class="muted small">Click a node, or search, to see someone\'s collaborators.</p>';
			return;
		}
		const a = graph.getNodeAttributes(node);
		const chips = roles
			.map((r, ri) =>
				a.held[ri]
					? `<span class="chip" style="--c:${r.color}">${r.label} · ${a.counts[ri]}</span>`
					: '',
			)
			.join('');
		// Roles they work in but aren't drawn as — the share floor at work.
		const minor = roles
			.map((r, ri) => (!a.held[ri] && a.counts[ri] > 0 ? `${a.counts[ri]} ${r.label.toLowerCase()}` : ''))
			.filter(Boolean)
			.join(', ');

		const partners = graph
			.neighbors(node)
			.map((n) => ({
				key: n,
				name: graph.getNodeAttribute(n, 'label'),
				w: graph.getUndirectedEdgeAttribute(node, n, 'weight'),
			}))
			.sort((x, y) => y.w - x.w);

		const m = metrics.find((x) => x.key === state.metric);
		const v = a.metricValues[state.metric];
		const shown = m.key === 'hit' ? `${(v * 100).toFixed(0)}th pct` : v.toLocaleString();
		const dims = dimensionLabels(a);

		details.innerHTML = `
			<h3>${escapeHtml(a.label)}</h3>
			<div class="chips">${chips}</div>
			<p class="muted small">
				${a.films} films · ${m.label}: <strong>${shown}</strong>
				${dims.map((d) => `<br>${escapeHtml(d)}`).join('')}
				${minor ? `<br><span class="minor">also ${escapeHtml(minor)} credits (below the ${(payload.roleShareFloor * 100).toFixed(0)}% share to colour the node)</span>` : ''}
			</p>
			<p class="muted small">${partners.length} collaborators</p>
			<ol class="partners">
				${partners.slice(0, 30).map((p) => `<li><button data-node="${p.key}">${escapeHtml(p.name)}</button><span>${p.w}</span></li>`).join('')}
			</ol>
			<p><a href="https://www.themoviedb.org/person/${a.tmdbId}" target="_blank" rel="noopener noreferrer">View on TMDB &nearr;</a></p>`;

		for (const b of details.querySelectorAll('button[data-node]')) {
			b.addEventListener('click', () => goTo(b.dataset.node));
		}
	}

	/** Select, reveal and fly to a node — the single path used by search and by
	 * clicking a collaborator. */
	function goTo(key) {
		revealNode(key);
		selectNode(key);
		focusNode(key);
	}

	// --- Search --------------------------------------------------------------
	// A <datalist> was the original approach and it was the bug: it only matched
	// on a committed exact value, so typing a surname did nothing, and it never
	// matched across diacritics. This is a plain filtered list instead.
	const search = $('#search');
	const results = $('#search-results');
	const index = graph.mapNodes((key, a) => ({ key, name: a.label, fold: foldName(a.label) }));

	function runSearch() {
		const q = foldName(search.value);
		if (!q) {
			results.innerHTML = '';
			results.hidden = true;
			return;
		}
		const starts = [];
		const contains = [];
		for (const e of index) {
			if (e.fold.startsWith(q)) starts.push(e);
			else if (e.fold.includes(q)) contains.push(e);
			if (starts.length >= 12) break;
		}
		const hits = [...starts, ...contains].slice(0, 12);
		results.hidden = false;
		if (!hits.length) {
			results.innerHTML =
				'<li class="empty">No one by that name is in the graph — they may not clear the role thresholds.</li>';
			return;
		}
		results.innerHTML = hits
			.map((h) => {
				const a = graph.getNodeAttributes(h.key);
				const tags = roles.filter((_r, ri) => a.held[ri]).map((r) => r.label).join(' / ');
				return `<li><button data-node="${h.key}"><span>${escapeHtml(h.name)}</span><em>${tags} · ${a.films} films</em></button></li>`;
			})
			.join('');
		for (const b of results.querySelectorAll('button[data-node]')) {
			b.addEventListener('click', () => {
				search.value = graph.getNodeAttribute(b.dataset.node, 'label');
				results.hidden = true;
				goTo(b.dataset.node);
			});
		}
	}

	search.addEventListener('input', runSearch);
	search.addEventListener('focus', runSearch);
	search.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			const first = results.querySelector('button[data-node]');
			if (first) first.click();
		} else if (e.key === 'Escape') {
			results.hidden = true;
		}
	});
	document.addEventListener('click', (e) => {
		if (!e.target.closest('.search-wrap')) results.hidden = true;
	});

	// --- Controls ------------------------------------------------------------
	function updateCounts() {
		$('#counts').textContent =
			`${visibleNodes.size.toLocaleString()} people · ${visibleEdges.length.toLocaleString()} collaborations`;
	}

	// Filter changes re-run the physics over the new subset, so the survivors
	// relax into the space instead of staying in their full-graph positions.
	//
	// Coalesced onto a frame, because a slider fires continuously while it's being
	// dragged and recomputing what's visible is a pass over 25,236 nodes and 126,660
	// edges. The re-settle behind it is debounced further still: restarting a worker
	// on every tick would thrash.
	let filterFrame = null;
	let resettleTimer = null;
	const applyFilters = () => {
		if (filterFrame !== null) return;
		filterFrame = requestAnimationFrame(() => {
			filterFrame = null;
			recomputeVisible();
			if (state.selected) renderDetails(state.selected);

			if (!resettleBox?.checked) return;
			clearTimeout(resettleTimer);
			resettleTimer = setTimeout(() => startPhysics({ burst: true }), 260);
		});
	};

	// Size-by selector
	const metricSel = $('#metric');
	metricSel.innerHTML = metrics.map((m) => `<option value="${m.key}">${m.label}</option>`).join('');
	const metricNote = $('#metric-note');
	const showMetricNote = () => {
		metricNote.textContent = metrics.find((m) => m.key === state.metric).note;
	};
	metricSel.value = state.metric;
	showMetricNote();
	metricSel.addEventListener('change', () => {
		state.metric = metricSel.value;
		applySizes(state.metric);
		applyRanking(state.metric);
		showMetricNote();
		applyFilters();
	});

	// Show top N
	const topN = $('#top-n');
	topN.max = String(nodes.length);
	topN.value = String(state.topN);
	$('#top-n-out').textContent = state.topN.toLocaleString();
	topN.addEventListener('input', () => {
		state.topN = Number(topN.value);
		$('#top-n-out').textContent = state.topN.toLocaleString();
		applyFilters();
	});

	const weightInput = $('#min-weight');
	weightInput.min = String(meta.minEdge);
	weightInput.value = String(meta.minEdge);
	$('#min-weight-out').textContent = state.minWeight;
	weightInput.addEventListener('input', () => {
		state.minWeight = Number(weightInput.value);
		$('#min-weight-out').textContent = state.minWeight;
		applyFilters();
	});

	const filmsInput = $('#min-films');
	filmsInput.addEventListener('input', () => {
		state.minFilms = Number(filmsInput.value);
		$('#min-films-out').textContent = state.minFilms;
		applyFilters();
	});

	// Colour-by selector. The filter groups below double as the legend, so there
	// is no separate colour key to fall out of sync with them.
	const colorSel = $('#color-by');
	colorSel.innerHTML = colorModes.map((m) => `<option value="${m.key}">${m.label}</option>`).join('');
	colorSel.value = state.colorBy;
	const colorNote = $('#color-note');

	// One checkbox group per dimension. Every dimension both colours and filters;
	// only the active one shows swatches, since a coloured key next to a
	// dimension the nodes aren't painted by would just contradict the canvas.
	const groupsEl = $('#filter-groups');
	function renderGroups() {
		const swatch = (m, l) =>
			m.key === state.colorBy
				? `<span class="swatch" style="background:${isDark() ? l.dark : l.light}"></span>`
				: '';
		groupsEl.innerHTML = colorModes
			.map(
				(m) => `<div class="group" data-dim="${m.key}">
					<div class="group-head">
						<h3>${m.label}${m.key === state.colorBy ? ' <span class="muted">— colouring</span>' : ''}</h3>
						<button type="button" class="link" data-all="${m.key}">all</button>
						<button type="button" class="link" data-only="${m.key}">none</button>
					</div>
					${m.legend
						.map(
							(l, i) => `<label class="legend-item">
								<input type="checkbox" ${state.enabled[m.key].has(i) ? 'checked' : ''} data-dim="${m.key}" data-bucket="${i}" />
								${swatch(m, l)}${l.label}
							</label>`,
						)
						.join('')}
				</div>`,
			)
			.join('');

		for (const cb of groupsEl.querySelectorAll('input[data-bucket]')) {
			cb.addEventListener('change', () => {
				const set = state.enabled[cb.dataset.dim];
				const bucket = Number(cb.dataset.bucket);
				if (cb.checked) set.add(bucket);
				else set.delete(bucket);
				applyFilters();
			});
		}
		for (const b of groupsEl.querySelectorAll('button[data-all]')) {
			b.addEventListener('click', () => {
				const key = b.dataset.all;
				const mode = colorModes.find((m) => m.key === key);
				state.enabled[key] = new Set(mode.legend.map((_l, i) => i));
				renderGroups();
				applyFilters();
			});
		}
		for (const b of groupsEl.querySelectorAll('button[data-only]')) {
			b.addEventListener('click', () => {
				state.enabled[b.dataset.only].clear();
				renderGroups();
				applyFilters();
			});
		}
		colorNote.textContent = colorModes.find((m) => m.key === state.colorBy).note;
	}

	colorSel.addEventListener('change', () => {
		state.colorBy = colorSel.value;
		applyColors();
		renderGroups();
		if (state.selected) renderDetails(state.selected);
		repaint();
	});

	// --- Live layout ---------------------------------------------------------
	// The layout that ships in the JSON was solved for all 25,236 people, so
	// filtering alone just hides nodes and leaves the survivors sitting in the
	// cramped positions the full graph gave them. Re-running the physics over
	// only what's visible lets that subset relax into the whole canvas, which is
	// what actually makes a filtered view readable.
	//
	// FA2 writes straight onto whatever graph it's handed, so it simulates a
	// separate subgraph and its positions are copied back to the real one. Node keys
	// are shared, so the mapping is the identity.
	const layoutBtn = $('#layout-toggle');

	/** Barnes-Hut opening angle. graphology defaults to 0.5, and on the full 25,236
	 * subset that measured 421ms an iteration — against 157ms at 1.0 and 111ms at
	 * 1.5. 1.2 takes most of the speedup while keeping the approximation fine enough
	 * that the dense core doesn't visibly coarsen. */
	const BARNES_HUT_THETA = 1.2;

	/** Pull toward the centre. Well *above* graphology's inferred 0.05, which is the
	 * opposite of what wanting a more open layout suggests.
	 *
	 * The reason is `frameVisible`: it fits the layout's bounding box to the canvas,
	 * so anything that expands the layout uniformly is divided straight back out and
	 * changes nothing on screen. What's left is the ratio between the periphery and
	 * the core — and weak gravity lets the periphery fly outward, growing the box,
	 * which fitting to a fixed canvas turns into a *smaller*, denser core.
	 *
	 * Measured on the default 1,600-node view, as median nearest-neighbour distance
	 * once fitted to a 960px canvas: gravity 0.02 gives 4.3px, the inferred 0.05
	 * gives 6.1px, 0.1 gives 7.7px, 0.25 gives 10.9px and 0.5 gives 12.6px. The gain
	 * flattens after 0.25. `scalingRatio` is not a second lever for the same reason
	 * — it scales the whole layout, so 20 and 40 land within 0.1px of each other. */
	const GRAVITY = 0.25;

	/** Floor on how often the simulation's positions are copied onto the rendered
	 * graph — fast enough that a settle reads as motion rather than as steps. */
	const SYNC_MIN_MS = 90;
	/** Share of the main thread the position sync may take.
	 *
	 * A sync costs one `updateNode` per visible node and one `updateEdge` per visible
	 * edge, so it scales with what's on screen: a few milliseconds at the 1,600
	 * default, a couple of hundred with all 25,236 people showing. Pacing the next
	 * sync off the last one's own cost keeps the page responsive at both ends,
	 * instead of picking one interval that is too slow for the small case and far too
	 * fast for the big one. */
	const SYNC_DUTY = 0.25;

	/** When the automatic re-settle after a filter change gives up.
	 *
	 * This was a flat 2,600ms wall-clock budget, which quietly stopped working
	 * when the graph grew to 25,236 people: FA2's cost per iteration scales with
	 * the graph, so the same milliseconds bought roughly a third as many
	 * iterations as they did at 7,518 and the burst started expiring mid-spread —
	 * leaving the user to press Re-settle to finish a job that was supposed to be
	 * automatic.
	 *
	 * So stop on the thing actually wanted, the layout coming to rest, instead of
	 * on a clock. That self-tunes: a bigger graph, a slower machine or a heavier
	 * filter all just take the polls they need.
	 *
	 * Rest is measured on positions normalised into their own bounding box. FA2
	 * expands more or less indefinitely, so raw displacement never settles to
	 * zero; normalising divides that global drift out and leaves only the
	 * structural rearrangement, which does converge. */
	const SETTLE_POLL_MS = 350;
	/** Mean normalised movement per poll under which the layout counts as at rest —
	 * the average node shifting <0.25% of the canvas between polls.
	 *
	 * Measured rather than picked. Movement on a 3,000-node view decays from ~0.025
	 * to ~0.0024 over twenty seconds, and NOT monotonically: it falls to ~0.005 by
	 * 2.5s, then climbs back to ~0.013 between 8s and 16s as the layout reorganises,
	 * before finally trailing off. That rebound is the trap — it sits below any
	 * threshold loose enough to be reached quickly, so a naive rule stops at ~4s
	 * with the real spreading still ahead of it. 0.0025 sits under the rebound. */
	const SETTLE_EPS = 0.0025;
	/** Consecutive quiet polls required. Guards against both a momentarily still
	 * frame and the tail of the rebound above dipping across the line once. */
	const SETTLE_QUIET_POLLS = 3;
	/** Backstop, so a graph that never converges cannot spin the worker forever.
	 * Generous because settling legitimately takes ~20s at a few thousand nodes;
	 * this is the "something is wrong" limit, not the expected duration. */
	const SETTLE_MAX_MS = 45_000;
	/** Nodes watched for movement. A sample is plenty to detect global rest, and
	 * keeps each poll cheap on a 25k-node graph. */
	const SETTLE_SAMPLE = 400;

	let layout = null;
	let settleTimer = null;
	let syncTimer = null;
	/** Which visibility generation `pinned` was built from. Building it is 25,236
	 * addNode plus 126,660 addUndirectedEdge — ~600ms, nearly all of it the edges —
	 * so a re-settle at an unchanged filter state shouldn't pay for it twice. */
	let pinnedGeneration = -1;

	/** Positions of `keys` in `source`, normalised into their own bounding box, so a
	 * uniformly expanding layout reads as no movement at all.
	 *
	 * Read off the simulation rather than the rendered graph, so that how often
	 * positions are synced across can't be mistaken for the layout coming to rest. */
	function normalizedPositions(source, keys) {
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		const raw = new Float64Array(keys.length * 2);
		for (let i = 0; i < keys.length; i++) {
			const { x, y } = source.getNodeAttributes(keys[i]);
			raw[i * 2] = x;
			raw[i * 2 + 1] = y;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
		const w = maxX - minX || 1;
		const h = maxY - minY || 1;
		for (let i = 0; i < raw.length; i += 2) {
			raw[i] = (raw[i] - minX) / w;
			raw[i + 1] = (raw[i + 1] - minY) / h;
		}
		return raw;
	}

	/** Mean per-node distance between two normalised snapshots. */
	function meanShift(a, b) {
		if (!a.length) return 0;
		let sum = 0;
		for (let i = 0; i < a.length; i += 2) sum += Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1]);
		return sum / (a.length / 2);
	}

	/** Copy the simulation's positions onto the rendered graph.
	 *
	 * FA2's `outputReducer` is the obvious way to do this, and it was the bug: it
	 * fires one `mergeNodeAttributes` per node per iteration, and Sigma answers every
	 * one of those with a full re-index. Writing the attribute objects directly —
	 * graphology hands back the live object, not a copy — and then repainting once
	 * costs a single pass per sync instead of 25,236 refreshes per iteration.
	 *
	 * A repaint rather than a reindex, because `updateNode` re-normalises each node
	 * it touches: nothing needs the frame rebuilt until the run ends. */
	function syncPositions() {
		if (!pinned) return;
		pinned.forEachNode((key, { x, y }) => {
			const attrs = graph.getNodeAttributes(key);
			attrs.x = x;
			attrs.y = y;
		});
		repaint();
	}

	/** Sync, then book the next one proportionally to what this one cost. */
	function scheduleSync() {
		const started = performance.now();
		syncPositions();
		const cost = performance.now() - started;
		syncTimer = setTimeout(scheduleSync, Math.max(SYNC_MIN_MS, cost / SYNC_DUTY));
	}

	function stopPhysics() {
		clearInterval(settleTimer);
		clearTimeout(syncTimer);
		settleTimer = null;
		syncTimer = null;
		if (layout) {
			// A last sync, so the graph lands on the positions the simulation actually
			// finished at rather than up to one interval behind them.
			syncPositions();
			layout.kill();
			layout = null;
		}
		layoutBtn.textContent = '▶ Re-settle';
		layoutBtn.classList.remove('running');
	}

	/** The visible subset as a graph FA2 can chew on, reusing the last one when the
	 * filters haven't moved since. Positions are re-seeded from the rendered graph
	 * either way, so a drag or an earlier run carries into the new pass. */
	function simulationGraph() {
		if (!pinned || pinnedGeneration !== visibilityGeneration) {
			pinned = new Graph({ type: 'undirected' });
			for (const key of visibleNodes) pinned.addNode(key, {});
			for (const key of visibleEdges) {
				const [s, t] = graph.extremities(key);
				pinned.addUndirectedEdge(s, t, { weight: graph.getEdgeAttribute(key, 'weight') });
			}
			pinnedGeneration = visibilityGeneration;
		}
		pinned.updateEachNodeAttributes((key) => {
			const { x, y, size } = graph.getNodeAttributes(key);
			return { x, y, size };
		});
		return pinned;
	}

	/** Run FA2 over the visible subgraph. `burst` auto-stops once it comes to rest. */
	function startPhysics({ burst }) {
		stopPhysics();
		if (visibleNodes.size < 2) return;

		const sub = simulationGraph();
		layout = new FA2Layout(sub, {
			settings: {
				...forceAtlas2.inferSettings(sub),
				barnesHutOptimize: true,
				barnesHutTheta: BARNES_HUT_THETA,
				gravity: GRAVITY,
				edgeWeightInfluence: 1,
			},
			getEdgeWeight: 'weight',
		});
		// Keep a node the user is dragging where they put it.
		if (dragged && sub.hasNode(dragged)) sub.setNodeAttribute(dragged, 'fixed', true);

		layout.start();
		scheduleSync();
		layoutBtn.textContent = '■ Stop';
		layoutBtn.classList.add('running');
		if (burst) {
			const sample = [...visibleNodes].slice(0, SETTLE_SAMPLE);
			let previous = normalizedPositions(sub, sample);
			let quiet = 0;
			const started = Date.now();
			settleTimer = setInterval(() => {
				const current = normalizedPositions(sub, sample);
				quiet = meanShift(previous, current) < SETTLE_EPS ? quiet + 1 : 0;
				previous = current;
				if (quiet < SETTLE_QUIET_POLLS && Date.now() - started < SETTLE_MAX_MS) return;
				stopPhysics();
				frameVisible();
				reindex();
			}, SETTLE_POLL_MS);
		}
	}

	layoutBtn.addEventListener('click', () => {
		if (layout) stopPhysics();
		else startPhysics({ burst: false });
	});

	const resettleBox = $('#auto-resettle');
	$('#reset-view').addEventListener('click', () => {
		frameVisible();
		// The frame drives Sigma's normalisation, so moving it needs a reprocess.
		reindex();
		renderer.getCamera().animatedReset({ duration: 400 });
	});

	// --- Boot ----------------------------------------------------------------
	applyColors();
	renderGroups();
	recomputeVisible();
	renderDetails(null);
	$('#meta').textContent =
		`${meta.films.toLocaleString()} films · ${meta.nodes.toLocaleString()} people in graph · ` +
		`built ${new Date(meta.generated).toISOString().slice(0, 10)}`;
	$('#loading')?.remove();
}

main().catch((e) => {
	console.error(e);
	const el = document.querySelector('#loading');
	if (el) el.textContent = `Failed to load the network: ${e.message}`;
});
