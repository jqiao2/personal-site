// The site header, in one place. Six pages draw this nav and each one styles it
// to its own art direction — the film log's tabs, the book shelf's, the subway
// map's, the plain column on the root pages — so what is shared here is the
// contents, not the markup. Callers map over `siteNav(current)` and attach their
// own classes.

export interface NavLink {
	href: string;
	label: string;
}

export const NAV_LINKS: readonly NavLink[] = [
	{ href: '/', label: 'Home' },
	{ href: '/about', label: 'About' },
	{ href: '/projects', label: 'Projects' },
	{ href: '/films', label: 'Films' },
	{ href: '/books', label: 'Books' },
	{ href: '/restaurants', label: 'Restaurants' },
	{ href: '/activities', label: 'Activities' },
	{ href: '/subway', label: 'Subway' },
];

export interface NavItem extends NavLink {
	active: boolean;
}

/**
 * The nav with the entry matching `current` flagged. `current` is a pathname;
 * a section link counts as active for everything beneath it (`/films/diary`
 * lights up Films), while `/` only matches itself.
 */
export function siteNav(current?: string): NavItem[] {
	return NAV_LINKS.map((link) => ({ ...link, active: isActive(link.href, current) }));
}

function isActive(href: string, current?: string): boolean {
	if (!current) return false;
	if (href === '/') return current === '/';
	return current === href || current.startsWith(`${href}/`);
}
