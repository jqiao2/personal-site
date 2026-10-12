// node scripts/subway-bundles.test.mjs
import assert from "node:assert/strict";
import { sectionLines } from "./subway-bundles.mjs";

const line = (svc, a, b, pts) => ({ sg: { id: `${svc}|${a}|${b}`, svc, a, b }, pts });

const gentle = (id, out) => {
  const os = out[id].map((p) => p.o);

  for (let i = 1; i < os.length; i++) assert.ok(Math.abs(os[i] - os[i - 1]) <= 1 / 16 + 1e-9, `${id} steps gently: ${os}`);

  return os;
};

const joined = (out) => {
  for (const pieces of Object.values(out)) for (let i = 1; i < pieces.length; i++) assert.deepEqual(pieces[i - 1].pts.at(-1), pieces[i].pts[0]);
};

// 1. "5" bends off "2" mid-segment: shared straight at ∓0.5, alone after the
//    bend at 0, and the shift happens inside the bend.
{
  const out = sectionLines(
    [
      line("2", 1, 2, [[0, 0], [2000, 0]]),
      line("5", 1, 3, [[0, 0], [1000, 0], [1030, 10], [1055, 30], [1070, 60], [1080, 100], [1080, 1000]]),
    ],
    ["2", "5"],
  );

  const os = gentle("5|1|3", out);

  assert.equal(os[0], 0.5);
  assert.equal(os.at(-1), 0);
  assert.deepEqual(gentle("2|1|2", out), [-0.5], "the 2 never moves: it is alone only past the bend, on its own straight");

  // every shifting piece of the 5 lies within the bend (x between 1000 and 1080, y < 100)
  for (const pc of out["5|1|3"].filter((p) => p.o !== 0.5 && p.o !== 0)) for (const [x, y] of pc.pts) assert.ok(x >= 999 && y <= 101, `shift outside the bend at ${x},${y}`);
  joined(out);
}

// 2. A service's two segments meet halfway between their slots at the station.
{
  const out = sectionLines(
    [
      line("2", 1, 2, [[0, 0], [1000, 0]]),
      line("2", 2, 3, [[1000, 0], [2000, 0]]),
      line("5", 1, 4, [[0, 0], [1000, 0]]),
    ],
    ["2", "5"],
  );

  const a = gentle("2|1|2", out), b = gentle("2|2|3", out);

  assert.equal(a[0], -0.5);
  assert.equal(b.at(-1), 0);
  assert.ok(Math.abs(a.at(-1) - b[0]) <= 1 / 16 + 1e-9, `meet at the station: ${a.at(-1)} vs ${b[0]}`);
  joined(out);
}

console.log("subway-bundles ok");
