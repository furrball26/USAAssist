# WorkLaw autonomous agent pipeline

This file is the operating manual for the self-running agent system. The orchestrator
and every subagent read it before acting. It defines **what may be done autonomously**,
**what must wait for a human**, and the **backlog**.

## Prime directives (guardrails — never violate)

1. **Branch only.** All autonomous work lands on `auto/agents`. Never commit to `main`,
   never `git push` to a deploy remote, never touch the Vercel shell. A human merges
   `auto/agents → main` to deploy. (Rationale: this is a legal-information app pending
   counsel review; unattended publishing to real users is out of scope for automation.)
2. **Never author or alter substantive legal claims as "reviewed."** `content/*.json`
   facts stay `reviewed: false`. The content agent may ADD facts sourced from official
   `.gov` sites (marked `reviewed:false`, with `sourceUrl`/`citation`), and may fix
   schema/formatting, but must never flip `reviewed:true` (that is counsel's call) and
   never invent a citation it cannot source.
3. **Green-gate every change.** No commit unless `npm run build` succeeds AND
   `node test/smoke.mjs`, `node test/persona.mjs` pass. A change that breaks tests is
   reverted, not committed.
4. **One logical change per commit**, with a clear message. Keep `index.dev.html` the
   single source of truth; always rebuild artifacts (`npm run build`) in the same commit.
5. **Product-direction items are BLOCKED** until the user decides (see below). Do not guess.

## Roster (see .claude/agents/*.md)

- **wl-qa** — extends + runs the headless suite; reports failures as findings. Does not fix.
- **wl-ux** — screenshots key screens; audits disclaimers, consistency, a11y, dead ends. Reports.
- **wl-content** — validates `content/` integrity; audits `sourceUrl`s vs official domains;
  may add `reviewed:false` facts from official sources. Never edits app logic.
- **wl-builder** — implements ONE engineering/UX fix in `index.dev.html`, rebuilds, green-gates,
  commits to `auto/agents`. The only agent that writes app code.

## Orchestration loop (see orchestrator.mjs)

Each iteration: run **wl-qa + wl-ux + wl-content in parallel** → dedupe findings →
**wl-builder** fixes the highest-value SAFE items one at a time (verify+commit each) →
append a dated entry to `AUTONOMY-STATUS.md`. Repeat until the safe backlog is drained or
the iteration budget is hit. Then stop and wait for the human.

## Backlog — SAFE to automate (engineering / quality)

- [ ] Test coverage: assert all **50 state** JSON files load + render in Rights with no
      console errors; every issue type reaches its dashboard; both letter types generate;
      deadline-watch fallback for states without `deadlines.wageClaim`; agency links present.
- [ ] Content integrity: validate every `content/*.json` against the schema (required
      fields, well-formed `sourceUrl` on official domains, `citation` present, `reviewed`
      boolean). Report malformed files; fix formatting only.
- [ ] Source hygiene: flag `sourceUrl`s that are not official `.gov`/court domains.
- [ ] A11y / UX consistency: a disclaimer on every screen; 44px+ hit targets; AA contrast;
      consistent copy; no dead buttons; sensible empty + error states.
- [ ] Robustness: content-fetch failure path, very long name/employer/note inputs,
      reload persistence across every screen, back/forward between tools.
- [ ] Dead code: remove unused constants/vars flagged by the build.

## Backlog — BLOCKED (needs the user / counsel — do NOT automate)

- [ ] **Product direction:** "remove the federal feature; add official state+county
      sources/resources links." The user has not confirmed scope/placement — leave the
      current federal overtime classification-request step in place until they decide.
- [ ] **Legal sign-off:** counsel review to flip state files `reviewed:true`.
- [ ] **Deploy:** merge `auto/agents → main` (GitHub Pages) and repoint/redeploy the
      Vercel shell to the new SHA (needs the user's Vercel access).

## Run / stop

- One supervised pass: invoke the orchestrator workflow (`orchestrator.mjs`).
- Scheduled (while away): a cron routine triggers an iteration periodically; it self-stops
  when the safe backlog is empty. Stop it anytime by deleting the routine (`/schedule` or
  CronList/CronDelete) — nothing it did is deployed, so stopping is always safe.
