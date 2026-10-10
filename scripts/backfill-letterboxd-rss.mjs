// Catch the film log up from Letterboxd's RSS feed — for when entries were made
// on Letterboxd while the site couldn't take them (e.g. the Supabase project was
// paused). The feed only holds the newest ~50 diary entries, so this covers gaps
// of weeks, not years; scripts/backfill-letterboxd.mjs is the full CSV import.
//
// Each entry goes through logFilm(), the same path as the composer. The feed has
// no tags, so each entry's page is fetched for them and the venue/format/theater
// tags become medium/theater/format the way scripts/backfill-medium.mjs did.
// Entries already logged (same film + watched date) are skipped, so it re-runs.
//
//   node --import ./scripts/ts-hook.mjs --env-file=.env scripts/backfill-letterboxd-rss.mjs [--since=YYYY-MM-DD] [--dry-run]

import { logFilm } from '../src/lib/films.ts';
import { siteDay } from '../src/lib/day.ts';
import { supabaseAdmin } from '../src/lib/supabase.ts';

const USER = 'jasonqiao';
const DRY_RUN = process.argv.includes('--dry-run');
const SINCE = process.argv.find((a) => a.startsWith('--since='))?.slice(8) ?? '0000';

// venue tag -> "Name, City" as the composer writes it. Not every venue is a
// cinema: seventh-heaven is a bar, central-park the Nat Geo film festival.
const VENUES = {
	'34th': 'AMC 34th Street 14, New York, NY',
	empire: 'AMC Empire 25, New York, NY',
	'seventh-heaven': '7th Heaven, Bushwick, Brooklyn, NY',
	'central-park': 'Central Park, New York, NY',
};
const FORMATS = { imax: 'IMAX', 'dolby-cinema': 'Dolby Cinema', '35mm': '35mm', '70mm': '70mm', '3d': '3D' };

const UA = { headers: { 'User-Agent': 'Mozilla/5.0' } };

const decode = (s) =>
	s
		.replace(/&#0*39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');

function parseItem(it) {
	const tag = (t) => it.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
	const html = it.match(/<!\[CDATA\[(.*?)\]\]>/s)?.[1] ?? '';
	const paras = [...html.matchAll(/<p>(.*?)<\/p>/gs)]
		.map((m) => decode(m[1].replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).trim())
		.filter((p) => p && !p.startsWith('This review may contain spoilers') && !/^Watched on \w+ \w+ \d+, \d{4}\.$/.test(p));
	const rating = tag('letterboxd:memberRating');

	return {
		title: decode(tag('letterboxd:filmTitle')),
		link: tag('link'),
		tmdbId: Number(tag('tmdb:movieId')),
		watchedDate: tag('letterboxd:watchedDate'),
		loggedDate: siteDay(new Date(tag('pubDate'))),
		rating: rating ? Number(rating) : null,
		rewatched: tag('letterboxd:rewatch') === 'Yes',
		liked: tag('letterboxd:memberLike') === 'Yes',
		reviewText: paras.join('\n\n') || null,
	};
}

async function entryTags(link) {
	const html = await (await fetch(link, UA)).text();

	return [...new Set([...html.matchAll(new RegExp(`href="/${USER}/tag/([^/"]+)/`, 'g'))].map((m) => m[1]))];
}

// Split Letterboxd tags into how-it-was-watched fields and the tags that stay.
function howWatched(tags) {
	const venueTag = tags.find((t) => t in VENUES);
	const formatTag = tags.find((t) => t in FORMATS);
	const inTheater = tags.includes('theater') || venueTag != null;
	const unknownVenue = inTheater && !venueTag;

	return {
		medium: inTheater ? 'theater' : tags.includes('plane') ? 'plane' : null,
		venue: venueTag ? VENUES[venueTag] : null,
		format: formatTag ? FORMATS[formatTag] : null,
		tags: tags.filter((t) => !['theater', 'plane', venueTag, formatTag].includes(t)),
		unknownVenue,
	};
}

const xml = await (await fetch(`https://letterboxd.com/${USER}/rss/`, UA)).text();
const entries = xml
	.split('<item>')
	.slice(1)
	.filter((it) => it.includes('<letterboxd:watchedDate>'))
	.map(parseItem)
	.filter((e) => e.watchedDate >= SINCE)
	.reverse(); // oldest first, so the newest entry ends up owning the film rating

for (const e of entries) {
	const { data: dupes, error } = await supabaseAdmin
		.from('logs_with_movie')
		.select('id')
		.eq('tmdb_id', e.tmdbId)
		.eq('watched_date', e.watchedDate);

	if (error) throw new Error(error.message);

	if (dupes.length) {
		console.log(`skip  ${e.watchedDate} ${e.title} (already logged)`);
		continue;
	}

	const how = howWatched(await entryTags(e.link));

	if (how.unknownVenue) console.warn(`  !! ${e.title}: theater tag but no known venue tag — add it to VENUES`);
	const { unknownVenue, ...fields } = how;
	console.log(`${DRY_RUN ? 'would log' : 'log  '} ${e.watchedDate} ${e.title}`, JSON.stringify({ ...fields, rating: e.rating, rewatched: e.rewatched }));

	if (!DRY_RUN) await logFilm({ ...e, ...fields });
}
