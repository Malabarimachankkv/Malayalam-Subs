const crypto = require('crypto');
const NodeCache = require('node-cache');
const AdmZip = require('adm-zip');
const drive = require('./googleDrive');
const { extractEpisodeNumber, SUB_EXTENSIONS, CONTENT_TYPES } = require('./fetchFile');

// The whole pool "index" (which subtitle belongs to which IMDb id/season/
// episode) lives as one JSON file on Drive, alongside the actual subtitle
// files, inside GDRIVE_FOLDER_ID. Nothing is ever written to local disk, so
// Render's free-tier wiping the disk on every sleep/redeploy doesn't matter —
// Drive is the only source of truth. A short in-memory cache just avoids
// hitting the Drive API on every single subtitle lookup.
const INDEX_FILENAME = 'pool-index.json';
const indexCache = new NodeCache({ stdTTL: 120 }); // 2 min

let indexFileId = null; // cached Drive file id for pool-index.json, once known

async function getIndexFileId() {
  if (indexFileId) return indexFileId;
  const existing = await drive.findFileByName(INDEX_FILENAME);
  if (existing) indexFileId = existing.id;
  return indexFileId;
}

async function loadIndex(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = indexCache.get('index');
    if (cached) return cached;
  }
  const fileId = await getIndexFileId();
  if (!fileId) {
    indexCache.set('index', []);
    return [];
  }
  const buffer = await drive.downloadFile(fileId);
  let entries = [];
  try {
    entries = JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    console.error('pool: pool-index.json on Drive is corrupt:', err.message);
  }
  indexCache.set('index', entries);
  return entries;
}

async function saveIndex(entries) {
  const buffer = Buffer.from(JSON.stringify(entries, null, 2));
  const fileId = await getIndexFileId();
  if (fileId) {
    await drive.updateFile(fileId, buffer, 'application/json');
  } else {
    indexFileId = await drive.uploadFile(INDEX_FILENAME, buffer, 'application/json');
  }
  indexCache.set('index', entries);
}

async function storeOne({ imdbId, type, season, episode, title, originalFilename, buffer, ext }) {
  const id = crypto.randomBytes(6).toString('hex');
  const driveFilename = `${id}${ext}`;
  const mimeType = CONTENT_TYPES[ext] || 'application/octet-stream';
  const driveFileId = await drive.uploadFile(driveFilename, buffer, mimeType);

  const entries = await loadIndex(true);
  const entry = {
    id,
    imdbId,
    type,
    season: season || null,
    episode: episode || null,
    title: title || null,
    originalFilename,
    driveFileId,
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
    // Season bundle: one file per episode. Upload sequentially (not
    // Promise.all) — Drive's API is happier with modest concurrency, and we
    // need loadIndex/saveIndex calls inside storeOne to not race each other.
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
  return drive.downloadFile(entry.driveFileId);
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
    await drive.deleteFile(removed.driveFileId);
  } catch (err) {
    // Drive file already gone/inaccessible — index is still corrected, that's what matters
  }
  return true;
}

module.exports = { ingestUpload, findMatches, getFileBuffer, listAll, deleteEntry };
