# Email Company Completion Mission — Audit, Gap Analysis, and Completion Plan

## Provenance

| Field | Value |
|---|---|
| Date | 2026-07-27 |
| Instance | `email-clean-20260719` (live, `127.0.0.1:3100`, `local_trusted`) |
| Company | `Email` (id `15f8fb0a-065d-4e2b-9d24-a49d986dcaf8`, prefix `EMA`) |
| Branch | `feat/qsl-current-upstream-integration` @ `17c315b42` |
| Server version | `2026.707.0+208.git.17c315b42.dirty` |
| Source | Mission Cell live audit — REST API, instance filesystem, repo source, TheBinMap mail docs |
| Prior art | `EMAIL_COMPANY_LIVE_ARCHITECTURE_AND_PLAN_2026-07-19.md`; `EMA_1_CORRECTIVE_WAKE_AND_DISPOSITION_AUDIT_2026-07-19.md`; `thebinmap/docs/architecture/email-flow.md` |

All statements verified against the running instance on 2026-07-27 unless tagged otherwise.

---

# 1. Architecture Map (current, verified)

## 1.1 What the Email Company is

The Email Company is **one Paperclip company** (prefix `EMA`) operating as QSL's communications function. It is not an email client. Paperclip is the control plane; issues are the only unit of work; agents execute through the `opencode_local` adapter; the Board is the human authority. The company is designed to serve TheBinMap today and every future QSL venture by configuration (mailbox profiles), not code.

## 1.2 Live component map

```text
THEBINMAP INBOUND CHANNELS (today, outside the system)
  Web3Forms (contact/submit/claim/intelligence) ──> gmail only (notify+xxx@web3forms.com)
  Direct email to {info,michael,privacy,legal,support,hello}@thebinmap.com
      ──> Hostinger mailboxes (copies saved) ──> forward to gmail
  MX: Hostinger. SPF/DKIM/DMARC: Hostinger-managed.

PAPERCLIP INSTANCE email-clean-20260719 (127.0.0.1:3100, local_trusted)
  Embedded PostgreSQL (port 54329), hourly backups (stale 100h at audit time)
  Company: Email (EMA)
    Root goal: "Operate reliable, human-approved email communications..."  [exists]
    Projects: Onboarding                                            [exists]
    Secrets: NONE                                                   [gap]
    Budget: 0 (no hard stop)                                        [gap]
    requireBoardApprovalForNewAgents: false                         [gap]
    Agents:
      Email Operations Lead  38c74e59  opencode_local  openrouter/deepseek/deepseek-chat  idle   budget=0
      Reflection Coach       a51fec7e  opencode_local  (built-in)                          paused
      Summarizer             299f8d56  claude_local    claude-haiku-4-5 (built-in)         paused
    Issues: EMA-1 blocked, EMA-2 blocked, EMA-3 blocked, EMA-4 blocked   [all need dispositions]
    Plugins installed: NONE                                         [gap]
    Routines: NONE                                                  [gap]
    Company skills (SOPs): NONE                                     [gap]

EXECUTION EDGE
  opencode CLI 1.18.7 installed; OpenRouter auth functional (`opencode models` lists
  openrouter/anthropic/*, openrouter/deepseek/*, openrouter/moonshotai/*).
  OpenCode auxiliary/small model UNCONFIGURED -> defaults to unavailable
  openai/gpt-5.1-codex-mini -> every corrective run fails fast (~7s). [gap, EMA-1 amplifier]

EXTENSION POINTS (verified available, zero code needed for most)
  Routines (cron -> issue), company skills (SOP doctrine), pipelines/cases (CRM),
  approvals + send-gate pattern, agent_config_revisions, activity_log, cost_events,
  heartbeat_run_events, plugin SDK (jobs.schedule, webhooks.receive, issues.create,
  http.outbound, secrets.read-ref, agent.tools.register, ui.* slots, plugin.state,
  api.routes.register, events.subscribe/emit).
```

## 1.3 The loop, mapped to mechanisms

