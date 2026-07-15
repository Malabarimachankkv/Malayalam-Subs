const axios = require('axios');
const AdmZip = require('adm-zip');

const client = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
  validateStatus: (s) => s < 500,
});

const SUB_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa'];
const CONTENT_TYPES = {
  '.srt': 'application/x-subrip; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.ssa': 'text/plain; charset=utf-8',
};

function extractEpisodeNumber(filename) {
  const patterns = [
    /s\d{1,2}e(\d{1,3})/i, // S01E05
    /\b\d{1,2}x(\d{1,3})\b/i, // 1x05
    /\bep(?:isode)?[\s._-]*0*(\d{1,3})\b/i, // Episode 5 / Ep05 / Ep 5
    /\be0*(\d{1,3})\b/i, // E05 on its own
  ];
  for (const re of patterns) {
    const m = filename.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Download whatever a source's download link points to. If it's a subtitle
 * file directly, return it as-is. If it's a zip, extract the right subtitle
 * from inside it — for a movie or single-episode release that's just "the
 * subtitle file in there," but season-bundle zips contain one .srt PER
 * EPISODE, so when an episode number is known we have to pick the entry that
 * actually matches it. Throws if nothing usable is found.
 *
 * `refererBaseUrl` MUST be the origin of the site that `downloadUrl` actually
 * belongs to (e.g. MSone links need MSone's own origin as Referer, Movie
 * Mirror links need Movie Mirror's). Sending a foreign-site Referer here is
 * exactly the kind of thing hotlink/anti-scrape protection blocks, so each
 * source must pass its own BASE_URL rather than sharing one hardcoded value.
 */
async function fetchSubtitleFile(downloadUrl, episode, refererBaseUrl) {
  const res = await client.get(downloadUrl, {
    responseType: 'arraybuffer',
    headers: refererBaseUrl ? { Referer: refererBaseUrl } : {},
    maxRedirects: 5,
  });

  const buffer = Buffer.from(res.data);
  const contentType = (res.headers['content-type'] || '').toLowerCase();
  const finalUrl = (res.request && res.request.res && res.request.res.responseUrl) || downloadUrl;
  const looksLikeZip =
    contentType.includes('zip') || /\.zip($|\?)/i.test(finalUrl) || (buffer[0] === 0x50 && buffer[1] === 0x4b);

  if (!looksLikeZip) {
    const extMatch = SUB_EXTENSIONS.find((ext) => finalUrl.toLowerCase().includes(ext));
    const ext = extMatch || '.srt'; // almost always .srt when not zipped
    return { buffer, ext, contentType: CONTENT_TYPES[ext] };
  }

  const zip = new AdmZip(buffer);
  const subEntries = zip
    .getEntries()
    .filter((e) => !e.isDirectory && SUB_EXTENSIONS.some((ext) => e.entryName.toLowerCase().endsWith(ext)));

  if (!subEntries.length) {
    throw new Error('No subtitle file found inside zip');
  }

  let match;
  if (subEntries.length === 1) {
    // Movie or single-episode release: only one subtitle in the zip anyway.
    match = subEntries[0];
  } else if (episode) {
    // Season bundle: find the entry whose filename matches the requested episode.
    match = subEntries.find((e) => extractEpisodeNumber(e.entryName) === episode);
    if (!match) {
      throw new Error(`Zip has ${subEntries.length} episode subtitles but none matched episode ${episode}`);
    }
  } else {
    // Multiple subtitles but no specific episode requested (e.g. a movie
    // query that happened to hit a multi-file zip) — refuse to guess.
    throw new Error(`Zip has ${subEntries.length} subtitle files and no episode number to pick the right one`);
  }

  const ext = SUB_EXTENSIONS.find((e) => match.entryName.toLowerCase().endsWith(e)) || '.srt';
  return { buffer: match.getData(), ext, contentType: CONTENT_TYPES[ext] };
}

module.exports = { fetchSubtitleFile, extractEpisodeNumber, SUB_EXTENSIONS, CONTENT_TYPES };
