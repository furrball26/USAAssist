# Future backend architecture — AI-consult proxy + attorney directory

**Status: design only.** Nothing in this document is deployed, provisioned, or wired into
the app. WorkLaw today is 100% client-side (React + `localStorage` + static `content/*.json`);
the "Ask AI" chat is keyword-routed canned copy (`REPLIES`/`ADA_REPLY` in `index.dev.html`,
see `send()`) and "Referrals" attorney listings are hardcoded, clearly-labeled samples
(`SAMPLE_LAWYERS` in `index.dev.html`). This document is the plan for replacing both with
real, narrowly-scoped backend services — written so a future implementer (human or agent
with deploy access) has a concrete starting point, not a from-scratch design exercise.

**Non-goals of this document / this pass:**
- No live service is created. No Vercel project, Supabase project, Cloudflare Worker,
  database, or API key is provisioned.
- No network call is added to `index.dev.html`/`index.html`/`assets/app.js`. The app keeps
  working exactly as it does today (offline-capable, zero required network calls beyond the
  content fetch) until a real backend is built and explicitly wired in as an *optional*
  enhancement, not a hard dependency — see "Client-side fallback" in each section below.
- No secrets of any kind are referenced, generated, or expected to be added to this repo.
  An Anthropic API key (or any other credential) must never reach client-side code; this is
  the entire reason a proxy exists (see Part 1).
- This is not a legal-advice generation system. Every design choice below is oriented around
  the same constraint the rest of the app already honors: **legal information, grounded in
  cited sources, not legal advice** — and the AI proxy must not be able to say more than that
  framing allows.

---

## Part 1 — AI-consult proxy

### Problem

The chat needs to move from fixed canned replies to model-generated answers, but the model
call has to happen **server-side**: shipping an Anthropic API key to the browser (e.g. as a
build-time constant or `NEXT_PUBLIC_*`-style env var) means every visitor can extract and
abuse it — unlimited free API usage on WorkLaw's bill, or the key gets scraped and resold.
The proxy's entire job is to be the only thing holding the key.

### Shape: a single stateless edge function

```
POST /api/consult
Content-Type: application/json

{
  "jurisdiction": "TX",              // 2-letter state code (or "US" for federal-only)
  "issueType": "overtime",           // one of a fixed enum, same as the app's onboarding issue keys
  "message": "Can my employer dock my pay for..."
}
```

- **Stateless**: no session, no server-side conversation history. The client already
  maintains the message list in `localStorage` (see `messages`/`STORE_KEY` in
  `index.dev.html`); if multi-turn context is needed, the client re-sends the last N
  messages in the request body on each call. The server never persists a transcript. This
  keeps the function trivially horizontally scalable and removes an entire class of
  "who can read past conversations" privacy questions.
- **Grounded, not open-ended**: the function does not let the model answer from general
  training knowledge alone. Server-side, before calling the model, it:
  1. Loads `content/_federal.json` + `content/states/<jurisdiction>.json` (same dataset the
     client already fetches — the proxy can read it from the same jsDelivr SHA-pinned URL,
     or from a bundled copy at deploy time).
  2. Filters to facts where **`reviewed: true`** — exactly the same gate the client UI
     already uses to decide whether to show a state's guidance as authoritative
     (`content/README.md`: "the app renders a state as authoritative only when its data is
     `reviewed: true`"). Unreviewed facts are never fed to the model as ground truth. If a
     jurisdiction has no reviewed facts for the relevant `issueType`, the proxy returns a
     federal-only-grounded answer (or a "not yet reviewed for this state" response) rather
     than letting the model improvise state law.
  3. Constructs a system prompt that (a) supplies only the filtered, reviewed fact objects
     (topic/value/summary/citation/sourceUrl) as the model's factual grounding, (b)
     instructs the model to answer only from what's supplied plus well-established federal
     baseline law it's allowed to state generally (FLSA/Title VII/ADA/ADEA/FMLA — the same
     federal floor `_federal.json` encodes), (c) requires every substantive claim in the
     reply to carry a citation drawn from the supplied facts, (d) requires the same
     information/not-advice framing already used throughout the app's UI copy, and (e)
     explicitly instructs the model to decline and redirect to Referrals/a licensed attorney
     for anything outside its grounding (mirrors today's `fallbackReply` behavior).
  4. Calls the Claude API server-side with that system prompt + the user's message (and any
     client-supplied prior turns), using the **latest available Claude model** at deploy
     time (currently the Claude Opus/Sonnet 4.x family; pin a specific model string in
     config and revisit periodically — do not hardcode a model version here, since "latest"
     will drift).
  5. Returns `{ text, cites: [{ citation, sourceUrl }] }` — the same shape the client's
     `messages`/`REPLIES` objects already use, so the swap from canned to real is a
     same-interface change on the client side.

