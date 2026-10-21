const { addonBuilder } = require('stremio-addon-sdk');
const { getMeta } = require('./lib/cinemeta');
const goat = require('./lib/goat');
const moviemirror = require('./lib/moviemirror');
const fileCache = require('./lib/fileCache');
const pool = require('./lib/pool');
const subtitleCache = require('./lib/subtitleCache');
const catalogs = require('./lib/catalogs');
const { CONTENT_TYPES } = require('./lib/fetchFile');

// Render sets RENDER_EXTERNAL_URL automatically. On other hosts, set a PUBLIC_URL
// env var to your public https:// URL (see README).
const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://127.0.0.1:${process.env.PORT || 7000}`
).replace(/\/$/, '');

// Stremio shows this text verbatim in the subtitle picker whenever it isn't a
// valid ISO 639-2 code (which "mal" is, but these deliberately aren't) — so
// each source shows up clearly labeled instead of unlabeled "Malayalam" entries.
const SOURCE_LABELS = {
  goat: 'Malayalam (Team GOAT)',
  moviemirror: 'Malayalam (Movie Mirror)',
  pool: 'Malayalam (Community Upload)',
};

// The manifest is built inside buildAddon() (below) because the catalog
// rows need one quick fetch first — the Team GOAT festival list feeds the
// "Festivals" row's genre dropdown. Everything else here is static.
function buildManifest() {
  return {
    id: 'community.malayalamsubs.goat-moviemirror',
    version: '5.3.0',
    name: 'Malayalam Subtitles (Team GOAT + Movie Mirror)',
    description:
      'Unofficial addon for Team GOAT and Movie Mirror Malayalam subtitles. ' +
      'Also adds browsable catalog rows (latest releases, movies, series, genres and festivals) from both sites.',
    // Subtitles stay IMDb-only ("tt…"). Catalog items are resolved to IMDb
    // ids too; the few that can't be get an "mlsub:" id served by the meta
    // handler so they still open to a page with the site link.
    resources: [
      { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] },
      'catalog',
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['mlsub:'] },
    ],
    types: ['movie', 'series'],
    catalogs: catalogs.buildCatalogs(),
    idPrefixes: ['tt', 'mlsub:'],
    behaviorHints: { configurable: false },
  };
}

let builder;

async function buildAddon() {
  await catalogs.init();
  builder = new addonBuilder(buildManifest());
  defineHandlers();
  return builder.getInterface();
}

