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

// Emitted viewBox width; height follows the state's real aspect ratio so no
// state is stretched. Coordinates are rounded to 1dp, which is well under a
// pixel at any size this renders and roughly halves the file.
const VB_W = 1000;
const PRECISION = 1;

const topo = JSON.parse(readFileSync(SRC, 'utf8'));
const { scale, translate } = topo.transform;

/* Dequantize + delta-decode one arc into absolute [x,y] points. */
const arcCache = new Map();
function arc(i) {
  if (arcCache.has(i)) return arcCache.get(i);
  let x = 0, y = 0;
  const out = topo.arcs[i].map(([dx, dy]) => {
    x += dx; y += dy;
    return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
  });
  arcCache.set(i, out);
  return out;
}
/* A negative index means "this arc, reversed" and encodes as ~i. */
function arcRef(i) { return i < 0 ? arc(~i).slice().reverse() : arc(i); }
/* Stitch a ring's arcs, dropping each arc's first point (it repeats the
   previous arc's last) so the ring has no duplicated vertices. */
function ring(indices) {
  const pts = [];
  indices.forEach((i, n) => { const a = arcRef(i); pts.push(...(n ? a.slice(1) : a)); });
  return pts;
}
function rings(geom) {
  if (geom.type === 'Polygon') return geom.arcs.map(ring);
  if (geom.type === 'MultiPolygon') return geom.arcs.flat().map(ring);
  return [];
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

let files = 0, counties = 0, bytes = 0;
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
    counties: decoded.map(c => ({
      fips: c.fips, name: c.name,
      d: c.rings.map(r => 'M' + r.map(([x, y]) => `${fx(x)} ${fy(y)}`).join('L') + 'Z').join(''),
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
  const json = JSON.stringify(out);
  writeFileSync(join(OUT, abbr + '.json'), json);
  files++; counties += out.counties.length; bytes += json.length;
}

if (unresolved.length) {
  console.error(`❌ ${unresolved.length} county shape(s) could not be matched to a selectable county name:`);
  unresolved.forEach(u => console.error('   ' + u));
  console.error('   Fix the name in US_COUNTIES (index.dev.html) or extend resolveName() — do not ship a map with holes in it.');
  process.exit(1);
}
console.log(`✅ wrote ${files} state files, ${counties} counties, ${(bytes / 1024).toFixed(0)}KB total`);
console.log(`   avg ${(bytes / files / 1024).toFixed(1)}KB per state -> content/geo/`);
