// Runnable check on src/lib/activity-detail.ts — the folding of stats into the
// Avg/Max table. A slip is silent: the table still renders, it just pairs the
// wrong columns or shows a stat a sport shouldn't have.
//
//   node --import ./scripts/ts-hook.mjs scripts/activity-detail.test.mjs
import assert from 'node:assert/strict';
import { detailRows } from '../src/lib/activity-detail.ts';

// A ride: speed and HR fold into two-column rows; NP is its own single row; the
// headline stats (distance, moving time) never appear in the table.
{
	const rows = detailRows(
		'ride',
		{
			distance_m: 40000,
			moving_seconds: 3600,
			avg_speed_ms: 8,
			max_speed_ms: 16,
			avg_hr: 150,
			max_hr: 179,
			avg_power_w: 192,
			normalized_power_w: 210,
			elevation_gain_m: 300,
			calories: 766,
			elapsed_seconds: 4000,
		},
		false,
	);
	const speed = rows.find((r) => r.label === 'Speed');
	assert.ok(speed && speed.max, 'Speed pairs avg + max');
	const hr = rows.find((r) => r.label === 'Heart rate');
	assert.ok(hr && hr.max, 'Heart rate pairs avg + max');
	assert.ok(
		rows.some((r) => r.label === 'NP' && r.max === undefined),
		'NP is a single-column row',
	);
	assert.ok(!rows.some((r) => r.label === 'Distance' || r.label === 'Moving time'), 'headline stats stay out of the table');
}

// A run: pace shows, but not a lone Max speed (no avg beside it).
{
	const rows = detailRows('run', { avg_speed_ms: 3, max_speed_ms: 4, avg_hr: 150, max_hr: 175, moving_seconds: 1800, elapsed_seconds: 1900 }, false);
	assert.ok(rows.some((r) => r.label === 'Avg pace'), 'run shows pace');
	assert.ok(!rows.some((r) => r.label === 'Speed' || r.label === 'Max speed'), 'run has no speed rows');
}

console.log('activity-detail.test.mjs ok');
