# Build-time source fetcher — keeping cited `.gov` pages and our facts in sync

**Status: design only.** No fetcher exists in the repo today. Nothing here is scheduled,
provisioned, or wired into `npm run verify`. This document is the plan, written so an
implementer (human or agent) starts from a concrete design rather than a blank file.

It answers a question that came up directly: *the site needs to pull data from `.gov` sites*.
It does — but not from the browser, and not by reading a value off a page and putting it in
front of a worker. This document is the version of that idea that is safe to build.

---

## Why not the obvious thing (fetch `.gov` from the browser)

Three independent blockers, any one of which is fatal:

**1. CORS.** The decisive one. `index.dev.html` runs on `worklaw.app`; a browser `fetch()` to
`dol.gov` is cross-origin, so it only succeeds if *the agency* sends
`Access-Control-Allow-Origin`. Most `.gov` sites don't. This is not something the app can fix
from its side — no header, no CSP change, no build flag makes another origin opt in. The
request is made and then discarded by the browser before our code sees a byte.

**2. CSP.** Secondary, but real. The app ships a deliberately tight policy (`index.dev.html`
line 13):

```
connect-src 'self' https://cdn.jsdelivr.net https://raw.githubusercontent.com
```

Runtime `.gov` fetching would mean widening `connect-src` to a large, changing set of
third-party hosts — giving up a control that `automation/check-csp.mjs` and
`check-csp-sync.mjs` exist to protect, in exchange for requests CORS will reject anyway.

**3. Those pages are HTML, not data.** `https://www.dol.gov/agencies/whd/overtime` is a
marketing-shaped page for humans. There is no `.json` endpoint behind most of what we cite.
Browser-side scraping would mean parsing agency prose at page load, in front of a worker, with
no human between the parse and the answer — and it would break *silently* the next time an
agency reflows a page. That is precisely the failure mode the 2026-08-29 audit was about:
confident top-line output contradicting the truth sitting next to it. Adding a live scraper
would industrialize it.

So the fetch moves to build time, where a person is still in the loop.

## Why not an edge-function proxy either

A server-side proxy (`/api/source?url=…`) solves CORS. It does not solve #3 — it just moves
the scrape from the browser to a server and keeps it on the request path. A user asking "what's
the minimum wage here?" would still get an answer derived from a parse that no one reviewed.

Build-time fetching is the option that keeps the property the whole dataset is built around:
**a human reads the source before a worker reads the fact.** It also fits `AUTONOMY.md`'s
`reviewed: false` rule without amendment, because — as designed below — the fetcher never
authors a fact.

---

## The core constraint that shapes everything

> **The fetcher never proposes a value. It only reports whether the value we already publish
> is still supported by the page we already cite.**

This is the whole design in one line, and it's what makes the thing safe to automate.

A fetcher that *extracts* ("the page now says $16.50, update `minimumWage.hourly`") is a
legal-content author. It would need review, it would be wrong in ways nobody notices, and it
would eventually write a hallucinated number into `content/`. A fetcher that *verifies*
("the string `$16.50` no longer appears anywhere on the page cited by `CA/minimumWage.hourly`")
can only ever lower our confidence in something we already said. Its worst-case failure is a
false alarm that wastes a reviewer's time. That asymmetry is the point.

Everything below follows from it.

---

## What it fetches — the list is derived, not maintained

`content/sources.md` is a human-facing registry of *entry points* (one agency per
jurisdiction). It is not the fetch list, and it should not become one: a second registry
of URLs would drift from the dataset the moment `wl-content` swaps a source on a single fact.

The fetch list comes from the dataset itself. Every fact already carries the exact page it
depends on:

```json
{ "topic": "minimumWage.hourly", "value": 16.5, "sourceUrl": "https://www.dir.ca.gov/…", … }
```

So the target set is `distinct(sourceUrl)` across `content/_federal.json`,
`content/states/*.json`, and (when they exist) `content/local/**`. Today that is:

