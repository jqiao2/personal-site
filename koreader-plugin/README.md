# Reading sync — KOReader plugin

Sends KOReader's reading statistics to `/api/reading/sync` as you read, so
pages-per-day appears on the site without anyone touching anything.

This is the device half of the reading tracker. The server half lives in
`src/pages/api/reading/`, `src/lib/reading.ts` and `supabase/migrations/0020_*`.

## Install

1. Mount the Kindle over USB.
2. Copy the whole `readingsync.koplugin` folder into `koreader/plugins/`:

   ```
   koreader/
     plugins/
       readingsync.koplugin/
         _meta.lua
         main.lua
         stats_sync.lua
   ```

3. Eject, and restart KOReader (exit to the launcher and back in).

## Set it up

**Tools → Reading sync**:

| Setting | Value |
|---|---|
| Server URL | `https://jqiao.vercel.app` — no trailing slash, no path |
| Sync token | the `READING_SYNC_TOKEN` value |
| Device name | `kindle-pw5` (anything, as long as it's stable) |

Then **Sync now**. It should report something like `12 sent, 12 new`. If it says
`0 sent`, the server already has everything — which is the expected result if
you have already run the USB importer.

The token is never displayed after it is saved; the menu only shows whether one
is set. A Kindle screen is a public surface and the token is a bearer
credential.

## How it syncs

- **When you close a book** — the natural point: the session's statistics are
  complete and you aren't mid-page. Deferred a few seconds so KOReader's
  statistics plugin has flushed its rows first, and so closing a book never
  feels like it's waiting on the network.
- **When the device goes to sleep** — catches the case where a book stays open
  for weeks, which on a Kindle is most of the time.
- **Manually**, from the menu.

Both automatic triggers can be turned off individually. They are silent: a
failed background sync is not an error worth interrupting a reader for, because
the rows are still on the device and the next sync carries them.

Each sync asks the server what it already has and sends only what came after,
so a normal sync is a handful of rows rather than the whole history. Re-syncing
is always safe — the server's uniqueness constraint on (book, page, timestamp)
discards anything it already holds, which is why the plugin deliberately starts
a day *before* the cursor rather than risk skipping a row.

## If it doesn't work

- **"Set the server URL and token first"** — one of the two is empty.
- **A WiFi prompt** — the device is offline. Automatic syncs skip silently when
  offline; only the manual one asks.
- **`HTTP 401`** — the token doesn't match `READING_SYNC_TOKEN` on the server.
- **`HTTP 500` on every request** — the server has no `READING_SYNC_TOKEN` set
  in its environment. It needs a redeploy after the variable is added.
- **Nothing at all** — check `koreader/crash.log`; the plugin logs under
  `[readingsync]`.

The statistics database it reads is `koreader/settings/statistics.sqlite3`. It
is opened read-only — it is the only copy of a reading history.

## Backfill

For history that predates the plugin, or a device that isn't jailbroken yet,
`scripts/reading-import-sqlite.mjs` does the same job over USB from a copy of
`statistics.sqlite3`. The two are interchangeable and can be mixed freely; both
go through the same endpoint and the same idempotency constraint.

## What has and hasn't been tested

The data path is verified against a real Paperwhite export: the SQL is run
against an actual `statistics.sqlite3`, the payload it builds is accepted by the
endpoint, the chunk loop drains correctly, and the UTC-cursor arithmetic
round-trips to the right instant. All three files parse as Lua 5.1.

What is **not** verified is the KOReader runtime itself — the menu registration,
the event names, and the SQ3 and socket bindings are all API surface that
differs between KOReader versions and cannot be exercised off-device. The first
run on the Kindle is the real test; `crash.log` is where it will say so.

## Credit

The approach follows [KoInsight](https://github.com/GeorgeSG/KoInsight) (MIT) —
the same SQ3 and `socket.http` idioms, because that is simply how a KOReader
plugin talks to a database and a network. What differs here is the payload, the
bearer auth, and syncing incrementally from a server-held cursor instead of
re-uploading the whole statistics database each time.
