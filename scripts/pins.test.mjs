// The runnable check on the pins feature's two pieces of real logic: the 10-pin
// cap, and the visitor-visibility drop. Imports src/lib/pins-logic.ts, which is
// deliberately free of any database import, so this runs with no .env and no
// network — same shape as scripts/privacy.test.mjs.
//
//   node --import ./scripts/ts-hook.mjs scripts/pins.test.mjs
import assert from 'node:assert/strict';
import {
	MAX_PINS,
	capCheck,
	bookVisibleToVisitor,
	activityVisibleToVisitor,
} from '../src/lib/pins-logic.ts';

// --- The cap ----------------------------------------------------------------
assert.equal(MAX_PINS, 10);

// Room to spare: a new pin is fine.
assert.equal(capCheck(0, false), false);
assert.equal(capCheck(MAX_PINS - 1, false), false);

// Full, and this is a new pair → blocked.
assert.equal(capCheck(MAX_PINS, false), true);
assert.equal(capCheck(MAX_PINS + 1, false), true);

// Full, but re-pinning something already pinned is always allowed (no-op).
assert.equal(capCheck(MAX_PINS, true), false);
assert.equal(capCheck(MAX_PINS + 5, true), false);

// --- Book visibility --------------------------------------------------------
assert.equal(bookVisibleToVisitor({ is_public: true }), true);
assert.equal(bookVisibleToVisitor({ is_public: false }), false);
// Fail closed on a missing flag.
assert.equal(bookVisibleToVisitor({ is_public: undefined }), false);

// --- Activity visibility ----------------------------------------------------
// Only an explicit private=false, and not held back, publishes.
assert.equal(activityVisibleToVisitor({ private: false, hide_from_review: false }), true);
assert.equal(activityVisibleToVisitor({ private: true, hide_from_review: false }), false);
assert.equal(activityVisibleToVisitor({ private: false, hide_from_review: true }), false);
// Fail closed: anything but a real false stays private.
for (const value of [undefined, null, true, 'false', 0]) {
	assert.equal(
		activityVisibleToVisitor({ private: value, hide_from_review: false }),
		false,
		`private=${String(value)} must stay hidden`,
	);
}

console.log('pins.test.mjs: ok');
