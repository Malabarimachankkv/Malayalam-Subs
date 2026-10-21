const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const { scoreCandidate, normalize } = require('./matching');
const { fetchSubtitleFile: fetchFile } = require('./fetchFile');

const BASE_URL = 'https://moviemirrorsubtitles.com';

// ---------------------------------------------------------------------------
// How Movie Mirror lookups work (v5.2)
//
// Candidate releases come from three sources, cheapest/freshest first:
//
//   1. The site's WordPress REST API: /wp-json/wp/v2/posts?search=<words>.
//      It's public (robots.txt only disallows /wp-admin/ and the bot-check
//      path), returns the post title + permalink straight away, and sees a
//      post the moment it's published. This is what makes a title posted
//      minutes ago findable without any crawl at all.
//   2. A small "recent" set: page 1 of /category/movies/ and
//      /category/series/ plus the homepage widgets, cached 15 min.
//   3. The full crawled title index of both category listings (12h TTL,
//      built in the background). Kept as a safety net for when the REST
//      search misses — e.g. a listing with a typo in the title
//      ("GRAGON"), which WordPress's exact-substring search can't find but
//      our fuzzy title scorer can.
//
// Every candidate's release page is then opened to read its IMDb id (for
// verification) and its actual download link.
// ---------------------------------------------------------------------------

const indexCache = new NodeCache({ stdTTL: 12 * 60 * 60, useClones: false }); // 12h
const detailsCache = new NodeCache({ stdTTL: 24 * 60 * 60, useClones: false });
const recentCache = new NodeCache({ stdTTL: 15 * 60, useClones: false }); // 15m
const apiSearchCache = new NodeCache({ stdTTL: 15 * 60, useClones: false }); // 15m
let buildPromise = null;
// Stale-while-revalidate: the last successfully built index is kept here
// even after its 12h TTL lapses, so a rebuild (120+ page fetches) never
// makes Movie Mirror results vanish for everyone while it runs. Before this,
// getIndexNonBlocking() returned null the moment the cache expired, and
// every lookup during the rebuild silently lost the whole index.
let lastGoodIndex = null;

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
const NON_RELEASE_PATH = /^(about-us|subtitles|advanced-filter|fest|subtitle-submission|freshers-submission|subtitle-status|enquiry|poster-designer|director|translator|language|genre|category|tag|author|feed|wp-content|wp-json|wp-admin|wp-login\.php|cdn-cgi|imunify-bot-check|page|search)(\/|$)/i;

// File types the DOWNLOAD button can point at. .zip is unpacked by
// lib/fetchFile.js; the rest are served as-is.
const DOWNLOAD_EXT = /\.(srt|vtt|ass|ssa|zip)(?:[?#]|$)/i;

function isReleaseLink(href) {
  if (!href || !href.startsWith(BASE_URL)) return false;
  const path = href.slice(BASE_URL.length).replace(/^\//, '').replace(/\/$/, '');
  if (!path || path.includes('/')) return false; // release permalinks are a single path segment
  if (path.startsWith('?') || path.startsWith('#')) return false;
  return !NON_RELEASE_PATH.test(path + '/');
}

function absoluteUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, BASE_URL).toString();
  } catch {
    return null;
  }
}

// Decode HTML entities (&#8211; &amp; etc.) that WordPress leaves in
// title.rendered and listing anchor text.
function decodeHtml(html) {
  if (!html) return '';
  return cheerio.load(`<div>${html}</div>`)('div').text().replace(/\s+/g, ' ').trim();
}

