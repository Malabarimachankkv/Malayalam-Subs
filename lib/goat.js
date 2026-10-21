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
async function getFullListing(forceFresh = false) {
  if (!forceFresh) {
    const cached = listingCache.get('all');
    if (cached) return cached;
  }

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
      // The same card also carries "Genre: Action, Crime" and the source
      // language — used by the catalog rows (lib/catalogs.js) for genre
      // filtering. Subtitle lookups ignore these fields.
      const genreText = block.find('.genre').first().text().trim();
      const genres = genreText ? genreText.split(',').map((g) => g.trim()).filter(Boolean) : [];
      const language = block.find('.lang').first().text().trim() || null;
      const releaseNo = parseInt(block.find('.releaseno').first().text().trim(), 10);
      releases.push({
        title,
        pageUrl: href.startsWith('http') ? href : `${BASE_URL}${href}`,
        downloadUrl: downloadHref,
        genres,
        language,
        releaseNo: Number.isFinite(releaseNo) ? releaseNo : null,
      });
    }
  });

  listingCache.set('all', releases);
  return releases;
}

// ---------------------------------------------------------------------------
// Catalog support (Stremio "Discover"/board rows). Everything below is only
// used by lib/catalogs.js; the subtitle lookup path above is unchanged.
//
// Site layout, as observed Oct 2026:
//   /movies, /movies/1/, /movies/2/ ...   12 poster cards per page, newest first
//   /series, /series/1/ ...               same, for series
//   /festivals                            list of /fest/<slug> collections
//   /fest/<slug>                          poster cards for one festival
//   /search-and-download                  every release, with genre + language
//   /release/<slug>                       release page, has the IMDb link
// Each poster card is:
//   <div><a href="/release/x"><img src="/img/ID-300.webp" alt="TITLE"></a>
//        <div><a href="/release/x"><p class="movie-name name">TITLE</p></a></div></div>
// Pagination: a "Next" link to /<section>/<n+1>/. Past the last page the
// site silently serves the HOME listing instead of a 404, so the only
// reliable end-of-listing signal is "no Next link pointing into this
// section" — crawlSection() checks exactly that.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 12;
const sectionCache = new NodeCache({ stdTTL: 60 * 60, useClones: false }); // 1h
const festCache = new NodeCache({ stdTTL: 6 * 60 * 60, useClones: false }); // 6h
let lastGoodSections = null;
let sectionsBuildPromise = null;

function absolute(href) {
  if (!href) return null;
  try {
    return new URL(href, BASE_URL).toString();
  } catch {
    return null;
  }
}

/**
 * Pull poster cards (title, release page URL, poster URL) out of any GOAT
 * listing page: /movies, /series, the homepage, or a /fest/<slug> page.
 */
function extractCards($) {
  // Two anchors per card point at the same /release/ URL: one wraps the
  // poster <img> (title only in its alt), the other wraps the title text.
  // Merge everything seen for a URL instead of guessing at the container
  // markup, which is fragile across theme changes.
  const byUrl = new Map();
  $('a[href*="/release/"]').each((_, el) => {
    const pageUrl = absolute($(el).attr('href'));
    if (!pageUrl) return;
    const entry = byUrl.get(pageUrl) || { title: '', pageUrl, poster: null };
    if (!byUrl.has(pageUrl)) byUrl.set(pageUrl, entry);
    const img = $(el).find('img').first();
    if (img.length) {
      entry.poster = entry.poster || absolute(img.attr('src'));
      if (!entry.title) entry.title = (img.attr('alt') || '').trim();
    }
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text) entry.title = text; // the text link wins over the alt text
  });
  return [...byUrl.values()].filter((c) => c.title);
}