| Loop stage | Mechanism | Status |
|---|---|---|
| Inbound email | `plugin-email` IMAP poll job (Hostinger) | **MISSING — build** |
| Synchronization | Job schedule + plugin.state dedup by Message-ID | **MISSING — build** |
| Classification | Intake Triage agent + `email-triage-sop` skill; plugin stamps class hints (mailbox, Web3Forms sender pattern) | agent/skill MISSING; hint build |
| Company assignment | Mailbox→company routing in plugin config | **MISSING — build (config-driven)** |
| Mission assignment | Issue in Intake project, assigned to CEO/Triage | native (needs org) |
| Human review | `in_review` + Board queue | native ✓ |
| Approve / Deny | Board disposition; approvals machinery | native ✓ |
| Questions / Comments | Issue comments | native ✓ |
| Execution | Comms Drafter agent drafts reply as work product (draft-only) | agent MISSING |
| Reply | Board-invoked plugin action `send-reply` (SMTP, threading headers) — agents have **no** send tool | **MISSING — build** |
| Archive | Issue `done`; IMAP flag/move to Archive folder | native + small build |
| Replay | activity_log, heartbeat runs, issue record | native ✓ |
| Metrics | cost_events + plugin dashboardWidget (counts, last sync, sends) | native + small build |
| Knowledge capture | Issue documents/work products; SOP updates | native ✓ (distillation deferred) |

---

# 2. Operational Audit

## 2.1 Implemented and working (verified)

- Paperclip fork runs clean on the QSL branch; instance isolation discipline holds.
- Core governed loop: issue → wake → heartbeat → adapter run → work product → disposition → cost/activity records. Proven end-to-end on 2026-07-19 (EMA-1) — the machinery worked, including its safety nets.
- Recovery engine, corrective wakes, productivity-review escalation — all native, all functioning (they correctly caught two agent-behavior loops).
- OpenCode adapter + OpenRouter model routing, including the `openrouter/` provider-prefix requirement (documented field lesson).
- Root goal, Onboarding project, one working agent, built-in agents correctly paused.
- Automatic DB backups configured (hourly; was stale only because server was off since 07-23).

## 2.2 Partially implemented

- **Agent org**: CEO-role agent exists (Email Operations Lead) but on a cheap model that demonstrably failed disposition discipline (EMA-1, EMA-3 loops); no Triage, Drafter, or Analyst agents; no SOP skills.
- **Governance baseline**: root goal exists, but budget `0`, agent budgets `0`, hire-approval gate `false` — the exact configuration that allowed 45 runs in 15 minutes.
- **EMA-3 design work**: the agent produced research toward a Gmail-intake design across 7/21–7/22, claimed a `plan.md` artifact, never recorded a disposition; artifact not present on disk. Research conclusions were directionally useful (plugin approach) but proposed Gmail API OAuth, which the TheBinMap mail reality does not favor (see 3.2).

## 2.3 Missing

1. **Mail input** — no channel brings email into the system. (The only genuinely missing capability identified by the 07-19 architecture plan.)
2. **Mail output** — no governed send path; "Reply" stage of the loop cannot execute inside the system.
3. **Intake project + routing** — no destination project or mailbox→venture mapping.
4. **SOP skills** — `email-triage-sop`, `outbound-drafting-sop`, `escalation-and-approval-rules` unwritten.
5. **Routines** — `morning-ops-brief`, `weekly-comms-review` absent.
6. **Secrets** — no mailbox credentials stored as secret bindings.
7. **OpenCode aux model fix** — corrective runs keep failing on the unavailable default small model.

## 2.4 Duplicated / dead ends (do not resurrect)

- **Gmail API OAuth design** (EMA-3 direction): wrong boundary. Gmail inbox mixes personal and business mail; OAuth sensitive-scope verification burden; TheBinMap canonical business mail already lives in Hostinger mailboxes with copies saved. IMAP against Hostinger is smaller, vendor-neutral, and reusable for future companies. Web3Forms bypasses Hostinger today — fixed by re-pointing Web3Forms delivery to `info@thebinmap.com` (operator dashboard task, ~20 min, zero code), which TheBinMap's own roadmap already schedules.
- **Fork QSL review bridge** — stays dormant (architecture plan A.8).
- **Custom core services for intake** (`src/services/gmail-intake.ts` proposals in EMA-3 comments) — would violate the never-modify-core rule; plugin supersedes.

