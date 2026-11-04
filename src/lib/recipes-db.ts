// Reads /recipes from Supabase, and pulls recipes.json from the private
// jqiao2/recipes repo into it. Muse writes that repo and never sees the database.
import { supabaseAdmin } from './supabase';
import { recipesFile, type Recipe, type RecipeListing, type RecipesFile, type SkippedRecipe } from './recipes';

const SOURCE = 'https://api.github.com/repos/jqiao2/recipes/contents/recipes.json';

const LISTING =
	'id, title, summary, creator, added, course, cuisine, tags, key_ingredients, ingredients, prep_minutes, cook_minutes, completeness';

// ponytail: reads all rows and filters in JS, and PostgREST stops at 1000 rows.
// Move the filters into the query if the library gets near that.
export async function listRecipes(): Promise<RecipeListing[]> {
	const { data, error } = await supabaseAdmin
		.from('recipes')
		.select(LISTING)
		.order('added', { ascending: false })
		.order('title');

	if (error) throw new Error(error.message);

	return data;
}

export async function getRecipe(id: string): Promise<Recipe | null> {
	const { data, error } = await supabaseAdmin.from('recipes').select('*').eq('id', id).maybeSingle();

	if (error) throw new Error(error.message);

	return data;
}

export interface RecipeSyncResult {
	synced: number;
	removed: number;
	skipped: SkippedRecipe[];
}

/** Make the table match a parsed recipes.json. The repo is the source of truth and
 *  the site edits no recipes, so an id missing from the file is deleted, and a
 *  truncated file is put right by the next good one. A run that skipped an entry
 *  or read an empty file deletes no rows: the skipped entry may be one of them. */
export async function saveRecipes({ recipes, skipped }: RecipesFile): Promise<RecipeSyncResult> {
	let removed = 0;

	if (recipes.length) {
		const { error } = await supabaseAdmin.from('recipes').upsert(recipes);

		if (error) throw new Error(error.message);
	}

	if (recipes.length && !skipped.length) {
		const { data: rows, error } = await supabaseAdmin.from('recipes').select('id');

		if (error) throw new Error(error.message);

		const keep = new Set(recipes.map((r) => r.id));

		const stale = rows.map((r) => r.id).filter((id) => !keep.has(id));

		if (stale.length) {
			const { error: deleteError } = await supabaseAdmin.from('recipes').delete().in('id', stale);

			if (deleteError) throw new Error(deleteError.message);

			removed = stale.length;
		}
	}

	return { synced: recipes.length, removed, skipped };
}

export async function syncRecipes(): Promise<RecipeSyncResult> {
	const token = import.meta.env.RECIPES_GITHUB_TOKEN;

	if (!token) throw new Error('RECIPES_GITHUB_TOKEN is not set');

	const res = await fetch(SOURCE, {
		headers: {
			Accept: 'application/vnd.github.raw+json',
			Authorization: `Bearer ${token}`,
			'User-Agent': 'jqiao-site',
		},
	});

	if (!res.ok) throw new Error(`GitHub answered ${res.status} for recipes.json`);

	return saveRecipes(recipesFile.parse(await res.json()));
}
