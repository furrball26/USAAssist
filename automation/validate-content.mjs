#!/usr/bin/env node
/*
 * Content-integrity validator for content/*.json.
 *
 * Scope is deliberately narrow: this checks SHAPE and SOURCING HYGIENE only — it never
 * touches legal substance (fact values, citations, summaries) and never flips `reviewed`.
 * Legal accuracy is wl-content's domain; this script is the mechanical backstop that keeps
 * the dataset well-formed so wl-content's review and the app's rendering gate can trust it.
 *
 * Checks:
 *   (a) Every file is valid JSON and every fact has all required fields.
 *   (b) Every sourceUrl (facts[].sourceUrl) AND every agency contact link
 *       (agencies.wageHour.url / agencies.discrimination.url) is https:// and on an
 *       official-looking domain (.gov, .us, or a small allowlist of non-.gov/.us hosts
 *       already used in the data for state code/legislature/agency portals). For
 *       facts[].sourceUrl this is a WARNING, not a hard fail — wl-content owns swapping a
 *       source, not this script. For agencies.*.url it IS a hard fail: it's a small,
 *       fully-auditable set (2 links x 50 states) that the app surfaces as its primary
 *       "contact this agency" action, not a best-effort citation footnote.
 *   (c) content/index.json's states[] list matches the files on disk in content/states/
 *       (minus _TEMPLATE.json, which is a scaffold, not authored content).
 *   (d) `reviewed` is false everywhere — file-level and per-fact. This is the rendering
 *       gate (content/README.md: "the app renders a state as authoritative only when its
 *       data is reviewed: true"); a stray `true` before counsel sign-off would silently
 *       promote unreviewed legal content to authoritative in the app. Hard fail.
 *   (e) No duplicate `topic` within a single file's facts[]. The app's factByTopic()
 *       (index.dev.html) does `facts.find(f => f.topic === topic)` — a duplicate topic in
 *       the same file would silently shadow the second entry (never rendered, never an
 *       error), which is exactly the kind of data-shape defect this script exists to catch.
 *       Scoped per-file, not globally: the same topic legitimately repeats across different
 *       state files (e.g. "overtime.basicRule" in every state). Hard fail.
 *   (f) Staleness WARNING: a fact whose `lastChecked` is unparseable as a date, or older
 *       than STALE_DAYS (default 365, override with WORKLAW_STALE_DAYS env var), is
 *       flagged. This is a hygiene signal for wl-content to re-verify against the live
 *       source — it is not a legal-accuracy judgment, so it's a warning, not a hard fail.
 *
 * Exit 0 = pass (warnings allowed). Exit 1 = any hard failure.
 * Run: node automation/validate-content.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const CONTENT = ROOT + 'content/';

const REQUIRED_FACT_FIELDS = [
  'topic', 'value', 'summary', 'citation', 'sourceUrl',
  'sourceAgency', 'lastChecked', 'reviewed', 'reviewedBy',
];

// Non-.gov/.us hosts already used in the dataset for legitimate official sources
// (state statute portals, semi-privatized state job/labor sites, etc). Extend this list
// only when wl-content adds a genuinely official new host; anything not here and not
// .gov/.us is flagged as a warning for wl-content to confirm or swap (see gap-report M4).
const HOST_ALLOWLIST = new Set([
  'nmonesource.com',       // New Mexico Compilation Commission — official statute portal
  'www.floridajobs.org',   // Florida Dept of Commerce — FL has no separate state DOL
  'fchr.myflorida.com',    // Florida Commission on Human Relations — official state agency
  'www.khrc.net',          // Kansas Human Rights Commission — official state agency
  'khrc.net',
  'www.laworks.net',       // Louisiana Workforce Commission — official state agency
  'laworks.net',
  // Municipal official sites that predate .gov adoption. Plenty of US cities still
  // run their official site on .org/.net; these three are the cities' own, and are
  // where each publishes its minimum-wage rate.
  'denvergov.org',              // City and County of Denver — official municipal site
  'www.denvergov.org',
  'www.weho.org',               // City of West Hollywood — official municipal site
  'weho.org',
  'www.cityofpasadena.net',     // City of Pasadena, CA — official municipal site
  'cityofpasadena.net',
]);

// Staleness threshold for the lastChecked warning (days). Configurable via env var so
// wl-content/wl-qa can tighten or loosen it (e.g. in a CI job) without editing this script.
const STALE_DAYS = Number(process.env.WORKLAW_STALE_DAYS) > 0 ? Number(process.env.WORKLAW_STALE_DAYS) : 365;

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

function isOfficialHost(host) {
  host = host.toLowerCase();
  return host.endsWith('.gov') || host.endsWith('.us') || HOST_ALLOWLIST.has(host);
}

// Shared sourcing-hygiene check for any URL field the app treats as a clickable official
// link (facts[].sourceUrl, agencies.wageHour.url, agencies.discrimination.url). A
// malformed URL is always a hard fail (broken data, not a sourcing nit). Scheme/host
// hygiene severity is caller-controlled via `severity` ('warn', the default, or 'err'):
// facts[].sourceUrl stays a WARNING (wl-content owns swapping a source, high volume,
// best-effort citations — see the file-header comment on (b)); agencies.*.url is called
// with severity: 'err' because it's a small, fully-auditable set (2 links x 50 states)
// that the app surfaces as its primary "contact this agency" action, not a citation
// footnote — an unofficial/broken agency link is a hard fail, not a hygiene nit.
function checkOfficialUrl(label, fieldName, rawUrl, severity = 'warn') {
  const flag = severity === 'err' ? err : warn;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    err(`${label}: ${fieldName} is not a valid URL ("${rawUrl}")`);
    return;
  }
  if (url.protocol !== 'https:') {
    flag(`${label}: ${fieldName} is not https:// ("${rawUrl}") — the app's safeUrl() guard will silently drop this as a clickable link`);
  } else if (!isOfficialHost(url.hostname)) {
    flag(`${label}: ${fieldName} host "${url.hostname}" is not .gov/.us and not on the allowlist — confirm it's an official source or swap it ("${rawUrl}")`);
  }
}

// Per-fact checks (a, e, f, and the sourceUrl half of b), shared by state files and by
// each locality inside a content/local file. `scope` is the array's path for messages;
// duplicate-topic detection is per CALL, which is what makes it correct for local files —
// minimumWage.hourly legitimately repeats across localities in one file, but a repeat
// WITHIN one locality would be silently shadowed by factByTopic() exactly as in a state file.
function checkFacts(relPath, facts, scope) {
  const topicsSeen = new Map(); // topic -> first index it appeared at, this scope only
  facts.forEach((fact, i) => {
    const label = `${relPath} ${scope}[${i}]${fact && fact.topic ? ` (${fact.topic})` : ''}`;

    for (const field of REQUIRED_FACT_FIELDS) {
      if (!(field in fact)) {
        err(`${label}: missing required field "${field}"`);
      }
    }
    // value/summary/citation/sourceUrl/sourceAgency/lastChecked must be non-empty when present
    // (value may legitimately be 0, so check emptiness only for string-typed fields).
    for (const field of ['summary', 'citation', 'sourceUrl', 'sourceAgency', 'lastChecked']) {
      if (field in fact && (fact[field] === '' || fact[field] === null)) {
        err(`${label}: required field "${field}" is empty`);
      }
    }
    if ('topic' in fact && (!fact.topic || typeof fact.topic !== 'string')) {
      err(`${label}: "topic" must be a non-empty string`);
    }

    // (e) duplicate topic within this file — the app's factByTopic() would silently return
    // only the FIRST match and shadow every later one, so this is a hard fail, not a warning.
    if (typeof fact.topic === 'string' && fact.topic) {
      if (topicsSeen.has(fact.topic)) {
        err(`${label}: duplicate topic "${fact.topic}" (first seen at ${scope}[${topicsSeen.get(fact.topic)}]) — factByTopic() would silently shadow this entry and it would never render`);
      } else {
        topicsSeen.set(fact.topic, i);
      }
    }

    /* (f) lastChecked. The app SHOWS this to readers now — "California Civil
       Rights Department · we last checked this 30 Jul 2026" — so it stopped
       being internal hygiene and became a claim about our own diligence.
       Two shapes of it are a lie and therefore hard failures:

         - a date that is not a real calendar date. `new Date('2026-02-29')`
           does not reject; it rolls forward to 1 March, so the old parse check
           passed it and the app rendered "29 Feb 2026" for a day that did not
           happen. The round-trip below is what catches that.
         - a date in the future, which claims we checked something we cannot
           have checked. The old age test only looked for dates too OLD, so a
           typo'd year sailed through.

       Staleness stays a WARNING: an out-of-date check is a hygiene signal for
       re-verification, not a false statement. */
    if (typeof fact.lastChecked === 'string' && fact.lastChecked) {
      const raw = fact.lastChecked.trim();
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      const parsed = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
      const realDate = !!parsed && !Number.isNaN(parsed.getTime()) &&
        parsed.getUTCFullYear() === +m[1] && parsed.getUTCMonth() === +m[2] - 1 && parsed.getUTCDate() === +m[3];

      if (!realDate) {
        err(`${label}: lastChecked "${fact.lastChecked}" is not a real calendar date in YYYY-MM-DD form — it is shown to readers as when we last verified this`);
      } else if (parsed.getTime() > Date.now() + 86400000) {
        err(`${label}: lastChecked "${fact.lastChecked}" is in the future — that claims a verification that has not happened`);
      } else {
        const ageDays = Math.floor((Date.now() - parsed.getTime()) / 86400000);
        if (ageDays > STALE_DAYS) {
          warn(`${label}: lastChecked "${fact.lastChecked}" is ${ageDays} day(s) old (> ${STALE_DAYS}) — consider re-verifying against the source`);
        }
      }
    }

    if (fact.reviewed === true) {
      err(`${label}: fact-level "reviewed" is true — must stay false until counsel review (out of this script's scope to change)`);
    }

    if (typeof fact.sourceUrl === 'string' && fact.sourceUrl) {
      checkOfficialUrl(label, 'sourceUrl', fact.sourceUrl);
    }
  });
}

