const storage = require('./storage');

// Deterministic key: source + imdbId + type + season/episode fully
// identifies one subtitle file, so we can check "do we already have this"
// with a single getObject instead of maintaining a separate index like the
// pool does. season/episode are 0 for movies (no season/episode to encode).
function buildKey(source, imdbId, type, season, episode) {
  const s = season || 0;
  const e = episode || 0;
  return `cache/${source}/${type}/${imdbId}/${s}/${e}`;
}

/**
 * Returns { buffer, ext, contentType } if this source already has a cached
 * copy of this exact title/episode, or null if it needs to be scraped fresh.
 */
async function getCached(source, imdbId, type, season, episode) {
  const key = buildKey(source, imdbId, type, season, episode);
  const obj = await storage.getObject(key);
  if (!obj) return null;
  return { buffer: obj.buffer, ext: obj.metadata.ext || '.srt', contentType: obj.contentType };
}

/**
 * Save a freshly-scraped subtitle so the next request for this exact
 * title/episode/source is served straight from storage instead of
 * re-scraping the source site.
 */
async function setCached(source, imdbId, type, season, episode, { buffer, ext, contentType }) {
  const key = buildKey(source, imdbId, type, season, episode);
  await storage.putObject(key, buffer, contentType, { ext: ext || '.srt' });
}

/**
 * Deletes one cached entry so the next request for it re-scrapes live
 * instead of serving whatever's stored. Exists for titles that got a bad
 * (HTML error page / challenge page) response cached before fetchFile.js
 * validated content — this clears the poisoned entry without needing direct
 * B2 console access. Safe to call even if nothing is cached for the key.
 */
async function deleteCached(source, imdbId, type, season, episode) {
  const key = buildKey(source, imdbId, type, season, episode);
  await storage.deleteObject(key);
}

module.exports = { getCached, setCached, deleteCached };
