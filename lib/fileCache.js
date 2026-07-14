const crypto = require('crypto');
const NodeCache = require('node-cache');

// Holds already-downloaded/extracted subtitle files in memory so the addon can
// serve them back to Stremio/Nuvio as plain .srt/.vtt at a stable URL of its own.
const cache = new NodeCache({ stdTTL: 6 * 60 * 60, checkperiod: 600 });

function put({ buffer, ext, contentType }) {
  const key = crypto.randomBytes(8).toString('hex');
  cache.set(key, { buffer, ext, contentType });
  return key;
}

function get(key) {
  return cache.get(key);
}

module.exports = { put, get };
