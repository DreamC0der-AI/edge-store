# edge-store

Personal file storage built on free services. Telegram holds the bytes, a Cloudflare Worker with a D1 database holds the index and is the only door in, and a scheduled job checks and repairs the stored copies.

It does one thing: keep files retrievable. It does **not** encrypt. File contents are readable by Telegram and file names are readable by Cloudflare, so encrypt anything private before you store it.

This is a personal project, built and tested over a few days. It leans on the free allowances of two services that were not designed for this, and either can change its limits or rules at any time. Read [Limits to know about](#limits-to-know-about) before trusting it with the only copy of anything.

## What you get

- **A command line** (`edge put`, `edge get`, `edge ls`, ...) that uploads and downloads files of any size, resumes interrupted uploads and checks every byte it reads against a hash.
- **A web page** served by the Worker: drop files in, browse folders, look at pictures, video, sound, PDFs and text, download, delete.
- **An HTTP API** for your own apps, with keys you grant and revoke one by one, read-only or read-write, optionally confined to a folder.
- **Two copies of everything**, in two separate Telegram channels, checked on a schedule and re-made from the other copy when one goes missing.
- **A daily backup of the index** stored in the channels themselves, so the index can be rebuilt if the database is lost.

## How it works

```
  your apps        edge command line        web page
       \                  |                   /
        \   HTTPS, "Authorization: Bearer <key>"
         v                v                 v
      +-----------------------------------------+        +---------------------------+
      |            Cloudflare Worker            | <----> | D1 database: the index    |
      |  (holds the bot token; scheduled job)   |        | files, chunks, hashes,    |
      +-----------------------------------------+        | replica locations, keys   |
                 |  Telegram Bot API  |                  +---------------------------+
                 v                    v
        private channel A     private channel B
        (copy 1 of each chunk) (copy 2 of each chunk)
```

- **One door:** apps talk only to the Worker's HTTP API. The Telegram bot token is a Worker secret and is never returned by any endpoint.
- **Keys:** each app gets its own key, which can be read-only or read-write, can be confined to a path prefix, and can be revoked at any time. Only a hash of each key is stored.
- **Splitting:** a file is cut into 16 MiB chunks (a Telegram bot can upload up to about 50 MB but can only download files under 20 MB).
- **Two replicas:** the Worker pipes every chunk into two separate uploads, one per private channel, so the two copies are independent stored files.
- **Index:** the Worker records each file, its chunks with their SHA-256 hashes, and where every replica lives. Half-finished uploads are never listed.
- **Folders are only names:** a file is stored under a path such as `photos/2026/cat.jpg`. There are no folder objects; a folder exists as long as some file's path starts with it.
- **Scrubber:** a scheduled job runs every minute. During a pass it checks the next 20 replicas (does the message exist, can Telegram still fetch the stored file at the right size); a pass over everything starts at most every 6 hours. Every run also re-uploads at most one missing replica from a surviving copy.
- **Index backup:** once a day the Worker uploads a snapshot of the index (including the key hashes) to both channels and pins it, so the index can be rebuilt from the channels alone.

## Requirements

- Node.js 20 or newer.
- A Cloudflare account. The free plan is enough.
- A Telegram account, to create one bot and two private channels.
- Google Chrome, only for the browser tests.

## Setup

1. Get the code and its tools:
   ```
   git clone https://github.com/DreamC0der-AI/edge-store.git
   cd edge-store
   npm install
   ```
2. In Telegram, create a bot with @BotFather and create two private channels. Add the bot to both channels as an administrator that can post, delete and pin messages.
3. Copy `spike/env.example` to `spike/.env` and put the bot's token in it. Run `node spike/tg-setup.mjs` and post one message in each channel while it waits; it finds the two channel ids and writes them into the same file. (`.env` files are ignored by git.)
4. Log in to Cloudflare with `npx wrangler login`, then run:
   ```
   node scripts/setup.mjs
   ```
   It creates the D1 database (or finds the one an earlier setup made), deploys the Worker, stores the bot token and a new owner token as Worker secrets, registers the two channels, and writes the connection settings to `~/.config/edge-store/config.json`. It prints no secret values.
5. Try it:
   ```
   node client/edge.mjs put some-file.pdf
   node client/edge.mjs ls
   node client/edge.mjs web
   ```

The owner token in `~/.config/edge-store/config.json` can do everything, including granting keys. Keep it to yourself and give apps their own keys.

After changing the Worker or the web page, deploy with `npm run deploy`. The Worker's settings live in `worker/wrangler.template.toml`; setup and `npm run deploy` copy it to `worker/wrangler.toml` with your database id filled in, and that copy is not committed.

## Giving apps access

```
edge key add "photo app" --prefix apps/photos/     read-write, only under apps/photos/
edge key add "dashboard" --read-only               may list and download everything
edge key add "second laptop" --admin               full control, like the owner token
edge key ls                                        names, limits, last use
edge key revoke <key-id>                           the key stops working at once
```

`key add` prints the key once; it cannot be shown again. A prefix is a plain "starts with" test, so end it with `/` (`apps/photos/`, not `apps/photos`). The owner token itself is the `ACCESS_TOKEN` Worker secret: change it with `npx wrangler secret put ACCESS_TOKEN` if it leaks.

## Web page

The Worker serves a page at its own address (`https://<your-worker>.workers.dev/`) for saving and checking files from a browser:

```
edge web                    grant a key for the page and open it, ready to sign in
edge web --link             print the sign-in link instead, to open on another device such as a phone
edge web --read-only        a page that can look and download but not change anything
edge web --prefix phone/    a page confined to one folder
```

- **Saving:** drop files or whole folders anywhere on the page, or use "Choose files". They go into the folder on show, in two copies, with progress, and an upload that was interrupted is picked up where it stopped when you drop the same file again.
- **Checking:** the page lists what is stored, by folder, with a name filter. "Download" fetches a file and checks every part against its hash before handing it over; "Delete" asks twice.
- **Looking:** clicking a picture, video, sound file, PDF or text file opens it in the page, with arrows to step through the folder. The file is downloaded and checked first, so this is for files up to 256 MB; a text file shows its first 256 KB. What a file is shown as depends only on its name, and a stored web page or script is only ever shown as text.
- **Previews:** a picture saved through the page gets a small preview (a JPEG of at most 256 pixels, a few kilobytes) stored beside it as `<folder>/.thumbs/<the picture's file id>.jpg`, made in the browser from the picture before it is sent. The list fetches only these, once per browser. A picture stored some other way has no preview until it is first opened in the page, which makes one; the list never downloads a whole picture just to show a preview. The page hides the `.thumbs` folders, `edge ls` and your own apps see them as ordinary files. Deleting a picture in the page or with `edge rm` deletes its preview; `edge clean` removes previews whose picture was deleted some other way.
- **Signing in:** the page itself holds no secrets and anyone can load it; it does nothing without a key. A link from `edge web` carries a key, and the page asks before using it: it shows which key it is and what it replaces, and signs in only when you press "Sign in". A link cannot sign a browser in, or swap the key it is signed in with, by itself. The key is kept in that browser until you sign out, and each `edge web` makes a new key that shows up in `edge key ls` and can be revoked on its own. Signed in with the owner token or an admin key, the page also shows whether every stored copy is in place.
- **Kept in the browser:** the key, and the previews it has fetched. Signing out removes both.
- **Large downloads:** Chrome and Edge on a computer write a download over 256 MB straight to a file you pick. Other browsers (Safari, Firefox, phones) hold the whole download in memory until it is complete, so use the command line there for files of several gigabytes.

The page lives in `worker/web/` and is an ordinary client of the HTTP API below. It is served as static files, which do not count against the Worker's daily request allowance.

## Commands

```
edge init <worker-url> <key>            save connection settings (owner token or an app key)
edge whoami                             what this key may do
edge web [--link]                       open the web page with a new key to sign in with
edge put <local-file> [remote-path]     upload (resumes an interrupted upload)
edge get <remote-path> [local-file]     download and verify
edge ls [prefix]                        list files
edge rm <remote-path>                   delete a file
edge status                             replica health and scrubber progress
edge verify [prefix]                    download every replica and check its hash
edge repair                             re-upload replicas marked missing
edge clean                              remove uploads abandoned more than a day ago, and previews of deleted pictures
edge backup                             snapshot the index into the channels now
edge restore                            rebuild the index from the pinned snapshot
edge channel add <chat-id> <slot>       register a channel for replica slot 0 or 1
edge channel rm <chat-id>               stop uploading to a channel
edge pause | resume                     stop or restart the scheduled scrubber
```

Run it as `node client/edge.mjs ...`, or `npm link` to get the `edge` command. Everything from `status` down needs the owner token or an admin key.

## HTTP API for apps

Send the key as `Authorization: Bearer <key>`. Errors come back as JSON `{"error": "..."}` with a matching status: 401 for an unknown or revoked key, 403 for something the key may not do, 409 for a path that already exists, 429 with `retryAfter` (seconds) when Telegram asks to slow down, 502 or 503 when Telegram failed and the request can simply be repeated.

**Small files, one request each** (up to 19 MB to upload; up to 24 chunks, about 384 MB, to download):

```
curl -X PUT  -H "Authorization: Bearer $KEY" --data-binary @notes.txt  $URL/raw/docs/notes.txt
curl         -H "Authorization: Bearer $KEY"  $URL/raw/docs/notes.txt -o notes.txt
```

The download carries the file's SHA-256 in the `X-Sha256` header.

**Any size, chunk by chunk:**

| Step | Request |
|---|---|
| Begin (or resume) | `POST /files` with `{"path", "size", "chunkSize", "chunks"}`; returns `id` and `have`, the chunks already stored |
| Send chunk n | `PUT /files/<id>/chunks/<n>?sha256=<hex>` with the raw bytes as the body |
| Finish | `POST /files/<id>/commit` with `{"sha256": <hash of the whole file>}` |
| Look up | `GET /file?path=...` returns the file with its chunk list and hashes |
| Read chunk n | `GET /files/<id>/chunks/<n>` returns the bytes, with `X-Sha256` for checking them |
| List | `GET /files?prefix=...` |
| Delete | `DELETE /files/<id>`; repeat until it answers `"done": true` |
| Who am I | `GET /whoami` |

`chunkSize` may be anything up to 19 MB; 16 MiB (16777216) is the usual choice. Every chunk but the last must be exactly `chunkSize` bytes. The Worker does not hash what it stores (that would cost more CPU than the free plan allows), so check each chunk you read against its hash; if one is wrong, read the other copy with `?slot=0` or `?slot=1` and report the bad one with `POST /replicas/<id>` `{"state":"missing"}`. `client/lib.mjs` does all of this and is the reference client.

## Tests

- `npm test` runs the unit tests and the offline integration tests: the real Worker code under `wrangler dev` with a local database, against a simulated Telegram (`test/fake-telegram.mjs`) that can delete messages, lose or corrupt files, rate-limit and lose a whole channel.
- The web page is tested the same way in a real browser (`test/web.test.mjs`, part of `npm test`). It needs `npm install` once and uses the Chrome already on the machine; without them those tests are skipped. `EDGE_WEB_BROWSER=webkit npm test` runs them in Safari's engine after `npx playwright-core install webkit`.
- `npm run e2e` runs against the deployed Worker and real Telegram: keys, the web page in a browser, the scheduled repair of a hand-deleted replica, index wipe and restore, and a 1 GB round trip through the Worker. `npm run e2e -- --no-big` skips the 1 GB round trip. Once the store is in use, add `--no-wipe`: the wipe-and-restore step empties the index for a few seconds, and anything saved by someone else in that time would drop out of it.

## What is where

| Path | What it is |
|---|---|
| `worker/src/index.js` | The Worker: the HTTP API, the scheduled scrubber and repair, the index backup |
| `worker/schema.sql` | The index's tables |
| `worker/web/` | The web page, served by the Worker as static files |
| `client/lib.mjs` | The reference client: chunking, hashing, resuming, falling back to the other copy |
| `client/edge.mjs` | The `edge` command line, built on `client/lib.mjs` |
| `scripts/` | Setup, deployment and maintenance |
| `test/` | Unit tests, offline tests against a simulated Telegram, browser tests, and the live test |
| `spike/` | The measurements the design rests on: Telegram's and Cloudflare's actual limits and behaviour |

## Maintenance scripts

- `node scripts/watch-scheduler.mjs [minutes]` prints each scheduled run as it is recorded.
- `node scripts/sweep-orphans.mjs [--delete]` looks for edge-store messages in the channels that the index does not know about (left behind if a run dies between an upload and its index write) and, with `--delete`, removes them. It reads messages by forwarding them one id at a time, so it only suits small channels.

## Where the secrets are

- **The Telegram bot token** is in `spike/.env` on the machine that ran setup and in the Worker's secrets. No endpoint returns it.
- **The owner token** is in `~/.config/edge-store/config.json` (readable only by you) and in the Worker's secrets.
- **Keys you grant** are shown once when made. The database keeps only their hashes.
- **The web page** keeps the key it was signed in with in that browser until you sign out.
- **Nothing secret is in this repository.** `.env` files and `worker/wrangler.toml` are ignored by git.

Anyone who is a member of the two channels can read the stored files directly in Telegram, so keep the channels private.

## Limits to know about

- **Everything is on Telegram.** Two replicas protect against a lost message, file or channel. They do not protect against Telegram being down or your Telegram account or bot being banned.
- **Everything passes through Cloudflare.** The free plan allows 100,000 requests a day and a 100 MB request body; each chunk is one request.
- **Free-plan CPU.** Chunk transfers are piped, not buffered, so they cost little CPU. A repair run buffers and hashes one chunk and uses several times Cloudflare's documented 10 ms allowance; occasional runs are tolerated, sustained heavy use is not, and any single run can be killed, so the scrubber is written to be retried. Repair is paced at one chunk a minute (about 23 GB a day); use `edge repair` for anything bigger.
- **Scrub speed.** 20 replicas a minute is about 28,800 a day, so a pass over a 100 GB store (12,800 replicas) takes roughly 11 hours. A deleted message or lost file is therefore noticed within about 6 hours plus the pass time, not instantly. Each check makes Telegram fetch the whole chunk internally, which is why passes are spaced out; `PUT /settings {"scrubIntervalMinutes": n}` changes the spacing.
- **Scheduler start.** After the first deployment the scheduled job took 30 minutes to run for the first time (5 to 8 minutes in other trials), and a deleted test Worker's schedule still fired once about 30 minutes after deletion. Treat Cloudflare's schedule changes as taking up to half an hour to settle. `edge status` shows the last run.
- **Not yet observed over time.** Everything here was tested within one day. Whether Telegram answers the message check the same way for messages older than 48 hours is unknown; if it does not, `edge status` shows a "note" line and the stored-file check still runs.
- **Shallow checks.** The scrubber does not hash content. Silent corruption is caught when a chunk is read by a client that checks hashes (`get`, a repair) or by `edge verify`.
- **Old messages.** Telegram is reported to refuse bots deleting messages older than 48 hours. If that happens `edge rm` still removes the file from the index, and the old chunk messages stay in the channel until you delete them yourself.
- **Index backup size.** The snapshot must fit in one message of under 19 MB compressed.
- **Channel size.** Uploads move on to another registered channel once one holds 500,000 messages; add channels with `edge channel add`.
