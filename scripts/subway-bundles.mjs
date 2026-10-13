// Side-by-side slots for /subway's Map view. A line's slot is fixed along each
// straight stretch and changes only through a curve, where it is interpolated —
// so the 2 and 5 slide together as they bend off the 3/4 after Franklin Av, and
// a shift hides in the bend instead of stepping sideways on a straight.
//
// Input lines are { sg, pts } in local metres (pts in the segment's stored
// direction). Output: segment id -> pieces [{ o, pts }], where `o` is the slot
// for MapLibre's `line-offset` (positive = right of the piece's direction).
//
//   1. Split each line into straights and curves (CURVE_TURN° of turning in a
//      run of vertices; gentle wiggles stay part of the straight).
//   2. A straight's bundle is every service whose track runs alongside it,
//      recorded from both sides (see 2 below). Its slot is the service's rank
//      in that bundle by the global service order.
//   3. Left/right is read once per connected group of straights (bundle mates,
//      and a service's straights through curves, stations and junctions), against
//      one fixed axis (AXIS) — so bundle mates agree and nothing mirrors.
//   4. Through a curve the slot interpolates from the straight before to the
//      one after. At a station the two segments of a service meet halfway
//      between their slots, easing in over STATION_EASE m.
//   5. The interpolated stretches are drawn as constant pieces (1/QUANT of a slot
//      each, ends on track vertices, none tiny), since `line-offset` is constant
//      per feature.

const SAME_TRACK = 15; // any parallel track this close shares the bundle

const SHARED = 45; // further than that, only if truly parallel (side-by-side tunnels)

const CURVE_VERTEX = 4; // a vertex turning more than this many degrees is part of a curve...

const CURVE_GAP = 60; // ...with the next such vertex if it is within this many metres...

const CURVE_TURN = 15; // ...and the run counts as a curve once it turns this much in total

const MERGE = 30; // bundle mates' tracks this close draw on one centreline...

const MERGE_END = 50; // ...and pull less and less out to this (the neighbour search's reach)

const SMOOTH = 120; // ...the pull spread over this many metres either side

const MIN_STRAIGHT = 60; // a cut at another line's station leaves no straight shorter than this

const MIN_SLIDE = 80; // a slot change slides over at least this many metres

const CHECK = 150;

const STATION_EASE = 80;

const QUANT = 16; // a shift is drawn in 1/16-slot steps (well under a pixel)

const SNAP = 1; // piece ends move to a track vertex this close

const MIN_PIECE = 2;

const MIN_EDGE = 2;

const CELL = 50;

const deg = (r) => (r * 180) / Math.PI;

function cumulative(pts) {
  const acc = [0];

  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));

  return acc;
}

// point and unit tangent at arc length a
function at(pts, acc, a) {
  let i = 1;

  while (i < pts.length - 1 && acc[i] < a) i++;
  const l = acc[i] - acc[i - 1] || 1e-9, t = Math.max(0, Math.min(1, (a - acc[i - 1]) / l));
  const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], n = Math.hypot(dx, dy) || 1;

  return { p: [pts[i - 1][0] + t * dx, pts[i - 1][1] + t * dy], t: [dx / n, dy / n] };
}

// the part of a polyline between arc lengths a0 and a1
// (no edge shorter than MIN_EDGE: see the piece snapping in sectionLines)
function cut(pts, acc, a0, a1) {
  const out = [at(pts, acc, a0).p];
  let last = a0;

  for (let i = 1; i < pts.length - 1; i++) {
    if (acc[i] - last >= MIN_EDGE && a1 - acc[i] >= MIN_EDGE) { out.push(pts[i]); last = acc[i]; }
  }

  out.push(at(pts, acc, a1).p);

  return out;
}

// 1. curves: [a0, a1] arc ranges; everything between them is straight
function curves(pts, acc, gap) {
  const turning = [];

  for (let i = 1; i < pts.length - 1; i++) {
    const h0 = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    const h1 = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
    const turn = Math.abs(deg(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0))));

    if (turn > CURVE_VERTEX) turning.push({ a: acc[i], turn });
  }

  const out = [];

  for (const v of turning) {
    const last = out[out.length - 1];

    if (last && v.a - last.a1 <= gap) { last.a1 = v.a; last.turn += v.turn; }
    else out.push({ a0: v.a, a1: v.a, turn: v.turn });
  }

  return out.filter((c) => c.turn >= CURVE_TURN);
}

