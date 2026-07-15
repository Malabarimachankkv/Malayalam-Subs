const { addonBuilder } = require('stremio-addon-sdk');
const { getMeta } = require('./lib/cinemeta');
const msone = require('./lib/msone');
const goat = require('./lib/goat');
const moviemirror = require('./lib/moviemirror');
const fileCache = require('./lib/fileCache');

// Render sets RENDER_EXTERNAL_URL automatically. On other hosts, set a PUBLIC_URL
// env var to your public https:// URL (see README).
const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://127.0.0.1:${process.env.PORT || 7000}`
).replace(/\/$/, '');

// Stremio shows this text verbatim in the subtitle picker whenever it isn't a
// valid ISO 639-2 code (which "mal" is, but these deliberately aren't) — so
// each source shows up clearly labeled instead of three unlabeled "Malayalam" entries.
const SOURCE_LABELS = {
  msone: 'Malayalam (MSone)',
  goat: 'Malayalam (Team GOAT)',
  moviemirror: 'Malayalam (Movie Mirror)',
};

const manifest = {
  id: 'org.msone.malayalam.subtitles',
  version: '3.0.0',
  name: 'Malayalam Subtitles (MSone + GOAT + Movie Mirror)',
  description:
    'Free Malayalam subtitles for movies and series, pulled from malayalamsubtitles.org (MSone), malayalamsubtitles.in (Team GOAT), and moviemirrorsubtitles.com (Movie Mirror).',
  logo: 'https://malayalamsubtitles.org/wp-content/uploads/2025/03/msone-main-navbar-logo.webp',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
  behaviorHints: { configurable: false },
};

const builder = new addonBuilder(manifest);

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

    async function searchSource(fn) {
      const primary = await fn(primaryQuery);
      if (primary) return primary;
      if (!fallbackQuery) return null;

      const fallback = await fn(fallbackQuery);
      if (fallback && season) {
        const foundSeason = extractSeasonNumber(fallback.matchedTitle);
        if (foundSeason !== null && foundSeason !== season) {
          return null; // confirmed different season — don't serve it
        }
      }
      return fallback;
    }

    // Query all sources in parallel; one failing/missing shouldn't block the others.
    const [msoneResult, goatResult, mirrorResult] = await Promise.allSettled([
      searchSource((q) => msone.findSubtitleUrl(q, meta.year)),
      searchSource((q) => goat.findSubtitleUrl(q, meta.year, imdbId)),
      searchSource((q) => moviemirror.findSubtitleUrl(q, meta.year, imdbId)),
    ]);

    const sources = [
      { name: 'msone', result: msoneResult.status === 'fulfilled' ? msoneResult.value : null },
      { name: 'goat', result: goatResult.status === 'fulfilled' ? goatResult.value : null },
      { name: 'moviemirror', result: mirrorResult.status === 'fulfilled' ? mirrorResult.value : null },
    ];

    // Each source's fetchSubtitleFile sends that source's own site as the
    // Referer header, which matters for sources like Movie Mirror that serve
    // files straight from /wp-content/uploads/ and can reject a foreign
    // Referer — calling the wrong module's fetchSubtitleFile silently broke
    // downloads for whichever source wasn't msone.
    const FETCHERS = { msone, goat, moviemirror };

    const subtitles = [];
    for (const { name, result } of sources) {
      if (!result) continue;
      try {
        // Some sources zip subtitles per-season, with one file per episode
        // inside — episode tells fetchSubtitleFile which one to pull out.
        const file = await FETCHERS[name].fetchSubtitleFile(result.url, episode);
        const key = fileCache.put(file);
        const servedUrl = `${PUBLIC_URL}/sub/${key}${file.ext}`;
        subtitles.push({
          id: `${name}-${id}`,
          url: servedUrl,
          lang: SOURCE_LABELS[name] || 'mal',
        });
      } catch (err) {
        console.error(`${name} fetchSubtitleFile failed:`, err.message);
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

module.exports = builder.getInterface();
