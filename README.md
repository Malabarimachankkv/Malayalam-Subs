# Malayalam Subtitles — Stremio/Nuvio Addon (MSone + Team GOAT + Movie Mirror)

A Stremio-protocol subtitle addon that pulls Malayalam subtitles from three community
subtitle sites — [malayalamsubtitles.org](https://malayalamsubtitles.org) (MSone),
[malayalamsubtitles.in](https://malayalamsubtitles.in) (Team GOAT), and
[moviemirrorsubtitles.com](https://moviemirrorsubtitles.com) (Movie Mirror) — for movies and
series, and serves them to any Stremio-compatible app, including Stremio itself and Nuvio.

## How it works

1. Stremio/Nuvio asks the addon for subtitles for an IMDb id (e.g. `tt6723592`).
2. The addon resolves that id to a title/year via [Cinemeta](https://v3-cinemeta.strem.io)
   (the same public metadata service Stremio uses).
3. It searches all three sites in parallel for a matching release.
4. Whichever sites have a match get downloaded and, if zipped, unzipped in memory to pull
   out the actual `.srt`/`.vtt` file (players can't open `.zip` links directly).
5. It briefly caches those extracted files and serves them from its own `/sub/<key>.srt`
   URL — so up to three Malayalam subtitle options can show up in the player's subtitle
   list, each one clearly labeled with which site it came from (e.g. "Malayalam (MSone)",
   "Malayalam (Team GOAT)", "Malayalam (Movie Mirror)"), so you can tell them apart and try
   another if one doesn't sync well.

Nothing is permanently stored or redistributed — files are only held in memory briefly per
request, same as a browser cache.

### A note on Movie Mirror specifically

Movie Mirror's `robots.txt` disallows automated access to its own search/filter page, so
this addon doesn't use it. It also has no separate search API. Instead, the addon builds an
index of Movie Mirror's public movie/series category listings (pages `robots.txt` does
allow) in the background, the first time it's needed, then reuses that index for 12 hours.
Practical effect: right after a cold start (or after 12h when the index refreshes), Movie
Mirror results may be briefly missing from a lookup while the index builds — MSone and Team
GOAT results are unaffected and appear immediately either way. A minute or two later, Movie
Mirror results start appearing normally.

## 1. Run it locally (fastest way to test)

```bash
npm install
npm start
```

This starts the addon at `http://127.0.0.1:7000/manifest.json`. You can install that URL
straight into the **desktop** Stremio app for a quick test. It will *not* work over the network
from your phone/TV unless port 7000 is reachable from those devices — for that, deploy it (step 2).

## 2. Deploy it so your phone/TV/Nuvio can reach it

Any Node.js host works. Two free/cheap options:

### Render.com
1. Push this folder to a GitHub repo.
2. In Render, create a new **Web Service** from that repo.
3. Build command: `npm install`  ·  Start command: `npm start`
4. Once deployed, your manifest URL is `https://<your-app>.onrender.com/manifest.json`

### Railway.app
1. Push this folder to a GitHub repo (or use `railway up` from this folder).
2. Railway auto-detects Node and runs `npm start`.
3. Add a public domain in the Railway dashboard.
4. **Add an environment variable `PUBLIC_URL`** set to that domain, e.g.
   `https://<your-app>.up.railway.app` (no trailing slash). The addon needs to know its
   own public address so it can hand back working subtitle-file links — Render sets this
   automatically, Railway doesn't, so this one manual step is needed there.
5. Your manifest URL is `https://<your-app>.up.railway.app/manifest.json`

Any host that gives you a public HTTPS URL and runs Node.js works the same way (Fly.io,
Cyclic, a VPS with a reverse proxy, etc.). Stremio requires **HTTPS** for remotely-hosted
addons, so make sure your host provides a TLS certificate (all three above do this for you).

## 3. Install into Stremio

- Open Stremio → the puzzle-piece **Addons** icon → paste your manifest URL
  (`https://<your-app>/manifest.json`) into the search bar at the top → **Install**.

## 4. Install into Nuvio

- Open Nuvio → **Addons** screen → **Install via Manifest URL** (or the "+" / add-addon
  option) → paste the same `https://<your-app>/manifest.json` URL → confirm.

Nuvio speaks the same addon protocol as Stremio, so no changes are needed between the two.

## Strongly recommended: keep the server from sleeping

Render's free tier puts your server to sleep after 15 minutes of no traffic, and each
wake-up is a brand new process with an empty memory. MSone (~300 pages) and Movie Mirror
(100+ pages) build their catalogs as a background crawl the first time they're needed —
Team GOAT only needs one quick page fetch, so it always finishes before you notice, but
MSone and Movie Mirror's multi-page crawls can easily still be mid-crawl when the server
goes back to sleep, meaning they silently never finish and those two sources look broken
even though nothing is actually wrong.

Fix: use a free uptime monitor to ping your manifest URL every few minutes so Render never
puts the server to sleep in the first place. [UptimeRobot](https://uptimerobot.com)'s free
plan (no card required) works well for this:
1. Sign up free → **Add New Monitor** → type **HTTP(s)**
2. URL: `https://<your-app>/manifest.json`
3. Interval: 5 minutes (the free plan's fixed interval — plenty fast enough here)
4. Save

Once that's running, MSone and Movie Mirror's indexes only ever have to build once and then
stay warm, refreshing quietly in the background every 12 hours.

## Storage: Backblaze B2 (subtitle pool + auto-cache)

This addon uses [Backblaze B2](https://www.backblaze.com/cloud-storage) — free object
storage (10GB free, no credit card required to sign up) — for two things:

1. **The manual subtitle pool** — titles you've uploaded yourself because the scrapers
   couldn't find them (see below).
2. **Auto-caching scraped subtitles** — the first time someone requests a title, the addon
   scrapes MSone/GOAT/Movie Mirror as normal and saves a copy to B2. Every request after
   that for the *same* title/episode is served straight from B2 instead of re-scraping the
   source site — faster, and it keeps working even if a source site is temporarily down or
   changes its markup.

Nothing is written to this server's own disk, so none of this is lost when Render's
free-tier restarts or sleeps.

### One-time setup

**1. Create a Backblaze account and bucket:**
1. Sign up free at [backblaze.com/sign-up/cloud-storage](https://www.backblaze.com/sign-up/cloud-storage) — no card needed.
2. In the dashboard, go to **B2 Cloud Storage → Buckets → Create a Bucket**.
3. Name it anything unique (e.g. `malayalam-subs-pool`) → set **Files in Bucket are: Private** → **Create Bucket**.
4. Click into the bucket → note the **Endpoint** shown (looks like `s3.us-west-004.backblazeb2.com`)
   — the part after `s3.` and before `.backblazeb2.com` (e.g. `us-west-004`) is your region.

**2. Create an application key:**
1. Left sidebar → **Application Keys** → **Add a New Application Key**.
2. Name it anything, restrict it to the bucket you just made, allow **Read and Write** → **Create New Key**.
3. Copy the **keyID** and **applicationKey** shown — like the Drive JSON key, the
   applicationKey is only shown once, so copy it now.

**3. Set environment variables on your host** (Render: your service → **Environment** tab):

| Variable | Value |
|---|---|
| `B2_ENDPOINT` | `https://s3.<region>.backblazeb2.com` (e.g. `https://s3.us-west-004.backblazeb2.com`) |
| `B2_REGION` | Just the region part (e.g. `us-west-004`) |
| `B2_BUCKET` | Your bucket name |
| `B2_KEY_ID` | The keyID from step 2.3 |
| `B2_APPLICATION_KEY` | The applicationKey from step 2.3 |
| `ADMIN_USER` | Any username you want for the upload dashboard |
| `ADMIN_PASSWORD` | Any password you want for the upload dashboard |

Redeploy after adding these (Render redeploys automatically when env vars change).

## Manual subtitle pool (for titles the scrapers can't find)

Sometimes a title genuinely has a Malayalam subtitle on MSone/GOAT/Movie Mirror but this
addon still can't fetch it (site changed its markup, Cloudflare blocked the request, weird
naming, etc.). For those cases there's a 4th subtitle source: a manually-curated pool you
upload to yourself via a small dashboard, stored in B2 (see above).

It shows up in the subtitle picker as **"Malayalam (Community Upload)"**, matched by exact
IMDb id (and season/episode for series) rather than fuzzy title search, so it's more
reliable than the scraped sources whenever it has a match.

### Using it

Go to `https://<your-app>/admin`, log in with `ADMIN_USER`/`ADMIN_PASSWORD` (your browser
will prompt for these), then:
1. Pick **Movie** or **Series**.
2. Type the title in the search box and click the correct result — this is what tags the
   file with the right IMDb id, so get this right.
3. For a series, fill in **Season**, and **Episode** if you're uploading a single episode's
   `.srt` directly (leave Episode blank if uploading a `.zip` with a whole season's `.srt`
   files inside — the addon reads each episode number from the filenames in the zip).
4. Choose the file and click **Upload**.

The dashboard also lists everything currently in the pool, with a delete button per entry.




MSone's site sits behind Cloudflare's bot-protection on some pages. Most of the time
requests from a normal cloud server pass fine, but if you start seeing empty subtitle
results and the logs show `MSONE_BLOCKED`, it means Cloudflare served a challenge page
instead of the article. Options if that happens:
- Try again later (challenges are often IP/traffic based and pass on retry).
- Host from a different provider/IP.
- For a more robust (but heavier) fix, swap the plain `axios` request in `lib/msone.js`
  for a headless-browser fetch (e.g. Playwright) or a Cloudflare-solving proxy like
  FlareSolverr — the rest of the addon logic doesn't need to change.

## Notes

- MSone groups TV series subtitles by *season* rather than per-episode, so the addon
  searches for `"<Show Name> Season <N>"` and returns whatever MSone has for that season.
- Only Malayalam subtitles are returned, since that's the site's entire purpose.
- This is an unofficial, personal-use integration with a free community subtitle site — it
  doesn't scrape or redistribute anything MSone doesn't already serve publicly for free.
