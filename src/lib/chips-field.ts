// Free-text values as removable chips, with autocomplete over names already in
// the database. Shared by the film editor (tags, "watched with") and the meal
// editor (tags, "with", to-try "why") — the same interaction everywhere. The
// markup and styling live in ChipsField.astro; this is only the behaviour.
export interface ChipField {
	get(): string[];
	set(values: string[]): void;
	hideSuggest(): void;
}

export function wireChips(
	input: HTMLInputElement,
	suggest: HTMLUListElement,
	chipsBox: HTMLDivElement,
	options: string[],
	removeLabel: (name: string) => string,
): ChipField {
	let values: string[] = [];
	let active = -1;

	function renderChips() {
		chipsBox.textContent = '';
		values.forEach((v, i) => {
			const chip = document.createElement('span');
			chip.className = 'chip';
			chip.append(v);
			const x = document.createElement('button');
			x.type = 'button';
			x.setAttribute('aria-label', removeLabel(v));
			x.textContent = '✕';
			x.addEventListener('click', () => remove(i));
			chip.appendChild(x);
			chipsBox.appendChild(chip);
		});
		chipsBox.hidden = values.length === 0;
	}
	function remove(i: number) {
		values.splice(i, 1);
		renderChips();
		renderSuggest();
	}
	function commit(raw: string) {
		const name = raw.trim();
		if (name && !values.some((v) => v.toLowerCase() === name.toLowerCase())) values.push(name);
		input.value = '';
		renderChips();
		renderSuggest();
	}
	function candidates(): string[] {
		const token = input.value.trim().toLowerCase();
		const used = new Set(values.map((v) => v.toLowerCase()));
		return options
			.filter((o) => !used.has(o.toLowerCase()))
			.filter((o) => !token || o.toLowerCase().includes(token))
			.slice(0, 6);
	}
	function renderSuggest() {
		const items = candidates();
		suggest.textContent = '';
		active = -1;
		if (!items.length) {
			suggest.hidden = true;
			return;
		}
		for (const o of items) {
			const li = document.createElement('li');
			li.textContent = o;
			li.addEventListener('mousedown', (e) => {
				e.preventDefault();
				commit(o);
			});
			suggest.appendChild(li);
		}
		suggest.hidden = false;
	}

	input.addEventListener('input', renderSuggest);
	input.addEventListener('focus', renderSuggest);
	input.addEventListener('blur', () => {
		suggest.hidden = true;
	});
	input.addEventListener('keydown', (e) => {
		const lis = Array.from(suggest.querySelectorAll('li'));
		if (e.key === 'Enter') {
			e.preventDefault();
			if (active >= 0 && lis[active]) commit(lis[active].textContent || '');
			else commit(input.value);
		} else if (e.key === 'ArrowDown' && lis.length) {
			e.preventDefault();
			active = (active + 1) % lis.length;
			lis.forEach((li, i) => li.classList.toggle('active', i === active));
		} else if (e.key === 'ArrowUp' && lis.length) {
			e.preventDefault();
			active = (active - 1 + lis.length) % lis.length;
			lis.forEach((li, i) => li.classList.toggle('active', i === active));
		} else if (e.key === 'Backspace' && !input.value && values.length) {
			remove(values.length - 1);
		}
	});

	return {
		get: () => values,
		set: (next) => {
			values = [...next];
			renderChips();
		},
		hideSuggest: () => {
			suggest.hidden = true;
		},
	};
}
