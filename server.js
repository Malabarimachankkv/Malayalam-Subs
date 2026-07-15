const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');
const fileCache = require('./lib/fileCache');
const msone = require('./lib/msone');
const moviemirror = require('./lib/moviemirror');

const PORT = process.env.PORT || 7000;

const app = express();

// MSone (~300 pages) and Movie Mirror (100+ pages) build their catalogs as a
// background crawl the first time they're needed, since doing it live per
// request would be too slow. Triggering that here means it starts the
// instant the server boots, instead of waiting for someone's first live
// subtitle lookup to kick it off — shaves the wait down as much as code can.
// This does NOT fix a server that keeps going to sleep on a free host between
// uses (each sleep/wake starts the crawl over) — see README for the actual
// fix for that (a free uptime monitor pinging /manifest.json every few minutes).
msone.getIndexNonBlocking();
moviemirror.getIndexNonBlocking();

// Mounts /manifest.json, /subtitles/*, etc. (the standard Stremio addon protocol)
app.use(getRouter(addonInterface));

// Serves the actual subtitle files this addon downloads/extracts from MSone
// (e.g. /sub/ab12cd34ef.srt) so players never have to open MSone's raw links directly.
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

app.listen(PORT, () => {
  console.log(`MSone Malayalam Subtitles addon running on port ${PORT}`);
  console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
});
