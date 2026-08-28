import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { recentJournal, TRACK_TAG } from '../lib/recent-journal';

// Live, and combined across all four logs — the same visitor-safe feed the home
// page shows (see lib/recent-journal.ts for the redaction rules). A build-time
// snapshot would go stale the moment anything is logged.
export const prerender = false;

export async function GET(context: APIContext) {
	const items = await recentJournal(30);
	return rss({
		title: 'Jason Qiao',
		description: 'Films, books, meals and activities — newest first.',
		// context.site comes from `site` in astro.config.mjs.
		site: context.site ?? 'https://jqiao.vercel.app',
		items: items
			// A row with no page of its own can't be a feed link; skip it.
			.filter((it) => it.href)
			.map((it) => ({
				title: `${TRACK_TAG[it.track]}: ${it.title}`,
				link: it.href!,
				// day is a plain YYYY-MM-DD; parse as local noon so the feed date
				// doesn't slip across timezones.
				pubDate: new Date(`${it.day}T12:00:00`),
				description: it.detail || undefined,
				categories: [TRACK_TAG[it.track]],
			})),
	});
}