function checkFile(relPath) {
  const full = CONTENT + relPath;
  let raw, data;
  try {
    raw = readFileSync(full, 'utf8');
  } catch (e) {
    err(`${relPath}: could not read file (${e.message})`);
    return;
  }
  try {
    data = JSON.parse(raw);
  } catch (e) {
    err(`${relPath}: invalid JSON (${e.message})`);
    return;
  }

  if (data.reviewed === true) {
    err(`${relPath}: top-level "reviewed" is true — content must stay unreviewed until counsel sign-off flips it (out of this script's scope to change)`);
  }

  if (!Array.isArray(data.facts)) {
    err(`${relPath}: "facts" is not an array`);
    return;
  }

  checkFacts(relPath, data.facts, 'facts');

  // (b, cont'd) agencies.wageHour.url / agencies.discrimination.url — same sourcing-hygiene
  // bar as facts[].sourceUrl. These are the app's "contact the agency" links and were
  // previously unchecked entirely.
  if (data.agencies && typeof data.agencies === 'object') {
    for (const agencyKey of ['wageHour', 'discrimination']) {
      const agency = data.agencies[agencyKey];
      if (agency && typeof agency.url === 'string' && agency.url) {
        checkOfficialUrl(`${relPath} agencies.${agencyKey}`, 'url', agency.url, 'err');
      }
    }
  }
}

