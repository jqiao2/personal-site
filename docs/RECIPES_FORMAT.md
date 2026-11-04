# recipes.json

Give this file to Muse. The site reads one file, `recipes.json`, from the root of
the default branch of `jqiao2/recipes`, once a day. Muse keeps writing to that repo
and needs no site or database access. `index.html` can stay, ideally built from
`recipes.json`, but the site does not read it.

The file is a JSON array with one object per recipe, and must always contain all
recipes: an `id` missing from the file is deleted from the site. Keep `id`s stable,
so editing a recipe in the file updates it on the site.

```json
[
  {
    "id": "DdmFAorRxJM",
    "title": "Herb Roasted Spatchcock Chicken",
    "summary": "Herb butter under the skin, roasted hot over slivered onions.",
    "creator": "zestfulkitchen",
    "added": "2026-11-04",
    "source_url": "https://www.instagram.com/reel/DdmFAorRxJM/",
    "site_url": "https://zestfulkitchen.com/herb-roasted-spatchcock-chicken-recipe/",
    "course": "main",
    "cuisine": "american",
    "tags": ["make-ahead", "weekend"],
    "key_ingredients": ["chicken", "butter", "onion", "rosemary", "sage", "thyme"],
    "ingredients": ["1 whole chicken (4½–5 lb), spatchcocked", "6 tbsp salted butter"],
    "steps": ["Remove the backbone and flatten the chicken.", "Roast at 450°F for 50–60 minutes."],
    "note": null,
    "prep_minutes": 20,
    "cook_minutes": 60,
    "servings": "4",
    "completeness": "full"
  }
]
```

| Field | Required | Rules |
|---|---|---|
| `id` | yes | The Instagram shortcode from the reel or post URL. Letters, digits, `_`, `-`. Unique. Never changes. |
| `title` | yes | Display title. |
| `summary` | no | One sentence for the list page. Describe the dish; no hype. |
| `creator` | no | Instagram handle. |
| `added` | yes | `YYYY-MM-DD`, the day it entered the library. The site sorts on this, newest first. Keep it fixed after that day. |
| `source_url` | yes | `https://` link to the reel or post. |
| `site_url` | no | `https://` link to the creator's own recipe page, or `null`. |
| `course` | yes | One of `main`, `noodles`, `rice`, `side`, `app`, `bake`, `prep`, `other`. Same values as the `data-cat` in `index.html`. |
| `cuisine` | no | One lowercase word or phrase: `thai`, `italian`, `sichuan`. `null` if none applies. Reuse values already in the file. |
| `tags` | no | Lowercase, for things that are not a course or cuisine: `breakfast`, `drink`, `vegetarian`, `vegan`, `gluten-free`, `one-pan`, `no-cook`, `make-ahead`, `weeknight`. Reuse values already in the file. |
| `key_ingredients` | yes | The ingredients you would filter by. See below. |
| `ingredients` | no | Display lines with quantities, as written. `[]` if unknown. |
| `steps` | no | One step per string, no numbering. `[]` if the method is only in the video. |
| `note` | no | Corrections, caveats or sourcing notes. `null` if none. |
| `prep_minutes` | no | Hands-on minutes before cooking. Whole number or `null`. |
| `cook_minutes` | no | Minutes of cooking, baking and resting, including overnight rests. `0` for a no-cook recipe. Whole number or `null`. |
| `servings` | no | Free text: `"4"`, `"makes 12"`. `null` if unknown. |
| `completeness` | yes | `full`, `partial` or `video`, meaning the same as the labels in `index.html`. |

## key_ingredients

These power the ingredient filter, so one food needs one spelling across the file.

- Lowercase, singular, no quantities or preparation: `chicken`, not `2 Chicken Thighs, deboned`.
- Name the food you would shop for: `chicken`, `shrimp`, `potato`, `scallion`, `gochujang`.
- Use one name per food. `scallion`, never also `green onion`. Reuse a value already in the file before adding a new one.
- Leave out salt, pepper, water and neutral oil.
- List 3 to 8 per recipe.

## Times

Add up the durations in the steps where they are given, and estimate the rest from
the method. Use `null` only when there are no steps to estimate from. The time filter
adds the two together, and a recipe with either one `null` does not match a time
filter. Quantities and steps stay as they are: do not make those up.

## Before committing

The file must parse as JSON. An entry that breaks a rule above is skipped and listed
by the site's Sync button; the other entries still sync. A file that does not parse
fails the whole sync, and the site keeps what it had.
