/**
 * Standalone diagnostic — run with `node debug-moviemirror.js` from the repo
 * root (after `npm install`), with real network access. Prints exactly how
 * far the Movie Mirror lookup for a title gets, so we can see which stage
 * actually breaks instead of guessing.
 *
 * Usage: node debug-moviemirror.js "<title>" <year> <imdbId>
 *   e.g. node debug-moviemirror.js "Hope" 2026 tt27369017
 *        node debug-moviemirror.js "Shattered" 1991 tt0102900
 *
 * Add --wait-index to also wait for the full background listing crawl and
 * report whether the title is in it (slow: ~120 page fetches).
 */
const moviemirror = require('./lib/moviemirror');
const { scoreCandidate } = require('./lib/matching');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const waitIndex = process.argv.includes('--wait-index');
const query = args[0] || 'Hope';
const year = args[1] ? parseInt(args[1], 10) : 2026;
const imdbId = args[2] || 'tt27369017';

function log(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(value);
}

async function waitForIndex(maxWaitMs = 5 * 60 * 1000) {
  const start = Date.now();
  let index = moviemirror.getIndexNonBlocking();
  while (!index) {
    if (Date.now() - start > maxWaitMs) {
      throw new Error(`Index still not ready after ${maxWaitMs}ms — buildIndex() is hanging or failing silently.`);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
    index = moviemirror.getIndexNonBlocking();
  }
  console.log('');
  return index;
}

(async () => {
  try {
    console.log(`Query="${query}" year=${year} imdb=${imdbId}`);

    // Stage 1: the REST API search (what a brand-new post is found by).
    const api = await moviemirror.searchViaApi(query);
    log(`REST API search results (${api.length})`, api.map((r) => `${r.title}  ->  ${r.pageUrl}`).join('\n') || '(none)');

    // Stage 2: the recent set (category page 1 + homepage).
    const recent = await moviemirror.getRecentReleases();
    log(`Recent listing entries (${recent.length})`, recent.map((r) => r.title).join('\n') || '(none — category/homepage fetch failed?)');

    const pool = [...api, ...recent];
    const scored = pool
      .map((r) => ({ ...r, score: scoreCandidate(query, year, r.title) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    log(`Candidates scoring > 0 (from REST + recent)`, scored.slice(0, 10));

    if (scored.length) {
      const details = await moviemirror.extractReleaseDetails(scored[0].pageUrl);
      log(`Release page details for top candidate (${scored[0].pageUrl})`, details);
      if (!details.downloadUrl) {
        console.log('No download link found on the release page — the page markup changed again, or the fetch was blocked. Open the URL in a browser and compare against parseReleasePage() in lib/moviemirror.js.');
      }
    }

    if (waitIndex) {
      console.log('\nWaiting for the full Movie Mirror index to build (crawls ~120 pages)...');
      const index = await waitForIndex();
      log('Index size (movies+series entries)', index.length);
      const hits = index.filter((r) => scoreCandidate(query, year, r.title) > 0);
      log(`Index entries matching "${query}"`, hits);
    }

    // Full real call, to see what findSubtitleUrl actually returns end to end.
    const result = await moviemirror.findSubtitleUrl(query, year, imdbId);
    log('findSubtitleUrl() result', result);
    if (!result) {
      console.log('findSubtitleUrl() returned null — see the stages above for where it stopped.');
      process.exit(1);
    }

    console.log('\nAttempting fetchSubtitleFile()...');
    const file = await moviemirror.fetchSubtitleFile(result.url, null);
    log('fetchSubtitleFile() result', { ext: file.ext, contentType: file.contentType, bytes: file.buffer.length });
    console.log('\nSUCCESS — first 200 bytes of the file:');
    console.log(file.buffer.toString('utf8', 0, 200));
    process.exit(0);
  } catch (err) {
    console.error('\nDIAGNOSTIC CRASHED:', err);
    process.exit(1);
  }
})();