## 2.5 Technical debt carried into this mission

- Four blocked issues (EMA-1..4) holding recovery-owner state; two are productivity-review audit trails that must be **resolved via Manager Decision, never deleted**.
- `database_backup_stale` warning (100h) — closes on first fresh backup with server running.
- `server/doc/plans/hiring-plan.md` modified in working tree (EMA-1 artifact leak into repo; leave or revert — Board call; not mission-blocking).
- Fork migration `0182_qsl_findings` numbering collision with upstream (dormant; pluginization deferred).

---

# 3. Gap Analysis — what prevents production operation today

## 3.0 Board rulings (2026-07-27, mission Q&A — binding)

| # | Ruling | Consequence |
|---|---|---|
| R1 | **v1 production inbox = Gmail operational inbox** (`mikebennett637@gmail.com`). All Hostinger mailboxes already forward there; Web3Forms delivers there. Per-mailbox Hostinger IMAP is a future *configuration* capability, not a blocker. | Connector architecture is **profile-based**: `gmail-operational` profile v1; Hostinger mailbox profiles later, zero redesign. |
| R2 | Credentials via Paperclip Secret Bindings only — never in code, config files, docs, comments, commits, logs, or issue history. | Plugin reads IMAP/SMTP secrets via `secrets.read-ref`; operator binds. |
| R3 | **Model-agnostic mandate.** Models are implementation defaults, not architectural constraints. Abstract model-routing: mission routing determines the model; record every invocation (provider, model, version, timestamp, company, mission, token usage, estimated cost). | Satisfied natively (see 3.2a). No new routing code. |
| R4 | Staged rollout: create agents → test/review use only → promote to production **only after** the end-to-end loop is demonstrated with real production email. Mission Cells under explicit Board authority. | Agents idle until loop test; routines deferred to promotion. |
| R5 | Audit review precedes major implementation. | Phases A/B (config/data, explicitly approved) executed; plugin code waits for Board go. |

## 3.0a Model-routing requirement → native mechanism map (R3)

The Board's model-routing layer already exists in the platform; the requirement is satisfied by configuration doctrine, not new code:

| Requirement | Native mechanism | Verification |
|---|---|---|
| Providers/models changeable through configuration | `agents.adapter_config.model` (revisioned in `agent_config_revisions`); per-task override `issues.assignee_adapter_overrides`; `runtimeConfig.modelProfiles.cheap` recovery lane | CEO switched deepseek→kimi-k3 2026-07-27 via one PATCH, zero code |
| Mission routing determines the model | Org design: model tier per role (cheap triage/analyst, strong CEO/drafter) + per-issue override when a mission justifies it | Roster below |
| Record every invocation (provider, model, timestamp, company, mission, tokens, cost) | `cost_events` (provider, model, input/output tokens, costCents, occurredAt, companyId, agentId, issue/run linkage) + `heartbeat_run_events` | EMA-1 audit sampled these live |
| Mission attribution | `issues.billingCode` (e.g. `mission:thebinmap-intake`) groups cost per mission; Ops Analyst weekly review aggregates cost_events by billingCode | Doctrine: every mission issue carries billingCode |

Doctrine addition (binding): **no model id may appear in skill text, instructions, or code.** Models live only in `adapter_config` / issue overrides. The Email Company is model-agnostic by construction.

## 3.1 Hard blockers (loop cannot complete)

| # | Gap | Resolution | Code? |
|---|---|---|---|
| G1 | No inbound mail channel | `plugin-email` v1: IMAP poll → normalize → dedup → issue in Intake project | **Yes** |
| G2 | No governed outbound send | `plugin-email` send-reply: **Board-invoked UI action only** (no agent send tool), SMTP with In-Reply-To/References threading, result commented to issue, audited | **Yes** |
| G3 | No mailbox credentials in the system | Board stores IMAP/SMTP secret bindings; plugin reads via `secrets.read-ref` | Config (Board) |
| G4 | Web3Forms submissions invisible to the loop | Operator re-points Web3Forms delivery to `info@thebinmap.com` (dashboard, ~20 min). Until then the loop covers direct email only | Config (Board) |
| G5 | Agent org incomplete (Triage/Drafter/Analyst + SOPs) | Hire via packets + Board approval; write 3 company skills | Config/data |
| G6 | Disposition discipline failure mode unfixed at source | Instructions line (verbatim intent from Operator Guide), operating skill attached, model tier raised for CEO/Drafter | Config |
| G7 | Governance baseline incomplete | Company budget, per-agent budgets, `requireBoardApprovalForNewAgents: true` | Config |
| G8 | OpenCode aux model unavailable | Set OpenCode `small_model` to an `openrouter/...` id in user-level opencode config | Config |
| G9 | Blocked legacy issues EMA-1..4 | Prescribed dispositions (EMA-1/3 → in_review→done w/ Board; EMA-2/4 → Manager Decision close-as-productive) | Board action |