// Local (county/city) ordinance files: content/local/<ABBR>/<slug>.json.
//
// Shape differs from a state file — facts are nested one level down, under
// localities[], because a county almost never has ONE answer. Los Angeles County
// has five different minimum wages inside it and the county's own applies only to
// unincorporated areas; Cook County's expressly stops at the Chicago line. Every
// locality therefore carries `covers`, in words, saying who it actually applies to.
function checkLocalFile(relPath, validCounties) {
  const full = CONTENT + relPath;
  let data;
  try {
    data = JSON.parse(readFileSync(full, 'utf8'));
  } catch (e) {
    err(`${relPath}: invalid JSON or unreadable (${e.message})`);
    return null;
  }

  if (data.reviewed === true) {
    err(`${relPath}: top-level "reviewed" is true — local content must stay unreviewed until counsel sign-off`);
  }
  if (typeof data.state !== 'string' || !/^[A-Z]{2}$/.test(data.state)) {
    err(`${relPath}: "state" must be a two-letter abbreviation, got ${JSON.stringify(data.state)}`);
    return null;
  }
  const dirAbbr = relPath.split('/')[1];
  if (data.state !== dirAbbr) {
    err(`${relPath}: "state" is "${data.state}" but the file lives under content/local/${dirAbbr}/`);
  }
  if (typeof data.name !== 'string' || !data.name) {
    err(`${relPath}: "name" must be a non-empty string`);
  }

  // The county names are the JOIN KEY against the user's selection. A typo here does
  // not fail loudly — the ordinance simply never matches and never renders, which is
  // indistinguishable from "this county has no local law". So it is a hard fail.
  if (!Array.isArray(data.counties) || data.counties.length === 0) {
    err(`${relPath}: "counties" must be a non-empty array of county names`);
  } else if (validCounties) {
    for (const c of data.counties) {
      if (typeof c !== 'string' || !c) {
        err(`${relPath}: counties[] contains a non-string entry`);
      } else if (!validCounties.has(c)) {
        err(`${relPath}: county "${c}" is not in the app's county list for ${data.state} — it would silently never match a user's selection`);
      }
    }
  }

  if (!Array.isArray(data.localities) || data.localities.length === 0) {
    err(`${relPath}: "localities" must be a non-empty array`);
    return data;
  }
  const namesSeen = new Set();
  data.localities.forEach((loc, i) => {
    const label = `${relPath} localities[${i}]${loc && loc.name ? ` (${loc.name})` : ''}`;
    if (!loc || typeof loc !== 'object') { err(`${label}: not an object`); return; }
    if (typeof loc.name !== 'string' || !loc.name) err(`${label}: "name" must be a non-empty string`);
    // `covers` is what stops the app collapsing five different rates into one wrong
    // number — it is the sentence telling the reader which of them is theirs.
    if (typeof loc.covers !== 'string' || !loc.covers.trim()) {
      err(`${label}: "covers" is required and must say in words who this ordinance applies to`);
    }
    if (loc.name && namesSeen.has(loc.name)) err(`${label}: duplicate locality name "${loc.name}" in this file`);
    if (loc.name) namesSeen.add(loc.name);
    if (!Array.isArray(loc.facts) || loc.facts.length === 0) {
      err(`${label}: "facts" must be a non-empty array`);
    } else {
      checkFacts(relPath, loc.facts, `localities[${i}].facts`);
    }
  });
  return data;
}

