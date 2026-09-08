// The section palettes the header wears, as bags of CSS custom properties.
//
// Pulled out of SiteHeader so the mobile drawer's nav (DrawerNav) can paint the
// collapsed tabs in the exact same section colours the header uses — `--sh-link`,
// `--sh-active`, `--sh-border`, `--sh-menu-bg`. One source of truth for both.
//
// `--sh-max` caps the header's inner column; `none` lets the strip run edge to
// edge (the subway map wants that). `root` leans on the variables Layout.astro
// already defines so it follows the light/dark scheme; every other section is
// art-directed to a fixed palette.
export type HeaderTheme =
	| 'root'
	| 'film'
	| 'book'
	| 'restaurant'
	| 'activity'
	| 'subway'
	| 'journal';

export const HEADER_THEMES: Record<HeaderTheme, Record<string, string>> = {
	root: {
		'--sh-bg': 'transparent',
		'--sh-border': 'var(--border, #ddd)',
		'--sh-link': 'var(--fg, #111)',
		'--sh-hover': 'var(--fg, #111)',
		'--sh-active': 'var(--fg, #111)',
		'--sh-accent': 'var(--fg, #111)',
		'--sh-font': 'system-ui, sans-serif',
		'--sh-max': '1120px',
		'--sh-pad': 'clamp(14px, 4vw, 32px)',
		'--sh-menu-bg': 'var(--bg, #fff)',
	},
	film: {
		'--sh-bg': '#20100f',
		'--sh-border': '#4a2529',
		'--sh-link': '#c2a99a',
		'--sh-hover': '#f4e8d1',
		'--sh-active': '#f4e8d1',
		'--sh-accent': '#d9b45a',
		'--sh-font': 'var(--font-archivo)',
		'--sh-max': '1120px',
		'--sh-pad': 'clamp(14px, 4vw, 32px)',
		'--sh-menu-bg': '#20100f',
	},
	book: {
		'--sh-bg': '#150e07',
		'--sh-border': '#45341f',
		'--sh-link': '#bfa886',
		'--sh-hover': '#f2e6cd',
		'--sh-active': '#f2e6cd',
		'--sh-accent': '#cfa452',
		'--sh-font': 'var(--font-archivo)',
		'--sh-max': '1008px',
		'--sh-menu-bg': '#150e07',
	},
	restaurant: {
		'--sh-bg': '#efe1c3',
		'--sh-border': '#c4ad86',
		'--sh-link': '#6d5740',
		'--sh-hover': '#8e3220',
		'--sh-active': '#2f1e12',
		'--sh-accent': '#b34328',
		'--sh-font': 'var(--font-archivo)',
		'--sh-max': '1120px',
		'--sh-pad': 'clamp(14px, 4vw, 32px)',
		'--sh-menu-bg': '#fdf7e8',
	},
	activity: {
		'--sh-bg': 'transparent',
		'--sh-border': '#c9d4dc',
		'--sh-link': '#6b7b88',
		'--sh-hover': '#3d4a55',
		'--sh-active': '#1c6e8c',
		'--sh-accent': '#1c6e8c',
		'--sh-font': 'var(--font-instrument-sans)',
		'--sh-max': '1120px',
		'--sh-pad': 'clamp(14px, 4vw, 32px)',
		'--sh-menu-bg': '#f8fbfd',
	},
	subway: {
		'--sh-bg': '#20100f',
		'--sh-border': '#4a2529',
		'--sh-link': '#c2a99a',
		'--sh-hover': '#f4e8d1',
		'--sh-active': '#f4e8d1',
		'--sh-accent': '#d9b45a',
		'--sh-font': 'var(--font-archivo)',
		'--sh-max': 'none',
		'--sh-menu-bg': '#20100f',
	},
	// The month-in-review journal: cream stock and ink, same palette as
	// JournalLayout.astro's --paper/--ink/--rule/--margin-red — always this,
	// never following light/dark like `root`, since the journal card itself
	// never does either.
	journal: {
		'--sh-bg': '#fbf5e6',
		'--sh-border': '#c9b795',
		'--sh-link': '#6a5b49',
		'--sh-hover': '#c2604f',
		'--sh-active': '#2c2118',
		'--sh-accent': '#c2604f',
		'--sh-font': 'var(--font-archivo)',
		'--sh-max': '1120px',
		'--sh-menu-bg': '#fdf7e8',
	},
};

/** Serialise a theme's variables into an inline `style` string, with an optional
    `--sh-max` override for pages whose column isn't the theme's default. */
export function headerThemeStyle(theme: HeaderTheme = 'root', max?: string): string {
	const vars = { ...(HEADER_THEMES[theme] ?? HEADER_THEMES.root), ...(max ? { '--sh-max': max } : {}) };
	return Object.entries(vars)
		.map(([k, v]) => `${k}:${v}`)
		.join(';');
}
