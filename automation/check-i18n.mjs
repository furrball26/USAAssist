#!/usr/bin/env node
/*
 * The un-extracted-string ratchet.
 *
 * A half-translated app is worse than an untranslated one: a Spanish reader
 * who gets Spanish headings and English legal copy has been told this site
 * speaks their language, and then handed the part that decides their claim in
 * a language they may not read. So the string layer is only worth building if
 * something can prove it is COMPLETE — hence this.
 *
 * It finds user-facing text still baked into the app as a bare literal, rather
 * than coming through t(). It does not regex the JSX: it transpiles the app
 * block exactly as build.mjs does and walks the React.createElement() calls
 * that come out, which are far more regular than the source. Two positions
 * count as user-facing:
 *
 *   - CHILDREN — every string argument from the third onward, which is what a
 *     JSX text node compiles to.
 *   - TEXT-BEARING PROPS — aria-label, placeholder, title, alt: strings a
 *     reader hears or sees even though they are not text nodes. A missed
 *     aria-label is the quietest possible failure, since only a screen-reader
 *     user ever meets it.
 *
 * The count is a RATCHET. It was built while index.dev.html still held hundreds
 * of these and they came out screen by screen; the build failed if the number
 * went up, which is what kept the migration from sliding backwards while it was
 * half-done.
 *
 * THE BASELINE IS NOW NOUGHT, so the ratchet has become a plain gate: any new
 * user-facing string that does not go through t() fails the build. Nothing here
 * changes for that — a baseline of 0 is just the last tightening — but it means
 * the next person to add copy will be told at once rather than discovering it
 * when a translation lands half-finished.
 *
 * Run: node automation/check-i18n.mjs            (check against the baseline)
 *      node automation/check-i18n.mjs --list     (print what is left)
 *      node automation/check-i18n.mjs --update   (write the baseline down)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE = ROOT + 'automation/i18n-baseline.json';

const dev = readFileSync(ROOT + 'index.dev.html', 'utf8');
const OPEN = '<script type="text/babel" data-presets="react">';
const start = dev.indexOf(OPEN);
if (start < 0) { console.error('i18n: dev babel <script> open tag not found'); process.exit(1); }
const bodyStart = start + OPEN.length;
const end = dev.indexOf('</script>', bodyStart);
const jsx = dev.slice(bodyStart, end);
// The same transform build.mjs runs, so what this scans is what actually ships.
const code = transformSync(jsx, {
  loader: 'jsx', jsx: 'transform',
  jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
  legalComments: 'none',
}).code;

const TEXT_PROPS = new Set(['aria-label', 'placeholder', 'title', 'alt', 'aria-description']);
const CALL = 'React.createElement(';

/* A character walk rather than a parser. It has to know about everything that
   can contain a bracket, comma or quote WITHOUT meaning one:

     - strings and template literals, so a paren inside one does not move the
       argument index,
     - comments, because an apostrophe in "the reader's own" opens a string
       that then swallows the rest of the file — this is what made the first
       version of this scanner report nought strings in an app with hundreds,
     - regex literals, whose brackets are not depth.

   Nothing else in the compiled output nests. The regex test is the usual
   heuristic: a `/` can only start a literal where a value cannot precede it,
   so an identifier, a closing bracket or a digit before it means division. */