// opts.ease: how far a station's slot change eases in (default STATION_EASE;
// it never takes more than a third of the straight). opts.smooth: return each
// segment as one polyline of [x, y, slot] points, the slot linear between
// them, instead of constant-slot pieces — for a renderer that offsets per
// vertex (the SVG diagram) rather than per feature (MapLibre). opts.axis: read
// left/right per straight against this fixed axis instead of per group (step
// 3) — right for octilinear schematic track, which never winds across it.
// opts.curveGap: overrides CURVE_GAP.
// `orders` overrides `order` for one bundle, keyed by its services sorted and
// comma-joined ("B,D,F,M"), where the global order would cross a line over.
export function sectionLines(lines, order, { ease: easeLen = STATION_EASE, smooth = false, axis = null, curveGap = CURVE_GAP, orders = {} } = {}) {
  const L = lines.map((line) => {
    const acc = cumulative(line.pts), total = acc[acc.length - 1];
    // straights: the gaps between curves
    const straights = [];
    let from = 0;

    for (const c of curves(line.pts, acc, curveGap)) {
      if (c.a0 > from) straights.push({ a0: from, a1: c.a0 });
      from = c.a1;
    }

    if (from < total || !straights.length) straights.push({ a0: from, a1: total });

    return { ...line, acc, total, straights };
  });

  // cut l's straights where points within `reach` m of its track project onto it,
  // leaving no straight shorter than `min`
  function cutAt(l, points, reach, min) {
    const xs = l.pts.map((p) => p[0]), ys = l.pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs) - reach, Math.max(...xs) + reach, Math.min(...ys) - reach, Math.max(...ys) + reach];
    const cuts = [];

    for (const q of points) {
      if (q[0] < x0 || q[0] > x1 || q[1] < y0 || q[1] > y1) continue;
      let best = null;

      for (let e = 0; e < l.pts.length - 1; e++) {
        const [a, b] = [l.pts[e], l.pts[e + 1]], ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey) || 1;
        const k = Math.max(0, Math.min(1, ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / (len * len)));
        const d = Math.hypot(a[0] + k * ex - q[0], a[1] + k * ey - q[1]);

        if (d <= reach && (!best || d < best.d)) best = { d, a: l.acc[e] + k * len };
      }

      if (best) cuts.push(best.a);
    }

    l.straights = l.straights.flatMap((s) => {
      const inner = cuts.filter((a) => a > s.a0 + min && a < s.a1 - min).sort((x, y) => x - y);
      const at = [s.a0, ...inner.filter((a, i) => !i || a - inner[i - 1] >= min), s.a1];

      return at.slice(1).map((a1, i) => ({ a0: at[i], a1, cutStart: i > 0 || s.cutStart, cutEnd: i < at.length - 2 || s.cutEnd }));
    });
  }

  // Straights are also cut wherever any line's station sits on them, so an
  // express's long straight (B/D from 34 St to W 4 St) breaks where its locals'
  // do: bundle mates then share boundaries and agree on who is in the bundle.
  // Measured as one straight, the B/D took the A/C/E from its last few hundred
  // metres into the whole run and sat half a slot off the F/M all the way.
  const stops = L.flatMap((l) => [l.pts[0], l.pts[l.pts.length - 1]]);

  for (const l of L) cutAt(l, stops, SAME_TRACK, MIN_STRAIGHT);

  // AXIS: "left" and "right" of a bundle must mean the same side to every
  // member, so slots are read against one fixed axis u: a straight heading
  // along +u keeps its direction, one heading along −u is read reversed. The
  // reading flips for straights perpendicular to u, so u is the heading with the
  // least straight track running across it.
  let u = [1, 0], least = Infinity;

  for (let d = 0; d < 180; d++) {
    const c = [Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180)];
    let across = 0;

    for (const l of L) {
      for (const s of l.straights) {
        const t = at(l.pts, l.acc, (s.a0 + s.a1) / 2).t;

        if (Math.abs(t[0] * c[0] + t[1] * c[1]) < 0.3) across += s.a1 - s.a0;
      }
    }

    if (across < least) { least = across; u = c; }
  }

  // grid of edges for the neighbour search
  const grid = new Map();
  const key = (x, y) => Math.floor(x / CELL) + "," + Math.floor(y / CELL);

  L.forEach((l, li) => {
    for (let e = 0; e < l.pts.length - 1; e++) {
      const [a, b] = [l.pts[e], l.pts[e + 1]];

      for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++) {
        for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
          const k = x + "," + y;

          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push([li, e]);
        }
      }
    }
  });

  // which straight of line l holds arc position a (the nearest one if a is in a curve)
  function straightAt(l, a) {
    let best = 0, bestGap = Infinity;

    l.straights.forEach((s, i) => {
      const gap = a < s.a0 ? s.a0 - a : a > s.a1 ? a - s.a1 : 0;

      if (gap < bestGap) { bestGap = gap; best = i; }
    });

    return best;
  }

  // services running alongside point p heading t -> the straights ("line,straight") they were seen on
  function alongside(p, t) {
    const found = new Map();

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const [li, e] of grid.get(key(p[0] + dx * CELL, p[1] + dy * CELL)) ?? []) {
          const o = L[li], [a, b] = [o.pts[e], o.pts[e + 1]], ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey) || 1;
          const k = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (len * len)));
          const d = Math.hypot(a[0] + k * ex - p[0], a[1] + k * ey - p[1]), par = Math.abs((ex * t[0] + ey * t[1]) / len);

          // Broadway closes on 7 Av at ~25° above Times Sq: near, but not shared
          if ((d <= SAME_TRACK && par > 0.85) || (d <= SHARED && par > 0.97)) {
            if (!found.has(o.sg.svc)) found.set(o.sg.svc, new Set());
            found.get(o.sg.svc).add(li + "," + straightAt(o, o.acc[e] + k * len));
          }
        }
      }
    }

    return found;
  }

  // 2. who shares each straight: checked every ~CHECK m along it (3 to 12
  //    times), counted if seen at 40% of them. Recorded from both sides — if a
  //    straight sees another service alongside, the straights it saw it on count
  //    this one back — so two bundles can't each think they have the track alone
  //    and draw over each other (the A/C/E and B/D/F/M through W 4 St).
  function share() {
    const back = [];

    for (const l of L) {
      for (const s of l.straights) {
        const n = Math.min(12, Math.max(3, Math.round((s.a1 - s.a0) / CHECK)));
        const hits = new Map(); // svc -> { count, refs }

        for (let i = 0; i < n; i++) {
          const { p, t } = at(l.pts, l.acc, s.a0 + ((s.a1 - s.a0) * (i + 0.5)) / n);

          for (const [svc, refs] of alongside(p, t)) {
            if (svc === l.sg.svc) continue;

            if (!hits.has(svc)) hits.set(svc, { count: 0, refs: new Set() });
            const h = hits.get(svc);
            h.count++;
            refs.forEach((r) => h.refs.add(r));
          }
        }

        s.shares = new Set([l.sg.svc]);

        for (const [svc, h] of hits) {
          if (h.count < Math.max(2, Math.ceil(n * 0.4))) continue;
          s.shares.add(svc);

          for (const r of h.refs) back.push([r, l.sg.svc, l, s]);
        }
      }
    }

    const sharing = []; // [line, straight, other line, other straight]: bundle mates

    for (const [r, svc, l, s] of back) {
      const [li, si] = r.split(",").map(Number);
      L[li].straights[si].shares.add(svc);
      sharing.push([l, s, L[li], L[li].straights[si]]);
    }

    return sharing;
  }

  // 2a. Where two mates disagree on who is in their bundle, each straight is cut
  //     where the other's starts or ends beside it (leaving at least CHECK m
  //     either side, enough to measure), and the bundles worked out again. The
  //     F from Bergen St to Jay St runs with the G at one end and beside the A/C
  //     at the other; measured whole, it ranked third of four while the G ranked
  //     second of two, and both took the same side.
  const mates = new Map(L.map((l) => [l, []]));

  for (const [l, s, m, z] of share()) {
    if (s.shares.size === z.shares.size && [...s.shares].every((v) => z.shares.has(v))) continue;
    mates.get(l).push(at(m.pts, m.acc, z.a0).p, at(m.pts, m.acc, z.a1).p);
    mates.get(m).push(at(l.pts, l.acc, s.a0).p, at(l.pts, l.acc, s.a1).p);
  }

  for (const l of L) cutAt(l, mates.get(l), SHARED, CHECK);

  const sharing = share();

  // the same service's best-aligned neighbouring segment at one end of line li:
  // { li, atStart, same } (`same`: stored running the same way through the station)
  const ends = new Map(); // "svc|station" -> [{ li, atStart }]

  L.forEach((l, li) => {
    for (const [st, atStart] of [[l.sg.a, true], [l.sg.b, false]]) {
      const k = l.sg.svc + "|" + st;

      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push({ li, atStart });
    }
  });

  // 2b. One centreline per bundle. Bundle mates on separate tracks (an express
  //     beside its local, the B/D beside the N/Q on the Manhattan Bridge) are
  //     metres apart, and the slots fan out in pixels from each one's own
  //     track, so close in they drew over each other. Each vertex moves to the
  //     weighted mean of its own track and its bundle mates' alongside: full
  //     weight within MERGE m, none past MERGE_END, so a branch drifting away
  //     lets go gradually. A service's ends at a station move together.
  function nearestOf(svc, p, t) {
    let best = null;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const [li, e] of grid.get(key(p[0] + dx * CELL, p[1] + dy * CELL)) ?? []) {
          const o = L[li];

          if (o.sg.svc !== svc) continue;
          const [a, b] = [o.pts[e], o.pts[e + 1]], ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey) || 1;
          const k = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (len * len)));
          const q = [a[0] + k * ex, a[1] + k * ey], d = Math.hypot(q[0] - p[0], q[1] - p[1]);

          if (Math.abs((ex * t[0] + ey * t[1]) / len) > 0.85 && d <= MERGE_END && (!best || d < best.d)) best = { q, d };
        }
      }
    }

    return best;
  }

  const moved = L.map((l) =>
    l.pts.map((p, i) => {
      const s = l.straights[straightAt(l, l.acc[i])], a = l.pts[Math.max(0, i - 1)], b = l.pts[Math.min(l.pts.length - 1, i + 1)];
      const n = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, t = [(b[0] - a[0]) / n, (b[1] - a[1]) / n];
      let x = p[0], y = p[1], w = 1;

      for (const svc of s.shares) {
        const near = svc === l.sg.svc ? null : nearestOf(svc, p, t);

        if (!near) continue;
        const k = Math.min(1, (MERGE_END - near.d) / (MERGE_END - MERGE));
        x += k * near.q[0]; y += k * near.q[1]; w += k;
      }

      return [x / w - p[0], y / w - p[1]];
    }),
  ).map((shift, li) => {
    // A pull measured vertex by vertex jumps wherever a mate's nearest point
    // does (curves, junctions); spread over ±SMOOTH m it slides instead.
    const { pts, acc } = L[li];

    return pts.map((p, i) => {
      let x = 0, y = 0, w = 0;

      for (let j = 0; j < pts.length; j++) {
        const d = Math.abs(acc[j] - acc[i]);

        if (d > SMOOTH) continue;
        const k = (1 - d / SMOOTH) * (((acc[j + 1] ?? acc[j]) - (acc[j - 1] ?? acc[j])) / 2 || 1);
        x += k * shift[j][0]; y += k * shift[j][1]; w += k;
      }

      return [p[0] + x / w, p[1] + y / w];
    });
  });

  for (const group of ends.values()) {
    const pts = group.map(({ li, atStart }) => moved[li][atStart ? 0 : moved[li].length - 1]);
    const c = [0, 1].map((j) => pts.reduce((sum, p) => sum + p[j], 0) / pts.length);

    for (const { li, atStart } of group) moved[li][atStart ? 0 : moved[li].length - 1] = c;
  }

  L.forEach((l, li) => {
    const acc = cumulative(moved[li]);

    // straights keep their vertices; their arc positions follow the moved track
    const remap = (a) => {
      let i = 1;

      while (i < l.acc.length - 1 && l.acc[i] < a) i++;
      const f = (a - l.acc[i - 1]) / (l.acc[i] - l.acc[i - 1] || 1);

      return acc[i - 1] + f * (acc[i] - acc[i - 1]);
    };

    for (const s of l.straights) { s.a0 = remap(s.a0); s.a1 = remap(s.a1); }

    l.pts = moved[li]; l.acc = acc; l.total = acc[acc.length - 1];
  });

  function neighbour(li, atStart) {
    const l = L[li], st = atStart ? l.sg.a : l.sg.b;
    const out = atStart ? at(l.pts, l.acc, 0).t.map((v) => -v) : at(l.pts, l.acc, l.total).t;
    let best = null, bestDot = 0.3;

    for (const n of ends.get(l.sg.svc + "|" + st)) {
      if (n.li === li) continue;
      const m = L[n.li], tin = n.atStart ? at(m.pts, m.acc, 0).t : at(m.pts, m.acc, m.total).t.map((v) => -v);
      const dot = tin[0] * out[0] + tin[1] * out[1];

      if (dot > bestDot) { bestDot = dot; best = n; }
    }

    // a neighbour that begins where l begins (or ends where l ends) is stored the other way
    return best && { ...best, same: best.atStart !== atStart };
  }

  const touching = (l, atStart) => (atStart ? l.straights[0] : l.straights[l.straights.length - 1]);

  // 3. Left/right is read per connected GROUP of straights, not per straight.
  //    Read per straight, a winding stretch (DeKalb Av to Atlantic Av) has
  //    straights on both sides of the axis's perpendicular, and every curve
  //    mirrored the line across the bundle and back; read per run of one
  //    bundle, a run could vote the other way from the run before it, and the
  //    line crossed the bundle at the junction. So straights are linked, with
  //    their relative direction, in priority order:
  //      a. bundle mates (they must agree, or they draw over each other);
  //      b. a service's consecutive straights in the same bundle, through
  //         curves and across stations;
  //      c. a service's consecutive straights across a junction — b and c
  //         together, ordered by how many bundle mates carry over.
  //    A link that contradicts earlier ones is skipped — a flip then happens
  //    only where a loop forces one. Each group reads left/right once, by a
  //    length-weighted vote of its straights against the axis.
  //    Union-find with parity: `par` is a straight's direction relative to its root.
  const all = L.flatMap((l) => l.straights.map((s) => ({ l, s })));

  all.forEach((x, i) => {
    x.s.i = i;
    x.s.key = [...x.s.shares].sort().join();
  });

  const parent = all.map((_, i) => i), par = all.map(() => 1);

  function find(x) {
    if (parent[x] === x) return x;
    const r = find(parent[x]);
    par[x] *= par[parent[x]];
    parent[x] = r;

    return r;
  }

  // b runs `rel` (+1 / −1) relative to a; a contradiction (same root) is skipped
  function link(a, b, rel) {
    const ra = find(a), rb = find(b);

    if (ra === rb) return;
    par[rb] = par[a] * rel * par[b];
    parent[rb] = ra;
  }

  const mid = (l, s) => at(l.pts, l.acc, (s.a0 + s.a1) / 2).t;

  // a.
  for (const [l, s, m, z] of sharing) {
    const t = mid(l, s), v = mid(m, z);
    link(s.i, z.i, t[0] * v[0] + t[1] * v[1] >= 0 ? 1 : -1);
  }

  // b and c, most shared mates first. A link carrying a pair that travels on
  // together (the B and D turning off 6 Av onto 53 St) goes before one where a
  // line leaves its mates (the E crossing 6 Av): where a loop forces a flip it
  // then falls on the line that crosses the others anyway, not between the pair.
  const runs = []; // [carried mates, a, b, rel]
  const carried = (x, y) => [...x.shares].filter((v) => y.shares.has(v)).length;

  L.forEach((l, li) => {
    for (let i = 1; i < l.straights.length; i++) runs.push([carried(l.straights[i - 1], l.straights[i]), l.straights[i - 1].i, l.straights[i].i, 1]);

    for (const atStart of [true, false]) {
      const n = neighbour(li, atStart), mine = touching(l, atStart);

      if (n) runs.push([carried(mine, touching(L[n.li], n.atStart)), mine.i, touching(L[n.li], n.atStart).i, n.same ? 1 : -1]);
    }
  });

  for (const [, a, b, rel] of runs.sort((x, y) => y[0] - x[0])) link(a, b, rel);

  const vote = new Map();

  for (const { l, s } of all) {
    const r = find(s.i), t = mid(l, s);
    vote.set(r, (vote.get(r) ?? 0) + (s.a1 - s.a0) * (t[0] * u[0] + t[1] * u[1] >= 0 ? 1 : -1) * par[s.i]);
  }

  // each straight's slot, read against the line's own stored direction
  for (const { l, s } of all) {
    const o = orders[s.key] ?? order, set = [...s.shares].sort((x, y) => o.indexOf(x) - o.indexOf(y));
    const slot = set.indexOf(l.sg.svc) - (set.length - 1) / 2, r = find(s.i);
    const t = mid(l, s);

    s.off = (axis ? (t[0] * axis[0] + t[1] * axis[1] >= 0 ? 1 : -1) : (vote.get(r) >= 0 ? 1 : -1) * par[s.i]) * slot;
  }

  // 4. at a station, the neighbour's slot read in l's direction (l's own if none)
  function across(li, atStart) {
    const n = neighbour(li, atStart);

    if (!n) return touching(L[li], atStart).off;
    const theirs = touching(L[n.li], n.atStart).off;

    return n.same ? theirs : -theirs;
  }

  // 5. offset as anchors (arc, slot), linear between; cut into constant pieces
  const out = {};

  L.forEach((l, li) => {
    const first = l.straights[0], last = l.straights[l.straights.length - 1];
    const ease = (s) => Math.min(easeLen, (s.a1 - s.a0) / 3);
    const anchors = [[0, (first.off + across(li, true)) / 2]];

    // a curve shorter than MIN_SLIDE (one sharp vertex, say) borrows the rest
    // from the straights either side, so a slot change never jumps
    const borrow = (s, t, gap) => (t && t.off !== s.off ? Math.min(ease(s), Math.max(0, (MIN_SLIDE - gap) / 2)) : 0);

    l.straights.forEach((s, i) => {
      const prev = l.straights[i - 1], next = l.straights[i + 1];

      // at a station, or a cut where another line's station sits, the change eases in
      anchors.push([(s === first && s.a0 === 0) || s.cutStart ? s.a0 + ease(s) : s.a0 + borrow(s, prev, prev && s.a0 - prev.a1), s.off]);
      anchors.push([(s === last && s.a1 === l.total) || s.cutEnd ? s.a1 - ease(s) : s.a1 - borrow(s, next, next && next.a0 - s.a1), s.off]);
    });

    anchors.push([l.total, (last.off + across(li, false)) / 2]);

    if (smooth) {
      const arcs = [...new Set([...l.acc, ...anchors.map(([a]) => a)])].sort((x, y) => x - y);

      const slot = (a) => {
        let i = 1;

        while (i < anchors.length - 1 && anchors[i][0] < a) i++;
        const [a0, o0] = anchors[i - 1], [a1, o1] = anchors[i];

        return a1 - a0 < 1e-6 ? o1 : o0 + ((o1 - o0) * (a - a0)) / (a1 - a0);
      };

      out[l.sg.id] = arcs.map((a) => [...at(l.pts, l.acc, a).p, slot(a) || 0]);

      return;
    }

    const pieces = [];

    for (let i = 1; i < anchors.length; i++) {
      const [a0, o0] = anchors[i - 1], [a1, o1] = anchors[i];

      if (a1 - a0 < 1e-6) continue;
      const steps = Math.max(1, Math.ceil(Math.abs(o1 - o0) * QUANT));

      for (let k = 0; k < steps; k++) {
        const o = steps === 1 ? o0 : Math.round((o0 + ((o1 - o0) * (k + 0.5)) / steps) * QUANT) / QUANT;
        const b0 = a0 + ((a1 - a0) * k) / steps, b1 = a0 + ((a1 - a0) * (k + 1)) / steps, prev = pieces[pieces.length - 1];

        if (prev && prev.o === o) prev.a1 = b1;
        else pieces.push({ a0: b0, a1: b1, o });
      }
    }

    // Piece ends sit on the track's own vertices where one is near, and no piece
    // is shorter than MIN_PIECE: an edge of a metre or two has a direction that
    // rounding makes close to random, and line-offset pushes it sideways along it.
    for (let i = 1; i < pieces.length; i++) {
      const b = pieces[i].a0;
      let near = b;

      for (let v = 1; v < l.acc.length - 1; v++) if (Math.abs(l.acc[v] - b) < Math.abs(near - b) && Math.abs(l.acc[v] - b) <= SNAP) near = l.acc[v];
      pieces[i - 1].a1 = pieces[i].a0 = near;
    }

    const kept = [];

    for (const pc of pieces) {
      const prev = kept[kept.length - 1];

      if (prev && (pc.a1 - pc.a0 < MIN_PIECE || prev.o === pc.o)) prev.a1 = pc.a1;
      else kept.push({ ...pc });
    }

    if (kept.length > 1 && kept[0].a1 - kept[0].a0 < MIN_PIECE) { kept[1].a0 = 0; kept.shift(); }

    out[l.sg.id] = kept.map((pc) => ({ o: pc.o || 0, pts: cut(l.pts, l.acc, pc.a0, pc.a1) })); // `|| 0`: no -0
  });

  return out;
}
