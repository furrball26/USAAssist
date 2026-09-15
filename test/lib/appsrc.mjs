/*
 * Pull real functions and the real string catalogue out of index.dev.html.
 *
 * Suites do this rather than reimplementing the logic they test: a copy in a
 * test agrees with itself forever while the app drifts out from under it. It
 * lives here because three suites now need it and the extraction is fiddly
 * enough to get subtly wrong in each of them.
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url).pathname;
export const devSource = () => readFileSync(ROOT + 'index.dev.html', 'utf8');

/** The source of a top-level `function name(...) { ... }`, braces balanced. */
export function fnSource(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}\\n'));
  if (!m) throw new Error('could not find function ' + name + ' in index.dev.html');
  return m[0];
}

/**
 * The source of a top-level `const NAME = ...;` statement, whatever its shape.
 *
 * Scans to the semicolon that actually ends the statement rather than matching
 * a bracket pair: ENTRY_SITUATIONS is `['home', ...].map(k => ({...}))`, and a
 * bracket match would stop at the array and drop the .map() that builds it.
 */
export function constSource(src, name) {
  const at = src.search(new RegExp('^const ' + name + ' =', 'm'));
  if (at < 0) throw new Error('could not find const ' + name + ' in index.dev.html');
  let d = 0, i = src.indexOf('=', at) + 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
    else if (c === ';' && d === 0) return src.slice(at, i + 1);
    else if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) break;
      }
    }
  }
  throw new Error('unterminated statement for const ' + name);
}

/**
 * One locale's catalogue, as the app defines it.
 *
 * Read out of the source rather than hand-copied, so a suite asserting on copy
 * is asserting on the string that actually ships — and so a suite covering a
 * second language is the same suite with one argument changed.
 *
 * The locale header is matched anchored at its own indentation (`^  es: {`)
 * rather than by substring: `es: {` occurs inside the English copy often
 * enough that a plain indexOf would find a fragment of prose and eval it.
 */
export function catalogue(src, code = 'en') {
  const at = src.indexOf('const STRINGS = {');
  if (at < 0) throw new Error('could not find STRINGS in index.dev.html');
  const rest = src.slice(at);
  const hdr = rest.search(new RegExp('^  ' + code + ': \\{', 'm'));
  if (hdr < 0) throw new Error('no locale ' + code + ' in STRINGS');
  const open = rest.indexOf('{', hdr);
  let d = 0;
  for (let j = open; j < rest.length; j++) {
    if (rest[j] === '{') d++;
    else if (rest[j] === '}') { d--; if (d === 0) return (0, eval)('(' + rest.slice(open, j + 1) + ')'); }
  }
  throw new Error('unbalanced STRINGS.' + code);
}

/**
 * A working t() bound to the given catalogue, matching the app's own.
 *
 * Kept deliberately small: it resolves a key and fills {holes}. The app's t()
 * additionally returns a React fragment when a hole carries an element, which
 * no suite needs here — the browser half of each suite covers rendering.
 */
export function translator(table) {
  return (key, vars) => {
    const s = table[key];
    if (s === undefined) return key;
    if (!vars) return s;
    return String(s).replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole);
  };
}