## 3.2 Decisions taken (with rationale)

- **Connector profiles, Gmail operational inbox first (Board ruling R1).** One IMAP/SMTP connector engine; profiles are config rows. v1 profile: Gmail (`imap.gmail.com:993` / `smtp.gmail.com:587`) reading the operational inbox where all ventures' mail already converges. Future profiles add per-mailbox Hostinger accounts by configuration. Vendor-neutral engine (imapflow + nodemailer); no Gmail-API OAuth dependency.
- **Send path is Board-invoked, not agent-invoked.** The plugin registers **no** send tool for agents. Send exists only as a plugin action rendered in the issue detail tab for the Board. This is the send-gate pattern made structural: agents *cannot* send; humans send. Stronger than instruction-level policy and fully audited.
- **One Email Company, routing by profile + venture tag.** v1: Gmail profile → venture tags assigned at triage (thebinmap, qsl, unknown). Future ventures/mailboxes = new profile rows, zero code.
- **Plugin lives in the fork at `packages/plugins/plugin-email`** (workspace package, local-path install) — the deployment model this instance supports today; npm packaging deferred.

---

# 4. Implementation Plan (ordered by operational impact)

## Phase A — Stabilize the base (zero code)

1. Fresh DB backup; confirm server health. 
2. Company hardening: set monthly budget; `requireBoardApprovalForNewAgents: true`.
3. Fix OpenCode aux model (user-level opencode config `small_model` → cheap `openrouter/...` id).
4. Disposition cleanup: EMA-1, EMA-3 → in_review → done (Board accepts artifacts as-is); EMA-2, EMA-4 → Manager Decision "close as productive" with incident note.
5. Upgrade Email Operations Lead: model → stronger `openrouter/...` tier; instructions gain the verbatim disposition line; attach `issue-triage`/`task-planning` bundled skills; per-agent budget.

**Exit:** EMA queue clean; one manual CEO wake completes with a valid disposition and normal cost.

## Phase B — Org + doctrine (zero code)

6. Create **Intake** project.
7. Hire (Board-approved packets): **Intake Triage** (cheapest), **Comms Drafter** (stronger), **Ops Analyst** (cheap). Reporting to CEO. Heartbeat timers off.
8. Write three company skills: `email-triage-sop`, `outbound-drafting-sop` (draft-only), `escalation-and-approval-rules`; attach per role.
9. Routines: `morning-ops-brief` (weekday cron → CEO), `weekly-comms-review` (weekly → Ops Analyst).

**Exit:** org runs clean on manual wakes; review load fits the 15-minute ritual.

## Phase C — plugin-email (the only new code)

10. Scaffold `packages/plugins/plugin-email` (manifest + worker + minimal UI), workspace package.
11. **v1 inbound:** `jobs.schedule` IMAP poll (imapflow) of the **Gmail operational inbox profile** (Board R1) → normalize (from/to/subject/date/body-text, Web3Forms class detection) → dedup by Message-ID in `plugin.state` → create issue in Intake project (`originKind: plugin:email:intake`, `originId: <message-id>` for idempotent re-runs) with class hint labels + assignee = Intake Triage. Config: connector profiles (host, port, user, secretRef, venture, projectKey) via `instanceConfigSchema` + company settings; Hostinger per-mailbox profiles are future config rows, same engine.
12. **v1 governed outbound:** issue `detailTab` slot for the Board showing the original message + drafted reply (latest work product/comment), with **Send** and **Skip** actions. Send → SMTP (nodemailer) with `In-Reply-To`/`References`, sent Message-ID + timestamp commented to the issue, IMAP `\Answered` flag + move to `Archive`, plugin metrics updated. No agent tool surface for sending — by construction.
13. **Metrics:** `dashboardWidget` — messages synced, by class, drafts awaiting Board, sends this week, last sync status. Data from plugin state + `activity.log.write` records.
14. Install into the live instance via `paperclipai plugin install <abs path>`; verify worker health, job schedule, dedup on re-run.

