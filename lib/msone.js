const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const AdmZip = require('adm-zip');

const BASE_URL = 'https://malayalamsubtitles.org';

// Cache search results (6h) and resolved subtitle links (6h) to avoid hammering the site.
const searchCache = new NodeCache({ stdTTL: 6 * 60 * 60 });
const linkCache = new NodeCache({ stdTTL: 6 * 60 * 60 });

const client = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ml;q=0.8',
  },
  validateStatus: (s) => s < 500,
});

function looksLikeChallengePage(html) {
  return (
    typeof html === 'string' &&
    (html.includes('Just a moment') ||
      html.includes('cf-browser-verification') ||
      html.includes('Attention Required! | Cloudflare'))
  );
}

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Very small fuzzy scorer: fraction of query words found in candidate title, plus a year bonus.
function scoreCandidate(query, year, candidateTitle) {
  const qWords = normalize(query).split(' ').filter(Boolean);
  const cNorm = normalize(candidateTitle);
  if (!qWords.length || !cNorm) return 0;
  let hits = 0;
  for (const w of qWords) {
    if (cNorm.includes(w)) hits += 1;
  }
  let score = hits / qWords.length;
  if (year && candidateTitle.includes(String(year))) score += 0.5;
  return score;
}

/**
 * Search MSone for a title and return candidate release page links.
 */
async function searchReleases(query, year) {
  const cacheKey = `search:${normalize(query)}:${year || ''}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
  const res = await client.get(url);

  if (looksLikeChallengePage(res.data)) {
    throw new Error('MSONE_BLOCKED: site returned a bot-verification page for search');
  }

  const $ = cheerio.load(res.data);
  const candidates = [];
  const seen = new Set();

  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    // Release/article pages live under /languages/<lang>/<slug>/
    if (/\/languages\/[a-z-]+\/[a-z0-9-]+\/?$/i.test(href) && text.length > 1) {
      if (seen.has(href)) return;
      seen.add(href);
      candidates.push({ href, text });
    }
  });

  const scored = candidates
    .map((c) => ({ ...c, score: scoreCandidate(query, year, c.text) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  searchCache.set(cacheKey, scored);
  return scored;
}

/**
 * Given a release page URL, extract the direct subtitle (.srt/.zip) download link.
 * MSone uses the WordPress Download Manager plugin, whose links always contain "wpdmdl=".
 */
async function extractDownloadLink(pageUrl) {
  const cached = linkCache.get(pageUrl);
  if (cached) return cached;

  const res = await client.get(pageUrl, { headers: { Referer: BASE_URL } });

  if (looksLikeChallengePage(res.data)) {
    throw new Error('MSONE_BLOCKED: site returned a bot-verification page for release page');
  }

  const $ = cheerio.load(res.data);
  let link = null;

  $('a[href*="wpdmdl="]').each((_, el) => {
    if (link) return;
    const href = $(el).attr('href');
    if (href) link = href.startsWith('http') ? href : `${BASE_URL}${href}`;
  });

  if (!link) return null;

  linkCache.set(pageUrl, link);
  return link;
}

/**
 * High level helper: given a title/year, find the best matching release and
 * return its direct subtitle download URL (or null if nothing usable was found).
 */
async function findSubtitleUrl(title, year) {
  const results = await searchReleases(title, year);
  for (const candidate of results.slice(0, 3)) {
    try {
      const link = await extractDownloadLink(candidate.href);
      if (link) {
        return { url: link, pageUrl: candidate.href, matchedTitle: candidate.text };
      }
    } catch (err) {
      // try next candidate
      console.error('extractDownloadLink failed for', candidate.href, err.message);
    }
  }
  return null;
}

const SUB_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa'];
const CONTENT_TYPES = {
  '.srt': 'application/x-subrip; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.ssa': 'text/plain; charset=utf-8',
};

/**
 * Download whatever MSone's download link points to. If it's a subtitle file
 * directly, return it as-is. If it's a zip (MSone very often packages subs as
 * .zip), extract the first actual subtitle file found inside and return that.
 * Throws if nothing usable is found.
 */
async function fetchSubtitleFile(downloadUrl) {
  const res = await client.get(downloadUrl, {
    responseType: 'arraybuffer',
    headers: { Referer: BASE_URL },
    maxRedirects: 5,
  });

  const buffer = Buffer.from(res.data);
  const contentType = (res.headers['content-type'] || '').toLowerCase();
  const finalUrl = (res.request && res.request.res && res.request.res.responseUrl) || downloadUrl;
  const looksLikeZip =
    contentType.includes('zip') || /\.zip($|\?)/i.test(finalUrl) || (buffer[0] === 0x50 && buffer[1] === 0x4b);

  if (!looksLikeZip) {
    const extMatch = SUB_EXTENSIONS.find((ext) => finalUrl.toLowerCase().includes(ext));
    const ext = extMatch || '.srt'; // MSone almost always serves .srt when not zipped
    return { buffer, ext, contentType: CONTENT_TYPES[ext] };
  }

  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);

  // Prefer .srt, then fall back to any other recognised subtitle format.
  let match =
    entries.find((e) => e.entryName.toLowerCase().endsWith('.srt')) ||
    entries.find((e) => SUB_EXTENSIONS.some((ext) => e.entryName.toLowerCase().endsWith(ext)));

  if (!match) {
    throw new Error('No subtitle file found inside MSone zip');
  }

  const ext = SUB_EXTENSIONS.find((e) => match.entryName.toLowerCase().endsWith(e)) || '.srt';
  return { buffer: match.getData(), ext, contentType: CONTENT_TYPES[ext] };
}

module.exports = { searchReleases, extractDownloadLink, findSubtitleUrl, fetchSubtitleFile, BASE_URL };
