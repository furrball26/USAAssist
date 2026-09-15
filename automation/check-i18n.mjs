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

/* ── The scanner proves itself before it is believed ───────────────────────
   A checker that reports nothing is indistinguishable from a checker that
   FINDS nothing, and this one has been broken four separate ways during its
   short life — an apostrophe in a comment swallowing the file, template holes
   blanked as if they were text, a regex that consumed the brace it needed to
   count depth, a strip pattern that wanted `src:url(` where the file says
   `src: url(`. Every one of those failed silently and plausibly.

   So: run the walk against a fixture whose answer is known, and refuse to
   grade anything if it comes back wrong. A baseline of 0 only means something
   if the instrument can still find a 1.

   Each line of the fixture is a real failure that happened. */
{
  /* TWO apostrophes in comments, with a real call BETWEEN them. That is what
     the live failure looked like: esbuild keeps line comments inside the
     catalogue object, one of them reads "so it doesn't just read as a
     courthouse", the next "so it's replaced rather than kept" — and without
     comment handling the first apostrophe opens a string that the second one
     closes, eating every call in between.

     A single apostrophe proves nothing, because an unterminated string is
     abandoned and the walk carries on. The first version of this fixture had
     exactly one, and deleting the comment handling still passed it while the
     real app silently fell from 22 findings to nought. */
  const FIXTURE = [
    "// the reader's own question, and a /* not-a-comment inside one",
    'const A = () => /* @__PURE__ */ React.createElement("p", {',
    '  style: css("margin:0"), "aria-label": "Close this panel", title: "ignored"',
    '}, "Where do you work?", n, " left");',
    "// ...and it's closed here, which is what makes the gap swallow A",
    // a regex holding brackets and a slash must not be read as structure
    'const C = /[(){}"]\\/+/g;',
    // a comparison operand sits exactly where a text node does
    'const B = () => React.createElement("p", null, x.key === "city" ? "Yes it is" : "No");',
    // a template hole is code; the literal around it is copy
    'const D = () => React.createElement("p", null, `pad ${MAP_PAD} end`);',
  ].join('\n');

  const got = scan(FIXTURE).filter(f => isProse(f.value)).map(f => f.kind + '|' + f.value.trim());
  const want = [
    'aria-label|Close this panel',
    'title|ignored',
    'child|Where do you work?',
    'child|left',
    // BOTH arms of the ternary are text. Only the operand being compared
    // against ("city") is excluded; what the branch RESOLVES to is copy.
    'child|Yes it is',
    'child|No',
    // A template literal in child position is un-extracted copy like any
    // other — `{`Hello ${name}`}` is a sentence a reader reads, and it is
    // reported so it gets a catalogue key with a named hole.
    'child|pad ${MAP_PAD} end',
  ];
  const missing = want.filter(w => !got.includes(w));
  const surplus = got.filter(g => !want.includes(g));
  if (missing.length || surplus.length) {
    console.error('i18n FAILED: the scanner does not agree with its own fixture, so nothing it reports can be trusted.');
    missing.forEach(m => console.error('   expected but not found: ' + m));
    surplus.forEach(x => console.error('   found but not expected: ' + x));
    process.exit(1);
  }
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

/* ── Placeholders must match what the call site passes ─────────────────────
   A string carrying {state} that is called with no arguments renders the
   literal "{state}" to a reader — t() substitutes nothing and leaves the hole
   sitting in the sentence. The reverse, an argument passed for a placeholder
   the string does not have, is silently dropped, which is how a value quietly
   stops appearing when copy is reworded.

   Neither shows up in a test unless a suite happens to assert the exact
   sentence, and most sentences are not asserted. So both are checked here,
   across every t('literal', {...}) call in the app.

   Only calls with a literal key can be checked; t(cat.label) and
   t('topic.' + k) resolve at runtime and the rendering suites cover those. */
{
  const placeholdersOf = (s) => new Set([...String(s).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(m => m[1]));
  const problems = [];

  // Walk every t( ... ) call, balancing brackets so a nested t() or an object
  // argument does not end the match early.
  for (const m of jsx.matchAll(/\bt\(\s*'([^']+)'/g)) {
    const key = m[1];
    if (!definedSet.has(key)) continue;           // already reported above
    let i = m.index + m[0].length;
    while (/\s/.test(jsx[i])) i++;
    const wants = placeholdersOf(defined.includes(key) ? catBlock.match(
      new RegExp("'" + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'"))?.[1] ?? '' : '');

    if (jsx[i] !== ',') {                          // a bare t('key')
      if (wants.size) problems.push(key + ': string has {' + [...wants].join('}, {') + '} but the call passes nothing');
      continue;
    }
    // Read the argument object, balancing brackets and skipping strings.
    let d = 0, j = i, arg = '';
    for (; j < jsx.length; j++) {
      const c = jsx[j];
      if (c === '"' || c === "'" || c === '`') {
        const q = c; let k = j + 1;
        while (k < jsx.length) { if (jsx[k] === '\\') { k += 2; continue; } if (jsx[k] === q) { k++; break; } k++; }
        arg += jsx.slice(j, k); j = k - 1; continue;
      }
      if (c === '(' || c === '{' || c === '[') d++;
      else if (c === ')' || c === '}' || c === ']') { d--; if (d < 0) break; }
      arg += c;
    }
    /* Top-level keys of the argument object only: `{ state: stName }` gives
       "state", and a nested t('k', { x: y }) inside it must not contribute.

       Walked rather than matched with one regex. The first version alternated
       `([{}])` with `(?:^|[{,])\s*(key)\s*:`, and the second branch CONSUMED
       the brace the first branch needed to count — so the depth never left
       nought, every argument object looked empty, and the check reported
       twenty mismatches that were not there. */
    const gives = new Set();
    let dd = 0, expectKey = false;
    for (let k = 0; k < arg.length; k++) {
      const c = arg[k];
      if (c === '"' || c === "'" || c === '`') {
        const q = c; k++;
        while (k < arg.length) { if (arg[k] === '\\') { k += 2; continue; } if (arg[k] === q) break; k++; }
        continue;
      }
      if (c === '{' || c === '[' || c === '(') { dd++; if (dd === 1) expectKey = true; continue; }
      if (c === '}' || c === ']' || c === ')') { dd--; continue; }
      if (dd === 1 && c === ',') { expectKey = true; continue; }
      if (dd === 1 && expectKey && /[A-Za-z_$]/.test(c)) {
        let n = k;
        while (n < arg.length && /[\w$]/.test(arg[n])) n++;
        let after = n;
        while (after < arg.length && /\s/.test(arg[after])) after++;
        /* A key is an identifier in KEY POSITION — at the start of the object
           or just after a top-level comma. Without that state, the value half
           of `{ state: stName }` also looked like a key and the check reported
           "call passes stName and the string has no {stName}" for a call that
           was perfectly correct. `{ word }` shorthand still counts. */
        if (after >= arg.length || arg[after] === ':' || arg[after] === ',' || arg[after] === '}') {
          gives.add(arg.slice(k, n));
        }
        expectKey = false;
        k = n - 1;
      }
    }
    for (const w of wants) if (!gives.has(w)) problems.push(key + ': string wants {' + w + '} and the call does not pass it');
    for (const g of gives) if (!wants.has(g)) problems.push(key + ': call passes ' + g + ' and the string has no {' + g + '}');
  }

  if (problems.length) {
    console.error('i18n FAILED: ' + problems.length + ' placeholder mismatch(es):');
    [...new Set(problems)].forEach(p => console.error('   ' + p));
    process.exit(1);
  }
}

/* ── Catalogue entries nothing can reach ───────────────────────────────────
   A key left behind after its call site was reworded or deleted is dead
   weight a translator will be asked to translate. 470 entries is already a
   lot to hand someone; none of it should be for text no reader can see.

   A key counts as reachable if its literal appears anywhere in the app source
   outside the catalogue — that covers both t('key') and the data structures
   that hold keys as values, like ENTRY_SITUATIONS and the wizard trees.

   Keys built by concatenation (`'topic.' + k`, `'entry.sit.' + k + '.label'`)
   never appear whole, so any literal that ends in a dot is treated as a
   prefix and everything under it counts as reached. That is deliberately
   narrow: it only forgives families the source actually names, not a blanket
   allowlist. */
{
  /* The catalogue's own span, by balancing braces from its declaration.
     Slicing by catBlock.length instead was wrong — catBlock is the INNER text
     of `en: { ... }`, so the offset landed mid-file and cut out live call
     sites, reporting five keys as unreached that are used every render. */
  const catStart = jsx.indexOf('const STRINGS = {');
  let catEnd = catStart, d = 0;
  for (let k = jsx.indexOf('{', catStart); k < jsx.length; k++) {
    if (jsx[k] === '{') d++;
    else if (jsx[k] === '}') { d--; if (d === 0) { catEnd = k + 1; break; } }
  }
  const outside = jsx.slice(0, catStart) + jsx.slice(catEnd);
  /* `[^']*` and not `[^']+`: an empty literal is still a literal, and
     `setStateSel('')` on the same line as a t('key') call would otherwise
     leave the regex pairing quotes one apart from then on — three keys that
     are used on every render were reported as unreached because of it. */
  const literals = new Set([...outside.matchAll(/'([^'\n]*)'/g)].map(m => m[1]).filter(Boolean));
  const prefixes = [...literals].filter(l => /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)*\.$/.test(l));

  const unreached = defined.filter(k =>
    !literals.has(k) && !prefixes.some(p => k.startsWith(p)));

  if (unreached.length) {
    console.error('i18n FAILED: ' + unreached.length + ' catalogue key(s) nothing reaches:');
    unreached.forEach(k => console.error('   ' + k));
    console.error('   Delete them, or point the call site at them.');
    process.exit(1);
  }
}