function extractReleaseLinks($) {
  const releases = [];
  const seen = new Set();

  $('a').each((_, el) => {
    const href = absoluteUrl($(el).attr('href'));
    // Listing cards wrap both the poster image and the title text in links
    // to the same post; the image link has no text but usually a title attr.
    const title = ($(el).text().trim() || $(el).attr('title') || '').replace(/\s+/g, ' ').trim();
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
  if (res.status === 404) return { releases: [], maxPage: page, notFound: true, status: res.status };
  const $ = cheerio.load(res.data);
  const releases = extractReleaseLinks($);

  // Highest pagination number linked from this page.
  let maxPage = page;
  $('a[href*="/page/"]').each((_, el) => {
    const m = ($(el).attr('href') || '').match(/\/page\/(\d+)\//);
    if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
  });

  return { releases, maxPage, notFound: false, status: res.status };
}

async function crawlSection(section) {
  const all = [];
  const CONCURRENCY = 4;
  // Sanity cap so a permanently-broken loop can't run forever.
  const HARD_LIMIT_PAGES = 400;

  let page = 1;
  while (page <= HARD_LIMIT_PAGES) {
    const batch = [];
    for (let i = 0; i < CONCURRENCY && page <= HARD_LIMIT_PAGES; i++, page++) batch.push(page);

    const results = await Promise.allSettled(batch.map((p) => fetchListingPage(section, p)));
    let releasesThisBatch = 0;
    let anySucceeded = false;
    let allNotFound = true;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        anySucceeded = true;
        if (!r.value.notFound) allNotFound = false;
        if (r.value.releases.length === 0 && !r.value.notFound) {
          // A 200 page with no release links is either the end of the
          // listing or an anti-bot/challenge page — log it so a truncated
          // index is diagnosable rather than silent.
          console.warn(`moviemirror: /category/${section}/ page ${batch[results.indexOf(r)]} returned HTTP ${r.value.status} with no release links`);
        }
        all.push(...r.value.releases);
        releasesThisBatch += r.value.releases.length;
      } else {
        console.warn(`moviemirror: listing page fetch failed (${section}):`, r.reason && r.reason.message);
      }
    }

    // WordPress answers 404 for pages past the end of a listing — that's the
    // definitive end. A whole batch of 200s with zero releases is treated the
    // same way (end of listing, or the site is serving us challenge pages —
    // either way there's nothing more to gain by continuing).
    if (anySucceeded && allNotFound) break;
    if (anySucceeded && releasesThisBatch === 0) break;
    if (!anySucceeded) break; // every request in this batch failed outright — bail rather than spin
  }

  return all;
}

async function buildIndex() {
  const [movies, series] = await Promise.all([crawlSection('movies'), crawlSection('series')]);
  const index = [...movies, ...series];
  if (index.length) {
    indexCache.set('index', index);
    lastGoodIndex = index;
    console.log(`moviemirror: index built — ${movies.length} movies, ${series.length} series`);
  } else {
    console.error('moviemirror: index build produced 0 entries (site unreachable or blocking?) — keeping previous index');
  }
  return index;
}

/**
 * Fast freshness check, independent of the big 12h index: page 1 of both
 * category listings (newest posts first) plus whatever the homepage widgets
 * are showing. A brand-new post is on category page 1 within seconds of
 * being published; the homepage NEW ARRIVALS widget on its own turned out
 * NOT to be reliable for this (it was observed lagging behind the category
 * listing by at least one post), so both are read.
 */
async function getRecentReleases() {
  const cached = recentCache.get('recent');
  if (cached) return cached;

  const urls = [`${BASE_URL}/category/movies/`, `${BASE_URL}/category/series/`, BASE_URL];
  const results = await Promise.allSettled(urls.map((u) => client.get(u)));
  const recent = [];
  const seen = new Set();
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      console.error(`moviemirror recent-listing fetch failed (${urls[i]}):`, r.reason && r.reason.message);
      return;
    }
    for (const rel of extractReleaseLinks(cheerio.load(r.value.data))) {
      if (seen.has(rel.pageUrl)) continue;
      seen.add(rel.pageUrl);
      recent.push(rel);
    }
  });

  if (recent.length) recentCache.set('recent', recent);
  return recent;
}

/**
 * Search the site's own WordPress REST API. Public, cheap (one request),
 * and sees new posts instantly. Returns [] on any failure so callers fall
 * back to the crawled index.
 *
 * WordPress search requires every search term to appear somewhere in the
 * post, so stop-words are dropped and only the significant title words are
 * sent — the fuzzy scorer then does the actual matching on the returned
 * titles.
 */
