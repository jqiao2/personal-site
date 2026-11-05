// The recipe library: the recipes.json format, and the filters on /recipes.
// No I/O here, so scripts/recipes.test.mjs can import it without Supabase env.
// Muse owns the format: docs/RECIPES_FORMAT.md in the jqiao2/recipes repo.
import { z } from 'astro/zod';

export const COMPLETENESS_LABEL = {
	full: 'Full recipe',
	partial: 'Partial',
	video: 'Video only',
} as const;

const isHttps = (v: string): boolean => URL.canParse(v) && new URL(v).protocol === 'https:';

const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The day a post went up. A shortcode is the media id in base64, and the id's high
 *  bits are milliseconds since Instagram's 2011 epoch. recipes.json has no date. */
function postedOn(shortcode: string): string {
	let media = 0n;

	for (const c of shortcode) media = media * 64n + BigInt(SHORTCODE_ALPHABET.indexOf(c));

	return new Date(Number(media >> 23n) + 1314220021721).toISOString().slice(0, 10);
}

const optionalText = z
	.string()
	.trim()
	.nullish()
	.transform((v) => v || null);

const lines = z.array(z.string().trim().min(1));

const labels = lines.transform((v) => [...new Set(v.map((s) => s.toLowerCase()))]);

const minutes = z.number().int().min(0);

/** One entry of recipes.json, which an agent writes. URLs end up in an href and
 *  the id in a path, so they are checked here. Its field names become ours. */
const recipeSchema = z
	.object({
		id: z.string().regex(/^[\w-]{10,12}$/),
		title: z.string().trim().min(1),
		creator: optionalText.transform((v) => v?.replace(/^@/, '') ?? null),
		source_url: z.string().refine(isHttps, 'must be an https URL'),
		source_links: z.array(z.string()).default([]),
		type: z.string().trim().min(1).toLowerCase(),
		cuisine: optionalText.transform((v) => v?.toLowerCase() ?? null),
		tags: labels.default([]),
		key_ingredients: labels,
		ingredients: lines.default([]),
		steps: lines.default([]),
		notes: lines.default([]),
		prep_minutes: minutes,
		cook_active_minutes: minutes,
		cook_waiting_minutes: minutes,
		servings: optionalText,
		status: z.enum(['full', 'partial', 'video']),
	})
	.transform(({ status, source_links, notes, ...recipe }) => ({
		...recipe,
		added: postedOn(recipe.id),
		// The file repeats the cuisine and type as tags; they have their own filters.
		tags: recipe.tags.filter((t) => t !== recipe.cuisine && t !== recipe.type),
		completeness: status,
		site_url: source_links.find(isHttps) ?? null,
		note: notes.join(' ') || null,
	}));

export type Recipe = z.output<typeof recipeSchema>;

/** What the index reads: no method, no links. */
export type RecipeListing = Omit<Recipe, 'steps' | 'note' | 'site_url' | 'source_url' | 'servings'>;

export interface SkippedRecipe {
	id: string;
	reason: string;
}

const entryId = z.object({ id: z.string() });

