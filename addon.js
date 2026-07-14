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
    const { imdbId, season } = parseId(id);
    const meta = await getMeta(type, imdbId);
    if (!meta || !meta.title) return { subtitles: [] };

    // Both sites group series subtitles by season, so include the season number.
    const query = type === 'series' && season ? `${meta.title} Season ${season}` : meta.title;

    // Query all sources in parallel; one failing/missing shouldn't block the others.
    const [msoneResult, goatResult, mirrorResult] = await Promise.allSettled([
      msone.findSubtitleUrl(query, meta.year),
      goat.findSubtitleUrl(query, meta.year, imdbId),
      moviemirror.findSubtitleUrl(query, meta.year, imdbId),
    ]);

    const sources = [
      { name: 'msone', result: msoneResult.status === 'fulfilled' ? msoneResult.value : null },
      { name: 'goat', result: goatResult.status === 'fulfilled' ? goatResult.value : null },
      { name: 'moviemirror', result: mirrorResult.status === 'fulfilled' ? mirrorResult.value : null },
    ];

    const subtitles = [];
    for (const { name, result } of sources) {
      if (!result) continue;
      try {
        // Some sources zip their subtitles, some don't; this handles either
        // and always hands back a plain .srt/.vtt file.
        const file = await msone.fetchSubtitleFile(result.url);
        const key = fileCache.put(file);
        const servedUrl = `${PUBLIC_URL}/sub/${key}${file.ext}`;
        subtitles.push({
          id: `${name}-${id}`,
          url: servedUrl,
          lang: 'mal', // Malayalam (ISO 639-2)
        });
      } catch (err) {
        console.error(`${name} fetchSubtitleFile failed:`, err.message);
      }
    }

    return { subtitles, cacheMaxAge: 6 * 60 * 60 };
  } catch (err) {
    console.error('subtitles handler error:', err.message);
    return { subtitles: [] };
  }
});

module.exports = builder.getInterface();