| | count |
| --- | --- |
| Facts | 492 |
| Distinct `sourceUrl` values | 379 |
| Distinct hosts | 124 |
| Facts with a numeric `value` | 103 |
| Facts with a string `value` containing a digit or `$` | 193 |

Two consequences worth stating: the fetch list stays correct for free as content changes, and
the source→topic mapping is the *inverse* of the URL index — one page, e.g.
`https://statutes.capitol.texas.gov/Docs/LA/htm/LA.21.htm` (6 facts, the widest fan-out in the
set today), maps to every fact citing it, so one drifted page produces a precise list of topics
to re-check.

## The three checks

Each runs per URL, cheapest first. All three are conservative — they can flag something that
turned out fine, never quietly bless something that changed.

### 1. Reachability — hard signal

`GET` (or `HEAD` where the host honors it). Non-2xx, DNS failure, or a redirect that lands on a
different host means the citation is broken: the worker who clicks **Source ↗** in the app gets
a 404. This is a *fix now* finding, and it is checkable without any judgment about content.

Note the interaction with `automation/validate-content.mjs`, which already validates that every
`sourceUrl` is `https:` and on an official-looking host. That's a *shape* check and runs
offline. Reachability is the network half that validator deliberately doesn't attempt.

### 2. Page drift — warning

Normalize the page (strip scripts/styles/nav/footer, collapse whitespace, drop obvious
per-request noise like session ids and "last updated" timestamps), hash it, compare to the
stored digest. A changed digest means *someone at the agency edited this page since we last
looked* — not that our fact is wrong. It routes to `wl-content` as "re-verify these N topics",
with a text diff to make that quick.

The normalization matters: raw HTML digests over agency CMS output change constantly for
reasons that have nothing to do with the law, and a check that cries wolf weekly gets muted,
which is worse than not having it.

### 3. Value support — the one that matters

For any fact whose `value` is numeric, or is a string containing a number or `$`, test whether
that value still appears in the normalized page text, under a small set of surface forms:

```
16.5  →  "16.50", "$16.50", "16.5"
684   →  "684", "$684", "684.00"
1352  →  "1,352", "$1,352", "1352"
```

If it appears: no signal. If it does not: **the page we cite no longer contains the number we
publish from it.** That is the single highest-value automated signal available here — it is
what catches a state minimum wage going up on January 1 while our fact still says last year's
figure, which is the concrete way this app hurts someone.

What it explicitly does not do: read the new number. If `$16.50` is gone and `$17.00` is
present, the report says *"`CA/minimumWage.hourly` = 16.5 not found on source page"* and stops.
A human opens the page. `wl-content` writes the new fact with a citation it actually read.

Roughly 296 of 492 facts (103 numeric + 193 numeric-ish strings) are eligible for this check.
The remaining ~200 are prose values ("1.5x after 40 hrs/week") and are covered by checks 1–2
only. Attempting to verify prose values automatically is where this design would start
hallucinating, so it doesn't.

---

## What it writes

Nothing in `content/*.json` facts. Ever.

**`content/.sources-cache/<sha256-of-url>.txt`** — normalized page text, committed. Committing
it is what makes drift *diffable* in a PR instead of a boolean; it's also what lets the check
run without a live fetch when a host is down. Text after normalization, not raw HTML, keeps
this to a manageable size and keeps the diffs readable.

**`content/.sources-cache/manifest.json`** — per URL: digest, HTTP status, `ETag`,
`Last-Modified`, timestamp of last successful fetch, and the topics that cite it.

**`docs/source-drift-report.md`** (regenerated) — the human artifact. Grouped by severity, then
by jurisdiction:

