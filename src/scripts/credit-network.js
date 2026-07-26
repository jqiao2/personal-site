// Client for the film credit collaboration network (/projects/credit-network).
//
// Renders public/data/credit-network.json — a pre-filtered, pre-laid-out graph
// from scripts/credit-graph/build.mjs — with Sigma (WebGL). The layout arrives
// already settled by ForceAtlas2, so the page paints a readable graph on first
// frame; the same FA2 can be re-run live in a worker to re-settle it after the
// filters change, which is what makes the thing feel like Gephi.
//
// Nodes are drawn by @sigma/node-piechart: one slice per role the person clears,
// all slices equal, so an actor-director is exactly half red / half blue.
//
// The JSON stores nodes and edges as positional arrays (see nodeFields /
// edgeFields in the payload) — the key names would otherwise dominate the file.

import Graph from 'graphology';
import Sigma from 'sigma';
import { createNodePiechartProgram } from '@sigma/node-piechart';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import forceAtlas2 from 'graphology-layout-forceatlas2';

const $ = (sel) => document.querySelector(sel);

/** Node radius in pixels from a person's film count. sqrt keeps the most
 * prolific actors from swamping everyone — raw counts span ~10 to ~200. */
const nodeSize = (films) => 2.5 + Math.sqrt(films) * 0.9;
/** Edge thickness from collaboration count, flattened and capped for the same reason. */
const edgeSize = (weight) => Math.min(0.4 + Math.log2(weight) * 0.7, 4);

const DIM_NODE = '#d8d8d8';
const DIM_EDGE = '#ececec';

