/**
 * Standalone diagnostic — run with `node debug-moviemirror.js` from the repo
 * root (after `npm install`), with real network access. Prints exactly how
 * far the Movie Mirror lookup for "Hokum" (2026) gets, so we can see which
 * stage actually breaks instead of guessing.
 *
 * Usage: node debug-moviemirror.js "Hokum" 2026 tt35672862
 */
const moviemirror = require('./lib/moviemirror');
const { scoreCandidate } = require('./lib/matching');

const [, , queryArg, yearArg, imdbArg] = process.argv;
const query = queryArg || 'Hokum';
const year = yearArg ? parseInt(yearArg, 10) : 2026;
const imdbId = imdbArg || 'tt35672862';

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
  console.log(''); // newline after dots
  return index;
}

(async () => {
  try {
    console.log(`Waiting for Movie Mirror index to build (this crawls ~100+ pages, can take a minute)...`);
    const index = await waitForIndex();

    log('Index size (total movies+series entries found)', index.length);

    if (index.length === 0) {
      console.log('Index built but came back EMPTY — the crawl itself is failing (check for errors printed above, e.g. axios/network errors per page).');
      process.exit(1);
    }

    // Does the index contain anything with "hokum" in the title at all?
    const hokumEntries = index.filter((r) => r.title.toLowerCase().includes('hokum'));
    log(`Entries with "hokum" in the title (raw, case-insensitive)`, hokumEntries);

    if (!hokumEntries.length) {
      console.log('Hokum is NOT in the crawled index at all. The crawl is either:');
      console.log('  - not reaching the page it is listed on (check maxPage detection / concurrency failures per page), or');
      console.log('  - excluding it via isReleaseLink/NON_RELEASE_PATH for some reason specific to its real href.');
      console.log('Try increasing logging inside crawlSection()/fetchListingPage() to see which pages failed.');
      process.exit(1);
    }

    // Now run the exact same scoring the real findSubtitleUrl() uses.
    const scored = index
      .map((r) => ({ ...r, score: scoreCandidate(query, year, r.title) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);

    log(`Candidates scoring > 0 for query="${query}" year=${year}`, scored.slice(0, 10));

    if (!scored.length) {
      console.log('Hokum IS in the index, but scoreCandidate() never scores it above 0 for this query/year.');
      console.log('Print the raw title text above and compare word-by-word against significantWords() in lib/matching.js.');
      process.exit(1);
    }

    // Full real call, to see what findSubtitleUrl actually returns end to end.
    const result = await moviemirror.findSubtitleUrl(query, year, imdbId);
    log('findSubtitleUrl() result', result);

    if (!result) {
      console.log('Candidates scored fine, but findSubtitleUrl() still returned null — likely extractReleaseDetails() failed to pull a downloadUrl/imdbId from the release page (check for logged errors above), or the IMDb id never matched any of the top 5 candidates and none had a usable downloadUrl either.');
      process.exit(1);
    }

    // Finally, try the actual file download with the (now-fixed) per-source referer.
    console.log('\nAttempting fetchSubtitleFile()...');
    const file = await moviemirror.fetchSubtitleFile(result.url, null);
    log('fetchSubtitleFile() result', { ext: file.ext, contentType: file.contentType, bytes: file.buffer.length });
    console.log('\nSUCCESS — first 200 bytes of the file:');
    console.log(file.buffer.toString('utf8', 0, 200));
  } catch (err) {
    console.error('\nDIAGNOSTIC CRASHED:', err);
    process.exit(1);
  }
})();
