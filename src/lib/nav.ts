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

function isActive(href: string, current?: string): boolean {
	if (!current) return false;
	if (href === '/') return current === '/';
	return current === href || current.startsWith(`${href}/`);
}