### Response contract (client-compatible)

```json
{
  "text": "…",
  "cites": [{ "citation": "29 U.S.C. § 207(a)", "sourceUrl": "https://www.dol.gov/..." }],
  "grounded": true
}
```

`grounded: false` signals the reply is a decline/redirect (no reviewed facts available) —
lets the client render it distinctly, the way the current fallback reply is distinct from a
matched one.

### Auth, rate limits, abuse

- **No user accounts required for v1.** The app has no login today and shouldn't gain one
  just for this. Rate-limit by IP + a lightweight anonymous client token (random UUID,
  generated once client-side, stored in `localStorage` alongside the case — not
  PII, just an abuse-rate bucket key).
- Suggested limits: ~20 requests/hour/IP, ~5 requests/minute/IP burst, hard daily cap per
  deploy to bound worst-case API spend. Cloudflare Workers/Vercel Edge both have built-in
  rate-limiting primitives (Cloudflare Rate Limiting rules, Vercel's `@vercel/kv`-backed
  token bucket) — don't hand-roll this.
- **CORS locked to worklaw.app + the GitHub Pages origin** (`furrball26.github.io`) only —
  the two known deploys of the app, mirroring the CSP `connect-src` allowlist already
  established in `vercel.json`/`index.dev.html`.
- No `dangerouslySetInnerHTML` equivalent server-side either: the model's `text` output is
  rendered as plain text on the client (as `messages` already are today), never as HTML.

### Privacy of case data

This is the most important constraint. The chat message a user sends can contain real,
sensitive facts (employer name, dates, pay figures, what happened). The proxy must:

- **Never persist the request or response.** No database write, no logging of message
  bodies (structured logs may capture `jurisdiction`/`issueType`/latency/status code for
  operability, explicitly *not* `message` or `text`).
- **Never forward the message anywhere except the model API call itself.** No analytics, no
  third-party logging/observability vendor that captures request bodies by default (audit
  whatever platform's default logging behavior before enabling it — e.g. Vercel's request
  logs, Cloudflare's logpush — and scrub or disable body capture).
- **Model-provider data retention**: use the Claude API in a mode consistent with the
  vendor's zero/short-retention API terms for the account in use (not a consumer chat
  product) — this is a contractual/account-configuration decision at deploy time, not
  something this repo can enforce in code, but the design must not *assume* retention is
  fine.
- Ties directly into the app's existing privacy posture: `localStorage`-only case data, a
  real "delete my case" control, zero telemetry today. Adding a backend call must not
  regress any of that — the case stays client-owned; the proxy only ever sees a single
  message + jurisdiction + issueType per call, not the whole case object.

### Client-side fallback (non-goal reminder)

The client must keep working with **no backend at all** — today's canned `REPLIES` become
the fallback path if `/api/consult` is unreachable or not configured (same pattern as the
existing jsDelivr → `raw.githubusercontent.com` content-fetch fallback in
`fetchContentJson()`), not a hard dependency. This is a client (`wl-builder`) implementation
detail when the time comes; noted here so the proxy's absence is never a crash.

---

## Part 2 — Licensed-attorney directory API

### Problem

`SAMPLE_LAWYERS` in `index.dev.html` is three hardcoded, clearly-labeled fictional listings.
A real version needs a searchable, licensure-verified directory, scoped to the same
state + county the user already has on file — no new data entry from the user.

### Data model (Postgres, e.g. via Supabase)

```sql
create table attorneys (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  firm_name         text,
  state             text not null,        -- 2-letter, matches content/states/<X>.json keys
  counties          text[] not null,      -- practice counties within that state; [] = statewide
  practice_areas    text[] not null,      -- controlled vocabulary matching the app's issue keys:
                                           -- 'overtime' | 'discrimination' | 'termination' | 'severance' | ...
  bar_number        text not null,
  bar_state         text not null,        -- state whose bar issued bar_number (usually = state)
  license_status    text not null,        -- 'active' | 'inactive' | 'suspended' | 'unverified'
  license_verified_at timestamptz,        -- last time license_status was confirmed against
                                           -- the state bar's public lookup, not self-reported
  fee_structure     text,                 -- 'contingency' | 'hourly' | 'free_consult' | 'sliding_scale'
  languages         text[],
  contact_url       text not null,        -- firm/attorney's own site or intake form — never
                                           -- an email/phone captured for outbound contact by us
  active            boolean not null default true,  -- publisher-controlled kill switch, distinct
                                           -- from license_status
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index on attorneys (state, active) where active;
```

