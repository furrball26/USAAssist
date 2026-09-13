#!/usr/bin/env node
/*
 * Generates content/geo/<ABBR>.json — one file per state holding that state's
 * county outlines as ready-to-render SVG path data.
 *
 * WHY THIS EXISTS AS A BUILD STEP, NOT A RUNTIME FETCH
 * The app can't reach census.gov (and shouldn't depend on it at page load
 * anyway — see docs/content-fetcher-architecture.md for the same argument
 * about legal sources). Boundaries also never change between elections, so
 * fetching them per visit would be pure cost. They are compiled once, here,
 * and committed.
 *
 * WHY PRE-PROJECTED PATH STRINGS, NOT GeoJSON
 * Shipping GeoJSON would force a projection library and a path generator into
 * a bundle that is already ~330KB. us-atlas ships an ALBERS-PROJECTED
 * topology, so the coordinates are already planar: fitting each state's own
 * bounding box to a viewBox is a translate + scale and nothing more. The app
 * renders <path d="..."> and needs no geo code at all.
 *
 * SOURCE: the `us-atlas` npm package (ISC), "Pre-built TopoJSON from the U.S.
 * Census Bureau". The underlying Census TIGER boundaries are US-government
 * work and not copyrightable. Pinned as a devDependency so regenerating is
 * reproducible; npm is reachable from CI and from the agent sandbox, which is
 * what makes this path available at all where a .gov fetch is not.
 *
 * The TopoJSON decode below is inline (~40 lines) rather than pulling in
 * topojson-client: the format is small and fully specified, and a build script
 * that runs a handful of times a decade does not need a dependency for it.
 *
 * Run: node automation/build-county-geo.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'content/geo');
const SRC = join(ROOT, 'node_modules/us-atlas/counties-albers-10m.json');
const SRC_STATES = join(ROOT, 'node_modules/us-atlas/states-albers-10m.json');

// Emitted viewBox width; height follows the state's real aspect ratio so no
// state is stretched. Coordinates are rounded to 1dp, which is well under a
// pixel at any size this renders and roughly halves the file.
const VB_W = 1000;
const PRECISION = 1;

/* Decoder bound to one topology. Both files (counties and states) are the same
   format, so this is built once per source rather than duplicated. */