async function fetchSectionPage(section, pageIndex) {
  // Page 0 is /<section>, page 1 is /<section>/1/, and so on.
  const url = pageIndex === 0 ? `${BASE_URL}/${section}` : `${BASE_URL}/${section}/${pageIndex}/`;
  const res = await client.get(url);
  if (res.status !== 200) return { cards: [], hasNext: false };
  const $ = cheerio.load(res.data);
  const cards = extractCards($);
  const nextRe = new RegExp(`/${section}/(\\d+)/?$`);
  let hasNext = false;
  $('a[href]').each((_, el) => {
    const m = ($(el).attr('href') || '').match(nextRe);
    if (m && parseInt(m[1], 10) === pageIndex + 1) hasNext = true;
  });
  // A page with no pagination links into this section at all is the
  // home-listing fallback the site serves past the end — ignore its cards.
  let inSection = pageIndex === 0;
  if (!inSection) {
    $('a[href]').each((_, el) => {
      if (nextRe.test($(el).attr('href') || '')) inSection = true;
    });
  }
  return { cards: inSection ? cards : [], hasNext: inSection && hasNext };
}

async function crawlSection(section) {
  const all = [];
  const HARD_LIMIT = 200; // ~2400 titles; the site has ~600 today
  const CONCURRENCY = 4;
  let page = 0;
  let done = false;
  while (!done && page < HARD_LIMIT) {
    const batch = [];
    for (let i = 0; i < CONCURRENCY && page < HARD_LIMIT; i++, page++) batch.push(page);
    const results = await Promise.allSettled(batch.map((p) => fetchSectionPage(section, p)));
    for (const r of results) {
      if (r.status !== 'fulfilled') {
        console.warn(`goat: /${section}/ page fetch failed:`, r.reason && r.reason.message);
        done = true;
        break;
      }
      all.push(...r.value.cards);
      if (!r.value.hasNext) {
        done = true;
        break;
      }
    }
  }
  return all;
}

async function buildSections() {
  const [movies, series] = await Promise.all([crawlSection('movies'), crawlSection('series')]);
  const sections = { movies, series };
  if (movies.length || series.length) {
    sectionCache.set('sections', sections);
    lastGoodSections = sections;
    console.log(`goat: listing crawled — ${movies.length} movies, ${series.length} series`);
  } else {
    console.error('goat: listing crawl produced 0 cards (site unreachable or markup changed?) — keeping previous');
  }
  return sections;
}

/**
 * Movies + series listings (with posters), cached 1h. Stale-while-revalidate:
 * the previous crawl keeps serving while a refresh runs. Returns null only
 * before the very first crawl has finished — callers should then await
 * ensureSections() instead.
 */
function getSectionsNonBlocking() {
  const cached = sectionCache.get('sections');
  if (cached) return cached;
  if (!sectionsBuildPromise) {
    sectionsBuildPromise = buildSections()
      .catch((err) => {
        console.error('goat: listing crawl failed:', err.message);
        return null;
      })
      .finally(() => {
        sectionsBuildPromise = null;
      });
  }
  return lastGoodSections;
}

async function ensureSections() {
  const have = getSectionsNonBlocking();
  if (have) return have;
  return (await sectionsBuildPromise) || lastGoodSections || { movies: [], series: [] };
}

/**
 * The homepage shows the newest releases of both kinds — one cheap fetch,
 * used for the "Latest" row so a release posted minutes ago shows up
 * without waiting for the hourly crawl.
 */
async function getHomepageCards() {
  const cached = sectionCache.get('home');
  if (cached) return cached;
  const res = await client.get(`${BASE_URL}/`);
  const cards = res.status === 200 ? extractCards(cheerio.load(res.data)) : [];
  if (cards.length) sectionCache.set('home', cards, 15 * 60);
  return cards;
}