async function searchViaApi(query) {
  const words = normalize(query).split(' ').filter((w) => w && !['the', 'a', 'an', 'of', 'and'].includes(w));
  const term = words.join(' ').trim();
  if (!term) return [];

  const cached = apiSearchCache.get(term);
  if (cached) return cached;

  const url = `${BASE_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(term)}&per_page=50&_fields=id,date,link,title`;
  try {
    const res = await client.get(url, { headers: { Accept: 'application/json' } });
    const posts = Array.isArray(res.data) ? res.data : null;
    if (!posts) {
      console.warn(`moviemirror: REST search returned HTTP ${res.status} (non-JSON) for "${term}"`);
      return [];
    }
    const releases = posts
      .map((p) => ({
        title: decodeHtml(p.title && (p.title.rendered || p.title)),
        pageUrl: absoluteUrl(p.link),
        date: p.date || null,
      }))
      .filter((r) => r.title && r.pageUrl && isReleaseLink(r.pageUrl));
    apiSearchCache.set(term, releases);
    return releases;
  } catch (err) {
    console.error(`moviemirror: REST search failed for "${term}":`, err.message);
    return [];
  }
}

/**
 * Returns the best available index immediately: the fresh one if cached,
 * otherwise the last good (possibly stale) one while a rebuild runs in the
 * background. Returns null only if no index has ever been built.
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
  return lastGoodIndex;
}

/**
 * Parse a release page for its IMDb id (verification) and its subtitle
 * download URL.
 *
 * The site used to route downloads through a `?custom_download=<url>`
 * query parameter, and this function only looked for that. The theme now
 * renders the DOWNLOAD button as a plain link straight to the file under
 * /wp-content/uploads/ (e.g. ".../2026/10/Hope.2026....srt" or
 * ".../Supernatural.S06.MovieMirror.zip"), so the old regex found nothing,
 * `downloadUrl` came back null, and every title not already sitting in the
 * B2 cache — i.e. every NEW title — silently disappeared from results.
 * Both forms are accepted now.
 */
