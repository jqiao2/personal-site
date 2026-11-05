-- recipes.json now splits cook time into hands-on and waiting, and gives every
-- recipe a finer dish type in place of the library's old category. All three times
-- are always present in the file. The table is a mirror, so this needs no backfill.
alter table public.recipes rename column course to type;
alter table public.recipes rename column cook_minutes to cook_active_minutes;
alter table public.recipes add column cook_waiting_minutes integer not null;
alter table public.recipes alter column prep_minutes set not null;
alter table public.recipes alter column cook_active_minutes set not null;
