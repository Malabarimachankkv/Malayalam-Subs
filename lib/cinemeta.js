const axios = require('axios');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 24 * 60 * 60 });

/** First year in a Cinemeta meta's `year` or `releaseInfo`, else null. */
function yearOf(m) {
  const raw = (m && (m.year || m.releaseInfo)) || '';
  const match = String(raw).match(/(19|20)\d{2}/);
  return match ? parseInt(match[0], 10) : null;
}

/**
 * Resolve an IMDb id (e.g. "tt1234567") + Stremio type into a title/year
 * using Cinemeta, the same public metadata addon Stremio itself relies on.
 */
async function getMeta(type, imdbId) {
  const cacheKey = `${type}:${imdbId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const res = await axios.get(url, { timeout: 10000 });
  const meta = res.data && res.data.meta;
  if (!meta) return null;

  const result = { title: meta.name, year: yearOf(meta) };
  cache.set(cacheKey, result);
  return result;
}

/**
 * Search Cinemeta by title text (same search Stremio's own discover/search
 * uses) so the admin dashboard can look up "The Furious" and get back its
 * IMDb id instead of the admin having to know/type tt-ids by hand.
 */
async function searchTitles(type, query) {
  if (!query || !query.trim()) return [];
  const cacheKey = `search:${type}:${query.trim().toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(query.trim())}.json`;
  const res = await axios.get(url, { timeout: 10000 });
  const metas = (res.data && res.data.metas) || [];
  const results = metas.slice(0, 10).map((m) => ({
    imdbId: m.id,
    title: m.name,
    // Cinemeta's catalog/search entries carry the year only as
    // `releaseInfo` ("2026", or "2021-2023" / "2021-" for series); `year`
    // is set on full /meta responses, almost never here. Reading only
    // `year` made every search result look undated, so a year-checked
    // lookup could never pick anything.
    year: yearOf(m),
    poster: m.poster || null,
    type,
  }));
  cache.set(cacheKey, results, 60 * 60); // 1h — search results change rarely
  return results;
}

module.exports = { getMeta, searchTitles };
