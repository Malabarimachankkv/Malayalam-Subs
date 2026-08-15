const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const { scoreCandidate } = require('./matching');
const { fetchSubtitleFile: fetchFile } = require('./fetchFile');

const BASE_URL = 'https://moviemirrorsubtitles.com';

// Movie Mirror has no working search endpoint, and robots.txt disallows its
// /subtitles/ filter page, but /category/movies|series/ listings are allowed.
// We build a full title->page index by crawling those listings in the
// background and cache it for a while, rather than crawling on every request.
const indexCache = new NodeCache({ stdTTL: 12 * 60 * 60 }); // 12h
const imdbCache = new NodeCache({ stdTTL: 24 * 60 * 60 });
// A brand-new post always shows up on page 1 of its category, well before
// the full 12h index is due to refresh. Checking just page 1 (2 lightweight
// requests) is cheap enough to do on every miss, so a title posted minutes
// ago doesn't have to wait out the whole crawl cycle to become findable.
const recentCache = new NodeCache({ stdTTL: 15 * 60 }); // 15m
let buildPromise = null;

const client = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
  validateStatus: (s) => s < 500,
});

// Paths on the site that are navigation/taxonomy pages, not releases.
const NON_RELEASE_PATH = /^(about-us|subtitles|advanced-filter|fest|subtitle-submission|freshers-submission|subtitle-status|enquiry|poster-designer|director|translator|language|category|wp-content|wp-json|cdn-cgi|page)(\/|$)/i;

