// Stremio catalog rows for the two subtitle sites, so the addon shows up on
// the Board / Discover page as browsable rows ("Team GOAT · Latest
// Releases", "Movie Mirror · Thriller", ...) and not just as a subtitle
// provider.
//
// Each row item is resolved to an IMDb id (read from the site's own release
// page, which both sites link), so clicking it opens the normal Stremio
// details page with posters/streams from the user's other addons — and this
// addon's own subtitles. Items whose page has no IMDb link fall back to a
// Cinemeta title search, and failing that get an "mlsub:" id served by the
// meta handler below so nothing silently disappears from a row.

const NodeCache = require('node-cache');
const goat = require('./goat');
const moviemirror = require('./moviemirror');
const { searchTitles } = require('./cinemeta');
const { scoreCandidate } = require('./matching');

const PAGE = 24; // items per catalog page (Stremio pages with `skip`)
const SOURCE_NAMES = { goat: 'Team GOAT', moviemirror: 'Movie Mirror' };
const SOURCE_SITES = { goat: goat.BASE_URL, moviemirror: moviemirror.BASE_URL };

// Genres as the sites label them. Team GOAT lists "Genre: Action, Crime"
// on every card of /search-and-download; this is the set with 3+ titles as
// of Oct 2026. Filtering is done in memory, so an unlisted genre just
// returns nothing rather than breaking anything.
const GOAT_GENRES = [
  'Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Coming of Age', 'Crime',
  'Dark Comedy', 'Documentary', 'Drama', 'Erotic', 'Family', 'Fantasy', 'Heist', 'History',
  'Horror', 'K-Drama', 'Martial Arts', 'Musical', 'Mystery', 'Psychological Thriller',
  'Romance', 'Sci-Fi', 'Short', 'Slasher', 'Sport', 'Spy', 'Superhero', 'Survival',
  'Thriller', 'War',
];

// Movie Mirror's WordPress category ids (GET /wp-json/wp/v2/categories).
// Only the ones with a meaningful number of posts; "Movies" (78) and
// "Series" (53) are the type categories and are combined with these.
const MM_GENRES = [
  { id: 20, name: 'Action' }, { id: 38, name: 'Adventure' }, { id: 28, name: 'Animation' },
  { id: 49, name: 'Anime' }, { id: 51, name: 'Biography' }, { id: 24, name: 'Comedy' },
  { id: 42, name: 'Crime' }, { id: 61, name: 'Dark Comedy' }, { id: 91, name: 'Documentary' },
  { id: 25, name: 'Drama' }, { id: 77, name: 'Erotic' }, { id: 34, name: 'Family' },
  { id: 43, name: 'Fantasy' }, { id: 177, name: 'Gangster' }, { id: 175, name: 'GEM' },
  { id: 44, name: 'History' }, { id: 40, name: 'Horror' }, { id: 95, name: 'IFFK' },
  { id: 185, name: 'Indian' }, { id: 75, name: 'K-Drama' }, { id: 55, name: 'Mini Series' },
  { id: 37, name: 'Mystery' }, { id: 131, name: 'Oscar' }, { id: 48, name: 'Psychological' },
  { id: 35, name: 'Romance' }, { id: 50, name: 'Sci-Fi' }, { id: 41, name: 'Short' },
  { id: 26, name: 'Sports' }, { id: 56, name: 'Survival' }, { id: 30, name: 'Thriller' },
  { id: 27, name: 'War' }, { id: 127, name: 'Western' },
];

// Used for the Festivals row if /festivals can't be read at startup.
const FALLBACK_FESTIVALS = [
  { slug: 'investigation-comedy-fest', name: 'ഇൻവെസ്റ്റിഗേഷൻ കോമഡി ഫെസ്റ്റ്' },
  { slug: 'jackie-chan-fest', name: 'ജാക്കി ചാൻ ഫെസ്റ്റ്' },
  { slug: 'members-choice', name: 'മെമ്പേഴ്‌സ് ചോയ്സ് ഫെസ്റ്റ്' },
  { slug: 'short-film-fest', name: 'ഷോർട് ഫിലിം ഫെസ്റ്റ്' },
];

let festivals = FALLBACK_FESTIVALS;

