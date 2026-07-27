# Malayalam Subtitles — Stremio/Nuvio Addon (Team GOAT + Movie Mirror)

A Stremio-protocol subtitle addon that pulls Malayalam subtitles from two community
subtitle sites — [malayalamsubtitles.in](https://malayalamsubtitles.in) (Team GOAT) and
[moviemirrorsubtitles.com](https://moviemirrorsubtitles.com) (Movie Mirror) — for movies and
series, and serves them to any Stremio-compatible app, including Stremio itself and Nuvio.

**For MSone specifically**, install their own official addon instead of relying on this one:
`https://addon.malayalamsubtitles.org/manifest.json`. It's built and run by the MSone team
themselves, so it's more reliable than anything scraped from outside — install it alongside
this addon and Stremio/Nuvio will show subtitles from all three sources together.

## How it works

1. Stremio/Nuvio asks the addon for subtitles for an IMDb id (e.g. `tt6723592`).
2. The addon resolves that id to a title/year via [Cinemeta](https://v3-cinemeta.strem.io)
   (the same public metadata service Stremio uses).
3. It searches both sites in parallel for a matching release.
4. Whichever site has a match gets downloaded and, if zipped, unzipped in memory to pull out
   the actual `.srt`/`.vtt` file (players can't open `.zip` links directly). For a season
   bundled as one zip with a file per episode, it picks out the specific episode being played.
5. It briefly caches those extracted files and serves them from its own `/sub/<key>.srt`
   URL — so up to two Malayalam subtitle options can show up in the player's subtitle list,
   each one clearly labeled with which site it came from ("Malayalam (Team GOAT)",
   "Malayalam (Movie Mirror)"), so you can tell them apart and try another if one doesn't
   sync well.

Nothing is permanently stored or redistributed — files are only held in memory briefly per
request, same as a browser cache.

### A note on Movie Mirror specifically

Movie Mirror's `robots.txt` disallows automated access to its own search/filter page, so
this addon doesn't use it. It also has no separate search API. Instead, the addon builds an
index of Movie Mirror's public movie/series category listings (pages `robots.txt` does
allow) in the background, the first time it's needed, then reuses that index for 12 hours.
Practical effect: right after a cold start (or after 12h when the index refreshes), Movie
Mirror results may be briefly missing from a lookup while the index builds — Team GOAT is
unaffected and appears immediately either way. A minute or two later, Movie Mirror results
start appearing normally.

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
- Also install `https://addon.malayalamsubtitles.org/manifest.json` the same way for MSone.

## 4. Install into Nuvio

- Open Nuvio → **Addons** screen → **Install via Manifest URL** (or the "+" / add-addon
  option) → paste the same `https://<your-app>/manifest.json` URL → confirm.
- Also install `https://addon.malayalamsubtitles.org/manifest.json` the same way for MSone.

Nuvio speaks the same addon protocol as Stremio, so no changes are needed between the two.
No account, sign-up, or API key is needed anywhere in this — just the one manifest URL.

## Strongly recommended: keep the server from sleeping

Render's free tier puts your server to sleep after 15 minutes of no traffic, and each
wake-up is a brand new process with an empty memory. Movie Mirror (100+ pages) builds its
catalog as a background crawl the first time it's needed — Team GOAT only needs one quick
page fetch, so it always finishes before you notice, but Movie Mirror's multi-page crawl can
easily still be mid-crawl when the server goes back to sleep, meaning it silently never
finishes and looks broken even though nothing is actually wrong.

Fix: use a free uptime monitor to ping your manifest URL every few minutes so Render never
puts the server to sleep in the first place. [UptimeRobot](https://uptimerobot.com)'s free
plan (no card required) works well for this:
1. Sign up free → **Add New Monitor** → type **HTTP(s)**
2. URL: `https://<your-app>/manifest.json`
3. Interval: 5 minutes (the free plan's fixed interval — plenty fast enough here)
4. Save

Once that's running, Movie Mirror's index only ever has to build once and then stays warm,
refreshing quietly in the background every 12 hours.

## Notes

- Team GOAT and Movie Mirror both group TV series subtitles by *season* rather than
  per-episode, so the addon searches for `"<Show Name> Season <N>"` and, if a zip with one
  file per episode comes back, picks out the specific episode being played.
- Only Malayalam subtitles are returned, since that's the whole point of these sites.
- This is an unofficial, personal-use integration with two free community subtitle sites —
  it doesn't scrape or redistribute anything they don't already serve publicly for free.
