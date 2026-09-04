// The client runtime shared by the five month-in-review cards.
//
// Every card is a fixed 1080-wide artboard scaled down for the screen, with the
// same chrome around it: a month picker, a step of prev/next, an aspect switch,
// and a way to save the drawing as a PNG. That chrome was copy-pasted three ways
// (films, books, activities) and skipped on the other two; this module is the
// one copy. Each page keeps its own card body, theme and section toggles and
// composes the helpers it needs — nothing here reaches into a section's own
// controls (likes, bands, maps), so those stay where they belong.
//
// It is deliberately a bag of small functions rather than one initMonthCard():
// the sections don't share a settings shape (films has two switches, books two
// bands, restaurants none), so a single config object would be mostly holes.

/**
 * Fit the 1080px artboard into whatever width the column gives it.
 *
 * `.viewport` reserves the scaled footprint and `.scaler` shrinks the real card
 * into it, so the PNG export always renders at 1080 whatever the screen is.
 * Floored so it stays a picture on a phone and capped so it doesn't outgrow the
 * controls above it on a wide screen.
 */
export function fitScaler(
	viewport: HTMLElement,
	{ width = 1080, min = 0.2, max = 0.62 }: { width?: number; min?: number; max?: number } = {},
): void {
	const stage = viewport.parentElement;
	const fit = (): void => {
		const w = stage?.clientWidth ?? width;
		viewport.style.setProperty('--s', String(Math.max(min, Math.min(max, w / width))));
	};
	if (stage && 'ResizeObserver' in window) new ResizeObserver(fit).observe(stage);
	else window.addEventListener('resize', fit);
	fit();
}

/** A transient status line at the foot of the screen. */
export function makeToast(el: HTMLElement | null): (message: string) => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (message: string) => {
		if (!el) return;
		el.textContent = message;
		el.hidden = false;
		clearTimeout(timer);
		timer = setTimeout(() => {
			el.hidden = true;
		}, 2600);
	};
}

/**
 * Stepping to another month is a real navigation, but the card is one place — so
 * it replaces the history entry rather than stacking one per month, or Back walks
 * you through every month you looked at instead of leaving for the page that sent
 * you here. Any modified click still means "open this elsewhere".
 *
 * `getQuery` is read at click time so the card's live settings ride along.
 */
export function wireHistoryReplace(getQuery: () => string = () => ''): void {
	for (const link of document.querySelectorAll<HTMLAnchorElement>(
		'[data-month-link], [data-picker-month]',
	)) {
		link.addEventListener('click', (event) => {
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
				return;
			event.preventDefault();
			const base = link.dataset.monthLink ?? link.pathname;
			location.replace(`${base}${getQuery()}`);
		});
	}
}

/** Rewrite every month link's href to carry the card's live settings. */
export function syncMonthLinks(getQuery: () => string): void {
	const q = getQuery();
	for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-month-link]'))
		link.href = `${link.dataset.monthLink}${q}`;
	for (const tile of document.querySelectorAll<HTMLAnchorElement>('[data-picker-month]'))
		tile.href = `${tile.pathname}${q}`;
	history.replaceState(null, '', `${location.pathname}${q}`);
}

export interface PickerConfig {
	/** e.g. "/films/month". */
	basePath: string;
	/** The month the page opened on, "YYYY-MM". */
	monthKey: string;
	/** Live query string for the tile hrefs. */
	getQuery: () => string;
	/**
	 * Paint one server-rendered tile for `monthId` as the picker's year changes:
	 * set its label/count/dots and its is-on state. The twelve tiles stay in the
	 * DOM (so they keep the page's scoped styles); only their contents move.
	 */
	paintTile: (tile: HTMLAnchorElement, monthId: string, current: boolean) => void;
}

/**
 * The month picker: a toggle button opens a panel of twelve month tiles with a
 * year stepper. The tiles are server-rendered for the opening year and repainted
 * in place when the year changes — building them here would drop them out of the
 * page's scoped styles.
 */
export function wirePicker({ basePath, monthKey, getQuery, paintTile }: PickerConfig): void {
	const picker = document.querySelector<HTMLElement>('[data-picker]');
	const panel = document.querySelector<HTMLElement>('[data-picker-panel]');
	const yearLabel = document.querySelector<HTMLElement>('[data-picker-label]');
	const tiles = document.querySelectorAll<HTMLAnchorElement>('[data-picker-month]');
	let year = Number(monthKey.slice(0, 4));

	const paint = (): void => {
		if (yearLabel) yearLabel.textContent = String(year);
		tiles.forEach((tile, i) => {
			const id = `${year}-${String(i + 1).padStart(2, '0')}`;
			tile.href = `${basePath}/${id}${getQuery()}`;
			paintTile(tile, id, id === monthKey);
		});
	};

	document.querySelector('[data-picker-toggle]')?.addEventListener('click', () => {
		if (!panel) return;
		panel.hidden = !panel.hidden;
		if (!panel.hidden) {
			year = Number(monthKey.slice(0, 4));
			paint();
		}
	});
	for (const button of document.querySelectorAll<HTMLElement>('[data-picker-year]')) {
		button.addEventListener('click', (event) => {
			event.stopPropagation();
			year += Number(button.dataset.pickerYear);
			paint();
		});
	}
	document.addEventListener('mousedown', (event) => {
		if (!panel || panel.hidden) return;
		if (!picker?.contains(event.target as Node)) panel.hidden = true;
	});
}

