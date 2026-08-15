// Behaviour for the StarPicker component: hover previews the value a click
// would set, the click commits it, and leaving the row puts the committed value
// back. Kept beside the markup so both composers get the same gesture rather
// than each writing its own.

export interface StarPickerHandle {
	/** The committed rating, or null when nothing is rated. */
	readonly value: number | null;
	/** Set the rating from outside (hydration, resets). Does not fire onChange. */
	set(value: number | null): void;
}

export interface StarPickerOptions {
	/** Caption while unrated. Must match the component's `emptyLabel`. */
	emptyLabel?: string;
	/** Called on every user-made change, including "clear" (null). */
	onChange?: (value: number | null) => void;
}

export function wireStarPicker(root: HTMLElement, options: StarPickerOptions = {}): StarPickerHandle {
	const { emptyLabel = 'Not rated', onChange } = options;
	const fill = root.querySelector<HTMLElement>('[data-sp-fill]')!;
	const label = root.querySelector<HTMLElement>('[data-sp-label]');
	const hitsBox = root.querySelector<HTMLElement>('[data-sp-hits]')!;
	const hits = Array.from(hitsBox.querySelectorAll<HTMLElement>('[data-sp-hit]'));
	const clear = root.querySelector<HTMLElement>('[data-sp-clear]');

	let value: number | null = null;

	const labelFor = (v: number | null) => (v == null ? emptyLabel : `${Math.floor(v)}${v % 1 ? '½' : ''}★`);
	const paint = (v: number | null) => {
		fill.style.width = `${((v ?? 0) / 5) * 100}%`;
		if (label) label.textContent = labelFor(v);
	};

	for (const hit of hits) {
		const v = Number(hit.dataset.spHit);
		hit.addEventListener('mouseenter', () => paint(v));
		hit.addEventListener('focus', () => paint(v));
		hit.addEventListener('blur', () => paint(value));
		hit.addEventListener('click', () => {
			value = v;
			paint(v);
			onChange?.(v);
		});
	}
	hitsBox.addEventListener('mouseleave', () => paint(value));

	clear?.addEventListener('click', () => {
		value = null;
		paint(null);
		onChange?.(null);
	});

	paint(null);

	return {
		get value() {
			return value;
		},
		set(v: number | null) {
			value = v ? v : null;
			paint(value);
		},
	};
}