async function main() {
	const container = $('#graph');
	const res = await fetch('/data/credit-network.json');
	if (!res.ok) throw new Error(`could not load graph data (${res.status})`);
	const payload = await res.json();
	const { roles, nodes, edges, meta } = payload;

	// --- Build the graphology graph ----------------------------------------
	// Positional decode. Role counts start at index 5, aligned with `roles`.
	const ROLE_OFFSET = 5;
	const graph = new Graph({ type: 'undirected' });

	nodes.forEach((n, i) => {
		const [tmdbId, name, x, y, films] = n;
		const counts = roles.map((_, ri) => n[ROLE_OFFSET + ri]);
		const held = roles.map((r, ri) => counts[ri] >= r.minFilms);
		const attrs = {
			label: name,
			tmdbId,
			x,
			y,
			films,
			counts,
			held,
			size: nodeSize(films),
			type: 'piechart',
			// Colour used by the label/hover renderer and by the dimming reducer;
			// the pie slices themselves come from the s_<role> attributes below.
			color: roles[held.findIndex(Boolean)].color,
		};
		roles.forEach((r, ri) => {
			// s_* is the slice's share (0 or 1 — equal wedges for every role held);
			// c_* is its colour. The colour is per-node rather than baked into the
			// program so the hover reducer can grey a node out slice by slice.
			attrs[`s_${r.role}`] = held[ri] ? 1 : 0;
			attrs[`c_${r.role}`] = r.color;
		});
		graph.addNode(String(i), attrs);
	});

	for (const [s, t, weight] of edges) {
		graph.addUndirectedEdge(String(s), String(t), { weight, size: edgeSize(weight) });
	}

	// --- Renderer ------------------------------------------------------------
	const NodePiechartProgram = createNodePiechartProgram({
		// Equal-valued slices, one per role held → an n-role node is split into n
		// equal wedges. A single-role node renders as a solid disc.
		slices: roles.map((r) => ({
			color: { attribute: `c_${r.role}`, defaultValue: r.color },
			value: { attribute: `s_${r.role}` },
		})),
	});

	const renderer = new Sigma(graph, container, {
		nodeProgramClasses: { piechart: NodePiechartProgram },
		defaultEdgeColor: '#d0d0d0',
		labelFont: 'system-ui, sans-serif',
		labelSize: 12,
		labelWeight: '600',
		labelColor: { color: getComputedStyle(document.body).getPropertyValue('--fg').trim() || '#111' },
		labelRenderedSizeThreshold: 9,
		zIndex: true,
		minCameraRatio: 0.02,
		maxCameraRatio: 3,
	});

	// --- Filter + highlight state -------------------------------------------
	const state = {
		minWeight: meta.minEdge,
		minFilms: 0,
		visibleRoles: new Set(roles.map((r) => r.role)),
		hovered: null,
		selected: null,
		neighbors: null, // Set of node keys adjacent to hovered/selected
	};

	/** A node passes the filters when it still holds a visible role and clears the
	 * film floor. Role filtering is per-role: hiding "Composer" hides pure
	 * composers but keeps a composer-director, who is still a visible director. */
	function nodeVisible(attrs) {
		if (attrs.films < state.minFilms) return false;
		return roles.some((r, ri) => attrs.held[ri] && state.visibleRoles.has(r.role));
	}

	/** Recompute what survives the filters. A node must clear the role/film filters
	 * AND keep at least one edge: raising the shared-films floor otherwise strands
	 * a drift of disconnected dots, which in a collaboration graph say nothing.
	 * Single pass — a node dropped for having no edges takes no edges with it. */
	let visibleNodes = new Set();
	let visibleEdges = 0;
	function recomputeVisible() {
		const candidates = new Set();
		graph.forEachNode((key, attrs) => {
			if (nodeVisible(attrs)) candidates.add(key);
		});

		visibleNodes = new Set();
		visibleEdges = 0;
		graph.forEachUndirectedEdge((_key, attrs, s, t) => {
			if (attrs.weight < state.minWeight || !candidates.has(s) || !candidates.has(t)) return;
			visibleEdges++;
			visibleNodes.add(s);
			visibleNodes.add(t);
		});
		updateCounts();
	}

	renderer.setSetting('nodeReducer', (key, attrs) => {
		if (!visibleNodes.has(key)) return { ...attrs, hidden: true };
		const focus = state.hovered ?? state.selected;
		if (focus && key !== focus && !state.neighbors?.has(key)) {
			// Recolour every slice grey, leaving the wedge geometry alone, so an
			// unrelated node fades back without changing shape.
			const dimmed = { ...attrs, color: DIM_NODE, label: '', zIndex: 0 };
			for (const r of roles) dimmed[`c_${r.role}`] = DIM_NODE;
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
				? { ...attrs, color: '#555', zIndex: 1, size: attrs.size + 0.4 }
				: { ...attrs, color: DIM_EDGE, zIndex: 0 };
		}
		return attrs;
	});

	// --- Node dragging -------------------------------------------------------
	// The point of the whole exercise: grab a node and move it. While dragging we
	// disable the camera so the canvas doesn't pan under the cursor.
	let dragged = null;
	let isDragging = false;

	renderer.on('downNode', ({ node }) => {
		isDragging = true;
		dragged = node;
		graph.setNodeAttribute(node, 'highlighted', true);
		if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox());
	});

	renderer.on('moveBody', ({ event }) => {
		if (!isDragging || !dragged) return;
		const pos = renderer.viewportToGraph(event);
		graph.setNodeAttribute(dragged, 'x', pos.x);
		graph.setNodeAttribute(dragged, 'y', pos.y);
		// Stop the camera from also handling this move.
		event.preventSigmaDefault();
		event.original.preventDefault();
		event.original.stopPropagation();
	});

	const endDrag = () => {
		if (dragged) graph.removeNodeAttribute(dragged, 'highlighted');
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
		renderDetails(node);
		renderer.refresh({ skipIndexation: true });
	}

	// --- Details panel -------------------------------------------------------
	const details = $('#details');

	function roleChips(attrs) {
		return roles
			.map((r, ri) =>
				attrs.held[ri]
					? `<span class="chip" style="--c:${r.color}">${r.label} · ${attrs.counts[ri]}</span>`
					: '',
			)
			.join('');
	}

	function renderDetails(node) {
		if (!node) {
			details.innerHTML = '<p class="muted">Click a node to see its collaborators.</p>';
			return;
		}
		const a = graph.getNodeAttributes(node);
		const partners = graph
			.neighbors(node)
			.filter((n) => visibleNodes.has(n))
			.map((n) => ({ key: n, name: graph.getNodeAttribute(n, 'label'), w: graph.getUndirectedEdgeAttribute(node, n, 'weight') }))
			.filter((p) => p.w >= state.minWeight)
			.sort((x, y) => y.w - x.w);

		details.innerHTML = `
			<h3>${escapeHtml(a.label)}</h3>
			<div class="chips">${roleChips(a)}</div>
			<p class="muted">${a.films} films in corpus · ${partners.length} collaborators shown</p>
			<ol class="partners">
				${partners
					.slice(0, 25)
					.map(
						(p) =>
							`<li><button data-node="${p.key}">${escapeHtml(p.name)}</button><span>${p.w}</span></li>`,
					)
					.join('')}
			</ol>
			<p><a href="https://www.themoviedb.org/person/${a.tmdbId}" target="_blank" rel="noopener noreferrer">View on TMDB &nearr;</a></p>`;

		for (const b of details.querySelectorAll('button[data-node]')) {
			b.addEventListener('click', () => {
				selectNode(b.dataset.node);
				focusNode(b.dataset.node);
			});
		}
	}

	function focusNode(node) {
		const { x, y } = graph.getNodeAttributes(node);
		renderer.getCamera().animate({ x, y, ratio: 0.12 }, { duration: 500 });
	}

	// --- Controls ------------------------------------------------------------
	function updateCounts() {
		$('#counts').textContent =
			`${visibleNodes.size.toLocaleString()} people · ${visibleEdges.toLocaleString()} collaborations`;
	}

	const applyFilters = () => {
		recomputeVisible();
		if (state.selected) renderDetails(state.selected);
		renderer.refresh({ skipIndexation: true });
	};

	const weightInput = $('#min-weight');
	weightInput.min = String(meta.minEdge);
	weightInput.value = String(meta.minEdge);
	weightInput.addEventListener('input', () => {
		state.minWeight = Number(weightInput.value);
		$('#min-weight-out').textContent = state.minWeight;
		applyFilters();
	});
	$('#min-weight-out').textContent = state.minWeight;

	const filmsInput = $('#min-films');
	filmsInput.addEventListener('input', () => {
		state.minFilms = Number(filmsInput.value);
		$('#min-films-out').textContent = state.minFilms;
		applyFilters();
	});

	// Legend doubles as the per-role visibility toggle.
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

	// --- Search --------------------------------------------------------------
	const search = $('#search');
	const datalist = $('#people');
	const byName = new Map();
	graph.forEachNode((key, attrs) => byName.set(attrs.label.toLowerCase(), key));
	datalist.innerHTML = graph
		.mapNodes((_k, a) => a.label)
		.sort()
		.map((n) => `<option value="${escapeHtml(n)}"></option>`)
		.join('');

	search.addEventListener('change', () => {
		const key = byName.get(search.value.trim().toLowerCase());
		if (!key) return;
		selectNode(key);
		focusNode(key);
	});

	// --- Live layout ---------------------------------------------------------
	// Re-settling after a filter change is the Gephi-ish part: press play, watch
	// it reorganise, drag nodes while it runs.
	const layout = new FA2Layout(graph, {
		settings: { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: true, edgeWeightInfluence: 1 },
		getEdgeWeight: 'weight',
	});
	const layoutBtn = $('#layout-toggle');
	layoutBtn.addEventListener('click', () => {
		if (layout.isRunning()) {
			layout.stop();
			layoutBtn.textContent = '▶ Run layout';
			layoutBtn.classList.remove('running');
		} else {
			layout.start();
			layoutBtn.textContent = '■ Stop layout';
			layoutBtn.classList.add('running');
		}
	});

	$('#reset-view').addEventListener('click', () => {
		renderer.getCamera().animatedReset({ duration: 400 });
	});

	// --- Boot ----------------------------------------------------------------
	recomputeVisible();
	renderDetails(null);
	$('#meta').textContent =
		`${meta.films.toLocaleString()} films · ${meta.people.toLocaleString()} people credited · ` +
		`built ${new Date(meta.generated).toISOString().slice(0, 10)}`;
	$('#loading').remove();
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

main().catch((e) => {
	console.error(e);
	const el = document.querySelector('#loading');
	if (el) el.textContent = `Failed to load the network: ${e.message}`;
});
