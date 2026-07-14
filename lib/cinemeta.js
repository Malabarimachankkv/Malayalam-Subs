const axios = require('axios');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 24 * 60 * 60 });

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

  const result = { title: meta.name, year: meta.year ? parseInt(meta.year, 10) : null };
  cache.set(cacheKey, result);
  return result;
}

module.exports = { getMeta };
