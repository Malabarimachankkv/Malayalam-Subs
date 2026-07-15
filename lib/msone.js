const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const { scoreCandidate } = require('./matching');
const { fetchSubtitleFile: fetchFile } = require('./fetchFile');

const BASE_URL = 'https://malayalamsubtitles.org';

// MSone's own WordPress search box (?s=) turned out to be unreliable — basic
// keyword matching that misses a lot of valid titles. Instead we crawl the
// site's full /releases/ listing (paginated, ~300 pages) once in the
// background and cache that index, the same reliable pattern used for Team
// GOAT and Movie Mirror, rather than depending on WordPress search at all.
const indexCache = new NodeCache({ stdTTL: 12 * 60 * 60 }); // 12h
const linkCache = new NodeCache({ stdTTL: 6 * 60 * 60 });
let buildPromise = null;

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

async function fetchListingPage(page) {
  const url = page === 1 ? `${BASE_URL}/releases/` : `${BASE_URL}/releases/page/${page}/`;
  const res = await client.get(url);
  if (looksLikeChallengePage(res.data)) {
    throw new Error('MSONE_BLOCKED: site returned a bot-verification page for releases listing');
  }

  const $ = cheerio.load(res.data);
  const releases = [];
  const seen = new Set();

  // Release links live under /languages/<lang>/<slug>/, titles are bilingual
  // e.g. "House of the Dragon Season 3 / ഹൗസ് ഓഫ് ദ ഡ്രാഗൺ സീസൺ 3 (2026)".
  $('a[href*="/languages/"]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (!href || !text || seen.has(href)) return;
    if (/\/languages\/[a-z-]+\/[a-z0-9-]+\/?$/i.test(href)) {
      seen.add(href);
      releases.push({ title: text, pageUrl: href.startsWith('http') ? href : `${BASE_URL}${href}` });
    }
  });

  // Highest pagination number linked from this page tells us how many pages exist.
  let maxPage = page;
  $('a[href*="/releases/page/"]').each((_, el) => {
    const m = $(el).attr('href').match(/\/releases\/page\/(\d+)\//);
    if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
  });

  return { releases, maxPage };
}

async function buildIndex() {
  const first = await fetchListingPage(1);
  const all = [...first.releases];
  const pageNumbers = [];
  for (let p = 2; p <= first.maxPage; p++) pageNumbers.push(p);

  // Modest concurrency so we don't hammer the site while indexing ~300 pages.
  const CONCURRENCY = 5;
  for (let i = 0; i < pageNumbers.length; i += CONCURRENCY) {
    const batch = pageNumbers.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((p) => fetchListingPage(p)));
    for (const r of results) {
      if (r.status === 'fulfilled') all.push(...r.value.releases);
    }
  }

  indexCache.set('index', all);
  return all;
}

/**
 * Returns the cached index if ready. If not built yet, kicks off a background
 * build (shared across concurrent callers) and returns null immediately so
 * callers don't block a live subtitle request on a ~300-page crawl.
 */
function getIndexNonBlocking() {
  const cached = indexCache.get('index');
  if (cached) return cached;

  if (!buildPromise) {
    buildPromise = buildIndex()
      .catch((err) => {
        console.error('msone index build failed:', err.message);
        return null;
      })
      .finally(() => {
        buildPromise = null;
      });
  }
  return null;
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
  const index = getIndexNonBlocking();
  if (!index) return null; // still indexing in the background; try again next time

  const scored = index
    .map((r) => ({ ...r, score: scoreCandidate(title, year, r.title) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const candidate of scored.slice(0, 3)) {
    try {
      const link = await extractDownloadLink(candidate.pageUrl);
      if (link) {
        return { url: link, pageUrl: candidate.pageUrl, matchedTitle: candidate.title };
      }
    } catch (err) {
      // try next candidate
      console.error('extractDownloadLink failed for', candidate.pageUrl, err.message);
    }
  }
  return null;
}

// Download + zip-extraction logic is shared across all three sources (see
// lib/fetchFile.js) — each source just needs to bind its own BASE_URL as the
// Referer, since a foreign-site Referer is exactly what hotlink/anti-scrape
// protection tends to block.
function fetchSubtitleFile(downloadUrl, episode) {
  return fetchFile(downloadUrl, episode, BASE_URL);
}

module.exports = { findSubtitleUrl, extractDownloadLink, fetchSubtitleFile, getIndexNonBlocking, BASE_URL };