const responseCache = new NodeCache({ stdTTL: 15 * 60, useClones: false });
// Items that couldn't be tied to an IMDb id, keyed by their "mlsub:" id so
// the meta handler can describe them. 24h is enough for a browsing session.
const customItems = new NodeCache({ stdTTL: 24 * 60 * 60, useClones: false });
const cinemetaCache = new NodeCache({ stdTTL: 6 * 60 * 60 }); // imdbId, or false for a miss

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Reads the live festival list (3s budget) so the Festivals row's genre
 * dropdown reflects the site; falls back to the hard-coded list.
 */
async function init() {
  try {
    const live = await Promise.race([
      goat.getFestivals(),
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (live && live.length) festivals = live;
  } catch (err) {
    console.warn('catalogs: could not read Team GOAT festivals, using built-in list:', err.message);
  }
}

function buildCatalogs() {
  const skip = { name: 'skip' };
  const search = { name: 'search' };
  const genre = (options) => ({ name: 'genre', options, isRequired: false });
  return [
    // Team GOAT — malayalamsubtitles.in
    { id: 'goat-latest', type: 'movie', name: 'Team GOAT · Latest Releases', extra: [skip] },
    { id: 'goat-movies', type: 'movie', name: 'Team GOAT · Movies', extra: [genre(GOAT_GENRES), search, skip] },
    { id: 'goat-series', type: 'series', name: 'Team GOAT · Series', extra: [genre(GOAT_GENRES), search, skip] },
    { id: 'goat-festivals', type: 'movie', name: 'Team GOAT · Festivals', extra: [genre(festivals.map((f) => f.name)), skip] },
    // Movie Mirror — moviemirrorsubtitles.com
    { id: 'mm-latest', type: 'movie', name: 'Movie Mirror · Latest Releases', extra: [skip] },
    { id: 'mm-movies', type: 'movie', name: 'Movie Mirror · Movies', extra: [genre(MM_GENRES.map((g) => g.name)), search, skip] },
    { id: 'mm-series', type: 'series', name: 'Movie Mirror · Series', extra: [genre(MM_GENRES.map((g) => g.name)), search, skip] },
  ];
}

// ---------------------------------------------------------------------------
// Title parsing
// ---------------------------------------------------------------------------

const MALAYALAM = /[ഀ-ൿ]/g;
const INVISIBLE = /[­​-‏‪-‮⁠﻿]/g;

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/(^|[\s(:\-/"])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase())
    // Roman numerals and common all-caps tokens
    .replace(/\b(ii|iii|iv|vi|vii|viii|ix|xi|xii|tv|uk|usa|fbi|cia|nyc|la)\b/gi, (m) => m.toUpperCase());
}

/**
 * "RAGING FIRE – റേജിംഗ് ഫയർ (2021)"            -> { name: "Raging Fire", year: 2021 }
 * "ഹാർഡ് ബോയിൽഡ് | Hard Boiled (1992)"          -> { name: "Hard Boiled", year: 1992 }
 * "ഹൗ ടു ... ( How To Train Your Dragon ) 2025" -> { name: "How To Train Your Dragon", year: 2025 }
 */
function parseTitle(raw) {
  let s = (raw || '').normalize('NFKC').replace(INVISIBLE, '').replace(MALAYALAM, '').replace(/\s+/g, ' ').trim();

  const years = [...s.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => m[0]);
  const year = years.length ? parseInt(years[years.length - 1], 10) : null;

  // Movie Mirror often puts the English title in parentheses after the
  // Malayalam one: "ഹൗ ടു ... (How To Train Your Dragon) 2025". Use the
  // longest parenthesised Latin segment — but only when there's no real
  // Latin title OUTSIDE the parentheses, otherwise Team GOAT's
  // "BUSINESS PROPOSAL (K-DRAMA)" would turn into "K-Drama".
  const groups = [...s.matchAll(/\(([^()]*)\)/g)]
    .map((m) => m[1].trim())
    .filter((g) => /[a-z]{2,}/i.test(g) && !/^(season|s)\s*\d+$/i.test(g));
  const outside = s
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\b(season\s*\d+|s\d{1,2}|(19|20)\d{2})\b/gi, ' ');
  const latinOutside = (outside.match(/[a-z]/gi) || []).length;
  let name;
  if (groups.length && latinOutside < 3) {
    name = groups.sort((a, b) => b.length - a.length)[0];
    // Keep a season marker that sits outside the parentheses, e.g.
    // "(Dexter) Season 2 2021", so series titles stay distinguishable.
    const season = s.match(/\b(season\s*\d+|s\d{1,2})\b/i);
    if (season && !new RegExp(season[1], 'i').test(name)) name += ` ${season[1]}`;
  } else {
    // Team GOAT style: "ENGLISH – (year)". Pick the '|' / '–' separated
    // segment with the most Latin letters.
    const segs = s.split(/\s[|–—-]\s|\|/).map((x) => x.trim()).filter(Boolean);
    name = segs.sort((a, b) => (b.match(/[a-z]/gi) || []).length - (a.match(/[a-z]/gi) || []).length)[0] || s;
  }

  name = name
    .replace(/\(\s*(19|20)\d{2}\s*\)/g, ' ')
    .replace(/\b(19|20)\d{2}\b\s*$/, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s|:–—\-&,.]+|[\s|:–—\-&,.]+$/g, '')
    .trim();

  // Site titles are often ALL CAPS; present them normally.
  if (name && name === name.toUpperCase() && /[A-Z]/.test(name)) name = titleCase(name);
  name = name || raw;

  // Show-only name for metadata lookups: "Dexter Season 2" -> "Dexter",
  // "Business Proposal (K-Drama)" -> "Business Proposal".
  const baseName = name
    .replace(/\(\s*(season\s*\d+|s\d{1,2}|k-?drama|mini[\s-]?series|series)\s*\)/gi, ' ')
    .replace(/\b(season\s*\d+|s\d{1,2})\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s|:–—\-&,.]+|[\s|:–—\-&,.]+$/g, '')
    .trim() || name;

  return { name, baseName, year };
}

function looksLikeSeries(title) {
  return /\bseason\b|\bs\d{1,2}\b|\bseries\b|k-?drama|mini[\s-]?series|\bepisode/i.test(title || '');
}

function slugOf(pageUrl) {
  const m = (pageUrl || '').match(/\/([^/?#]+)\/?(?:[?#].*)?$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Item -> Stremio meta
// ---------------------------------------------------------------------------

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        out[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Cinemeta title search, used only when the release page has no IMDb link. */
async function cinemetaLookup(type, name, year) {
  const key = `${type}:${name.toLowerCase()}:${year || ''}`;
  const cached = cinemetaCache.get(key);
  if (cached !== undefined) return cached || null;
  try {
    const results = await searchTitles(type, name);
    const exact = results.filter((r) => scoreCandidate(name, null, r.title) > 0);
    const pool = exact.length ? exact : results;
    let pick = null;
    if (year) pick = pool.find((r) => r.year && Math.abs(parseInt(String(r.year).slice(0, 4), 10) - year) <= 1);
    if (!pick && !year) pick = pool[0] || null;
    cinemetaCache.set(key, pick ? pick.imdbId : false);
    return pick ? pick.imdbId : null;
  } catch {
    return null;
  }
}

/**
 * item: { source, title, pageUrl, poster, type, genres? }
 * Resolves the IMDb id and returns a Stremio meta preview. Never returns
 * null — an unresolved item gets an "mlsub:" id instead.
 */
async function toMeta(item) {
  const { name, baseName, year } = parseTitle(item.title);
  const mod = item.source === 'goat' ? goat : moviemirror;

  let imdbId = await mod.getImdbId(item.pageUrl);
  // Series pages list a release year per season, which rarely equals the
  // show's first-air year Cinemeta knows — so only movies get year-checked.
  if (!imdbId) imdbId = await cinemetaLookup(item.type, baseName, item.type === 'movie' ? year : null);

  const id = imdbId || `mlsub:${item.source}:${slugOf(item.pageUrl) || encodeURIComponent(item.title)}`;
  if (!imdbId) customItems.set(id, { ...item, name, year });

  const sourceName = SOURCE_NAMES[item.source];
  const meta = {
    id,
    type: item.type,
    name,
    poster: item.poster || undefined,
    posterShape: 'poster',
    description: `Malayalam subtitles from ${sourceName}${item.language ? ` · ${item.language}` : ''}\n${item.pageUrl}`,
  };
  if (year) meta.releaseInfo = String(year);
  if (item.genres && item.genres.length) meta.genres = item.genres;
  return meta;
}

// ---------------------------------------------------------------------------
// Team GOAT rows
// ---------------------------------------------------------------------------

function matchesGenre(item, genre) {
  if (!genre) return true;
  const g = genre.toLowerCase();
  return (item.genres || []).some((x) => x.toLowerCase() === g);
}

function matchesSearch(item, search) {
  if (!search) return true;
  return scoreCandidate(search, null, item.title) > 0;
}

/**
 * Everything Team GOAT lists, newest first, with type + poster from the
 * /movies and /series crawls and genre/language from /search-and-download.
 */
async function goatIndex() {
  const [listing, sections] = await Promise.all([
    goat.getFullListing().catch((err) => {
      console.error('goat listing failed:', err.message);
      return [];
    }),
    goat.ensureSections(),
  ]);

  const byUrl = new Map();
  const add = (card, type) => {
    const key = card.pageUrl.replace(/\/$/, '');
    const cur = byUrl.get(key) || { source: 'goat', pageUrl: key, title: card.title, poster: null, type: null, genres: [] };
    if (card.poster && !cur.poster) cur.poster = card.poster;
    if (type && !cur.type) cur.type = type;
    if (card.genres && card.genres.length) cur.genres = card.genres;
    if (card.language) cur.language = card.language;
    if (card.releaseNo != null) cur.releaseNo = card.releaseNo;
    if (!cur.title) cur.title = card.title;
    byUrl.set(key, cur);
  };
  // Order: the full listing is newest-first across both kinds (release
  // number descending), so it defines the "Latest" order. Section crawls
  // add posters/types; anything only they know about goes at the end.
  for (const r of listing) add(r, null);
  for (const c of sections.movies || []) add(c, 'movie');
  for (const c of sections.series || []) add(c, 'series');

  const items = [...byUrl.values()];
  for (const it of items) if (!it.type) it.type = looksLikeSeries(it.title) ? 'series' : 'movie';
  return items;
}

async function goatCatalog(id, extra) {
  const skip = parseInt(extra.skip, 10) || 0;
  let items;

  if (id === 'goat-festivals') {
    const wanted = extra.genre ? festivals.filter((f) => f.name === extra.genre) : festivals;
    const lists = await Promise.all(wanted.map((f) => goat.getFestivalCards(f.slug).catch(() => [])));
    const seen = new Set();
    items = [];
    lists.forEach((cards, i) => {
      for (const c of cards) {
        if (seen.has(c.pageUrl)) continue;
        seen.add(c.pageUrl);
        items.push({
          source: 'goat',
          ...c,
          type: looksLikeSeries(c.title) ? 'series' : 'movie',
          genres: [wanted[i].name],
        });
      }
    });
    // Posters/genres from the main index when we have them.
    const index = await goatIndex().catch(() => []);
    const byUrl = new Map(index.map((it) => [it.pageUrl, it]));
    items = items.map((it) => {
      const known = byUrl.get(it.pageUrl.replace(/\/$/, ''));
      return known ? { ...known, genres: [...new Set([...(known.genres || []), ...it.genres])] } : it;
    });
  } else {
    let all = await goatIndex();
    if (id === 'goat-latest') {
      // Put whatever the homepage shows right now first, so a release
      // posted after the last crawl still leads the row. (Done for every
      // page, not just the first, so paging stays consistent.)
      try {
        const home = await goat.getHomepageCards();
        const seen = new Set(home.map((c) => c.pageUrl.replace(/\/$/, '')));
        const byUrl = new Map(all.map((it) => [it.pageUrl, it]));
        const fresh = home.map((c) => {
          const key = c.pageUrl.replace(/\/$/, '');
          return byUrl.get(key) || { source: 'goat', ...c, pageUrl: key, type: looksLikeSeries(c.title) ? 'series' : 'movie', genres: [] };
        });
        all = [...fresh, ...all.filter((it) => !seen.has(it.pageUrl))];
      } catch (err) {
        console.warn('goat homepage fetch failed:', err.message);
      }
    }
    const type = id === 'goat-movies' ? 'movie' : id === 'goat-series' ? 'series' : null;
    items = all.filter((it) => (!type || it.type === type) && matchesGenre(it, extra.genre) && matchesSearch(it, extra.search));
  }

  const page = items.slice(skip, skip + PAGE);
  return (await mapLimit(page, 6, toMeta)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Movie Mirror rows
// ---------------------------------------------------------------------------

async function moviemirrorCatalog(id, extra) {
  const skip = parseInt(extra.skip, 10) || 0;
  const page = Math.floor(skip / PAGE) + 1;

  const categories = [];
  if (id === 'mm-movies') categories.push(moviemirror.CATEGORY_MOVIES);
  if (id === 'mm-series') categories.push(moviemirror.CATEGORY_SERIES);
  if (extra.genre) {
    const g = MM_GENRES.find((x) => x.name.toLowerCase() === extra.genre.toLowerCase());
    if (!g) return [];
    categories.push(g.id);
  }

  const { posts } = await moviemirror.listPosts({ categories, search: extra.search || '', page, perPage: PAGE });
  if (!posts.length) return [];

  const posters = await moviemirror.getMediaUrls(posts.map((p) => p.featuredMedia));
  const catNames = new Map(MM_GENRES.map((g) => [g.id, g.name]));
  const items = posts.map((p) => ({
    source: 'moviemirror',
    title: p.title,
    pageUrl: p.pageUrl,
    poster: posters[p.featuredMedia] || null,
    type: id === 'mm-movies' ? 'movie' : id === 'mm-series' ? 'series' : p.type,
    genres: p.categories.map((c) => catNames.get(c)).filter(Boolean),
  }));

  return (await mapLimit(items, 6, toMeta)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCatalog({ id, extra }) {
  extra = extra || {};
  const key = `${id}|${extra.genre || ''}|${extra.search || ''}|${extra.skip || 0}`;
  const cached = responseCache.get(key);
  if (cached) return cached;

  let metas = [];
  try {
    metas = id.startsWith('goat-') ? await goatCatalog(id, extra) : await moviemirrorCatalog(id, extra);
  } catch (err) {
    console.error(`catalog ${id} failed:`, err.message);
    return { metas: [] }; // don't cache failures
  }

  // Search responses are not cached by Stremio for long anyway; rows are.
  const response = { metas, cacheMaxAge: extra.search ? 60 : 15 * 60, staleRevalidate: 60 * 60, staleError: 24 * 60 * 60 };
  responseCache.set(key, response, extra.search ? 60 : 15 * 60);
  return response;
}

/** Full meta for an "mlsub:<source>:<slug>" item (no IMDb id available). */
async function handleMeta({ id }) {
  const item = customItems.get(id);
  if (!item) return { meta: null };
  const mod = item.source === 'goat' ? goat : moviemirror;
  let details = null;
  try {
    details = await mod.getReleaseDetails(item.pageUrl);
  } catch (err) {
    console.warn('release details fetch failed:', err.message);
  }
  const sourceName = SOURCE_NAMES[item.source];
  const meta = {
    id,
    type: item.type,
    name: item.name,
    poster: (details && details.poster) || item.poster || undefined,
    background: (details && details.poster) || item.poster || undefined,
    posterShape: 'poster',
    description: [
      details && details.description,
      `Malayalam subtitles from ${sourceName}. No IMDb link was found on the release page, so this entry can't be matched to streams automatically — open it on the site:`,
      item.pageUrl,
    ].filter(Boolean).join('\n\n'),
    genres: item.genres && item.genres.length ? item.genres : undefined,
    releaseInfo: item.year ? String(item.year) : undefined,
    links: [{ name: sourceName, category: 'website', url: item.pageUrl }],
    website: SOURCE_SITES[item.source],
  };
  return { meta, cacheMaxAge: 60 * 60 };
}

module.exports = { init, buildCatalogs, handleCatalog, handleMeta, parseTitle, PAGE, GOAT_GENRES, MM_GENRES };
