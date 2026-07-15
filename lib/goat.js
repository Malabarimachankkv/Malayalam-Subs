const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const { scoreCandidate } = require('./matching');
const { fetchSubtitleFile: fetchFile } = require('./fetchFile');

const BASE_URL = 'https://malayalamsubtitles.in';

// The /search-and-download page lists every release (title, slug, download link)
// in one page, so we cache that whole listing rather than re-fetching per search.
const listingCache = new NodeCache({ stdTTL: 60 * 60 }); // 1h
const imdbCache = new NodeCache({ stdTTL: 24 * 60 * 60 }); // 24h

const client = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
  validateStatus: (s) => s < 500,
});

/**
 * Fetch (and cache) the full list of Team GOAT releases: title, release page
 * URL, and direct download link, all available from one listing page.
 */
async function getFullListing() {
  const cached = listingCache.get('all');
  if (cached) return cached;

  const res = await client.get(`${BASE_URL}/search-and-download`);
  const $ = cheerio.load(res.data);
  const releases = [];

  // Each release block has a heading link to /release/<slug> and a nearby
  // download link pointing at wp.malayalamsubtitles.in/download/<id>.
  $('a[href*="/release/"]').each((_, el) => {
    const href = $(el).attr('href');
    const title = $(el).text().trim();
    if (!href || !title) return;

    // The download link is the next matching anchor within the same block.
    const block = $(el).closest('div, li, article');
    const downloadHref = block.find('a[href*="wp.malayalamsubtitles.in/download/"]').first().attr('href');

    if (downloadHref) {
      releases.push({ title, pageUrl: href.startsWith('http') ? href : `${BASE_URL}${href}`, downloadUrl: downloadHref });
    }
  });

  listingCache.set('all', releases);
  return releases;
}

/**
 * Confirm a candidate release actually matches the requested IMDb id by
 * checking the IMDb link shown on its release page. Team GOAT's listing can
 * contain near-duplicate titles (different years/cuts), so this avoids
 * serving the wrong film's subtitles.
 */
async function verifyImdbMatch(pageUrl, imdbId) {
  const cached = imdbCache.get(pageUrl);
  if (cached !== undefined) return cached === imdbId;

  try {
    const res = await client.get(pageUrl);
    const match = res.data.match(/imdb\.com\/title\/(tt\d+)/i);
    const foundId = match ? match[1] : null;
    imdbCache.set(pageUrl, foundId);
    return foundId === imdbId;
  } catch {
    return false;
  }
}

/**
 * Find a Team GOAT subtitle download URL for a title/year, verified against
 * the requested IMDb id where possible.
 */
async function findSubtitleUrl(query, year, imdbId) {
  const listing = await getFullListing();

  const scored = listing
    .map((r) => ({ ...r, score: scoreCandidate(query, year, r.title) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  // Prefer an IMDb-confirmed candidate when we can get one (handles the case
  // of near-duplicate titles in the catalog — different years/cuts/remakes).
  if (imdbId) {
    for (const candidate of scored.slice(0, 5)) {
      const ok = await verifyImdbMatch(candidate.pageUrl, imdbId);
      if (ok) return { url: candidate.downloadUrl, pageUrl: candidate.pageUrl, matchedTitle: candidate.title };
    }
  }

  // No IMDb-confirmed match (either no imdbId to check, or the release page's
  // IMDb link couldn't be read for whatever reason). The title scorer itself
  // already requires every significant word of the query to match — including
  // typo tolerance for small catalog misspellings — so a top-scored candidate
  // here is still a reliable match, just not independently double-confirmed.
  const top = scored[0];
  return { url: top.downloadUrl, pageUrl: top.pageUrl, matchedTitle: top.title };
}

// Reuses the shared download/unzip logic (lib/fetchFile.js), binding it to
// Team GOAT's own origin as the Referer — not whichever source happened to
// be called last, as addon.js previously (incorrectly) always used msone's.
function fetchSubtitleFile(downloadUrl, episode) {
  return fetchFile(downloadUrl, episode, BASE_URL);
}

module.exports = { getFullListing, findSubtitleUrl, fetchSubtitleFile, BASE_URL };
