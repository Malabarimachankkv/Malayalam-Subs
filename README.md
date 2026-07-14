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
   list, one per site that had a match.

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

## Known limitation: Cloudflare

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
