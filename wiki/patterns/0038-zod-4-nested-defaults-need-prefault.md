# 0038 — Zod 4: nested defaults need `.prefault({})`, and a coerce in a pipe needs `<string>`

**Type:** failure-mode
**Applies when:** writing an `astro/zod` schema (zod 4 under Astro 7) that fills a stored JSON blob with defaults, or parses form strings into numbers.

## Symptoms
- `z.object({ a: z.number().default(1) }).default({})` parses `{}` to `{}`: the inner defaults never apply.
- `z.string().min(1).pipe(z.coerce.number())` fails `astro check` with `ZodCoercedNumber<unknown>` not assignable, `'unknown' is not assignable to type 'string'`.

## Root cause
Zod 4 changed `.default(v)` to short-circuit: on `undefined` it returns `v` as-is, without parsing it. Zod 3 parsed the default, which is what made the nested pattern work. And `z.coerce.number()` now types its input as `unknown`, which can't receive a pipe's `string` output.

## Fix
- Use `.prefault({})` on the nested object: the default is fed through the schema, so the inner `.default()`s fill in. `schema.parse({})` then gives a complete defaults object (see `DEFAULT_CONFIG` in `src/lib/flight-poster.ts`).
- Use `z.coerce.number<string>()` after a string pipe.
- Add `.trim().min(1)` before the coerce, because `Number('')` is `0` and an emptied form field would otherwise save as 0.

## Seen
- 2026-11-16 — flight poster settings (`src/lib/flight-poster.ts`).
