export const meta = {
  name: 'worklaw-orchestrator',
  description: 'Supervised WorkLaw pipeline: an SME panel (legal-content, qa, ux, design, usertest, security, backend) audits IN PARALLEL and report-only, findings are deduped + ranked, then the right specialist implementer (builder/content/qa/backend) fixes each safe item sequentially — green-gated and committed to auto/agents. Never deploys, never flips content reviewed:true.',
  phases: [
    { title: 'Audit', detail: '7 SME auditors in parallel, report only' },
    { title: 'Fix', detail: 'route each safe finding to its specialist; implement, verify, commit' },
  ],
};

const GUARDRAILS = `Follow AUTONOMY.md. Hard rules: work only on the auto/agents git branch; never commit to main; never push or deploy; never flip any content/*.json "reviewed" flag to true; never start items AUTONOMY.md marks BLOCKED (the federal-feature product pivot, legal sign-off, deploy). This app is legal INFORMATION, not legal advice.`;
const REPORT_ONLY = 'ANALYSIS ONLY: do not modify files, do not run the build, do not commit. Investigate and return findings only.';

const FINDINGS = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          area: { type: 'string', description: 'screen / file / state the finding is in' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          repro: { type: 'string' },
          suggestedFix: { type: 'string' },
          domain: {
            type: 'string',
            enum: ['app', 'content', 'test', 'infra'],
            description: 'what must change to fix it: app=index.dev.html (wl-builder); content=content/*.json (wl-content); test=test/* (wl-qa); infra=build.mjs/automation/docs (wl-backend)',
          },
          safeToAutomate: { type: 'boolean', description: 'false if it needs a product or legal decision per AUTONOMY.md' },
        },
        required: ['title', 'safeToAutomate'],
      },
    },
  },
  required: ['findings'],
};

const FIX_RESULT = {
  type: 'object', additionalProperties: false,
  properties: {
    committed: { type: 'boolean' },
    sha: { type: 'string' },
    testsPassed: { type: 'boolean' },
    summary: { type: 'string' },
    blockedReason: { type: 'string' },
  },
  required: ['committed', 'summary'],
};

// ── Audit: the full SME panel, IN PARALLEL, REPORT ONLY (no writes/commits) ──
// Grouped into teams by concern; every specialist uses its own agent definition
// (.claude/agents/wl-*.md) via agentType so its domain expertise + tool limits apply.
phase('Audit');
const PANEL = [
  { type: 'wl-content',  team: 'Legal & Data', brief: 'Audit content/ as a US employment-law SME: validate every content/*.json against the schema (required fields, reviewed is boolean, sourceUrl well-formed + on an official .gov/court domain, citation present), confirm index.json matches files on disk, and flag stale annual figures + any datum you cannot source officially. Do NOT propose flipping reviewed.' },
  { type: 'wl-qa',       team: 'Quality',      brief: 'Audit functional correctness + coverage: read test/*.mjs and the app; identify screens/states/issues/letter-types not exercised, screens that could throw pageerror/console.error, persistence + content-fetch-failure edge cases, and jurisdiction-correctness of generated letters.' },
  { type: 'wl-usertest', team: 'Experience',   brief: 'Run persona-driven, task-based usability walkthroughs (hourly-TX-overtime, salaried-NY-discrimination, FL-fired, ADA-accommodation, Plain-mode, 390px-mobile). Report where each persona fails their goal, comprehension gaps (federal vs state vs county; information-not-advice), and trust/friction points.' },
  { type: 'wl-ux',       team: 'Experience',   brief: 'Audit WCAG 2.2 AA + usability: disclaimer reachable on every screen, dead buttons, 44px+ hit targets, AA contrast (name the pair+ratio), visible focus, honest/consistent copy, empty + content-fetch-error states, layout at 390-430px.' },
  { type: 'wl-design',   team: 'Experience',   brief: 'Audit the visual system: token drift (type/spacing/radius/color/border), button + heading hierarchy, icon consistency, and whether the three home modes read as one calm, trustworthy (not law-firm-promising) product. Give token-level fixes.' },
  { type: 'wl-security', team: 'Security',     brief: 'Threat-model the client-only app: XSS/injection sinks (dangerouslySetInnerHTML/innerHTML, the letter export/print path, user input rendering, attacker-influenced URLs), privacy of sensitive legal case data in localStorage, and supply-chain (jsDelivr SHA-pin, SRI, CSP, dep advisories). Rank by exploitability × impact.' },
  { type: 'wl-backend',  team: 'Platform',     brief: 'Audit the pipeline + delivery: build.mjs idempotence and dev↔built artifact sync, content-fetch robustness + graceful degradation, index.json↔disk integrity, and gaps in data-validation tooling. Note (design-only) any future-backend need. No deploy.' },
];

const reports = await parallel(PANEL.map(p => () =>
  agent(`You are the ${p.type} specialist for the WorkLaw app (repo at cwd; read AUTONOMY.md). ${REPORT_ONLY} ${p.brief} Rank findings; set domain (app/content/test/infra) and safeToAutomate on each. ${GUARDRAILS}`,
    { agentType: p.type, phase: 'Audit', label: `${p.team}:${p.type.replace('wl-', '')}`, schema: FINDINGS })
));

const all = reports.filter(Boolean).flatMap((r, i) => (r.findings || []).map(f => ({ ...f, from: PANEL[i].type })));
const rank = { high: 0, medium: 1, low: 2 };
const safe = all.filter(f => f.safeToAutomate)
  .sort((a, b) => (rank[a.severity] ?? 1) - (rank[b.severity] ?? 1))
  .slice(0, 6); // bound cost per supervised run
const blocked = all.filter(f => !f.safeToAutomate);
log(`audit complete: ${all.length} findings from ${reports.filter(Boolean).length}/${PANEL.length} SMEs — ${safe.length} safe queued, ${blocked.length} blocked/needs-human`);

// ── Fix: route each safe finding to the RIGHT specialist implementer ──
// Sequential only (shared working tree → never two writers at once).
phase('Fix');
const IMPLEMENTER = { app: 'wl-builder', content: 'wl-content', test: 'wl-qa', infra: 'wl-backend' };
const fixes = [];
for (const f of safe) {
  const impl = IMPLEMENTER[f.domain] || 'wl-builder';
  const r = await agent(
    `You are ${impl}, the WorkLaw specialist implementer. ${GUARDRAILS}
Implement exactly ONE fix for the finding below, staying strictly within your file domain, then stop. Steps:
1. Confirm you are on branch auto/agents (git branch --show-current); if not, stop and report committed:false.
2. Make the smallest change that resolves it, only in files your role owns (${impl}).
3. npm run build && node test/smoke.mjs && node test/persona.mjs. If anything fails, git checkout -- . and report committed:false with the reason.
4. If green, git commit to auto/agents with a clear message (do NOT push). Report the short SHA.
Finding (raised by ${f.from}, domain=${f.domain}):
${JSON.stringify(f, null, 2)}`,
    { agentType: impl, phase: 'Fix', label: `fix:${impl.replace('wl-', '')}:${String(f.area || f.title).slice(0, 16)}`, schema: FIX_RESULT }
  );
  fixes.push({ finding: f.title, domain: f.domain, implementer: impl, ...(r || { committed: false, summary: 'agent returned nothing' }) });
}

return {
  auditedCount: all.length,
  safeQueued: safe.length,
  committed: fixes.filter(x => x.committed).length,
  blocked: blocked.map(f => f.title),
  findings: all,
  fixes,
};
