// Shared title-matching logic used by all three subtitle sources.
//
// Previous versions scored candidates by "fraction of query words found,"
// which let something like "House of the Dragon" weakly match completely
// unrelated titles just for sharing common words like "the" or "of" — and
// then confidently serve that wrong title's subtitles. This version requires
// EVERY significant (non-stopword) word in the query to appear in the
// candidate title before it's considered a match at all. Year, if known, is
// used only to break ties between multiple otherwise-equal matches (e.g. a
// remake sharing the same base title).

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

/**
 * Returns a score > 0 only if every significant query word appears in the
 * candidate title. Adds a small bonus if the year is also present, purely
 * to rank same-title remakes/re-releases correctly relative to each other.
 */
function scoreCandidate(query, year, candidateTitle) {
  const qWords = significantWords(query);
  const cNorm = normalize(candidateTitle);
  if (!qWords.length || !cNorm) return 0;

  const allMatch = qWords.every((w) => cNorm.includes(w));
  if (!allMatch) return 0;

  let score = 1;
  if (year && candidateTitle.includes(String(year))) score += 0.5;
  return score;
}

module.exports = { normalize, scoreCandidate };
