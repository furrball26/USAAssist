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
import { readFileSync, readdirSync } from 'node:fs';

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

  const topicsSeen = new Map(); // topic -> first fact index it appeared at, this file only
  data.facts.forEach((fact, i) => {
    const label = `${relPath} facts[${i}]${fact && fact.topic ? ` (${fact.topic})` : ''}`;

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
        err(`${label}: duplicate topic "${fact.topic}" (first seen at facts[${topicsSeen.get(fact.topic)}]) — factByTopic() would silently shadow this entry and it would never render`);
      } else {
        topicsSeen.set(fact.topic, i);
      }
    }

    // (f) staleness warning — unparseable or older than STALE_DAYS. Not a hard fail: this
    // is a hygiene signal for wl-content to re-verify, not a legal-accuracy judgment.
    if (typeof fact.lastChecked === 'string' && fact.lastChecked) {
      const parsed = new Date(fact.lastChecked);
      if (Number.isNaN(parsed.getTime())) {
        warn(`${label}: lastChecked "${fact.lastChecked}" is not a parseable date`);
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

console.log(`validate-content: checked _federal.json + ${stateFiles.length} state file(s)`);
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