function parseReleasePage(html) {
  const $ = cheerio.load(html);

  const imdbMatch = html.match(/imdb\.com\/title\/(tt\d+)/i);
  const imdbId = imdbMatch ? imdbMatch[1] : null;

  // 1. Legacy ?custom_download=<encoded file url>
  let downloadUrl = null;
  const legacy = html.match(/custom_download=([^&"'\s<>]+)/i);
  if (legacy) {
    try {
      downloadUrl = decodeURIComponent(legacy[1]);
    } catch {
      downloadUrl = legacy[1];
    }
  }

  // 2. Direct file links. Prefer the explicit DOWNLOAD button, then any
  //    uploads link with a subtitle/zip extension.
  if (!downloadUrl) {
    const candidates = [];
    $('a[href]').each((_, el) => {
      const href = absoluteUrl($(el).attr('href'));
      if (!href || !DOWNLOAD_EXT.test(href)) return;
      const text = $(el).text().trim().toLowerCase();
      const isButton = /download/.test(text) || $(el).attr('download') !== undefined;
      const isUpload = href.includes('/wp-content/uploads/');
      candidates.push({ href, rank: (isButton ? 2 : 0) + (isUpload ? 1 : 0) });
    });
    candidates.sort((a, b) => b.rank - a.rank);
    if (candidates.length) downloadUrl = candidates[0].href;
  }

  return { imdbId, downloadUrl };
}

async function extractReleaseDetails(pageUrl) {
  const cached = detailsCache.get(pageUrl);
  if (cached) return cached;

  const res = await client.get(pageUrl);
  const details = res.status === 200 ? parseReleasePage(res.data) : { imdbId: null, downloadUrl: null };

  // Only remember a page for the full 24h once it actually yielded a
  // download link. A failed/blocked/temporarily broken page is remembered
  // for just a few minutes so one bad fetch can't poison a title for a day.
  detailsCache.set(pageUrl, details, details.downloadUrl ? 24 * 60 * 60 : 5 * 60);
  return details;
}

async function findSubtitleUrl(query, year, imdbId) {
  const [apiResults, recent] = await Promise.all([searchViaApi(query), getRecentReleases()]);
  const index = getIndexNonBlocking() || [];

  const seen = new Set();
  const combined = [...apiResults, ...recent, ...index].filter((r) => {
    if (!r || !r.pageUrl || seen.has(r.pageUrl)) return false;
    seen.add(r.pageUrl);
    return true;
  });
  if (!combined.length) return null;

  const scored = combined
    .map((r) => ({ ...r, score: scoreCandidate(query, year, r.title) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  // Open the best-scored candidates' pages in parallel (order preserved).
  const top = scored.slice(0, 6);
  const settled = await Promise.allSettled(top.map((c) => extractReleaseDetails(c.pageUrl)));
  const detailed = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') detailed.push({ candidate: top[i], details: s.value });
    else console.error(`moviemirror: release page fetch failed (${top[i].pageUrl}):`, s.reason && s.reason.message);
  });

  // Prefer an IMDb-confirmed candidate when we can get one.
  if (imdbId) {
    for (const { candidate, details } of detailed) {
      if (details.downloadUrl && details.imdbId === imdbId) {
        return { url: details.downloadUrl, pageUrl: candidate.pageUrl, matchedTitle: candidate.title };
      }
    }
  }

  // No IMDb-confirmed match. The title scorer already requires every
  // significant query word to match (with small typo tolerance), so the
  // best-scored candidate is still reliable — but never serve a page whose
  // IMDb link points at a DIFFERENT title than the one requested.
  for (const { candidate, details } of detailed) {
    if (!details.downloadUrl) continue;
    if (imdbId && details.imdbId && details.imdbId !== imdbId) continue;
    return { url: details.downloadUrl, pageUrl: candidate.pageUrl, matchedTitle: candidate.title };
  }
  return null;
}

// Reuses the shared download/unzip logic (lib/fetchFile.js), binding it to
// Movie Mirror's own origin as the Referer (files are served straight from
// /wp-content/uploads/, where a foreign Referer can be rejected).
function fetchSubtitleFile(downloadUrl, episode) {
  return fetchFile(downloadUrl, episode, BASE_URL);
}

// ---------------------------------------------------------------------------
// Catalog support (Stremio "Discover"/board rows) — used by lib/catalogs.js.
//
// Movie Mirror's WordPress REST API does all the heavy lifting:
//   /wp-json/wp/v2/posts?categories[terms][]=78&categories[terms][]=20
//                        &categories[operator]=AND&page=2&per_page=24
//   -> posts in BOTH "Movies" (78) and "Action" (20), newest first, with
//      X-WP-Total / X-WP-TotalPages headers for pagination.
//   /wp-json/wp/v2/posts?search=dragon             -> site search
//   /wp-json/wp/v2/media?include=10021,9993        -> poster URLs in one call
// Category ids come from /wp-json/wp/v2/categories (see MM_GENRES in
// lib/catalogs.js). The IMDb id is NOT exposed through the API — it's only
// in the theme-rendered release page, so extractReleaseDetails() (already
// used for subtitle lookups, cached 24h) supplies it.
// ---------------------------------------------------------------------------

const CATEGORY_MOVIES = 78;
const CATEGORY_SERIES = 53;
const listCache = new NodeCache({ stdTTL: 15 * 60, useClones: false }); // 15m
const mediaCache = new NodeCache({ stdTTL: 24 * 60 * 60, useClones: false });

/**
 * One page of posts. `categories` is a list of category ids that must ALL
 * apply (e.g. [78, 20] = Movies that are also Action). `search` is passed
 * to WordPress search. Returns { posts, total, totalPages }, where each
 * post is { id, title, pageUrl, date, categories, featuredMedia, type }.
 */
async function listPosts({ categories = [], search = '', page = 1, perPage = 24 } = {}) {
  const params = new URLSearchParams();
  params.set('per_page', String(perPage));
  params.set('page', String(page));
  params.set('_fields', 'id,date,link,title,categories,featured_media');
  for (const id of categories) params.append('categories[terms][]', String(id));
  if (categories.length) params.set('categories[operator]', 'AND');
  if (search) params.set('search', search);
  const url = `${BASE_URL}/wp-json/wp/v2/posts?${params.toString()}`;

  const cached = listCache.get(url);
  if (cached) return cached;

  const res = await client.get(url, { headers: { Accept: 'application/json' } });
  // WordPress answers 400 (rest_post_invalid_page_number) past the last page.
  if (res.status === 400) return { posts: [], total: 0, totalPages: 0 };
  const data = Array.isArray(res.data) ? res.data : null;
  if (!data) {
    throw new Error(`moviemirror: REST listing returned HTTP ${res.status} (non-JSON)`);
  }
  const posts = data
    .map((p) => ({
      id: p.id,
      title: decodeHtml(p.title && (p.title.rendered || p.title)),
      pageUrl: absoluteUrl(p.link),
      date: p.date || null,
      categories: Array.isArray(p.categories) ? p.categories : [],
      featuredMedia: p.featured_media || null,
      type: Array.isArray(p.categories) && p.categories.includes(CATEGORY_SERIES) ? 'series' : 'movie',
    }))
    .filter((p) => p.title && p.pageUrl && isReleaseLink(p.pageUrl));

  const result = {
    posts,
    total: parseInt(res.headers['x-wp-total'], 10) || posts.length,
    totalPages: parseInt(res.headers['x-wp-totalpages'], 10) || 1,
  };
  listCache.set(url, result);
  return result;
}

/**
 * Poster URLs for a batch of featured_media ids, as { [mediaId]: url }.
 * One request for up to 100 ids; results cached 24h per id.
 */
async function getMediaUrls(mediaIds) {
  const out = {};
  const missing = [];
  for (const id of new Set(mediaIds.filter(Boolean))) {
    const cached = mediaCache.get(String(id));
    if (cached) out[id] = cached;
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const url = `${BASE_URL}/wp-json/wp/v2/media?include=${chunk.join(',')}&per_page=100&_fields=id,source_url,media_details`;
    try {
      const res = await client.get(url, { headers: { Accept: 'application/json' } });
      if (!Array.isArray(res.data)) continue;
      for (const m of res.data) {
        const sizes = (m.media_details && m.media_details.sizes) || {};
        // A ~300-700px poster is plenty for a catalog row; fall back to full size.
        const pick = (sizes.medium_large || sizes.large || sizes.medium || {}).source_url || m.source_url;
        const abs = absoluteUrl(pick);
        if (abs) {
          out[m.id] = abs;
          mediaCache.set(String(m.id), abs);
        }
      }
    } catch (err) {
      console.error('moviemirror: media lookup failed:', err.message);
    }
  }
  return out;
}

/** IMDb id from a release page (null if none) — reuses the 24h details cache. */
async function getImdbId(pageUrl) {
  try {
    const details = await extractReleaseDetails(pageUrl);
    return details.imdbId || null;
  } catch {
    return null;
  }
}

/** Synopsis + poster from a release page, for items with no IMDb id. */
async function getReleaseDetails(pageUrl) {
  const res = await client.get(pageUrl);
  if (res.status !== 200) return null;
  const $ = cheerio.load(res.data);
  const imdbMatch = res.data.match(/imdb\.com\/title\/(tt\d+)/i);
  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    null;
  // og:image on this theme is the site logo, and the first .wp-post-image
  // is a "related posts" thumbnail — the post's own poster is the
  // .ms-poster-img inside .ms-poster-col.
  const poster =
    absoluteUrl($('img.ms-poster-img, .ms-poster-col img').first().attr('src')) ||
    absoluteUrl($('img[src*="/wp-content/uploads/"]').not('.related-thumb-img').first().attr('src'));
  return { imdbId: imdbMatch ? imdbMatch[1] : null, poster, description };
}

module.exports = {
  findSubtitleUrl,
  fetchSubtitleFile,
  // catalog support
  listPosts,
  getMediaUrls,
  getImdbId,
  getReleaseDetails,
  CATEGORY_MOVIES,
  CATEGORY_SERIES,
  getIndexNonBlocking,
  getRecentReleases,
  searchViaApi,
  extractReleaseDetails,
  parseReleasePage,
  extractReleaseLinks,
  isReleaseLink,
  BASE_URL,
};