// (a)+(b)+(d): federal + every state file
checkFile('_federal.json');
const stateFiles = readdirSync(CONTENT + 'states/')
  .filter((f) => f.endsWith('.json') && f !== '_TEMPLATE.json')
  .sort();
stateFiles.forEach((f) => checkFile('states/' + f));

// (c) index.json states[] vs files on disk
let index;
try {
  index = JSON.parse(readFileSync(CONTENT + 'index.json', 'utf8'));
} catch (e) {
  err(`index.json: invalid or unreadable (${e.message})`);
}
if (index) {
  const declared = new Set(index.states || []);
  const onDisk = new Set(stateFiles.map((f) => f.replace(/\.json$/, '')));
  for (const abbr of declared) {
    if (!onDisk.has(abbr)) err(`index.json declares state "${abbr}" but content/states/${abbr}.json does not exist`);
  }
  for (const abbr of onDisk) {
    if (!declared.has(abbr)) err(`content/states/${abbr}.json exists on disk but is not listed in index.json states[]`);
  }
}

// (g) local ordinance files, and index.json's local{} manifest vs what is on disk.
// The app fetches by the manifest, so a file the manifest does not list is dead weight
// and a manifest entry with no file is a 404 at runtime.
const APP_COUNTIES = (() => {
  try {
    const app = readFileSync(ROOT + 'index.dev.html', 'utf8');
    const m = app.match(/const US_COUNTIES = (\{[\s\S]*?\});/);
    const byName = m ? JSON.parse(m[1]) : null;
    const abbrM = app.match(/const US_STATE_ABBR = (\{[\s\S]*?\});/);
    const abbr = abbrM ? JSON.parse(abbrM[1]) : null;
    if (!byName || !abbr) return null;
    const out = {};
    for (const [stateName, counties] of Object.entries(byName)) {
      if (abbr[stateName]) out[abbr[stateName]] = new Set(counties);
    }
    return out;
  } catch (e) {
    warn(`could not read US_COUNTIES from index.dev.html to cross-check local county names (${e.message})`);
    return null;
  }
})();

