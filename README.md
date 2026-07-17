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

## Manual subtitle pool (for titles the scrapers can't find)

Sometimes a title genuinely has a Malayalam subtitle on MSone/GOAT/Movie Mirror but this
addon still can't fetch it (site changed its markup, Cloudflare blocked the request, weird
naming, etc.). For those cases there's a 4th subtitle source: a manually-curated pool you
upload to yourself, stored in **your own Google Drive** — not this server's disk — so it
survives Render's free-tier restarts/sleeps without you re-uploading anything.

It shows up in the subtitle picker as **"Malayalam (Community Upload)"**, matched by exact
IMDb id (and season/episode for series) rather than fuzzy title search, so it's more
reliable than the scraped sources whenever it has a match.

### One-time setup

**1. Create a Google Cloud service account** (a robot account, not your personal login):
1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create a project (or use an existing one).
2. **APIs & Services → Library** → search "Google Drive API" → **Enable**.
3. **APIs & Services → Credentials** → **Create Credentials → Service Account** → give it
   any name (e.g. `subtitle-pool-bot`) → **Done**.
4. Click into that service account → **Keys** tab → **Add Key → Create new key → JSON** →
   it downloads a `.json` file. Keep this private, like a password.
5. Open that JSON file and copy the `client_email` value (looks like
   `subtitle-pool-bot@your-project.iam.gserviceaccount.com`).

**2. Share your Drive folder with the robot:**
1. In Google Drive, open (or create) the folder you want to use as the subtitle pool.
2. Right-click → **Share** → paste the `client_email` from step 1 → give it **Editor**
   access → Send (it's fine that it's not a real person — it'll just show an email invite
   warning, ignore it).
3. Open the folder and copy its id from the URL:
   `https://drive.google.com/drive/folders/`**`THIS_PART_IS_THE_FOLDER_ID`**

**3. Set environment variables on your host** (Render: your service → **Environment** tab):

| Variable | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | The **entire contents** of the JSON key file from step 1, pasted as one value |
| `GDRIVE_FOLDER_ID` | The folder id from step 2.3 |
| `ADMIN_USER` | Any username you want for the upload dashboard |
| `ADMIN_PASSWORD` | Any password you want for the upload dashboard |

Redeploy after adding these (Render redeploys automatically when env vars change).

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

Uploads go straight to your Drive folder — you can also just drag files into that folder
yourself in Drive, but they won't show up in the addon until they've gone through the
dashboard once (that's what writes the IMDb-id/season/episode mapping the addon actually
matches against).



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
