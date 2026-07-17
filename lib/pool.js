const crypto = require('crypto');
const NodeCache = require('node-cache');
const AdmZip = require('adm-zip');
const storage = require('./storage');
const { extractEpisodeNumber, SUB_EXTENSIONS, CONTENT_TYPES } = require('./fetchFile');

// The pool's index (which subtitle belongs to which IMDb id/season/episode)
// lives as one JSON object on B2 at this key, alongside the actual subtitle
// files under pool-files/. Nothing is ever written to local disk, so
// Render's free-tier wiping the disk on every sleep/redeploy doesn't matter.
const INDEX_KEY = 'pool-index.json';
const indexCache = new NodeCache({ stdTTL: 120 }); // 2 min in-memory cache to avoid hitting B2 on every lookup

async function loadIndex(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = indexCache.get('index');
    if (cached) return cached;
  }
  const obj = await storage.getObject(INDEX_KEY);
  let entries = [];
  if (obj) {
    try {
      entries = JSON.parse(obj.buffer.toString('utf8'));
    } catch (err) {
      console.error('pool: pool-index.json is corrupt:', err.message);
    }
  }
  indexCache.set('index', entries);
  return entries;
}

async function saveIndex(entries) {
  const buffer = Buffer.from(JSON.stringify(entries, null, 2));
  await storage.putObject(INDEX_KEY, buffer, 'application/json');
  indexCache.set('index', entries);
}

async function storeOne({ imdbId, type, season, episode, title, originalFilename, buffer, ext }) {
  const id = crypto.randomBytes(6).toString('hex');
  const storageKey = `pool-files/${id}${ext}`;
  const mimeType = CONTENT_TYPES[ext] || 'application/octet-stream';
  await storage.putObject(storageKey, buffer, mimeType, { ext });

  const entries = await loadIndex(true);
  const entry = {
    id,
    imdbId,
    type,
    season: season || null,
    episode: episode || null,
    title: title || null,
    originalFilename,
    storageKey,
    ext,
    addedAt: new Date().toISOString(),
  };
  entries.push(entry);
  await saveIndex(entries);
  return entry;
}

/**
 * Accepts an uploaded file buffer (either a raw .srt/.vtt or a .zip). If it's
 * a zip with multiple subtitle files inside (a season bundle), each one is
 * stored separately with its episode number auto-detected from its own
 * filename. Returns { stored: [...entries], skipped: [...filenames] } so the
 * dashboard can show the admin exactly what happened.
 */
async function ingestUpload({ imdbId, type, season, episodeOverride, title, originalFilename, buffer }) {
  const lower = originalFilename.toLowerCase();
  const isZip = lower.endsWith('.zip') || (buffer[0] === 0x50 && buffer[1] === 0x4b);

  if (!isZip) {
    const extMatch = SUB_EXTENSIONS.find((ext) => lower.endsWith(ext));
    const ext = extMatch || '.srt';
    const episode = type === 'series' ? (episodeOverride != null ? episodeOverride : extractEpisodeNumber(originalFilename)) : null;
    const entry = await storeOne({ imdbId, type, season, episode, title, originalFilename, buffer, ext });
    return { stored: [entry], skipped: [] };
  }

  const zip = new AdmZip(buffer);
  const subEntries = zip
    .getEntries()
    .filter((e) => !e.isDirectory && SUB_EXTENSIONS.some((ext) => e.entryName.toLowerCase().endsWith(ext)));

  const stored = [];
  const skipped = [];

  if (subEntries.length === 1) {
    const e = subEntries[0];
    const ext = SUB_EXTENSIONS.find((x) => e.entryName.toLowerCase().endsWith(x)) || '.srt';
    const episode = type === 'series' ? (episodeOverride != null ? episodeOverride : extractEpisodeNumber(e.entryName)) : null;
    stored.push(await storeOne({ imdbId, type, season, episode, title, originalFilename: e.entryName, buffer: e.getData(), ext }));
  } else {
    // Season bundle: one file per episode. Sequential (not Promise.all) so
    // the read-modify-write of the index inside storeOne doesn't race itself.
    for (const e of subEntries) {
      const ext = SUB_EXTENSIONS.find((x) => e.entryName.toLowerCase().endsWith(x)) || '.srt';
      const episode = extractEpisodeNumber(e.entryName);
      if (type === 'series' && episode == null) {
        skipped.push(e.entryName);
        continue;
      }
      stored.push(await storeOne({ imdbId, type, season, episode, title, originalFilename: e.entryName, buffer: e.getData(), ext }));
    }
  }

  return { stored, skipped };
}

/**
 * Find pool entries matching a lookup, same shape of inputs as the addon's
 * subtitles handler. An entry with no recorded season/episode is treated as
 * "unspecified" and only matches a request that also has none — this avoids
 * ever serving a random episode's subs for the wrong episode.
 */
async function findMatches(imdbId, type, season, episode) {
  const entries = await loadIndex();
  return entries.filter((e) => {
    if (e.imdbId !== imdbId || e.type !== type) return false;
    if (type === 'movie') return true;
    if (e.season != null && season != null && e.season !== season) return false;
    if (e.episode != null && episode != null && e.episode !== episode) return false;
    return true;
  });
}

async function getFileBuffer(entry) {
  const obj = await storage.getObject(entry.storageKey);
  if (!obj) throw new Error(`Pool file missing from storage: ${entry.storageKey}`);
  return obj.buffer;
}

async function listAll() {
  const entries = await loadIndex();
  return [...entries].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
}

async function deleteEntry(id) {
  const entries = await loadIndex(true);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  const [removed] = entries.splice(idx, 1);
  await saveIndex(entries);
  try {
    await storage.deleteObject(removed.storageKey);
  } catch (err) {
    // storage file already gone/inaccessible — index is still corrected, that's what matters
  }
  return true;
}

module.exports = { ingestUpload, findMatches, getFileBuffer, listAll, deleteEntry };
