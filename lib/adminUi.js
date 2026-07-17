// Single self-contained HTML page for the upload dashboard. No build step,
// no framework — plain fetch() calls against the /admin/* JSON routes in
// server.js. Kept as one template string so there's nothing extra to deploy.
function renderAdminPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Subtitle Pool — Admin</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2.5rem; }
  label { display: block; font-weight: 600; margin-top: 14px; margin-bottom: 4px; font-size: 0.9rem; }
  input[type=text], select { width: 100%; padding: 8px; box-sizing: border-box; font-size: 0.95rem; }
  input[type=file] { margin-top: 4px; }
  button { margin-top: 16px; padding: 10px 18px; font-size: 0.95rem; cursor: pointer; }
  #searchResults { border: 1px solid #ddd; margin-top: 4px; max-height: 220px; overflow-y: auto; display: none; }
  #searchResults div { padding: 8px; cursor: pointer; border-bottom: 1px solid #eee; font-size: 0.9rem; }
  #searchResults div:hover { background: #f2f2f2; }
  #selectedTitle { margin-top: 8px; padding: 8px; background: #eef6ff; display: none; font-size: 0.9rem; }
  #status { margin-top: 14px; font-size: 0.9rem; white-space: pre-wrap; }
  #status.ok { color: #147a2e; }
  #status.err { color: #b3261e; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.85rem; }
  td, th { text-align: left; padding: 6px 4px; border-bottom: 1px solid #eee; }
  .del { color: #b3261e; cursor: pointer; background: none; border: none; padding: 2px 6px; font-size: 0.85rem; }
  .season-row { display: none; gap: 10px; }
  .season-row > div { flex: 1; }
</style>
</head>
<body>
<h1>Malayalam Subtitle Pool — Admin</h1>
<p>Use this to manually add a subtitle the addon couldn't fetch on its own. Search for the title first so it gets tagged with the correct IMDb id — that's how the addon matches it later.</p>

<label>1. Type</label>
<select id="type">
  <option value="movie">Movie</option>
  <option value="series">Series</option>
</select>

<label>2. Search for the title</label>
<input type="text" id="titleSearch" placeholder="e.g. The Furious" autocomplete="off" />
<div id="searchResults"></div>
<div id="selectedTitle"></div>

<div class="season-row" id="seasonRow" style="display:flex;">
  <div>
    <label>Season</label>
    <input type="text" id="season" placeholder="e.g. 3" />
  </div>
  <div>
    <label>Episode (leave blank if uploading a whole-season zip)</label>
    <input type="text" id="episode" placeholder="e.g. 5" />
  </div>
</div>

<label>3. Subtitle file (.srt, .vtt, or a .zip containing one or more of those)</label>
<input type="file" id="file" accept=".srt,.vtt,.ass,.ssa,.zip" />

<button id="uploadBtn">Upload</button>
<div id="status"></div>

<h2>Current pool</h2>
<table id="poolTable">
  <thead><tr><th>Title</th><th>IMDb</th><th>S/E</th><th>File</th><th>Added</th><th></th></tr></thead>
  <tbody></tbody>
</table>

<script>
let selected = null; // { imdbId, title, year, type }

const typeEl = document.getElementById('type');
const seasonRow = document.getElementById('seasonRow');
function syncSeasonRow() {
  seasonRow.style.display = typeEl.value === 'series' ? 'flex' : 'none';
}
typeEl.addEventListener('change', syncSeasonRow);
syncSeasonRow();

const searchInput = document.getElementById('titleSearch');
const resultsBox = document.getElementById('searchResults');
const selectedBox = document.getElementById('selectedTitle');
let searchTimer = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value;
  selected = null;
  selectedBox.style.display = 'none';
  if (!q.trim()) { resultsBox.style.display = 'none'; return; }
  searchTimer = setTimeout(async () => {
    const res = await fetch('/admin/search?type=' + typeEl.value + '&q=' + encodeURIComponent(q));
    const data = await res.json();
    resultsBox.innerHTML = '';
    if (!data.length) {
      resultsBox.style.display = 'none';
      return;
    }
    data.forEach((r) => {
      const div = document.createElement('div');
      div.textContent = r.title + (r.year ? ' (' + r.year + ')' : '') + ' — ' + r.imdbId;
      div.addEventListener('click', () => {
        selected = r;
        selectedBox.style.display = 'block';
        selectedBox.textContent = 'Selected: ' + r.title + (r.year ? ' (' + r.year + ')' : '') + ' — ' + r.imdbId;
        resultsBox.style.display = 'none';
        searchInput.value = r.title;
      });
      resultsBox.appendChild(div);
    });
    resultsBox.style.display = 'block';
  }, 350);
});

document.getElementById('uploadBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('status');
  statusEl.className = '';
  const fileEl = document.getElementById('file');

  if (!selected) {
    statusEl.className = 'err';
    statusEl.textContent = 'Pick a title from the search results first.';
    return;
  }
  if (!fileEl.files.length) {
    statusEl.className = 'err';
    statusEl.textContent = 'Choose a file to upload.';
    return;
  }

  const form = new FormData();
  form.append('file', fileEl.files[0]);
  form.append('imdbId', selected.imdbId);
  form.append('title', selected.title);
  form.append('type', typeEl.value);
  if (typeEl.value === 'series') {
    form.append('season', document.getElementById('season').value || '');
    form.append('episode', document.getElementById('episode').value || '');
  }

  statusEl.textContent = 'Uploading…';
  try {
    const res = await fetch('/admin/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    statusEl.className = 'ok';
    statusEl.textContent = 'Stored ' + data.stored.length + ' file(s).' +
      (data.skipped.length ? ' Skipped (no episode number found in filename): ' + data.skipped.join(', ') : '');
    fileEl.value = '';
    loadPool();
  } catch (err) {
    statusEl.className = 'err';
    statusEl.textContent = 'Error: ' + err.message;
  }
});

async function loadPool() {
  const res = await fetch('/admin/list');
  const items = await res.json();
  const tbody = document.querySelector('#poolTable tbody');
  tbody.innerHTML = '';
  items.forEach((item) => {
    const tr = document.createElement('tr');
    const se = item.type === 'series' ? [item.season, item.episode].filter((x) => x != null).map((x, i) => (i === 0 ? 'S' + x : 'E' + x)).join('') : '—';
    tr.innerHTML = '<td>' + (item.title || '') + '</td>' +
      '<td>' + item.imdbId + '</td>' +
      '<td>' + (se || '—') + '</td>' +
      '<td>' + item.originalFilename + '</td>' +
      '<td>' + new Date(item.addedAt).toLocaleDateString() + '</td>' +
      '<td><button class="del" data-id="' + item.id + '">delete</button></td>';
    tbody.appendChild(tr);
  });
  document.querySelectorAll('.del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this subtitle from the pool?')) return;
      await fetch('/admin/delete/' + btn.dataset.id, { method: 'DELETE' });
      loadPool();
    });
  });
}
loadPool();
</script>
</body>
</html>`;
}

module.exports = { renderAdminPage };