function defineHandlers() {
  builder.defineCatalogHandler((args) => catalogs.handleCatalog(args));
  builder.defineMetaHandler((args) => catalogs.handleMeta(args));

  // Stremio sends ids like "tt1234567" for movies and "tt1234567:1:5" for series (season:episode)
  function parseId(id) {
    const [imdbId, season, episode] = id.split(':');
    return {
      imdbId,
      season: season ? parseInt(season, 10) : null,
      episode: episode ? parseInt(episode, 10) : null,
    };
  }

  builder.defineSubtitlesHandler(async ({ type, id }) => {
    try {
      const { imdbId, season, episode } = parseId(id);
      const meta = await getMeta(type, imdbId);
      if (!meta || !meta.title) return { subtitles: [] };

      // Sites usually include the season number in a show's listing once it has
      // multiple seasons, but a freshly-released show's first season is often
      // listed under just its plain name with no "Season 1" anywhere yet. Try
      // the season-qualified query first (helps pick the right season when a
      // show has several), and fall back to the bare title if that finds nothing.
      const primaryQuery = type === 'series' && season ? `${meta.title} Season ${season}` : meta.title;
      const fallbackQuery = type === 'series' ? meta.title : null;

      // A bare-title fallback search can't tell seasons apart — for a show with
      // several numbered seasons on a site (e.g. GOAT listing House of the
      // Dragon as three separate Season 1/2/3 pages), dropping "Season N" from
      // the query makes all of them match equally, and the code would silently
      // serve whichever one happened to come first — Season 1's subtitles for
      // a Season 4 episode, with no error or warning. If we can read an actual
      // season number off the matched title and it doesn't agree with what was
      // requested, that's a confirmed wrong-season match — refuse it rather
      // than guess. Titles with no identifiable season number at all (the
      // actual case this fallback exists for) still pass through untouched.
      function extractSeasonNumber(title) {
        const m = (title || '').match(/season\s*0*(\d{1,2})\b|\bs0*(\d{1,2})e\d{1,3}\b/i);
        if (!m) return null;
        return parseInt(m[1] || m[2], 10);
      }

      // Runs the season-qualified query and the bare-title fallback query at
      // the SAME time rather than one after the other. This used to be
      // sequential — wait for primaryQuery to fully fail (a full listing
      // scan + page fetch to confirm IMDb id) before even starting
      // fallbackQuery — which stacks two slow round-trips into one request
      // and risks timing out, especially on a cold/sleeping free-tier host.
      // Firing both at once means the fallback is already in flight by the
      // time we find out primary failed, cutting worst-case latency roughly
      // in half. It also fixes titles that will NEVER match the primary
      // query at all — e.g. a source lists a brand-new show as just
      // "Brown (2026)" with no "Season 1" anywhere in it, so a query for
      // "Brown Season 1" scores zero every single time, not just on a slow
      // day. Previously this always required a manual pool upload to work
      // around; now the fallback's own result is available immediately.
      async function searchSource(fn) {
        if (!fallbackQuery) return fn(primaryQuery);

        const [primary, fallback] = await Promise.all([
          fn(primaryQuery).catch((err) => {
            console.error('primary query failed:', err.message);
            return null;
          }),
          fn(fallbackQuery).catch((err) => {
            console.error('fallback query failed:', err.message);
            return null;
          }),
        ]);

        if (primary) return primary;
        if (!fallback) return null;

        if (season) {
          const foundSeason = extractSeasonNumber(fallback.matchedTitle);
          if (foundSeason !== null && foundSeason !== season) {
            return null; // confirmed different season — don't serve it
          }
        }
        return fallback;
      }

      // Each source's fetchSubtitleFile sends that source's own site as the
      // Referer header, which matters for sources like Movie Mirror that serve
      // files straight from /wp-content/uploads/ and can reject a foreign
      // Referer — calling the wrong module's fetchSubtitleFile silently broke
      // downloads for whichever source wasn't written for.
      const SOURCE_MODULES = { goat, moviemirror };
      const SEARCHERS = {
        goat: () => searchSource((q) => goat.findSubtitleUrl(q, meta.year, imdbId)),
        moviemirror: () => searchSource((q) => moviemirror.findSubtitleUrl(q, meta.year, imdbId)),
      };

      const subtitles = [];

      // For each source: check the B2 cache first. A hit means we already
      // scraped this exact title/episode before, so skip hitting the source
      // site entirely — faster for the user and lighter on the source sites.
      // A miss means search + fetch as before, then cache the result so the
      // *next* request for this title/episode is a cache hit.
      await Promise.all(
        Object.keys(SOURCE_MODULES).map(async (name) => {
          // B2 is a speed optimization, never a hard dependency — if it's
          // misconfigured or B2 itself is briefly down, that must degrade to
          // "treat as cache miss," not take down the live scrape underneath it.
          let cached = null;
          try {
            cached = await subtitleCache.getCached(name, imdbId, type, season, episode);
          } catch (err) {
            console.error(`${name} cache read failed (falling back to live scrape):`, err.message);
          }

          if (cached) {
            const key = fileCache.put(cached);
            subtitles.push({
              id: `${name}-${id}`,
              url: `${PUBLIC_URL}/sub/${key}${cached.ext}`,
              lang: SOURCE_LABELS[name] || 'mal',
            });
            return;
          }

          try {
            const result = await SEARCHERS[name]();
            if (!result) return;

            // Some sources zip subtitles per-season, with one file per episode
            // inside — episode tells fetchSubtitleFile which one to pull out.
            const file = await SOURCE_MODULES[name].fetchSubtitleFile(result.url, episode);

            subtitleCache.setCached(name, imdbId, type, season, episode, file).catch((err) => {
              console.error(`${name} cache write failed (serving live result anyway):`, err.message);
            });

            const key = fileCache.put(file);
            subtitles.push({
              id: `${name}-${id}`,
              url: `${PUBLIC_URL}/sub/${key}${file.ext}`,
              lang: SOURCE_LABELS[name] || 'mal',
            });
          } catch (err) {
            console.error(`${name} lookup failed:`, err.message);
          }
        })
      );

      // Manually-uploaded fallback pool (B2-backed), checked by exact IMDb id
      // match. Disabled by default: an uploaded file skips the same-site
      // validation that scraped downloads now go through (lib/fetchFile.js),
      // so a bad upload would go straight into the main addon's results with
      // nothing catching it. Set ENABLE_POOL_SUBS=true to turn it back on
      // once uploads get their own validation/review step.
      if (process.env.ENABLE_POOL_SUBS === 'true') {
        try {
          const poolMatches = await pool.findMatches(imdbId, type, season, episode);
          for (const match of poolMatches) {
            const buffer = await pool.getFileBuffer(match);
            const contentType = CONTENT_TYPES[match.ext] || 'application/x-subrip; charset=utf-8';
            const key = fileCache.put({ buffer, ext: match.ext, contentType });
            const servedUrl = `${PUBLIC_URL}/sub/${key}${match.ext}`;
            subtitles.push({
              id: `pool-${match.id}-${id}`,
              url: servedUrl,
              lang: SOURCE_LABELS.pool,
            });
          }
        } catch (err) {
          console.error('pool lookup failed:', err.message);
        }
      }

      // No cacheMaxAge: tell Stremio/Nuvio not to hold onto this response, so a
      // fresh lookup always happens per video. Our own internal search/file
      // caches still keep things fast; this only affects client-side caching.
      return { subtitles };
    } catch (err) {
      console.error('subtitles handler error:', err.message);
      return { subtitles: [] };
    }
  });
}

module.exports = { buildAddon };
