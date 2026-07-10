-- Add updated_at + deleted_at to the logs (review/diary) table.
--
-- updated_at is auto-maintained by a BEFORE UPDATE trigger. deleted_at enables
-- soft-deletes (NULL = live row); the log-a-film feature will filter
-- `deleted_at is null` in reads and switch the DELETE endpoint to set this
-- column instead of hard-deleting.

alter table public.logs
	add column if not exists updated_at timestamptz not null default now(),
	add column if not exists deleted_at timestamptz;

-- Keep "live rows" filtering cheap once soft-deletes accumulate.
create index if not exists logs_deleted_at_idx on public.logs (deleted_at)
	where deleted_at is null;

-- Auto-bump updated_at on every row update. Reusable across tables if needed.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
	new.updated_at = now();
	return new;
end;
$$;

drop trigger if exists logs_set_updated_at on public.logs;
create trigger logs_set_updated_at
	before update on public.logs
	for each row
	execute function public.set_updated_at();
