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

// A real .srt/.vtt has a timestamp line ("00:00:01,000 --> 00:00:04,000"
// or "00:00:01.000 --> 00:00:04.000"); .ass/.ssa has "Dialogue:" lines. If
// none of these show up anywhere in the first chunk of the file, what we
// downloaded almost certainly isn't a subtitle — most likely an HTML error
// page, a WAF/anti-bot challenge, or a "file not found" page that the
// source site returned with a 200 status. Source sites do this often
// enough that trusting the status code alone isn't safe.
const SUBTITLE_CONTENT_PATTERN = /\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s*--\>\s*\d{1,2}:\d{2}:\d{2}[.,]\d{3}|^Dialogue:/im;

function looksLikeSubtitleText(buffer) {
  return SUBTITLE_CONTENT_PATTERN.test(buffer.toString('utf8', 0, Math.min(buffer.length, 20000)));
}

function extractEpisodeNumber(filename) {
  const patterns = [
    /s\d{1,2}e(\d{1,3})/i, // S01E05
    // S1EP1 / S01EP07 / S1 EP1 / S01.EP.07 — the "EP" sits directly against
    // the season digits with no separator, so it has no word boundary in
    // front for the "Episode 5 / Ep05" pattern below to find; needs its own
    // pattern that anchors on the season prefix instead of a boundary.
    /s\d{1,2}[\s._-]*ep[\s._-]*0*(\d{1,3})/i,
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
  // validateStatus here (distinct from the shared client's s<500 default)
  // rejects anything that isn't a plain success — a 4xx means the file is
  // gone/moved, and letting that through as "the subtitle" is exactly how
  // a bad response gets permanently cached and served to every future user.
  const res = await client.get(downloadUrl, {
    responseType: 'arraybuffer',
    headers: refererBaseUrl ? { Referer: refererBaseUrl } : {},
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 300,
  });

  const buffer = Buffer.from(res.data);
  const contentType = (res.headers['content-type'] || '').toLowerCase();
  const finalUrl = (res.request && res.request.res && res.request.res.responseUrl) || downloadUrl;
  const looksLikeZip =
    contentType.includes('zip') || /\.zip($|\?)/i.test(finalUrl) || (buffer[0] === 0x50 && buffer[1] === 0x4b);

  // A source site returning an HTML page (redesign, "file not found",
  // anti-bot challenge, a login wall) with a 200 status looks identical to
  // a real download at the status/extension level. Content-Type is the one
  // signal that reliably gives this away even before we've looked at the
  // bytes, so check it before falling through to the subtitle-content check.
  if (contentType.includes('html')) {
    throw new Error(`Download returned an HTML page instead of a subtitle file (${downloadUrl})`);
  }

  if (!looksLikeZip) {
    const extMatch = SUB_EXTENSIONS.find((ext) => finalUrl.toLowerCase().includes(ext));
    const ext = extMatch || '.srt'; // almost always .srt when not zipped
    if (!looksLikeSubtitleText(buffer)) {
      throw new Error(`Downloaded file doesn't look like a real subtitle (no timestamp/dialogue lines found): ${downloadUrl}`);
    }
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
  const extractedBuffer = match.getData();
  if (!looksLikeSubtitleText(extractedBuffer)) {
    throw new Error(`Zip entry "${match.entryName}" doesn't look like a real subtitle (no timestamp/dialogue lines found)`);
  }
  return { buffer: extractedBuffer, ext, contentType: CONTENT_TYPES[ext] };
}

module.exports = { fetchSubtitleFile, extractEpisodeNumber, SUB_EXTENSIONS, CONTENT_TYPES };