function decoder(topo) {
  const { scale, translate } = topo.transform;
  const cache = new Map();
  /* Dequantize + delta-decode one arc into absolute [x,y] points. */
  const arc = (i) => {
    if (cache.has(i)) return cache.get(i);
    let x = 0, y = 0;
    const out = topo.arcs[i].map(([dx, dy]) => {
      x += dx; y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
    cache.set(i, out);
    return out;
  };
  /* A negative index means "this arc, reversed" and encodes as ~i. */
  const arcRef = (i) => (i < 0 ? arc(~i).slice().reverse() : arc(i));
  /* Stitch a ring's arcs, dropping each arc's first point (it repeats the
     previous arc's last) so the ring has no duplicated vertices. */
  const ring = (indices) => {
    const pts = [];
    indices.forEach((i, n) => { const a = arcRef(i); pts.push(...(n ? a.slice(1) : a)); });
    return pts;
  };
  return (geom) => {
    if (geom.type === 'Polygon') return geom.arcs.map(ring);
    if (geom.type === 'MultiPolygon') return geom.arcs.flat().map(ring);
    return [];
  };
}

const topo = JSON.parse(readFileSync(SRC, 'utf8'));
const rings = decoder(topo);

/* ── Label placement ─────────────────────────────────────────────────
 * Where to put a shape's name, and whether it will even fit.
 *
 * A polygon CENTROID is the obvious choice and the wrong one: for concave
 * shapes it lands outside the shape entirely. Florida's centroid sits in the
 * Gulf, Michigan's in Lake Michigan, Louisiana's offshore. Labels would float
 * on water next to the state they name.
 *
 * Instead this finds the largest circle that fits inside the shape (the "pole
 * of inaccessibility") by grid search with refinement. That gives two things:
 * a point guaranteed to be inside, and its RADIUS — a direct measure of how
 * much room there is, which is what decides whether a name can be drawn at all.
 * Rhode Island and Bristol County get no label because they genuinely cannot
 * hold one; pretending otherwise would just produce overlapping text.
 */
function pointInRings(px, py, rings) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
function distToEdges(px, py, rings) {
  let best = Infinity;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      const dx = xj - xi, dy = yj - yi;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((px - xi) * dx + (py - yi) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (xi + t * dx), ey = py - (yi + t * dy);
      const d = Math.sqrt(ex * ex + ey * ey);
      if (d < best) best = d;
    }
  }
  return best;
}
/* Grid search, then two refinement passes around the winner. Cheap and ample
   for shapes this simple; a full polylabel priority queue buys nothing here. */
function labelPoint(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  let bx = (x0 + x1) / 2, by = (y0 + y1) / 2, br = -1;
  let sx = x0, sy = y0, ex = x1, ey = y1, steps = 16;
  for (let pass = 0; pass < 3; pass++) {
    const gx = (ex - sx) / steps, gy = (ey - sy) / steps;
    for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
      const px = sx + i * gx, py = sy + j * gy;
      if (!pointInRings(px, py, rings)) continue;
      const d = distToEdges(px, py, rings);
      if (d > br) { br = d; bx = px; by = py; }
    }
    // Zoom in around the current best for the next pass.
    sx = bx - gx; ex = bx + gx; sy = by - gy; ey = by + gy;
  }
  return { x: bx, y: by, r: Math.max(br, 0) };
}

/* Reconcile Census names to the app's own county strings HERE, at build time,
   so the runtime can compare exactly and never guess.
 *
 * Two problems make naive matching wrong:
 *   - Spelling. The app list and the topology disagree on spacing
 *     ("La Salle"/"LaSalle"), accents ("Dona Ana"/"Doña Ana") and suffixes.
 *   - Genuine ambiguity. In Virginia and Maryland an independent CITY and a
 *     COUNTY share a name, and the topology strips the suffix from both — VA
 *     has two shapes literally called "Fairfax" (51600, 51059). Resolved by
 *     FIPS: an independent city's last three digits are >= 500 (Baltimore city
 *     24510 vs Baltimore County 24005; St. Louis city 29510 vs 29189).
 *
 * Anything that cannot be resolved to exactly one app county FAILS THE BUILD.
 * A silently dropped shape is a county a worker cannot pick off the map with
 * nothing anywhere reporting it. */
