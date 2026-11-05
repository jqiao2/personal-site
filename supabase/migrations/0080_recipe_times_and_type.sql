-- recipes.json now splits cook time into hands-on and waiting, and gives every
-- recipe a finer dish type in place of the library's old category. All three times
-- are always present in the file. Rows already synced get 0 for a missing time; the
-- table is a mirror, so the next sync overwrites those and the old categories.
alter table public.recipes rename column course to type;
alter table public.recipes rename column cook_minutes to cook_active_minutes;
alter table public.recipes add column cook_waiting_minutes integer not null default 0;
alter table public.recipes alter column cook_waiting_minutes drop default;

update public.recipes
set prep_minutes = coalesce(prep_minutes, 0),
	cook_active_minutes = coalesce(cook_active_minutes, 0);

alter table public.recipes alter column prep_minutes set not null;
alter table public.recipes alter column cook_active_minutes set not null;
