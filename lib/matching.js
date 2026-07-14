// Shared title-matching logic used by all three subtitle sources.
//
// v1 scored candidates by "fraction of query words found," which let
// something like "House of the Dragon" weakly match completely unrelated
// titles just for sharing common words like "the" — and then confidently
// served that wrong title's subtitles.
//
// v2 required EVERY significant word to appear as an exact substring. That
// fixed the false-positive problem, but broke on real-world typos in these
// volunteer-run catalogs (e.g. one site's actual listing literally reads
// "House of the GRAGON" instead of "Dragon") — exact matching rejected
// perfectly good releases over a single misspelled letter.
//
// v3 (this version) requires every significant query word to fuzzy-match a
// word in the candidate title, allowing small typos (via edit distance)
// while still rejecting words that aren't actually related at all.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'to', 'for', 'is', 'it',
  'with', 'part', 'movie', 'film',
]);

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function significantWords(query) {
  const words = normalize(query).split(' ').filter(Boolean);
  const filtered = words.filter((w) => !STOPWORDS.has(w));
  return filtered.length ? filtered : words; // don't strip everything away
}

// Small dependency-free Levenshtein (edit distance) implementation.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

// A query word "found" in a candidate title if it appears as an exact
// substring (handles plurals, "predator" inside "predators", etc.) OR
// fuzzy-matches some word in the title within a small typo tolerance
// (roughly one typo per 4 characters, minimum 1).
function wordFound(queryWord, candidateWords, candidateNorm) {
  if (candidateNorm.includes(queryWord)) return true;
  const tolerance = Math.max(1, Math.floor(queryWord.length / 4));
  return candidateWords.some((cw) => {
    // Only compare words of roughly similar length; avoids "a" fuzzy-matching everything.
    if (Math.abs(cw.length - queryWord.length) > tolerance + 1) return false;
    return editDistance(queryWord, cw) <= tolerance;
  });
}

/**
 * Returns a score > 0 only if every significant query word is found (exactly
 * or via small typo tolerance) in the candidate title. Adds a small bonus if
 * the year is also present, used to rank same-title remakes/re-releases
 * correctly relative to each other.
 */
function scoreCandidate(query, year, candidateTitle) {
  const qWords = significantWords(query);
  const cNorm = normalize(candidateTitle);
  if (!qWords.length || !cNorm) return 0;

  const cWords = cNorm.split(' ').filter(Boolean);
  const allMatch = qWords.every((w) => wordFound(w, cWords, cNorm));
  if (!allMatch) return 0;

  let score = 1;
  if (year && candidateTitle.includes(String(year))) score += 0.5;
  return score;
}

module.exports = { normalize, scoreCandidate };