/** recipes.json. A bad entry is skipped and reported; the others still sync. */
export const recipesFile = z.array(z.unknown()).transform((entries) => {
	const byId = new Map<string, Recipe>();

	const skipped: SkippedRecipe[] = [];

	for (const entry of entries) {
		const parsed = recipeSchema.safeParse(entry);

		const id = entryId.safeParse(entry).data?.id ?? '?';

		if (!parsed.success) {
			skipped.push({ id, reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
		} else if (byId.has(id)) {
			skipped.push({ id, reason: 'duplicate id' });
		} else {
			byId.set(id, parsed.data);
		}
	}

	return { recipes: [...byId.values()], skipped };
});

export type RecipesFile = z.output<typeof recipesFile>;

type RecipeTimes = Pick<Recipe, 'prep_minutes' | 'cook_active_minutes' | 'cook_waiting_minutes'>;

/** Time you are working: everything but the waiting. */
export const handsOnMinutes = (r: RecipeTimes): number => r.prep_minutes + r.cook_active_minutes;

export const totalMinutes = (r: RecipeTimes): number => handsOnMinutes(r) + r.cook_waiting_minutes;

export function formatMinutes(total: number): string {
	const hours = Math.floor(total / 60);

	const mins = total % 60;

	if (!hours) return `${mins} min`;

	return mins ? `${hours} hr ${mins} min` : `${hours} hr`;
}

export const TIME_LIMITS = [15, 30, 60] as const;

export interface RecipeQuery {
	q: string;
	types: string[];
	cuisines: string[];
	ingredients: string[];
	tags: string[];
	maxMinutes: number | null;
	maxHandsOn: number | null;
	fullOnly: boolean;
}

export function parseRecipeQuery(params: URLSearchParams): RecipeQuery {
	const limit = (key: string): number | null => TIME_LIMITS.find((t) => t === Number(params.get(key))) ?? null;

	return {
		q: params.get('q') ?? '',
		types: params.getAll('type'),
		cuisines: params.getAll('cuisine'),
		ingredients: params.getAll('ingredient'),
		tags: params.getAll('tag'),
		maxMinutes: limit('max'),
		maxHandsOn: limit('hands'),
		fullOnly: params.get('full') === '1',
	};
}

/** Type and cuisine widen (any selected); ingredients and tags narrow (all selected). */
export function filterRecipes(recipes: RecipeListing[], query: RecipeQuery): RecipeListing[] {
	const terms = query.q.toLowerCase().split(/\s+/).filter(Boolean);

	return recipes.filter((r) => {
		const haystack = [r.title, r.creator, r.cuisine, ...r.tags, ...r.key_ingredients, ...r.ingredients]
			.join(' ')
			.toLowerCase();

		return (
			(!query.types.length || query.types.includes(r.type)) &&
			(!query.cuisines.length || (r.cuisine != null && query.cuisines.includes(r.cuisine))) &&
			query.ingredients.every((i) => r.key_ingredients.includes(i)) &&
			query.tags.every((t) => r.tags.includes(t)) &&
			(query.maxMinutes == null || totalMinutes(r) <= query.maxMinutes) &&
			(query.maxHandsOn == null || handsOnMinutes(r) <= query.maxHandsOn) &&
			(!query.fullOnly || r.completeness === 'full') &&
			terms.every((t) => haystack.includes(t))
		);
	});
}

export interface RecipeChip {
	label: string;
	count?: number;
	href: string;
	on: boolean;
}

function tally(values: string[]): [string, number][] {
	const counts = new Map<string, number>();

	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);

	return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Everything the index renders for one request. */
export function recipeIndexView(recipes: RecipeListing[], params: URLSearchParams) {
	const query = parseRecipeQuery(params);

	const shown = filterRecipes(recipes, query);

	/** This page's URL with one parameter set to these values. */
	function link(key: string, values: string[]): string {
		const next = new URLSearchParams(params);

		next.delete(key);

		for (const v of values) next.append(key, v);

		const qs = next.toString();

		return qs ? `/recipes?${qs}` : '/recipes';
	}

	const toggled = (selected: string[], value: string): string[] =>
		selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];

	// An any-of group is counted with its own selection off, so its options show
	// what picking them would add. An all-of group is counted on the current
	// results, so its options show what is left.
	const chips = (key: string, selected: string[], pool: string[]): RecipeChip[] =>
		tally(pool).map(([value, count]) => ({
			label: value,
			count,
			href: link(key, toggled(selected, value)),
			on: selected.includes(value),
		}));

	const limits = (key: string, selected: number | null): RecipeChip[] =>
		TIME_LIMITS.map((t) => ({
			label: `Under ${formatMinutes(t)}`,
			href: link(key, selected === t ? [] : [String(t)]),
			on: selected === t,
		}));

	const times = limits('max', query.maxMinutes);

	const handsOn = limits('hands', query.maxHandsOn);

	const full: RecipeChip = {
		label: COMPLETENESS_LABEL.full,
		href: link('full', query.fullOnly ? [] : ['1']),
		on: query.fullOnly,
	};

	const selection = (key: string, selected: string[]) =>
		selected.map((v) => ({ label: v, href: link(key, toggled(selected, v)) }));

	return {
		query,
		shown,
		types: chips('type', query.types, filterRecipes(recipes, { ...query, types: [] }).map((r) => r.type)),
		cuisines: chips(
			'cuisine',
			query.cuisines,
			filterRecipes(recipes, { ...query, cuisines: [] }).flatMap((r) => r.cuisine ?? []),
		),
		ingredients: chips('ingredient', query.ingredients, shown.flatMap((r) => r.key_ingredients)),
		tags: chips('tag', query.tags, shown.flatMap((r) => r.tags)),
		times,
		handsOn,
		full,
		active: [
			...(query.q.trim() ? [{ label: `“${query.q.trim()}”`, href: link('q', []) }] : []),
			...selection('type', query.types),
			...selection('cuisine', query.cuisines),
			...selection('ingredient', query.ingredients),
			...selection('tag', query.tags),
			...times.filter((t) => t.on),
			...handsOn.filter((t) => t.on).map((t) => ({ ...t, label: `Hands-on ${t.label.toLowerCase()}` })),
			...(full.on ? [full] : []),
		],
		// The search form re-sends these so submitting a query keeps the filters.
		carried: [...params.entries()].filter(([k]) => k !== 'q'),
	};
}