function scan(src) {
  const found = [];
  const stack = [];           // { depth, argIndex } per createElement call
  let depth = 0;
  let i = 0;

  /* Escapes are DECODED, not passed through. esbuild writes an em dash as
     \\u2014, and a scanner that reports "u2014 the same amount" is showing the
     author a string that does not exist and will never match the catalogue. */
  const SIMPLE = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
  const readString = (at) => {
    const q = src[at];
    if (q !== '"' && q !== "'" && q !== '`') return null;
    let j = at + 1, out = '';
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') {
        const e = src[j + 1];
        if (e === 'u' && src[j + 2] === '{') {
          const close = src.indexOf('}', j + 3);
          out += String.fromCodePoint(parseInt(src.slice(j + 3, close), 16)); j = close + 1; continue;
        }
        if (e === 'u') { out += String.fromCharCode(parseInt(src.substr(j + 2, 4), 16)); j += 6; continue; }
        if (e === 'x') { out += String.fromCharCode(parseInt(src.substr(j + 2, 2), 16)); j += 4; continue; }
        out += Object.prototype.hasOwnProperty.call(SIMPLE, e) ? SIMPLE[e] : e; j += 2; continue;
      }
      if (c === q) return { value: out, next: j + 1 };
      out += c; j++;
    }
    return null;
  };

  // The last token that was not whitespace — tells a regex from a division.
  let prev = '';
  const canStartRegex = () => !/[A-Za-z0-9_$)\]]$/.test(prev);

  /* Is the string spanning [from, to) one side of an equality test? Looks at
     the non-whitespace text immediately before it and immediately after it. */
  const isComparisonOperand = (from, to) => {
    const before = src.slice(Math.max(0, from - 8), from).replace(/\s+$/, '');
    if (/[=!]==?$/.test(before)) return true;
    const after = src.slice(to, to + 8).replace(/^\s+/, '');
    return /^[=!]==?/.test(after);
  };

  while (i < src.length) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const close = src.indexOf('*/', i + 2); i = close < 0 ? src.length : close + 2; continue; }
    if (c === '/' && canStartRegex()) {
      let j = i + 1, inClass = false, closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;                  // unterminated: it was division
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) { while (/[gimsuyd]/.test(src[j] || '')) j++; prev = '/'; i = j; continue; }
    }

    if (c === '"' || c === "'" || c === '`') {
      const s = readString(i);
      if (!s) { i++; continue; }
      const top = stack[stack.length - 1];
      /* A child: an argument from the third onward, at this call's own depth.

         ...unless it is a COMPARISON OPERAND. An argument can be an expression
         rather than a text node, and `wage.winner.key === "city"` puts "city"
         in exactly the same position a text node occupies. Six such literals —
         "city", "home", "wage", "non", "number", "harassment", all of them
         screen ids, topic prefixes or typeof tests — were being reported as
         untranslated copy, which is how a checker loses its authority.
         A ternary's RESULT is still counted: those are real text. */
      if (top && depth === top.depth && top.argIndex >= 2 && !isComparisonOperand(i, s.next)) {
        found.push({ kind: 'child', value: s.value });
      }
      // A prop: inside the props object, which sits one level deeper. Only the
      // VALUE half counts, and only for a key that a reader actually meets.
      if (top && depth === top.depth + 1 && top.argIndex === 1) {
        const before = src.slice(Math.max(0, i - 220), i);
        const m = /(?:^|[{,])\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*$/.exec(before);
        const key = m && (m[1] || m[2] || m[3]);
        if (key && TEXT_PROPS.has(key)) found.push({ kind: key, value: s.value });
      }
      prev = '"'; i = s.next; continue;
    }

    if (!/\s/.test(c)) prev = c;

    if (c === '(') {
      if (src.startsWith(CALL, i - CALL.length + 1)) stack.push({ depth: depth + 1, argIndex: 0 });
      depth++; i++; continue;
    }
    if (c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      const top = stack[stack.length - 1];
      if (top && top.depth === depth) stack.pop();
      depth--; i++; continue;
    }
    if (c === ',') {
      const top = stack[stack.length - 1];
      if (top && depth === top.depth) top.argIndex++;
      i++; continue;
    }
    i++;
  }
  return found;
}

/* What counts as text a reader reads. Punctuation, arrows, separators and the
   whitespace JSX leaves between elements are not translatable content, and
   listing them as debt would bury the real strings. A word is two letters
   next to each other — enough to clear the arrows and dots, and to keep "of". */
const isProse = (v) => {
  const t = v.trim();
  if (t.length < 2) return false;
  if (!/[A-Za-z]{2}/.test(t)) return false;
  if (/^[a-z-]+:[^;]*;/.test(t)) return false;              // a CSS declaration
  if (/^https?:\/\//.test(t)) return false;                 // a URL
  return true;
};

/* ── Prose held in DATA, which the walk above cannot see ───────────────────
   LAW_CATEGORIES carries `label: 'Pay & overtime'` and the JSX renders it as
   {cat.label} — an expression, not a literal, so the createElement walk finds
   nothing and would happily report nought while six category names, seventy
   topic labels and every wizard question sat in English forever.

   So the source is also read for the property names that carry prose. A value
   that is already a dotted catalogue key ('entry.sit.home.label') has been
   migrated; a value that is a sentence has not. */
const PROSE_KEYS = ['label', 'blurb', 'desc', 'summary', 'help', 'note', 'covers',
                    'doneTitle', 'qDisclaimer', 'tag', 'heading', 'title', 'q'];
/* A value that is already a catalogue key, or the literal PREFIX of one built
   by concatenation — `label: 'entry.sit.' + k + '.label'` puts 'entry.sit.' in
   a label position, and reporting that as untranslated copy is noise. */
const looksLikeKey = (v) => /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]*)+$/.test(v.trim());
const inData = [];
for (const key of PROSE_KEYS) {
  // One quoted string, either quote style, escapes allowed: the backreference
  // keeps an apostrophe inside a double-quoted value from ending the match.
  const re = new RegExp('(?:^|[{,\\s])' + key + '\\s*:\\s*([\'"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1', 'g');
  for (const m of jsx.matchAll(re)) {
    const v = m[2];
    if (!v || looksLikeKey(v) || !isProse(v)) continue;
    inData.push({ kind: 'data:' + key, value: v });
  }
}

