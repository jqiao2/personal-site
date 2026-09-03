# Getting a Beli account's lists out, and into the log

**Type:** strategy · **Applies when:** exporting Beli data, or talking to any
reverse-engineered app backend behind a bot gate

## The account is readable, there is just no export

Beli has no export and no official API, but the app's own backend answers to
your account's credentials. `scripts/export-beli.mjs` (`npm run beli:export`,
creds in `.env`) signs in and writes `tmp/beli.json`; `scripts/import-beli.mjs`
(`npm run beli:import`, dry-run by default) maps it into `restaurants` +
`restaurant_visits`. Endpoints come from the community spec
`github.com/ProjectBarks/beli-api`, cross-checked live against this account.

## The endpoints that matter (all need the bot-gate headers, below)

- `POST {ONBOARD}/api/token/` `{email,password}` → `{access,refresh}` (20-min access).
- `GET  {ONBOARD}/api/user/logged-in/` → `{results:[profile]}`; the uuid is `results[0].id`.
- **Ranked ("been"):** `GET {API}/api/get-ranking/?user={uuid}&category={CODE}`
  → rows with the **business inline**, plus `value`/`score` (0–10), `visit_dates`,
  `created_dt`. One call per category. `user-scores/{uuid}/` is the cheap way to
  learn which categories the account uses (3-letter codes: RES, BAR, BAK, DES, COF…).
- **Bookmarked ("want to try"):** `GET {API}/api/get-bookmark/?user={uuid}&category={CODE}`
  → `{ "<display name>": [rows] }`, each row's `.business` inline. `?user=` alone 400/405s;
  the `category` is required.
- Hydrate a bare business id (not needed above, but the general tool):
  `POST {API}/api/filter-list/ {user, ids:[int], load_businesses:true}` → `business_hash`.
  A single removed id 500s the whole batch, so bisect to singles on failure.

Hosts: `ONBOARD = backoffice-service-onboarding-t57o3dxfca-nn.a.run.app`,
`API = backoffice-service-t57o3dxfca-nn.a.run.app` (four in all; login/profile on
ONBOARD, lists on API).

## The bot gate

Every request needs a browser `User-Agent` **and** an `Origin`
(`https://app.beliapp.com`); without them the backend answers `403`. A login
probe returning **401 (not 403)** is how you confirm the headers pass before you
have valid credentials. Space calls ~400 ms; bursts are throttled. This same
network flakes S3/gcloud connects, so wrap fetches in retry.

## Mapping decisions (settled with the owner)

- Beli's 0–10 `score` → new `restaurants.beli_score` column (migration 0052);
  the visit's star rating is `round(score)/2` clamped to 0.5–5 — lossy, hence
  keeping the real number.
- `filter-list list_field:"been"` is **discovery/trending**, not the personal
  list — it returns count 0. Do not use it for a user's list.
- Dedupe on Google `place_id` then `name+city`; **skip** matches, never overwrite
  hand-entered rows. `been` is processed before `want` so a place that is both
  lands as visited.
- `city` arrives as "New York, NY"; split a trailing 2-letter code into
  `state_region`, else keep whole. Country names → ISO-2.
