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
 *   (b) Every sourceUrl is https:// and on an official-looking domain (.gov, .us, or a
 *       small allowlist of non-.gov/.us hosts already used in the data for state
 *       code/legislature/agency portals). Anything else is a WARNING, not a hard fail —
 *       wl-content owns swapping a source, not this script.
 *   (c) content/index.json's states[] list matches the files on disk in content/states/
 *       (minus _TEMPLATE.json, which is a scaffold, not authored content).
 *   (d) `reviewed` is false everywhere — file-level and per-fact. This is the rendering
 *       gate (content/README.md: "the app renders a state as authoritative only when its
 *       data is reviewed: true"); a stray `true` before counsel sign-off would silently
 *       promote unreviewed legal content to authoritative in the app. Hard fail.
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
]);

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

function isOfficialHost(host) {
  host = host.toLowerCase();
  return host.endsWith('.gov') || host.endsWith('.us') || HOST_ALLOWLIST.has(host);
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

    if (fact.reviewed === true) {
      err(`${label}: fact-level "reviewed" is true — must stay false until counsel review (out of this script's scope to change)`);
    }

    if (typeof fact.sourceUrl === 'string' && fact.sourceUrl) {
      let url;
      try {
        url = new URL(fact.sourceUrl);
      } catch {
        // A malformed URL (unparseable) is a hard fail — a valid https official URL that
        // fails a lower-severity sourcing check is a warning (see below), but garbage
        // input isn't a "sourcing hygiene" nit, it's broken data.
        err(`${label}: sourceUrl is not a valid URL ("${fact.sourceUrl}")`);
        return;
      }
      // Sourcing-hygiene checks (scheme + host) are WARNINGS, not hard fails, per spec:
      // this script validates shape/sourcing, not legal substance, and doesn't own fixing
      // a source URL — that's wl-content. The app's own safeUrl() already refuses to render
      // non-https hrefs at runtime, so a flagged URL degrades (drops the link) rather than
      // ever executing/crashing; it's a real defect worth surfacing, just not a build-breaker.
      if (url.protocol !== 'https:') {
        warn(`${label}: sourceUrl is not https:// ("${fact.sourceUrl}") — the app's safeUrl() guard will silently drop this as a clickable source link`);
      } else if (!isOfficialHost(url.hostname)) {
        warn(`${label}: sourceUrl host "${url.hostname}" is not .gov/.us and not on the allowlist — confirm it's an official source or swap it ("${fact.sourceUrl}")`);
      }
    }
  });
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