/** Copy a link to the card as it stands, settings and all. */
export function wireCopy(
	button: Element | null,
	{ url, toast }: { url: () => string; toast: (m: string) => void },
): void {
	button?.addEventListener('click', () => {
		const link = url();
		if (navigator.clipboard)
			navigator.clipboard.writeText(link).then(
				() => toast(`Link copied · ${link}`),
				() => toast(link),
			);
		else toast(link);
	});
}

/** Whether this browser can hand a file to the OS share sheet (touch only). */
export function canShareFile(): boolean {
	return (
		matchMedia('(pointer: coarse)').matches &&
		typeof navigator.share === 'function' &&
		(() => {
			try {
				return !!navigator.canShare?.({
					files: [new File([new Blob()], 'card.png', { type: 'image/png' })],
				});
			} catch {
				return false;
			}
		})()
	);
}

export interface RenderConfig {
	/** The 1080-wide artboard element. */
	card: HTMLElement;
	/** Solid ground behind the export — the card's own background colour. */
	backgroundColor: string;
	/** Bust the URL cache when inlining cross-origin <img>s (TMDB, Open Library). */
	cacheBust?: boolean;
	/** Keep the `?w=` on optimised photos so they don't collide to one cache key. */
	includeQueryParams?: boolean;
	/** A second pass on WebKit, which can drop <img>s on a cold rasterise. */
	webkitDouble?: boolean;
	/** Explicit pixel height; defaults to the card's own offsetHeight. */
	height?: number;
}

const isWebkit = (): boolean =>
	/AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);

/** Rasterise the card to a PNG blob via html-to-image. */
export async function renderCard(cfg: RenderConfig): Promise<Blob | null> {
	const { toBlob } = await import('html-to-image');
	const options = {
		width: cfg.card.offsetWidth || 1080,
		height: cfg.height ?? cfg.card.offsetHeight,
		pixelRatio: 1,
		backgroundColor: cfg.backgroundColor,
		// The card sits inside a scaled wrapper; the clone must not inherit it.
		style: { transform: 'none' },
		...(cfg.cacheBust ? { cacheBust: true } : {}),
		...(cfg.includeQueryParams ? { includeQueryParams: true } : {}),
	};
	const first = await toBlob(cfg.card, options);
	return cfg.webkitDouble && isWebkit() ? await toBlob(cfg.card, options) : first;
}

export interface SaveConfig {
	button: HTMLElement | null;
	render: () => RenderConfig;
	/** The saved file's name, e.g. `film-log-2026-08.png`. */
	filename: () => string;
	/** A signature of what's on the card; a kept render is reused while it holds. */
	state: () => string;
	/** Awaited before rendering — map snapshots, cover audits, font loads. */
	beforeRender?: () => Promise<void>;
	toast: (m: string) => void;
	/** Feedback while drawing; a card that shows status in the button omits the toast. */
	labels?: { rendering?: (w: number, h: number) => string; saved?: (name: string) => string };
}

/**
 * Wire the save button. On a phone a downloaded file lands in Files, not Photos,
 * and Photos is where a picture you meant to post belongs — so touch devices are
 * handed the render through the share sheet, which offers "Save Image". Desktop
 * keeps the plain download. Rendering can outlast the tap that started it and
 * Safari won't open the sheet without a live gesture, so the render is kept and
 * the second tap shares it inside its own gesture.
 */
export function wireSave(cfg: SaveConfig): void {
	const { button, toast } = cfg;
	if (!button) return;
	const share = canShareFile();
	if (share && button.dataset.shareLabel) button.textContent = button.dataset.shareLabel;

	let kept: { state: string; file: File } | null = null;
	const rendering = cfg.labels?.rendering ?? ((w, h) => `Rendering ${w}×${h}…`);
	const saved = cfg.labels?.saved ?? ((name) => `Saved ${name}`);

	button.addEventListener('click', async () => {
		const name = cfg.filename();

		if (share && kept?.state === cfg.state()) {
			try {
				await navigator.share({ files: [kept.file] });
			} catch (error) {
				if ((error as DOMException)?.name !== 'AbortError') toast('Could not open the share sheet');
			}
			return;
		}

		const rc = cfg.render();
		toast(rendering(rc.card.offsetWidth || 1080, rc.height ?? rc.card.offsetHeight));
		try {
			await cfg.beforeRender?.();
			const blob = await renderCard(rc);
			if (!blob) throw new Error('nothing was rendered');

			if (share) {
				const file = new File([blob], name, { type: 'image/png' });
				kept = { state: cfg.state(), file };
				try {
					await navigator.share({ files: [file] });
				} catch (error) {
					const kind = (error as DOMException)?.name;
					if (kind === 'NotAllowedError') toast('Ready. Tap again to save.');
					else if (kind !== 'AbortError') toast('Could not open the share sheet');
				}
				return;
			}

			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = name;
			a.click();
			// Revoked late: some browsers are still reading the blob when click() returns.
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			toast(saved(name));
		} catch {
			toast('Could not render the image.');
		}
	});
}