```
BROKEN (2)
  GA  final-pay                 404  https://dol.georgia.gov/…
  NM  deadlines.wageClaim       301 → off-host  https://nmonesource.com/…

VALUE NOT FOUND ON SOURCE (1)
  CA  minimumWage.hourly        16.5 absent from https://www.dir.ca.gov/…
      last seen present 2026-08-08 · page changed 2026-09-02 · +14/−9 lines

PAGE CHANGED (6)
  TX  discrimination.protectedClasses, deadlines.discriminationComplaint, …
      6 facts cite https://statutes.capitol.texas.gov/Docs/LA/htm/LA.21.htm
```

The optional fourth artifact is a **field**, not a value: `lastVerifiedAuto` on a fact,
written only when checks 1–3 all pass for it.

It is deliberately *not* `lastChecked`. `content/README.md` defines `lastChecked` as "when the
value was last confirmed against the source" — a human reading a page. A machine confirming
that a string still occurs on it is a genuinely weaker claim, and collapsing the two would let
automated passes make the dataset look freshly reviewed when nobody has read anything. Keeping
them separate also lets `validate-content.mjs`'s staleness warning stay honest: it keys on
`lastChecked` (human review cadence) and can *additionally* escalate a fact whose
`lastVerifiedAuto` has gone stale or failed.

`lastVerifiedAuto` is additive and optional — not added to `REQUIRED_FACT_FIELDS`, so existing
files stay valid.

## How it stays inside the `reviewed: false` rule

Directly, and without needing an exception:

- The fetcher **never sets `reviewed`**, in either direction. Not `true` (counsel's call, per
  `AUTONOMY.md` and check (d) in `validate-content.mjs`, which hard-fails a stray `true`), and
  not `false`-as-a-downgrade either — that would be a machine overruling counsel.
- The fetcher **never writes `value`, `summary`, `citation`, or `sourceUrl`.** Those are
  `wl-content`'s, sourced from a page a person read. Nothing the fetcher produces is legal
  content, so nothing it produces needs review.
- The fetcher **never invents a citation**, because it never produces one. Its entire output
  vocabulary is: reachable / not, changed / not, our value present / absent.
- Everything it emits is a *signal to a reviewer*. The rendering gate is unchanged: a state is
  authoritative only when `reviewed: true`, and today nothing is.

Put plainly — the fetcher can create work for a human. It cannot do that human's work.

## Where it runs (and why not here)

**In CI, on a schedule.** A new `.github/workflows/source-drift.yml`, weekly:

```yaml
on:
  schedule: [{ cron: '17 8 * * 1' }]   # Mondays, off the hour
  workflow_dispatch:
```

…running `node automation/fetch-sources.mjs --check`, and opening (or updating) a single PR
against `auto/agents` carrying the regenerated cache + report. A PR rather than an issue, so
the *diff of the agency's page* is the review surface.

**Not in `npm run verify`.** The verify chain is the green gate on every commit; making it
depend on 379 third-party hosts would make it slow, flaky, and dependent on network access that
contributors and sandboxes don't reliably have. `verify` stays offline. This is the same
reasoning `automation/check-live-drift.mjs` already documents for staying out of the chain.

**Not from an agent session in this environment.** Outbound HTTPS here goes through an agent
proxy whose egress policy does not permit `.gov` hosts — CONNECT returns 403. That is a policy
boundary, not an obstacle to route around, and it is why this document is design rather than a
working fetcher: the design can be written offline; exercising it against live agency sources
cannot. GitHub Actions runners have the open egress this needs.

## Being a good citizen of someone else's server

379 URLs across 124 hosts, some of them small state agencies. The fetcher must:

- Send conditional requests (`If-None-Match` / `If-Modified-Since` from the manifest). A `304`
  is a pass on checks 1–2 with no body transferred — which, after the first run, should be most
  of them.
- Rate-limit **per host** (~1 request/sec, small concurrency cap), not globally. Texas has 12
  facts on `statutes.capitol.texas.gov`; those should not arrive at once.
- Send an honest `User-Agent` identifying the project with a contact URL.
- Respect `robots.txt`, and treat a disallow as a finding for `wl-content` (that source may
  need swapping), not something to work around.
