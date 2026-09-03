# 0011 — Applying a migration when there is no linked Supabase project

**Type:** strategy
**Applies when:** a migration must reach the live database from a worktree, and
`supabase link` is not an option (no `supabase/config.toml` anywhere in the
repo, no `SUPABASE_ACCESS_TOKEN`, CLI not installed).

## Symptom
`supabase` is not on PATH; `npx supabase db push` has nothing to push *to*
because this repo has never held a `config.toml` — pattern 0001's "re-link for
this checkout" advice assumes state that does not exist here. Meanwhile the
direct host `db.<ref>.supabase.co` does not resolve at all (the project has no
IPv4 direct connection), so the obvious `psql` fallback fails on DNS.

## Root cause
The only usable route in is the **connection pooler**, whose hostname encodes a
region — `aws-<n>-<region>.pooler.supabase.com` — and nothing in `.env` records
which one. A wrong region does not fail on DNS; it connects and then returns
`FATAL: (ENOTFOUND) tenant/user postgres.<ref> not found`, which reads like a
credentials problem and is not.

## Workaround
The project ref is the first label of `SUPABASE_URL`; the password is
`SUPABASE_DB_PASSWORD`. Probe for the region — the distinctive error above means
"right pooler protocol, wrong region", so loop until one returns a row:

```sh
REF=<first label of SUPABASE_URL>
export PGPASSWORD=$(grep '^SUPABASE_DB_PASSWORD=' .env | cut -d= -f2-)
for r in us-west-1 us-west-2 us-east-1 us-east-2 eu-west-1 eu-central-1 ap-southeast-1; do
  for n in 0 1; do
    psql "host=aws-$n-$r.pooler.supabase.com port=5432 dbname=postgres \
      user=postgres.$REF sslmode=require connect_timeout=5" -tAc 'select 1' \
      >/dev/null 2>&1 && echo "aws-$n-$r"
  done
done
```

As of 2026-09-03 this project is on **`aws-1-us-west-2.pooler.supabase.com`**.

Then apply the file *and record it*, in one transaction — CLAUDE.md's rule that
an applied migration must exist as a committed file has a mirror image, that a
file applied by hand must be written into the history or `db push` will try it
again later:

```sh
psql "$CONN" -v ON_ERROR_STOP=1 --single-transaction \
  -f supabase/migrations/00NN_name.sql \
  -c "insert into supabase_migrations.schema_migrations (version, name, statements)
      values ('00NN','name', array[\$\$$(cat supabase/migrations/00NN_name.sql)\$\$]);"
```

## Also seen
`supabase_migrations.schema_migrations` and the `supabase/migrations/` directory
**disagreed**: 0057 was committed on `main` but never applied. CLAUDE.md warns
about this; it is real, so read the history before choosing a number rather than
taking `ls | tail -1` plus one. (0058 was free, so the number stood.)

## Seen
- 2026-09-03 — Applying `0058_athlete_height.sql` while building
  `/activities/athlete`.
