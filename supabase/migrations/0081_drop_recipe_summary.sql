-- The summaries were almost all the recipe's first step, so the site no longer shows them.
alter table public.recipes drop column summary;
