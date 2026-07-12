-- Add a "favorite" flag to watched films.
--
-- Favorites are the (at most four) films featured on the profile overview. The
-- flag lives on `watched` because a favorite is a property of the FILM, and only
-- a film you've watched can be favorited. The four-at-a-time cap is enforced both
-- in the API (for a friendly error) and here by a trigger (the hard guarantee
-- against races or manual edits).

alter table public.watched
	add column if not exists favorite boolean not null default false;

-- Cheap lookups of the handful of favorites.
create index if not exists watched_favorite_idx on public.watched (favorite)
	where favorite;

-- ---------------------------------------------------------------------------
-- Enforce at most four favorites.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_max_favorites()
returns trigger
language plpgsql
as $$
begin
	-- Only guard when a row is being turned INTO a favorite; unfavoriting and
	-- edits to already-favorite rows are always fine.
	if new.favorite and (tg_op = 'INSERT' or old.favorite is distinct from new.favorite) then
		-- In a BEFORE trigger the current row's old value is still what's committed,
		-- so this counts the OTHER favorites. >= 4 means this would be the fifth.
		if (select count(*) from public.watched where favorite) >= 4 then
			raise exception 'cannot have more than 4 favorite films';
		end if;
	end if;
	return new;
end;
$$;

drop trigger if exists watched_max_favorites on public.watched;
create trigger watched_max_favorites
	before insert or update on public.watched
	for each row
	execute function public.enforce_max_favorites();
