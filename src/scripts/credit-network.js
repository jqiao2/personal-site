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
// Readability note: 7,518 nodes cannot all be legible at once — measured median
// nearest-neighbour spacing is ~2.3px at 960px wide. The "Show top" control is
// the real lever (at 600 nodes it's ~5.7px), so it defaults well below the full
// set and the full graph is opt-in.

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
	function bucketLabel(attrs) {
		const mode = colorModes.find((m) => m.key === state.colorBy);
		if (!mode?.field) return null;
		return (mode.legend[attrs.buckets[mode.key]] ?? {}).label ?? null;
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
		visibleRoles: new Set(roles.map((r) => r.role)),
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
	let visibleNodes = new Set();
	let visibleEdges = 0;

	/** A node passes when it's in the top-N for the current metric, holds a
	 * visible role, and clears the film floor. Role filtering is per-role, so
	 * hiding "Composer" still keeps a composer-director as a director. */
	function passesNodeFilters(key, attrs, topSet) {
		if (!topSet.has(key)) return false;
		if (attrs.films < state.minFilms) return false;
		return roles.some((r, ri) => attrs.held[ri] && state.visibleRoles.has(r.role));
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

		visibleNodes = new Set();
		visibleEdges = 0;
		graph.forEachUndirectedEdge((_key, attrs, s, t) => {
			if (attrs.weight < state.minWeight || !candidates.has(s) || !candidates.has(t)) return;
			visibleEdges++;
			visibleNodes.add(s);
			visibleNodes.add(t);
		});
		// A selected node stays on screen even if the filters would drop it, so
		// clicking a search result never shows an empty canvas.
		if (state.selected) visibleNodes.add(state.selected);
		frameVisible();
		updateCounts();
	}

	/** Point the camera's reference frame at the visible nodes only.
	 *
	 * Sigma derives its scale from the extent of every node in the graph, and
	 * hidden ones keep their full-graph coordinates — so without this, filtering
	 * down to a few hundred people leaves them huddled in a corner of a frame
	 * sized for all 7,518. Setting a custom bbox makes whatever survives the
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

	renderer.setSetting('edgeReducer', (key, attrs) => {
		const [s, t] = graph.extremities(key);
		if (attrs.weight < state.minWeight || !visibleNodes.has(s) || !visibleNodes.has(t)) {
			return { ...attrs, hidden: true };
		}
		const focus = state.hovered ?? state.selected;
		if (focus) {
			const touches = s === focus || t === focus;
			return touches
				? { ...attrs, color: theme.node === THEME.dark.node ? '#9aa7b4' : '#4a5560', zIndex: 1, size: attrs.size + 0.5 }
				: { ...attrs, color: theme.edge, zIndex: 0 };
		}
		return attrs;
	});

	prefersDark.addEventListener('change', (e) => {
		theme = e.matches ? THEME.dark : THEME.light;
		renderer.setSetting('defaultEdgeColor', theme.idle);
		renderer.setSetting('labelColor', { color: getComputedStyle(document.body).color || '#111' });
		// Region and era carry per-mode steps, so re-paint rather than letting the
		// light values sit on a dark surface.
		applyColors();
		renderColorLegend();
		renderer.refresh({ skipIndexation: true });
	});

	// --- Node dragging -------------------------------------------------------
	let dragged = null;
	let isDragging = false;
	/** The subgraph the physics is currently simulating, if it's running. */
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

	renderer.on('enterNode', ({ node }) => {
		if (isDragging) return;
		state.hovered = node;
		state.neighbors = neighborsOf(node);
		renderer.refresh({ skipIndexation: true });
	});
	renderer.on('leaveNode', () => {
		if (isDragging) return;
		state.hovered = null;
		state.neighbors = state.selected ? neighborsOf(state.selected) : null;
		renderer.refresh({ skipIndexation: true });
	});
	renderer.on('clickNode', ({ node }) => selectNode(node));
	renderer.on('clickStage', () => selectNode(null));

	function selectNode(node) {
		state.selected = node;
		state.neighbors = node ? neighborsOf(node) : null;
		recomputeVisible();
		renderDetails(node);
		renderer.refresh({ skipIndexation: true });
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
		for (const [ri, r] of roles.entries()) {
			if (a.held[ri] && !state.visibleRoles.has(r.role)) {
				state.visibleRoles.add(r.role);
				const cb = $(`#legend input[data-role="${r.role}"]`);
				if (cb) cb.checked = true;
				changes.push(`showed ${r.label.toLowerCase()}s`);
			}
		}
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
		const bucket = bucketLabel(a);

		details.innerHTML = `
			<h3>${escapeHtml(a.label)}</h3>
			<div class="chips">${chips}</div>
			<p class="muted small">
				${a.films} films · ${m.label}: <strong>${shown}</strong>
				${bucket ? `<br>${escapeHtml(bucket)}` : ''}
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
			`${visibleNodes.size.toLocaleString()} people · ${visibleEdges.toLocaleString()} collaborations`;
	}

	// Filter changes re-run the physics over the new subset, so the survivors
	// relax into the space instead of staying in their full-graph positions.
	// Debounced: dragging a slider fires continuously, and restarting a worker
	// on every tick would thrash.
	let resettleTimer = null;
	const applyFilters = () => {
		recomputeVisible();
		if (state.selected) renderDetails(state.selected);
		renderer.refresh({ skipIndexation: true });

		if (!resettleBox?.checked) return;
		clearTimeout(resettleTimer);
		resettleTimer = setTimeout(() => startPhysics({ burst: true }), 260);
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

	// Colour-by selector, with its own legend so what the colours mean is always
	// stated — identity is never carried by hue alone.
	const colorSel = $('#color-by');
	colorSel.innerHTML = colorModes.map((m) => `<option value="${m.key}">${m.label}</option>`).join('');
	colorSel.value = state.colorBy;
	const colorLegend = $('#color-legend');
	const colorNote = $('#color-note');
	function renderColorLegend() {
		const mode = colorModes.find((m) => m.key === state.colorBy);
		colorLegend.innerHTML = mode.legend
			.map(
				(l) =>
					`<li><span class="swatch" style="background:${isDark() ? l.dark : l.light}"></span>${l.label}</li>`,
			)
			.join('');
		colorNote.textContent = mode.note;
		// Role swatches on the filter checkboxes would contradict the nodes when
		// colour encodes something else, so they only show in role mode.
		$('#legend').classList.toggle('no-swatch', state.colorBy !== 'role');
	}
	colorSel.addEventListener('change', () => {
		state.colorBy = colorSel.value;
		applyColors();
		renderColorLegend();
		if (state.selected) renderDetails(state.selected);
		renderer.refresh({ skipIndexation: true });
	});

	const legend = $('#legend');
	legend.innerHTML = roles
		.map(
			(r) => `<label class="legend-item">
				<input type="checkbox" checked data-role="${r.role}" />
				<span class="swatch" style="background:${r.color}"></span>
				${r.label} <span class="muted">&ge;${r.minFilms} films</span>
			</label>`,
		)
		.join('');
	for (const cb of legend.querySelectorAll('input[data-role]')) {
		cb.addEventListener('change', () => {
			if (cb.checked) state.visibleRoles.add(cb.dataset.role);
			else state.visibleRoles.delete(cb.dataset.role);
			applyFilters();
		});
	}

	// --- Live layout ---------------------------------------------------------
	// The layout that ships in the JSON was solved for all 7,518 people, so
	// filtering alone just hides nodes and leaves the survivors sitting in the
	// cramped positions the full graph gave them. Re-running the physics over
	// only what's visible lets that subset relax into the whole canvas, which is
	// what actually makes a filtered view readable.
	//
	// FA2 writes straight onto whatever graph it's handed, so it simulates a
	// throwaway subgraph and mirrors positions back to the real one through
	// `outputReducer`. Node keys are shared, so the mapping is the identity.
	const layoutBtn = $('#layout-toggle');
	/** Length of the automatic re-settle after a filter change. Long enough to
	 * spread out, short enough that the graph comes to rest on its own. */
	const BURST_MS = 2600;

	let layout = null;
	let burstTimer = null;

	function stopPhysics() {
		clearTimeout(burstTimer);
		burstTimer = null;
		if (layout) {
			layout.kill();
			layout = null;
			pinned = null;
		}
		layoutBtn.textContent = '▶ Re-settle';
		layoutBtn.classList.remove('running');
	}

	/** Run FA2 over the visible subgraph. `burst` auto-stops after BURST_MS. */
	function startPhysics({ burst }) {
		stopPhysics();
		if (visibleNodes.size < 2) return;

		const sub = new Graph({ type: 'undirected' });
		for (const key of visibleNodes) {
			const a = graph.getNodeAttributes(key);
			sub.addNode(key, { x: a.x, y: a.y, size: a.size });
		}
		graph.forEachUndirectedEdge((_e, a, s, t) => {
			if (a.weight >= state.minWeight && visibleNodes.has(s) && visibleNodes.has(t)) {
				sub.addUndirectedEdge(s, t, { weight: a.weight });
			}
		});

		layout = new FA2Layout(sub, {
			settings: { ...forceAtlas2.inferSettings(sub), barnesHutOptimize: true, edgeWeightInfluence: 1 },
			getEdgeWeight: 'weight',
			outputReducer: (key, attr) => {
				graph.mergeNodeAttributes(key, { x: attr.x, y: attr.y });
				return attr;
			},
		});
		// Keep a node the user is dragging where they put it.
		if (dragged && sub.hasNode(dragged)) sub.setNodeAttribute(dragged, 'fixed', true);
		pinned = sub;

		layout.start();
		layoutBtn.textContent = '■ Stop';
		layoutBtn.classList.add('running');
		if (burst) {
			burstTimer = setTimeout(() => {
				stopPhysics();
				frameVisible();
				renderer.refresh({ skipIndexation: true });
			}, BURST_MS);
		}
	}

	layoutBtn.addEventListener('click', () => {
		if (layout) stopPhysics();
		else startPhysics({ burst: false });
	});

	const resettleBox = $('#auto-resettle');
	$('#reset-view').addEventListener('click', () => {
		frameVisible();
		renderer.getCamera().animatedReset({ duration: 400 });
	});

	// --- Boot ----------------------------------------------------------------
	applyColors();
	renderColorLegend();
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