let localFileCount = 0;
const localOnDisk = new Map(); // "AB/file.json" -> data
if (existsSync(CONTENT + 'local')) {
  for (const abbr of readdirSync(CONTENT + 'local').sort()) {
    const dir = CONTENT + 'local/' + abbr;
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const rel = `local/${abbr}/${f}`;
      const data = checkLocalFile(rel, APP_COUNTIES ? APP_COUNTIES[abbr] : null);
      localFileCount++;
      if (data) localOnDisk.set(`${abbr}/${f}`, data);
    }
  }
}
if (index) {
  const manifest = index.local || {};
  const declared = new Set();
  for (const [abbr, entries] of Object.entries(manifest)) {
    if (!Array.isArray(entries)) { err(`index.json local.${abbr} is not an array`); continue; }
    for (const e of entries) {
      const key = `${abbr}/${e && e.file}`;
      declared.add(key);
      const data = localOnDisk.get(key);
      if (!data) { err(`index.json declares local file "${key}" but content/local/${key} does not exist`); continue; }
      // The manifest's counties[] is what the app matches on without opening the file,
      // so a drift between the two silently changes which counties see the ordinance.
      const a = JSON.stringify(data.counties || []);
      const b = JSON.stringify(e.counties || []);
      if (a !== b) err(`index.json local.${abbr} "${e.file}" counties ${b} do not match the file's own ${a}`);
      if (e.name !== data.name) err(`index.json local.${abbr} "${e.file}" name "${e.name}" does not match the file's "${data.name}"`);
    }
  }
  for (const key of localOnDisk.keys()) {
    if (!declared.has(key)) err(`content/local/${key} exists on disk but is not listed in index.json local{} — the app fetches by that manifest, so it would never load`);
  }
}

console.log(`validate-content: checked _federal.json + ${stateFiles.length} state file(s) + ${localFileCount} local file(s)`);
if (warnings.length) {
  console.log(`\n⚠️  ${warnings.length} warning(s):`);
  warnings.forEach((w) => console.log('   ' + w));
}
if (errors.length) {
  console.log(`\n❌ ${errors.length} error(s):`);
  errors.forEach((e) => console.log('   ' + e));
  console.log('\n❌ VALIDATE-CONTENT FAILED');
  process.exit(1);
}
console.log('\n✅ VALIDATE-CONTENT PASSED' + (warnings.length ? ' (with warnings)' : ''));
process.exit(0);