**Exit:** real inbound email → issue, automatically; Board send from the issue tab → threaded reply in the real world.

## Phase D — Prove the loop (production test)

15. Board stores mailbox secret bindings; plugin config validated (`onValidateConfig` → Test Connection green).
16. Live fire: real email to `info@thebinmap.com` → poll → issue → Triage classification → Drafter reply draft → Board review in UI → Board send → threaded reply received → archive → replay via activity log → widget metrics.
17. Evidence capture (screenshots + API records) appended to this document's Test section.
18. Operator runbook added to `docs/qsl/operations/`; Operator Guide Future-Improvements entries #1/#2 marked shipped.

## Deferred backlog (documented, not built)

Gmail OAuth path · Web3Forms direct webhook intake · additional mailboxes (privacy@/legal@/support@) as profiles · pipelines/cases for lead qualification · calendar tool · `plugin-llm-wiki` knowledge distillation · npm packaging of plugin-email · QSL bridge pluginization · attachment ingestion to issue files · auto-acknowledgement drafts (still Board-sent) · multi-operator auth hardening (local_trusted remains the approved posture).

---

# 5. Execution Log

## Phase A — Stabilize (COMPLETE 2026-07-27, verified live)

| Action | Result |
|---|---|
| Server up on `email-clean-20260719` | Health ok; version `2026.707.0+208.git.17c315b42.dirty` |
| Company hardening | `budgetMonthlyCents: 5000` ($50/mo); `requireBoardApprovalForNewAgents: true` — verified: direct agent POST now rejected with "requires board approval" |
| OpenCode aux model | `~/.config/opencode/opencode.jsonc` → `small_model: openrouter/deepseek/deepseek-chat` (was unset → unavailable `openai/gpt-5.1-codex-mini` default) |
| EMA-1..4 dispositions | All four closed `done` with Board decision comments (EMA-2/EMA-4 via Manager Decision = close as productive) |
| CEO upgrade | model → `openrouter/moonshotai/kimi-k3`; budget $20/mo; skills `paperclip` + `issue-triage` + `task-planning` refs; `dangerouslySkipPermissions: true` restored (audited baseline; false silently rejected every tool call in headless runs — field lesson) |
| Proof run EMA-5 | Wake → run → `readiness-note` issue document → `in_review` disposition → Board accepted `done`. Cost ≈ $0.10 total across attempts. **Loop green.** |

Field lessons bought this phase (candidates for `PAPERCLIP_KNOWN_GOTCHAS.md`):
1. `dangerouslySkipPermissions: false` on an unattended agent = every tool call auto-rejected; runs spin without progress. Headless agents require `true`.
2. Catalog skill ids in `desiredSkills` use the **company-library key** format `paperclipai/bundled/<category>/<slug>`; catalog listing ids (`paperclipai:bundled:...`) are for `install-catalog`. Skills must be installed into the company library before agents can reference them.
3. `skills/install-catalog` returned 422 "Internal server error" for `issue-triage` and `task-planning` on this build (works for `summarize-status`/`reflection-coach`). Backlog: upstream bug report.
4. Agent PATCH with partial `adapterConfig` merges safely, but send the complete object to avoid surprises.

## Phase B-1 — Org + doctrine (COMPLETE 2026-07-27, staged rollout)