/* ── The other half: every key used must exist, exactly once ───────────────
   The ratchet proves strings have LEFT the JSX. This proves they landed
   somewhere real. A t('typo') renders the key itself on screen, which is loud
   in review and harmless to a reader — but only if something fails the build
   when it happens, or it ships.

   Keys are read out of the SOURCE text rather than by evaluating the object,
   because a duplicate key in a JS object literal is silently the last one to
   win: two entries for 'when.heading' would leave one dead and the other
   quietly overriding it, with no error anywhere. */
const catBlock = (() => {
  const at = jsx.indexOf('const STRINGS = {');
  if (at < 0) return null;
  const enAt = jsx.indexOf('en: {', at);
  let d = 0;
  const i = jsx.indexOf('{', enAt);
  for (let j = i; j < jsx.length; j++) {
    if (jsx[j] === '{') d++;
    else if (jsx[j] === '}') { d--; if (d === 0) return jsx.slice(i + 1, j); }
  }
  return null;
})();
if (catBlock === null) { console.error('i18n FAILED: could not find the STRINGS.en catalogue'); process.exit(1); }

const defined = [];
for (const m of catBlock.matchAll(/^\s*'([^']+)'\s*:/gm)) defined.push(m[1]);
const dupes = defined.filter((k, i) => defined.indexOf(k) !== i);
if (dupes.length) {
  console.error('i18n FAILED: duplicate catalogue keys (the later one silently wins): ' + [...new Set(dupes)].join(', '));
  process.exit(1);
}
const definedSet = new Set(defined);

// Only literal keys can be checked. t(s.label) and t('topic.' + k) are resolved
// at runtime; the suites that render those screens are what cover them.
const usedLiteral = [...jsx.matchAll(/\bt\(\s*'([^']+)'/g)].map(m => m[1]);
const missing = [...new Set(usedLiteral)].filter(k => !definedSet.has(k));
if (missing.length) {
  console.error('i18n FAILED: used but not in the catalogue: ' + missing.join(', '));
  process.exit(1);
}

const all = scan(code).filter(f => isProse(f.value)).concat(inData);
// One entry per distinct string: the same label in three places is one thing
// to translate, not three.
const distinct = [...new Map(all.map(f => [f.kind + ' | ' + f.value.trim(), f])).keys()].sort();

const arg = process.argv[2];
if (arg === '--list') {
  distinct.forEach(d => console.log(d));
  console.log('\n' + distinct.length + ' distinct un-extracted strings (' + all.length + ' occurrences)');
  process.exit(0);
}
if (arg === '--update') {
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Un-extracted user-facing strings still baked into index.dev.html. The build fails if this goes UP. Lower it as screens move to t(); the target is 0. See automation/check-i18n.mjs.',
    distinct: distinct.length,
    occurrences: all.length,
  }, null, 2) + '\n');
  console.log('baseline written: ' + distinct.length + ' distinct / ' + all.length + ' occurrences');
  process.exit(0);
}

let base;
try { base = JSON.parse(readFileSync(BASELINE, 'utf8')); }
catch (e) { console.error('i18n: no baseline — run `node automation/check-i18n.mjs --update`'); process.exit(1); }

if (distinct.length > base.distinct) {
  console.error(`i18n FAILED: ${distinct.length} un-extracted strings, up from ${base.distinct}.`);
  console.error('   New user-facing copy must go through t(). Run --list to see what is left.');
  process.exit(1);
}
if (distinct.length < base.distinct) {
  console.error(`i18n FAILED: down to ${distinct.length} from ${base.distinct} — lower the baseline with --update.`);
  console.error('   The ratchet only holds if it is tightened when it can be.');
  process.exit(1);
}
console.log(`i18n: ${defined.length} strings in the catalogue, ${distinct.length} still to extract (baseline held; target 0)`);