function isReleaseLink(href) {
  if (!href || !href.startsWith(BASE_URL)) return false;
  const path = href.slice(BASE_URL.length).replace(/^\//, '').replace(/\/$/, '');
  if (!path || path.includes('/')) return false; // release permalinks are a single path segment
  return !NON_RELEASE_PATH.test(path + '/');
}

function extractReleaseLinks($) {
  const releases = [];
  const seen = new Set();

  $('a').each((_, el) => {
    const href = $(el).attr('href');
    const title = $(el).text().trim();
    if (!href || !title || seen.has(href)) return;
    if (isReleaseLink(href)) {
      seen.add(href);
      releases.push({ title, pageUrl: href });
    }
  });

  return releases;
}

async function fetchListingPage(section, page) {
  const url = page === 1 ? `${BASE_URL}/category/${section}/` : `${BASE_URL}/category/${section}/page/${page}/`;
  const res = await client.get(url);
  const $ = cheerio.load(res.data);
  const releases = extractReleaseLinks($);

  // Highest pagination number linked from page 1 tells us how many pages exist.
  let maxPage = page;
  $('a[href*="/page/"]').each((_, el) => {
    const m = $(el).attr('href').match(/\/page\/(\d+)\//);
    if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
  });

  return { releases, maxPage };
}

async function crawlSection(section) {
  const first = await fetchListingPage(section, 1);
  const all = [...first.releases];
  const pageNumbers = [];
  for (let p = 2; p <= first.maxPage; p++) pageNumbers.push(p);

  // Modest concurrency so we don't hammer the site while indexing ~100+ pages.
  const CONCURRENCY = 5;
  for (let i = 0; i < pageNumbers.length; i += CONCURRENCY) {
    const batch = pageNumbers.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((p) => fetchListingPage(section, p)));
    for (const r of results) {
      if (r.status === 'fulfilled') all.push(...r.value.releases);
    }
  }
  return all;
}

async function buildIndex() {
  const [movies, series] = await Promise.all([crawlSection('movies'), crawlSection('series')]);
  const index = [...movies, ...series];
  indexCache.set('index', index);
  return index;
}

/**
 * Fetch (and briefly cache) the homepage — independently of the big 12h
 * index — as a fast freshness check. Used to rely on page 1 of
 * /category/{section}/, but the site's current theme doesn't link those
 * anywhere (no nav item, no footer link) and Google has nothing indexed
 * under /category/ for this domain either, so that's no longer a safe
 * signal for "what's newest." The homepage's own NEW RELEASES / TRENDING
 * widgets are guaranteed current since surfacing new posts is their whole
 * purpose, and as a bonus this also picks up anything MUST WATCH /
 * RANDOM SELECTIONS happens to be showing.
 */
async function getRecentReleases() {
  const cached = recentCache.get('recent');
  if (cached) return cached;

  try {
    const res = await client.get(BASE_URL);
    const $ = cheerio.load(res.data);
    const recent = extractReleaseLinks($);
    recentCache.set('recent', recent);
    return recent;
  } catch (err) {
    console.error('moviemirror recent-listing fetch failed:', err.message);
    return [];
  }
}

/**
 * Returns the cached index if ready. If not built yet, kicks off a background
 * build (shared across concurrent callers) and returns null immediately so
 * callers don't block a live subtitle request on a multi-page crawl.
 */
function getIndexNonBlocking() {
  const cached = indexCache.get('index');
  if (cached) return cached;

  if (!buildPromise) {
    buildPromise = buildIndex()
      .catch((err) => {
        console.error('moviemirror index build failed:', err.message);
        return null;
      })
      .finally(() => {
        buildPromise = null;
      });
  }
  return null;
}

/**
 * Visit a release page and extract both its IMDb id (for verification) and
 * its direct subtitle download URL, which sits inside a `custom_download`
 * query parameter rather than needing a redirect to be followed.
 */
async function extractReleaseDetails(pageUrl) {
  const cached = imdbCache.get(pageUrl);
  if (cached) return cached;

  const res = await client.get(pageUrl);
  const imdbMatch = res.data.match(/imdb\.com\/title\/(tt\d+)/i);
  const downloadMatch = res.data.match(/custom_download=([^&"']+)/i);

  const details = {
    imdbId: imdbMatch ? imdbMatch[1] : null,
    downloadUrl: downloadMatch ? decodeURIComponent(downloadMatch[1]) : null,
  };
  imdbCache.set(pageUrl, details);
  return details;
}

async function findSubtitleUrl(query, year, imdbId) {
  const index = getIndexNonBlocking() || [];
  const recent = await getRecentReleases();

  const seen = new Set();
  const combined = [...index, ...recent].filter((r) => {
    if (seen.has(r.pageUrl)) return false;
    seen.add(r.pageUrl);
    return true;
  });
  if (!combined.length) return null; // main index still building and recent-page fetch also failed

  const scored = combined
    .map((r) => ({ ...r, score: scoreCandidate(query, year, r.title) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  // Prefer an IMDb-confirmed candidate when we can get one.
  if (imdbId) {
    for (const candidate of scored.slice(0, 5)) {
      const details = await extractReleaseDetails(candidate.pageUrl);
      if (details.downloadUrl && details.imdbId === imdbId) {
        return { url: details.downloadUrl, pageUrl: candidate.pageUrl, matchedTitle: candidate.title };
      }
    }
  }

  // No IMDb-confirmed match. The title scorer already requires every
  // significant query word to match (with small typo tolerance), so a
  // top-scored candidate is still reliable even without independent
  // IMDb confirmation.
  const top = scored[0];
  const details = await extractReleaseDetails(top.pageUrl);
  if (!details.downloadUrl) return null;
  return { url: details.downloadUrl, pageUrl: top.pageUrl, matchedTitle: top.title };
}

// Reuses the shared download/unzip logic (lib/fetchFile.js), binding it to
// Movie Mirror's own origin as the Referer. This was the missing piece:
// addon.js used to reuse one source's fetchSubtitleFile() for every result,
// which sent the wrong site's Referer on requests to
// moviemirrorsubtitles.com's own /wp-content/uploads/ files — a
// foreign-site Referer is exactly what hotlink/anti-scrape protection tends
// to block, causing the download to fail and Movie Mirror to silently drop
// out of the results entirely.
function fetchSubtitleFile(downloadUrl, episode) {
  return fetchFile(downloadUrl, episode, BASE_URL);
}

module.exports = { findSubtitleUrl, fetchSubtitleFile, getIndexNonBlocking, BASE_URL };