/** Festival collections listed on /festivals: [{ name, slug, pageUrl, count }]. */
async function getFestivals() {
  const cached = festCache.get('list');
  if (cached) return cached;
  const res = await client.get(`${BASE_URL}/festivals`);
  const fests = [];
  if (res.status === 200) {
    const $ = cheerio.load(res.data);
    const seen = new Set();
    $('a[href*="/fest/"]').each((_, el) => {
      const pageUrl = absolute($(el).attr('href'));
      const m = pageUrl && pageUrl.match(/\/fest\/([^/?#]+)/);
      if (!m || seen.has(m[1])) return;
      const raw = $(el).text().replace(/\s+/g, ' ').trim();
      if (!raw) return;
      seen.add(m[1]);
      const countMatch = raw.match(/\((\d+)\)\s*$/);
      fests.push({
        slug: m[1],
        name: raw.replace(/\s*\(\d+\)\s*$/, ''),
        pageUrl,
        count: countMatch ? parseInt(countMatch[1], 10) : null,
      });
    });
  }
  if (fests.length) festCache.set('list', fests);
  return fests;
}

/** Poster cards for one festival (/fest/<slug>). */
async function getFestivalCards(slug) {
  const key = `fest:${slug}`;
  const cached = festCache.get(key);
  if (cached) return cached;
  const res = await client.get(`${BASE_URL}/fest/${encodeURIComponent(slug)}`);
  const cards = res.status === 200 ? extractCards(cheerio.load(res.data)) : [];
  if (cards.length) festCache.set(key, cards);
  return cards;
}

/**
 * IMDb id shown on a release page (null if none). Shares imdbCache with
 * verifyImdbMatch() so a catalog browse and a later subtitle lookup never
 * fetch the same page twice.
 */
async function getImdbId(pageUrl) {
  const cached = imdbCache.get(pageUrl);
  if (cached !== undefined) return cached;
  try {
    const res = await client.get(pageUrl);
    const match = res.status === 200 ? res.data.match(/imdb\.com\/title\/(tt\d+)/i) : null;
    const foundId = match ? match[1] : null;
    // Remember a miss only briefly: a page that was mid-edit or blocked
    // shouldn't lose its IMDb id for a whole day.
    imdbCache.set(pageUrl, foundId, foundId ? 24 * 60 * 60 : 10 * 60);
    return foundId;
  } catch {
    return null;
  }
}

/** Synopsis + big poster from a release page, for items with no IMDb id. */
async function getReleaseDetails(pageUrl) {
  const res = await client.get(pageUrl);
  if (res.status !== 200) return null;
  const $ = cheerio.load(res.data);
  const html = res.data;
  const imdbMatch = html.match(/imdb\.com\/title\/(tt\d+)/i);
  // og:image / og:description here are the site's generic logo and blurb,
  // so read the release's own poster card instead. The genre list sits in
  // a plain table cell ("Action, History, Fantasy").
  const poster = absolute($('img.card-image').first().attr('src'));
  let genres = [];
  $('td').each((_, el) => {
    const text = $(el).text().trim();
    if (!genres.length && /^[A-Za-z][A-Za-z\s-]*(,\s*[A-Za-z][A-Za-z\s-]*)+$/.test(text)) {
      genres = text.split(',').map((g) => g.trim()).filter(Boolean);
    }
  });
  return { imdbId: imdbMatch ? imdbMatch[1] : null, poster, description: null, genres };
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
  let listing = await getFullListing();

  let scored = listing
    .map((r) => ({ ...r, score: scoreCandidate(query, year, r.title) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  // A total miss against the cached listing could mean the film genuinely
  // isn't up yet, or it could mean it was posted after the listing was last
  // cached (up to 1h stale). The listing page is a single cheap fetch, so
  // it's worth one live retry before giving up rather than making the user
  // wait out the rest of the cache window.
  if (!scored.length) {
    listing = await getFullListing(true);
    scored = listing
      .map((r) => ({ ...r, score: scoreCandidate(query, year, r.title) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
  }

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

module.exports = {
  getFullListing,
  findSubtitleUrl,
  fetchSubtitleFile,
  // catalog support
  extractCards,
  getSectionsNonBlocking,
  ensureSections,
  getHomepageCards,
  getFestivals,
  getFestivalCards,
  getImdbId,
  getReleaseDetails,
  PAGE_SIZE,
  BASE_URL,
};