const SUFFIX_RE = /\s+(County|Parish|Borough|Census Area|Municipio|Municipality|City and Borough)$/i;
const CITY_RE = /\s+city$/;   // lowercase only: "Richmond city" is a city, "Charles City County" is not
const normName = n => String(n || '').replace(CITY_RE, '').replace(SUFFIX_RE, '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

function resolveName(geoName, fips, appCounties) {
  const hits = appCounties.filter(c => normName(c) === normName(geoName));
  if (hits.length === 1) return hits[0];
  if (hits.length === 2) {
    const isCity = Number(String(fips).slice(-3)) >= 500;
    const city = hits.find(c => CITY_RE.test(c));
    const county = hits.find(c => !CITY_RE.test(c));
    if (city && county) return isCity ? city : county;
  }
  return null;
}

/* ── Which labels actually get drawn ──────────────────────────────────
 * Fitting a name inside its own county is necessary but not sufficient: two
 * adjacent counties can each have room and still collide, because each label
 * is placed relative to its own shape with no knowledge of its neighbours.
 * Texas showed exactly that — Jack over Wise, King over Knox, Lamb over Hale.
 *
 * Greedy pass, roomiest first: a label is kept only if it fits its own shape
 * AND its box clears every label already accepted. Decided here rather than at
 * render time so the result is deterministic and costs the browser nothing.
 */
const LABEL_FS = 14;             // must match .wlCountyLabel in index.dev.html
const CHAR_W = 0.62;             // average advance for Atkinson Hyperlegible, rounded up
const LABEL_PAD_X = 6;           // breathing room so neighbours don't touch
const LABEL_PAD_Y = 4;
const SUFFIX_FOR_LABEL = /\s+(County|Parish|Borough|Census Area|Municipio|Municipality|City and Borough)$/i;

function chooseLabels(items) {
  const boxes = [];
  const scored = items
    .map((it, i) => ({ i, it, w: it.short.length * LABEL_FS * CHAR_W }))
    .sort((a, b) => b.it.lr - a.it.lr);
  const keep = new Set();
  for (const { i, it, w } of scored) {
    if (it.lr * 2 < w) continue;                      // won't fit its own shape
    const box = {
      x0: it.lx - w / 2 - LABEL_PAD_X, x1: it.lx + w / 2 + LABEL_PAD_X,
      y0: it.ly - LABEL_FS * 0.5 - LABEL_PAD_Y, y1: it.ly + LABEL_FS * 0.5 + LABEL_PAD_Y,
    };
    if (boxes.some(b => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
    boxes.push(box);
    keep.add(i);
  }
  return keep;
}

// FIPS -> postal abbr. Derived from the topology's own `states` object so the
// mapping can't drift from the geometry it labels.
const STATE_NAMES = {};
for (const g of topo.objects.states.geometries) STATE_NAMES[g.id] = g.properties.name;
const DEV = readFileSync(join(ROOT, 'index.dev.html'), 'utf8');
const ABBR = JSON.parse(DEV.match(/const US_STATE_ABBR = (\{.*?\});/s)[1]);
const APP_COUNTIES = JSON.parse(DEV.match(/const US_COUNTIES = (\{.*?\});/s)[1]);
const unresolved = [];

// Group counties by their state FIPS (first two digits of the county FIPS).
const byState = new Map();
for (const g of topo.objects.counties.geometries) {
  const sf = String(g.id).slice(0, 2);
  if (!byState.has(sf)) byState.set(sf, []);
  byState.get(sf).push(g);
}

mkdirSync(OUT, { recursive: true });
// Only emit states the app actually offers, so content/geo never carries a
// file the picker cannot reach (the same rule US_TILE_GRID follows).
const shipped = new Set(readdirSync(join(ROOT, 'content/states'))
  .filter(f => f.endsWith('.json') && f !== '_TEMPLATE.json')
  .map(f => f.replace('.json', '')));

let files = 0, counties = 0, bytes = 0, labelled = 0;
for (const [sf, geoms] of byState) {
  const name = STATE_NAMES[sf];
  const abbr = ABBR[name];
  if (!abbr || !shipped.has(abbr)) continue;

  const appCounties = APP_COUNTIES[name] || [];
  const decoded = [];
  for (const g of geoms) {
    const r = rings(g);
    if (!r.length) continue;
    const resolved = resolveName(g.properties.name, g.id, appCounties);
    if (!resolved) { unresolved.push(`${abbr} ${g.id} "${g.properties.name}"`); continue; }
    decoded.push({ fips: String(g.id), name: resolved, rings: r });
  }

  // Fit this state's own bbox — each map is drawn at its own scale, which is
  // the point: the screen shows one state, not a slice of the country.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of decoded) for (const r of c.rings) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const k = VB_W / (x1 - x0);
  const vbH = +((y1 - y0) * k).toFixed(PRECISION);
  const fx = x => ((x - x0) * k).toFixed(PRECISION);
  const fy = y => ((y - y0) * k).toFixed(PRECISION);

  const out = {
    state: name, abbr, viewBox: `0 0 ${VB_W} ${vbH}`,
    source: 'us-atlas 3.0.1 (US Census Bureau, Albers)',
    counties: (() => {
      const rows = decoded.map(c => {
        const lp = labelPoint(c.rings);
        return {
          fips: c.fips, name: c.name,
          short: c.name.replace(SUFFIX_FOR_LABEL, ''),
          d: c.rings.map(r => 'M' + r.map(([x, y]) => `${fx(x)} ${fy(y)}`).join('L') + 'Z').join(''),
          lx: +fx(lp.x), ly: +fy(lp.y), lr: +(lp.r * k).toFixed(1),
        };
      });
      const keep = chooseLabels(rows);
      labelled += keep.size;
      return rows.map((r, i) => ({
        fips: r.fips, name: r.name, d: r.d,
        lx: r.lx, ly: r.ly,
        lab: keep.has(i) ? 1 : 0,   // 1 = draw the name; 0 = hover/list only
      })).sort((a, b) => a.name.localeCompare(b.name));
    })(),
  };
  const json = JSON.stringify(out);
  writeFileSync(join(OUT, abbr + '.json'), json);
  files++; counties += out.counties.length; bytes += json.length;
}

/* ── National map: the 50 states as one shared picture ────────────────
 * All states share ONE bounding box (unlike the county files, which each fit
 * their own) so they assemble into the United States. us-atlas's Albers
 * projection already places Alaska and Hawaii in the conventional insets at
 * the lower left, so the result reads as the map people expect.
 *
 * Coordinates round to whole units here rather than 1dp: this renders around
 * 360px wide inside a 1000-unit viewBox, so a whole unit is ~0.36px — below
 * what anyone can see, and it cuts the file by roughly a third.
 */
{
  const st = JSON.parse(readFileSync(SRC_STATES, 'utf8'));
  const stRings = decoder(st);
  const rows = [];
  for (const g of st.objects.states.geometries) {
    const abbr = ABBR[g.properties.name];
    if (!abbr || !shipped.has(abbr)) continue;   // same rule as the picker: no tile without content
    const r = stRings(g);
    if (r.length) rows.push({ abbr, name: g.properties.name, rings: r });
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of rows) for (const r of s.rings) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const k = VB_W / (x1 - x0);
  const out = {
    viewBox: `0 0 ${VB_W} ${Math.round((y1 - y0) * k)}`,
    source: 'us-atlas 3.0.1 (US Census Bureau, Albers)',
    states: rows.map(s => {
      const lp = labelPoint(s.rings);
      return {
        abbr: s.abbr, name: s.name,
        d: s.rings.map(r => 'M' + r.map(([x, y]) =>
          `${Math.round((x - x0) * k)} ${Math.round((y - y0) * k)}`).join('L') + 'Z').join(''),
        lx: Math.round((lp.x - x0) * k), ly: Math.round((lp.y - y0) * k),
        lr: +(lp.r * k).toFixed(1),
      };
    }).sort((a, b) => a.abbr.localeCompare(b.abbr)),
  };
  const json = JSON.stringify(out);
  writeFileSync(join(OUT, '_states.json'), json);
  console.log(`✅ wrote _states.json — ${out.states.length} states, ${(json.length / 1024).toFixed(0)}KB`);
}

if (unresolved.length) {
  console.error(`❌ ${unresolved.length} county shape(s) could not be matched to a selectable county name:`);
  unresolved.forEach(u => console.error('   ' + u));
  console.error('   Fix the name in US_COUNTIES (index.dev.html) or extend resolveName() — do not ship a map with holes in it.');
  process.exit(1);
}
console.log(`✅ wrote ${files} state files, ${counties} counties, ${(bytes / 1024).toFixed(0)}KB total`);
console.log(`   avg ${(bytes / files / 1024).toFixed(1)}KB per state -> content/geo/`);
console.log(`   ${labelled} of ${counties} counties carry a drawn label (the rest are hover + list only)`);
