// Pulls the Malayalam synopsis out of a release page (or a WordPress
// excerpt) so catalog rows can describe a title in the language the sites
// write in, instead of the generic "Malayalam subtitles from …" line.
//
// Neither site marks the synopsis up with a heading or class we could rely
// on — Team GOAT prints it as plain paragraphs after the "ഡൗൺലോഡുകൾ" label,
// Movie Mirror as the post body (also exposed as the REST `excerpt`). So
// this looks for the longest run of consecutive paragraphs that are mostly
// Malayalam script and are not site boilerplate (the Team GOAT tagline,
// disclaimer and "join our group" line are Malayalam too, but every one of
// them names the team or the site).

const cheerio = require('cheerio');

const MALAYALAM_CHAR = /[ഀ-ൿ]/g;
const MIN_PARAGRAPH = 40; // chars; the metadata table cells are far shorter
const MAX_LENGTH = 1200; // Stremio shows ~4 lines; keep it a synopsis, not an essay

// Paragraphs that are about the team/site rather than the film.
const BOILERPLATE = /team\s*goat|ടീം\s*ഗോട്ട്|movie\s*mirror|മൂവി\s*മിറർ|അംഗമാകൂ|പരിഭാഷകൾക്കായി|പുതുക്കിയത്|all rights reserved|telegram|facebook|whatsapp|disclaimer|pirat|പൈറ|copyright|subscribe|related/i;

function malayalamRatio(text) {
  const letters = text.replace(/[\s\d\p{P}]/gu, '');
  if (!letters.length) return 0;
  return (letters.match(MALAYALAM_CHAR) || []).length / letters.length;
}

function clean(text) {
  return (text || '')
    .replace(/[­​-‏‪-‮⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSynopsisParagraph(text) {
  return text.length >= MIN_PARAGRAPH && malayalamRatio(text) >= 0.4 && !BOILERPLATE.test(text);
}

/**
 * Longest run of consecutive qualifying paragraphs, joined with blank
 * lines; null when the page has none.
 */
function pickRun(paragraphs) {
  let best = [];
  let run = [];
  for (const p of paragraphs) {
    if (!p) continue; // an empty <p> between plot paragraphs doesn't end the run
    if (isSynopsisParagraph(p)) {
      run.push(p);
    } else {
      if (run.join('').length > best.join('').length) best = run;
      run = [];
    }
  }
  if (run.join('').length > best.join('').length) best = run;
  if (!best.length) return null;
  let out = best.join('\n\n');
  if (out.length > MAX_LENGTH) {
    const cut = out.lastIndexOf(' ', MAX_LENGTH);
    out = `${out.slice(0, cut > MAX_LENGTH / 2 ? cut : MAX_LENGTH).trim()}…`;
  }
  return out;
}

/**
 * Synopsis from a release page's HTML. Reads <p> elements outside the
 * chrome (header/nav/footer/tables); if the theme doesn't use <p> for body
 * text, falls back to leaf <div>/<span> elements.
 */
function fromHtml(html) {
  if (!html) return null;
  // .text() drops <br> entirely, which would glue "തന്റെ<br />പിതാവ്" into
  // one word; make line breaks spaces first.
  const $ = cheerio.load(html.replace(/<br\s*\/?>/gi, ' '));
  $('script, style, noscript, header, nav, footer, table, form, aside').remove();

  const texts = (sel) => $(sel).map((_, el) => clean($(el).text())).get();
  let result = pickRun(texts('p'));
  if (!result) {
    // Leaf blocks only, so a wrapper div's concatenated text doesn't win.
    const leaves = $('div, span, li').filter((_, el) => $(el).children('div, p, ul, ol, section, article').length === 0);
    result = pickRun(leaves.map((_, el) => clean($(el).text())).get());
  }
  return result;
}

/** Synopsis from a WordPress `excerpt.rendered` / `content.rendered` snippet. */
function fromWpHtml(rendered) {
  if (!rendered) return null;
  // Excerpts use <br /> rather than separate <p>s for line breaks; treat a
  // double break as a paragraph boundary and a single one as a space.
  const html = rendered.replace(/(<br\s*\/?>\s*){2,}/gi, '</p><p>').replace(/<br\s*\/?>/gi, ' ');
  const $ = cheerio.load(`<div id="x">${html}</div>`);
  const paragraphs = $('#x p').length ? $('#x p').map((_, el) => clean($(el).text())).get() : [clean($('#x').text())];
  return pickRun(paragraphs);
}

module.exports = { fromHtml, fromWpHtml, pickRun, isSynopsisParagraph, malayalamRatio };
