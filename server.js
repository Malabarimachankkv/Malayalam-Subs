const express = require('express');
const multer = require('multer');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');
const fileCache = require('./lib/fileCache');
const moviemirror = require('./lib/moviemirror');
const subtitleCache = require('./lib/subtitleCache');
const pool = require('./lib/pool');
const { searchTitles } = require('./lib/cinemeta');
const { requireAdminAuth } = require('./lib/adminAuth');
const { renderAdminPage } = require('./lib/adminUi');

const PORT = process.env.PORT || 7000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB is generous for subtitle files/zips

const app = express();

// Movie Mirror (100+ pages) builds its catalog as a background crawl the
// first time it's needed, since doing it live per request would be too
// slow. Triggering that here means it starts the instant the server boots,
// instead of waiting for someone's first live subtitle lookup to kick it
// off — shaves the wait down as much as code can. This does NOT fix a server
// that keeps going to sleep on a free host between uses (each sleep/wake
// starts the crawl over) — see README for the actual fix for that (a free
// uptime monitor pinging /manifest.json every few minutes).
moviemirror.getIndexNonBlocking();

// Mounts /manifest.json, /subtitles/*, etc. (the standard Stremio addon protocol)
app.use(getRouter(addonInterface));

// Serves the actual subtitle files this addon downloads/extracts from these
// sites (e.g. /sub/ab12cd34ef.srt) so players never have to open a source
// site's raw links directly.
app.get('/sub/:file', (req, res) => {
  const key = req.params.file.replace(/\.[a-z0-9]+$/i, '');
  const item = fileCache.get(key);
  if (!item) {
    return res
      .status(404)
      .send('Subtitle link expired. Reopen the video/subtitle list in Stremio to fetch it again.');
  }
  res.setHeader('Content-Type', item.contentType);
  res.send(item.buffer);
});

// --- Manual subtitle pool admin dashboard -----------------------------
// Everything under /admin requires ADMIN_USER + ADMIN_PASSWORD (see
// lib/adminAuth.js). If those env vars aren't set, this whole area 503s.

app.get('/admin', requireAdminAuth, (req, res) => {
  res.type('html').send(renderAdminPage());
});

app.get('/admin/search', requireAdminAuth, async (req, res) => {
  try {
    const type = req.query.type === 'series' ? 'series' : 'movie';
    const results = await searchTitles(type, req.query.q || '');
    res.json(results);
  } catch (err) {
    console.error('admin search failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/list', requireAdminAuth, async (req, res) => {
  try {
    res.json(await pool.listAll());
  } catch (err) {
    console.error('admin list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/upload', requireAdminAuth, upload.single('file'), async (req, res) => {
  try {
    const { imdbId, title, type } = req.body;
    if (!imdbId || !type) return res.status(400).json({ error: 'Missing imdbId or type — pick a title from search first.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const season = req.body.season ? parseInt(req.body.season, 10) : null;
    const episode = req.body.episode ? parseInt(req.body.episode, 10) : null;

    const result = await pool.ingestUpload({
      imdbId,
      type,
      season: Number.isInteger(season) ? season : null,
      episodeOverride: Number.isInteger(episode) ? episode : null,
      title,
      originalFilename: req.file.originalname,
      buffer: req.file.buffer,
    });

    res.json({ stored: result.stored, skipped: result.skipped });
  } catch (err) {
    console.error('admin upload failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/delete/:id', requireAdminAuth, async (req, res) => {
  try {
    const ok = await pool.deleteEntry(req.params.id);
    res.json({ deleted: ok });
  } catch (err) {
    console.error('admin delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Purges one cached goat/moviemirror subtitle so the next request re-scrapes
// live instead of serving whatever's stored. For clearing out entries that
// got a bad response (HTML error/challenge page) cached before fetchFile.js
// started validating content — use this once per reported-broken title
// rather than wiping the whole cache.
// e.g. DELETE /admin/subtitle-cache/moviemirror/tt31436476?type=movie
app.delete('/admin/subtitle-cache/:source/:imdbId', requireAdminAuth, async (req, res) => {
  try {
    const { source, imdbId } = req.params;
    if (source !== 'goat' && source !== 'moviemirror') {
      return res.status(400).json({ error: 'source must be "goat" or "moviemirror"' });
    }
    const type = req.query.type === 'series' ? 'series' : 'movie';
    const season = req.query.season ? parseInt(req.query.season, 10) : null;
    const episode = req.query.episode ? parseInt(req.query.episode, 10) : null;
    await subtitleCache.deleteCached(source, imdbId, type, season, episode);
    res.json({ purged: true, source, imdbId, type, season, episode });
  } catch (err) {
    console.error('admin cache purge failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Malayalam Subtitles addon running on port ${PORT}`);
  console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
});
