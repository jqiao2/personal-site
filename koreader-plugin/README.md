# Reading sync — KOReader plugin

Sends KOReader's reading statistics to `/api/reading/sync` as you read, so
pages-per-day appears on the site without anyone touching anything.

This is the device half of the reading tracker. The server half lives in
`src/pages/api/reading/`, `src/lib/reading.ts` and `supabase/migrations/0020_*`.

## Install

Mount the Kindle over USB, then:

```bash
node --env-file=.env scripts/reading-plugin-install.mjs --dest F:/
```

That copies the plugin in and writes its settings file already filled in, so
there is nothing to type on the device — which matters, because the sync token
is 64 hex characters and the alternative is an e-ink keyboard. It refuses to
write anywhere without a `koreader/` directory, since the argument is a drive
letter and drive letters move. Re-running it updates the plugin but leaves your
settings alone unless you pass `--force`.

Then eject and restart KOReader (exit to the launcher and back in).

To do it by hand instead: copy the `readingsync.koplugin` folder into
`koreader/plugins/`, then fill in **Tools → Reading sync**:

| Setting | Value |
|---|---|
| Server URL | `https://jqiao.vercel.app` — no trailing slash, no path |
| Sync token | the `READING_SYNC_TOKEN` value |
| Device name | `kindle-pw5` (anything, as long as it's stable) |

Either way, finish with **Sync now**. It should report something like
`12 sent, 12 new`. If it says `0 sent`, the server already has everything —
the expected result if you have already run the USB importer.

## Keeping it hands-off

The plugin only syncs when the device is online, and skips silently when it
isn't. On a Kindle that usually means turning on **KOReader → Network → auto
connect on network access** (or leaving WiFi on), otherwise a sync fires only
when WiFi happens to already be up.

Worth knowing before you leave WiFi on: on a jailbroken Kindle that also means
the device can reach Amazon's update servers. If OTA updates are not already
blocked (OTArenamer, from the post-jailbreak setup), a firmware update can
remove the jailbreak — and KOReader with it.

There is no background daemon. KOReader has to be running for a sync to happen;
if you exit to the Kindle's own reader, nothing syncs until you go back in. The
suspend trigger is what covers the normal case of a book left open for weeks.

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
- **`HTTP 503: reading sync is not configured`** — the server has no
  `READING_SYNC_TOKEN` in its environment. Note that setting it is not enough on
  Vercel: the deployment has to postdate the variable, so add it *and* redeploy.
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
