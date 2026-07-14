const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');
const fileCache = require('./lib/fileCache');

const PORT = process.env.PORT || 7000;

const app = express();

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
