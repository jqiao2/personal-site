// The site header, in one place. Every page draws the same four tabs — Home,
// About, Projects, Journal — through the shared <SiteHeader> component, which
// themes them to whatever section it's sitting in. So what lives here is the
// contents, not the markup.
//
// "Journal" is a dropdown: it collapses the four logs (films, books,
// restaurants, activities) into one tab, and the tab itself points at the
// month-in-review page that draws all four on one calendar. The individual
// logs hang off it as children. Subway is no longer a tab — it lives on the
// projects page now, as the interactive thing it is.

import type { HeaderTheme } from './header-theme';

export interface NavLink {
	href: string;
	label: string;
}

/** The top-level tabs, minus Journal (which is assembled with its children). */
const PRIMARY: readonly NavLink[] = [
	{ href: '/', label: 'Home' },
	{ href: '/about', label: 'About' },
	{ href: '/projects', label: 'Projects' },
];

/** The four logs, collapsed under Journal. */
export const LOG_SECTIONS: readonly NavLink[] = [
	{ href: '/films', label: 'Films' },
	{ href: '/books', label: 'Books' },
	{ href: '/restaurants', label: 'Restaurants' },
	{ href: '/activities', label: 'Activities' },
];

/** Where the Journal tab itself points — the month in review. */
export const JOURNAL_HREF = '/month';

export interface NavItem extends NavLink {
	active: boolean;
	/** Present on the Journal tab: the four logs, as a dropdown. */
	children?: (NavLink & { active: boolean })[];
}

/**
 * The nav with the entry matching `current` flagged. `current` is a pathname;
 * a section link counts as active for everything beneath it, while `/` only
 * matches itself. Journal lights up for the month page and for any of the four
 * logs; Projects also lights up for the subway map, which now lives there.
 */
export function siteNav(current?: string): NavItem[] {
	const children = LOG_SECTIONS.map((link) => ({ ...link, active: isActive(link.href, current) }));
	return [
		...PRIMARY.map((link) => ({
			...link,
			active: isActive(link.href, current) || (link.href === '/projects' && isActive('/subway', current)),
		})),
		{
			href: JOURNAL_HREF,
			label: 'Journal',
			active: isActive(JOURNAL_HREF, current) || children.some((c) => c.active),
			children,
		},
	];
}

// A section's own pages — the links that used to live only in that section's
// right-hand sidebar (the "log index"). Kept here as data so the same list can be
// folded into the mobile drawer on EVERY page of a section, not just its index:
// from a film diary entry the drawer can now still reach Watchlist, Stats, and so
// on. The section index keeps rendering its richer sidebar (with live counts); the
// drawer just needs the labels. `ownerOnly` links mirror the sidebar's own
// owner-gating, so a visitor never sees a page they can't open.
export interface SectionLink extends NavLink {
	ownerOnly?: boolean;
}

const SECTION_NAV: Partial<Record<HeaderTheme, readonly SectionLink[]>> = {
	film: [
		{ href: '/films/watched', label: 'Films watched' },
		{ href: '/films/diary', label: 'Diary' },
		{ href: '/films/watchlist', label: 'Watchlist' },
		{ href: '/films/stats', label: 'Stats' },
		{ href: '/films/month', label: 'The month in film', ownerOnly: true },
	],
	book: [
		{ href: '/books/to-read', label: 'To read' },
		{ href: '/books/month', label: 'Month in review', ownerOnly: true },
	],
	restaurant: [
		{ href: '/restaurants/places', label: 'All restaurants' },
		{ href: '/restaurants/diary', label: 'Diary' },
		{ href: '/restaurants/to-try', label: 'To try' },
		{ href: '/restaurants/stats', label: 'Stats' },
		{ href: '/restaurants/month', label: 'Month in review', ownerOnly: true },
	],
	activity: [
		{ href: '/activities/all', label: 'All activities' },
		{ href: '/activities/training', label: 'Training calendar' },
		{ href: '/activities/fitness', label: 'Fitness trend', ownerOnly: true },
		{ href: '/activities/heatmap', label: 'Heatmap', ownerOnly: true },
		{ href: '/activities/athlete', label: 'Athlete', ownerOnly: true },
		{ href: '/activities/gear', label: 'Gear', ownerOnly: true },
		{ href: '/activities/month', label: 'Month in review', ownerOnly: true },
		{ href: '/activities/settings', label: 'Settings', ownerOnly: true },
	],
};

/**
 * A section's own pages, with the active one flagged and owner-only links dropped
 * for visitors. Empty for sections without a sub-nav (root, subway). `current` is
 * the pathname; `owner` gates the owner-only rows.
 */
export function sectionNav(theme: HeaderTheme, current?: string, owner = false): NavItem[] {
	return (SECTION_NAV[theme] ?? [])
		.filter((l) => owner || !l.ownerOnly)
		.map((l) => ({ href: l.href, label: l.label, active: isActive(l.href, current) }));
}

function isActive(href: string, current?: string): boolean {
	if (!current) return false;
	if (href === '/') return current === '/';
	return current === href || current.startsWith(`${href}/`);
}