- **Licensure verification is the load-bearing field, not a nice-to-have.** `license_status`
  is not attorney-self-reported; it's populated/refreshed by a periodic job that checks the
  attorney's bar number against the relevant state bar's public attorney-lookup service (each
  state bar publishes one; format varies by state, so this is per-state adapter work, not a
  single API). Only `license_status = 'active'` rows are ever returned to the public search
  endpoint. This is a real content-moderation/liability surface (an app steering users toward
  a *suspended* attorney is a serious problem) and deserves its own review pass before launch,
  not a rubber-stamp import from an unverified source.
- No case data, no user PII, no user identifiers of any kind live in this table or any table
  adjacent to it. It is a pure read-side directory.

### API

```
GET /api/attorneys?state=TX&county=Travis+County&practiceArea=overtime
```

- **Public, read-only, no auth required** — this is the same trust level as the state
  attorney-bar directories it's built from; there's no reason to gate it.
- Returns active + license-verified rows only, filtered server-side (never ship the whole
  table and filter client-side — avoids leaking `inactive`/`suspended`/`unverified` rows to
  a curious client).
- Rate-limited generously (this is read-only public data, abuse risk is low, but still worth
  a coarse cap to prevent scraping the whole directory in one sweep).
- No write endpoint exposed publicly. Attorney onboarding/updates go through an admin-only
  path (Supabase's own row-level-security-gated admin UI, or a separate authenticated admin
  tool) — out of scope to design further here since it's an internal ops tool, not part of
  the public app surface.

### Client-side fallback (non-goal reminder)

Exactly as today: if the directory API is unreachable or not configured, "Referrals" shows
the real agency links (EEOC/DOL/state agency — already real, not samples) with the
attorney-listing section either omitted or showing the current clearly-labeled sample cards.
Never silently show stale/cached attorney data as if it were live-verified.

---

## Recommended stack

| Concern | Recommendation | Why |
|---|---|---|
| AI-consult proxy | **Cloudflare Worker** (or Vercel Edge Function, since worklaw.app is already on Vercel) | Stateless-by-construction, cheap at low volume, built-in rate limiting, no server to patch. Vercel Edge Functions are the lower-friction choice specifically because worklaw.app is already a Vercel project — one platform, one deploy story, `vercel.json` already exists for headers. |
| Attorney directory DB + read API | **Supabase** (Postgres + auto-generated REST/RPC + row-level security) | Row-level security is exactly the right primitive for "public read of `active=true` rows only, admin write" without hand-rolling an authorization layer; Postgres array/index support fits the `counties`/`practice_areas` filtering directly; generous free tier suitable for a directory of this size. |
| Secrets | Platform env vars (Vercel/Cloudflare project secrets), never committed | Standard; the whole point of the proxy is that the key never leaves this boundary. |
| Rate limiting | Platform-native (Vercel `@vercel/kv` token bucket, or Cloudflare Rate Limiting rules) | Don't hand-roll; both platforms have this solved. |

**Trade-off called out explicitly**: Supabase + Vercel Edge means two platforms/vendors
instead of one. The alternative — Vercel Postgres/KV for everything — keeps a single vendor
but Supabase's row-level security and Postgres array columns are a meaningfully better fit
for the directory's public-read/admin-write shape, so the two-vendor cost is worth it here.

## Open questions for whoever implements this

- Exact per-state bar-lookup adapters for `license_status` verification (50 different sites,
  50 different scrape/API shapes) — real content work, likely as slow as the `content/`
  dataset itself was.
- Whether `issueType`/`practiceArea` vocabularies should be a shared enum imported by both
  the client and the backend (avoiding drift) — probably yes, via a small shared JSON/TS
  types package once there's a second consumer of the app's issue-key vocabulary.
- Cost ceiling / kill-switch design for the AI proxy (a hard daily spend cap that degrades to
  the canned-reply fallback rather than an unbounded bill) — sketch above assumes this exists
  but doesn't specify the exact mechanism.
