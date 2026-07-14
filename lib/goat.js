const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

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

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

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

  for (const candidate of scored.slice(0, 5)) {
    if (imdbId) {
      const ok = await verifyImdbMatch(candidate.pageUrl, imdbId);
      if (!ok) continue;
    }
    return { url: candidate.downloadUrl, pageUrl: candidate.pageUrl, matchedTitle: candidate.title };
  }

  // Fall back to best fuzzy match if no IMDb-verified candidate was found.
  if (scored.length) {
    const top = scored[0];
    return { url: top.downloadUrl, pageUrl: top.pageUrl, matchedTitle: top.title };
  }

  return null;
}

module.exports = { getFullListing, findSubtitleUrl, BASE_URL };
