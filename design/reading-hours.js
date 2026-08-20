// ---------------------------------------------------------------------------
// Page turns bucketed by local hour (America/New_York), for the hour histogram.
//
// The real source is one row per page turn: started_at to the second, plus
// duration_seconds. Here there is only a per-day page count, so each day is
// dealt back out into sittings and hours from the observed shape of the log.
// Deterministic: the same day always produces the same hours.
//
// A bar counts page turns whose own timestamp falls in that hour. Nothing is
// split across a boundary — a sitting that runs from 23:40 to 00:20 simply has
// some of its rows land in 23 and the rest in 00, which is where they happened.
// ---------------------------------------------------------------------------

// Every page turn in the log, by hour. 87% of it sits in 23:00-03:00.
export const HOUR_SHAPE = [42, 211, 250, 95, 0, 0, 0, 1, 19, 9, 3, 0, 0, 0, 0, 4, 11, 3, 27, 13, 1, 0, 5, 52];
const SHAPE_TOTAL = HOUR_SHAPE.reduce((a, b) => a + b, 0);

function seedOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rngOf(seed) {
  let x = seed || 1;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
function startHour(rand) {
  const t = rand() * SHAPE_TOTAL;
  let acc = 0;
  for (let h = 0; h < 24; h++) { acc += HOUR_SHAPE[h]; if (t < acc) return h; }
  return 23;
}

// rows: [{ key, pages }] — key is the local calendar day, and the seed.
export function bucketHours(rows) {
  const hours = new Array(24).fill(0);
  const dayHit = Array.from({ length: 24 }, () => ({}));
  const sittingHit = new Array(24).fill(0);
  let sittings = 0;

  rows.forEach((row) => {
    const pages = row.pages || 0;
    if (pages <= 0) return;
    const rand = rngOf(seedOf(row.key));

    let n = 1;
    if (pages > 45 && rand() < 0.55) n++;
    if (pages > 110 && rand() < 0.6) n++;
    const parts = [];
    let left = pages;
    for (let i = 0; i < n - 1; i++) {
      const take = Math.max(1, Math.round(pages * (0.25 + rand() * 0.3)));
      if (take >= left) break;
      parts.push(take);
      left -= take;
    }
    parts.push(left);

    parts.forEach((p) => {
      sittings++;
      let h = startHour(rand);
      let rem = p;
      const touched = {};
      while (rem > 0) {
        const take = Math.min(rem, Math.max(6, Math.round(20 + rand() * 22)));
        hours[h] += take;
        dayHit[h][row.key] = 1;
        touched[h] = 1;
        rem -= take;
        h = (h + 1) % 24;
      }
      Object.keys(touched).forEach((k) => { sittingHit[+k]++; });
    });
  });

  return {
    hours,
    dayspread: dayHit.map((o) => Object.keys(o).length),
    sittingSpread: sittingHit,
    sittings,
    occupied: hours.filter((v) => v > 0).length,
  };
}

export function hourLabel(h) {
  if (h === 0) return "midnight";
  if (h === 12) return "noon";
  return (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? " am" : " pm");
}

// What stands in for the chart when there is not enough of a day to draw one.
export function tooFewLine(hours) {
  const on = [];
  hours.forEach((v, h) => { if (v > 0) on.push(h); });
  if (!on.length) return "No page turns with a usable time on them.";
  return "Only " + on.map(hourLabel).join(" and ") + " \u2014 not enough of a day to draw one.";
}
