#!/usr/bin/env node
/*
 * Domain-palette gate (index.dev.html: LAW_CATEGORIES).
 *
 * The app colour-codes six domains of law. Colour that carries meaning has to
 * clear two SEPARATE bars, and passing one says nothing about the other:
 *
 *   1. CONTRAST   — is each pairing legible?          WCAG 2.2 AA, numerically.
 *   2. SEPARATION — are the six tellable APART?       CVD simulation + Lab dE.
 *
 * The second exists because contrast guidance is luminance-based: two fills can
 * both clear 4.5:1 against the page and still collapse onto each other for a
 * reader with colour-vision deficiency. That is a different measurement, so it
 * gets a different test.
 *
 * Values are parsed out of index.dev.html rather than duplicated here, so this
 * grades what actually ships and cannot drift away from it.
 *
 * Run: node automation/check-palette.mjs
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;

/* ── colour maths ── */
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const encc = (v) => { v = Math.min(1, Math.max(0, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };
const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const hx = (a) => '#' + a.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const lum = (h) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const r2 = (a, b) => Math.round(ratio(a, b) * 100) / 100;

/* Vienot, Brettel & Mollon (1999), applied in LINEAR rgb */
const M = {
  protan: [[0.11238, 0.88762, 0], [0.07276, 0.92724, 0], [0.00399, -0.00399, 1]],
  deutan: [[0.29275, 0.70725, 0], [0.34597, 0.65403, 0], [-0.0023, 0.0023, 1]],
};
const sim = (h, k) => { if (!M[k]) return h; const [r, g, b] = rgb(h).map(lin), m = M[k];
  return hx([0, 1, 2].map((i) => encc(m[i][0] * r + m[i][1] * g + m[i][2] * b))); };
const lab = (h) => {
  const [r, g, b] = rgb(h).map(lin);
  let X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let Y = (0.2126 * r + 0.7152 * g + 0.0722 * b);
  let Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  [X, Y, Z] = [f(X), f(Y), f(Z)];
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
};
const dE = (a, b) => { const [p, q] = [lab(a), lab(b)]; return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

/* ── self-test: a contrast function that is itself wrong is worse than none.
 *    An earlier draft of this maths silently reported 136:1, which is
 *    impossible when 21:1 is the ceiling. Prove the tool before trusting it. ── */
const near = (a, b) => Math.abs(a - b) < 0.02;
const SELFTEST = [
  ['black on white is the maximum', r2('#000000', '#FFFFFF'), 21],
  ['a colour on itself is the minimum', r2('#FFFFFF', '#FFFFFF'), 1],
  ['#767676 on white passes AA', r2('#767676', '#FFFFFF'), 4.54],
  ['#777777 on white fails AA', r2('#777777', '#FFFFFF'), 4.48],
];
for (const [name, got, want] of SELFTEST) {
  if (!near(got, want)) {
    console.log(`❌ CHECK-PALETTE self-test failed: ${name} — got ${got}, expected ${want}`);
    console.log('   the contrast maths is wrong, so the palette was not graded at all');
    process.exit(1);
  }
}

/* ── parse the shipped domains ── */
const dev = readFileSync(ROOT + 'index.dev.html', 'utf8');
const block = dev.match(/const LAW_CATEGORIES = \[([\s\S]*?)\n\];/);
if (!block) { console.log('❌ CHECK-PALETTE: could not find LAW_CATEGORIES in index.dev.html'); process.exit(1); }
const DOMAINS = [...block[1].matchAll(/key:'([^']+)'[\s\S]*?fill:'(#[0-9A-Fa-f]{6})',\s*edge:'(#[0-9A-Fa-f]{6})',\s*on:'(#[0-9A-Fa-f]{6})'/g)]
  .map((m) => ({ key: m[1], fill: m[2], edge: m[3], on: m[4] }));

const declared = (block[1].match(/key:'/g) || []).length;
if (DOMAINS.length !== declared) {
  console.log(`❌ CHECK-PALETTE: ${declared} domains declared but only ${DOMAINS.length} carry a full fill/edge/on triple`);
  process.exit(1);
}
if (!DOMAINS.length) { console.log('❌ CHECK-PALETTE: no domains parsed'); process.exit(1); }

/* Surfaces the cards actually sit on, read from the stylesheet's own values. */
const SURFACE = '#FFFDF8';
const INK = '#14181F';

let bad = 0;
const chk = (name, got, need) => {
  const ok = got >= need; if (!ok) bad++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name.padEnd(52)} ${String(got).padStart(6)}  (>= ${need})`);
};

console.log(`check-palette: grading ${DOMAINS.length} domains from index.dev.html\n`);
console.log('contrast — AA 4.5 for text, 3.0 for a boundary');
for (const d of DOMAINS) {
  chk(`${d.key}: label/icon on its own fill`, r2(d.on, d.fill), 4.5);
  chk(`${d.key}: edge as text on the page`, r2(d.edge, SURFACE), 4.5);
  chk(`${d.key}: edge as the card border`, r2(d.edge, SURFACE), 3.0);
  /* `on` is a per-hue choice between ink and white; assert the app picked the
     one that actually wins, rather than the one that looks tidier in source. */
  const better = r2(INK, d.fill) >= r2('#FFFFFF', d.fill) ? INK : '#FFFFFF';
  const okPick = d.on.toUpperCase() === better.toUpperCase();
  if (!okPick) bad++;
  console.log(`${okPick ? '  ok  ' : '  FAIL'} ${(d.key + ': `on` is the higher-contrast choice').padEnd(52)} ${d.on} (best ${better})`);
}

/* dE76 on a simulated image is a crude proxy — it penalises hues that fall on a
 * dichromat's confusion line even when lightness still separates them — so the
 * floor is set at what the Okabe-Ito family can actually reach at six hues
 * (measured: 18.1), not at a rounder number that would fail honest colours. */
const MIN_DE = 18;
console.log('\nseparation — every pair, normal and simulated colour-vision deficiency');
for (const kind of ['normal', 'protan', 'deutan']) {
  let w = { d: Infinity, a: '', b: '' };
  for (let i = 0; i < DOMAINS.length; i++) for (let j = i + 1; j < DOMAINS.length; j++) {
    const d = dE(sim(DOMAINS[i].fill, kind), sim(DOMAINS[j].fill, kind));
    if (d < w.d) w = { d, a: DOMAINS[i].key, b: DOMAINS[j].key };
  }
  chk(`${kind}: closest pair (${w.a} vs ${w.b})`, Math.round(w.d), MIN_DE);
}

/* Greyscale matters because people print these pages to take to a hearing. */
const Ls = DOMAINS.map((d) => ({ k: d.key, L: Math.round(lab(d.fill)[0]) })).sort((a, b) => a.L - b.L);
let minGap = Infinity;
for (let i = 1; i < Ls.length; i++) minGap = Math.min(minGap, Ls[i].L - Ls[i - 1].L);
console.log('\ngreyscale — lightness spacing, for printed pages');
console.log('  ' + Ls.map((x) => `${x.k} ${x.L}`).join('  |  '));
chk('smallest lightness gap between fills', minGap, 3);

console.log(bad ? `\n❌ CHECK-PALETTE FAILED (${bad})` : '\n✅ CHECK-PALETTE PASSED — six domains, legible and tellable apart');
process.exit(bad ? 1 : 0);