| Item | Value |
|---|---|
| Intake project | `2afae42a-c1e8-4633-aafd-b2510a3247ca` |
| Skill: `email-triage-sop` | `company/<cid>/email-triage-sop` |
| Skill: `outbound-drafting-sop` | `company/<cid>/outbound-drafting-sop` |
| Skill: `escalation-and-approval-rules` | `company/<cid>/escalation-and-approval-rules` |
| Intake Triage `03882a12` | deepseek-chat, $8/mo, reports to CEO, hire-approved, **idle (test-only per R4)** |
| Communications Drafter `7c1afe2d` | kimi-k3, $15/mo, hire-approved, **idle (test-only per R4)** |
| Operations Analyst `244a421f` | deepseek-chat, $5/mo, hire-approved, **idle (test-only per R4)** |

Governance demonstration: all three hires went through `agent-hires` → pending approval → Board approve (3 approvals in `activity_log`). The gate works.

Emergent behavior note: the CEO, after EMA-5, used native task-suggestion machinery to create **EMA-6** (investigate missing `PAPERCLIP_API_KEY` injection in run env — audit-attribution anomaly from its own readiness note) and is executing it under budget. Delegated-work disposition path working as designed. This is in-scope for "leave every system more capable" but outside the email loop; outcome will be reviewed and either adopted or cancelled at promotion gate.

## Phase B-2 — Routines (DEFERRED to promotion gate per R4)

`morning-ops-brief`, `weekly-comms-review` created when the company promotes to production.

## Phase C — plugin-email (BUILT AND VERIFIED 2026-07-27; awaiting credential for live loop)

**Package:** `packages/plugins/plugin-email` (`@qsl/plugin-email`, plugin key `qsl.email`, v0.1.0). Installed in the live instance from local path; status `ready`; worker healthy; job `poll-inbox` (`*/5 * * * *`) registered with the scheduler.

**What was built:**
- **Inbound (v1):** `poll-inbox` job → per-company connector profiles (Gmail operational inbox per R1; extra profiles via JSON, same engine) → IMAP UNSEEN fetch (imapflow) → normalize (from/to/subject/date/body, Web3Forms + subject heuristics → class/venture **hints**) → dedup by SHA-1(profile:message-id) in plugin state → issue in Intake project (`originKind: plugin:qsl.email:intake`, `originId: <message-id>`, `billingCode: mission:email-ops`, assignee = Intake Triage) → mark seen. Thread record (Message-ID, References, uid) stored in plugin state per issue.
- **Outbound (Board-gated):** `send-reply` action exposed **only** through the Board's UI (issue "Email" tab) — no agent tool surface exists. Reads the `reply-draft` issue document, sends via SMTP (nodemailer) with `In-Reply-To`/`References` threading, writes the permanent send record as an issue comment, flags the original `\Answered` + moves to `[Gmail]/All Mail`, updates metrics. Idempotent: refuses a second send for the same issue.
- **Metrics:** `Email Intake` dashboard widget (last poll, ingested, sent, per-profile health, Poll-now button); counters in plugin state; `activity.log` entries for every intake and send (actor `plugin`).
- **UI (existing interface, zero core changes):** issue `detailTab` "Email" (inbound record, draft preview, Board send with confirm) + `dashboardWidget` "Email Intake". Verified rendering in the live UI (screenshots on file).
- **Config:** company-scoped (`POST /api/plugins/qsl.email/config`) — reusable per company by construction; secret via `credentialSecretRef` (`format: secret-ref`, resolved at execution time only, `secret_access_events` audit).

**Verification so far:** build clean; worker RPC path proven end-to-end (manual `poll-now` reaches the handler and correctly refuses without a credential — error surfaces through the bridge and is recorded); UI slots render in the live interface.

**Fork patch required (upstream candidate):** `plugin-loader.ts` passed a bare Windows path to Node `--import`, crashing every plugin worker on win32. Fixed with `pathToFileURL(...).href` (3 lines). Recorded in `operations/PAPERCLIP_FORK_MAINTENANCE_BACKLOG.md` and Gotcha #6.

**Blocked on (exactly one external dependency):** the Gmail app password for `mikebennett637@gmail.com` (Google account → Security → 2-Step Verification → App passwords). Stored as an Email-company secret binding by the operator; never touches code, docs, or issue history.

---

# 6. Test Evidence

*(Populated in Phase D — live loop with a real inbound email.)*

---

# 7. Remaining Backlog

*(Finalized at mission close; see Deferred backlog above for the initial list.)*