- Never retry a `403`/`429` past one backoff — report it.

## Sketch

```
automation/
  fetch-sources.mjs          # entry: --check (default) | --snapshot | --url <one>
  lib/
    source-index.mjs         # dataset → { url → [{ jurisdiction, topic, value }] }
    normalize.mjs            # html → stable text (+ digest)
    value-forms.mjs          # 16.5 → ["16.50", "$16.50", "16.5"]
    fetch-queue.mjs          # per-host rate limit, conditional GET, backoff
    report.mjs               # findings → docs/source-drift-report.md
content/.sources-cache/
  manifest.json
  <sha256>.txt
.github/workflows/source-drift.yml
```

`--snapshot` seeds the cache the first time (and after a deliberate source swap); `--check` is
what CI runs. `--url <one>` is the debugging path for a single flagged page.

Roughly 200 lines of real logic plus normalization heuristics. The normalization is where the
work actually is, and it should start crude — strip tags, collapse whitespace, drop `<nav>`,
`<header>`, `<footer>`, `<script>`, `<style>` — then tighten per-host only where a real false
positive shows up. Tuning it speculatively against pages nobody has diffed yet is guesswork.

## Order to build it

1. `source-index.mjs` + a `--dry-run` that prints the URL→topics map. No network. Immediately
   useful on its own: it's the first accurate answer to "what does this fact depend on?"
2. Reachability only (check 1), `--snapshot` to seed the manifest. This alone finds broken
   citations, which are pure user-facing harm and need no judgment to confirm.
3. Normalization + digests (check 2). Run it weekly for a month against nothing but a report
   before anyone acts on it, to see the real false-positive rate.
4. Value support (check 3) once normalization is trusted. Highest value, and the one that most
   needs a quiet baseline underneath it.
5. `lastVerifiedAuto` + the `validate-content.mjs` escalation, last.

Each step is independently useful and independently revertible. Nothing before step 4 can
produce a false "your minimum wage is stale" claim.

## Open questions for whoever implements this

- **What should the app show for a drifted fact?** Today the rendering gate already covers it
  (nothing is `reviewed: true`, so every state shows the not-yet-reviewed banner). Once counsel
  starts flipping states to `true`, a fact whose source page has changed underneath a review
  needs *some* surface — a "source page changed since review" note, a temporary demotion to the
  federal baseline, or nothing. This is a product + counsel decision, not an engineering one,
  and it should be answered before the first `reviewed: true` lands.
- **Is committing the normalized cache the right call at 379 pages?** It's what makes drift
  reviewable in a PR diff, but it's also a large mostly-machine-written area of the repo. An
  alternative is digests-only in git with full text in CI artifacts — cheaper, much worse to
  review. Recommend committing until size is an actual problem.
- **Per-host normalization overrides** will eventually be needed (a few state CMSes inject
  per-request tokens). Where do they live — a table in `normalize.mjs`, or alongside the host
  allowlist in `validate-content.mjs`?
- **Should `content/sources.md` be generated** from the derived index rather than
  hand-maintained? It would stop the two from drifting, but the prose columns ("no state DOL")
  carry human knowledge a generator would drop.
- **Local/county content** (`content/local/**`) doesn't exist yet but is in the content model.
  City minimum wages change more often than state ones and are hosted on the flakiest sites in
  the set. Worth confirming the design holds there before that data lands.

---

## Related

- `content/README.md` — the fact schema, `lastChecked` semantics, and the rendering gate.
- `content/sources.md` — human-facing registry of per-jurisdiction entry points.
- `automation/validate-content.mjs` — the offline shape/sourcing validator this complements.
- `automation/check-live-drift.mjs` — prior art for a network-dependent, read-only checker kept
  deliberately outside `npm run verify`.
- `docs/backend-architecture.md` — the *other* server-side design (AI proxy + attorney
  directory). Independent of this one; neither depends on the other.
