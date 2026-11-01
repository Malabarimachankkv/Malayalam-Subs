/**
 * Prints the Malayalam synopsis the catalog would show for a release page,
 * so you can check the extraction against the site without deploying.
 *
 * Usage (from the repo root, after `npm install`):
 *   node debug-synopsis.js https://malayalamsubtitles.in/release/ek-villain-returns-2022/
 *   node debug-synopsis.js https://moviemirrorsubtitles.com/the-cycle-2026/
 *   node debug-synopsis.js --mm-list        # first page of Movie Mirror · Latest, via the REST excerpt
 */
const goat = require('./lib/goat');
const moviemirror = require('./lib/moviemirror');

(async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Give a release page URL, or --mm-list');
    process.exit(1);
  }
  if (arg === '--mm-list') {
    const { posts } = await moviemirror.listPosts({ perPage: 10 });
    for (const p of posts) {
      console.log(`\n=== ${p.title} ===\n${p.synopsis || '(no synopsis in excerpt)'}`);
    }
    process.exit(0);
  }
  const mod = /malayalamsubtitles\.in/.test(arg) ? goat : moviemirror;
  const info = await mod.getPageInfo(arg);
  console.log('IMDb id :', info.imdbId || '(none)');
  console.log('Synopsis:', info.synopsis ? `\n${info.synopsis}` : '(none found)');
  process.exit(0);
})().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
