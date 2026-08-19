# Directory Conversation Operator V1

**Date:** 2026-08-18  
**Branch:** `feat/directory-conversation-operator-v1`  
**Base:** `feat/qsl-native-mission-orchestration-v0-1`

## Mission

Extend the existing governed Email Operations intake, mailbox identity, deterministic sorting, and outbound safety boundaries into a stateful conversation operator for real portfolio businesses.

Initial tenants:

1. TheBinMap
2. TherapistIndex
3. QuantumShield Labs (schema-compatible from V1; live activation may follow after directory proof)

The goal is not generic email automation. The goal is to reduce human clerical attention while preserving evidence and escalating consequential business judgment.

> Delegate execution. Escalate judgment. Preserve evidence.

## Existing foundation — do not rebuild

The current Paperclip Email Operations work already provides:

- first-class mailbox identity;
- company/tenant context;
- per-mailbox credential isolation;
- deterministic intake sorting;
- live source/form identity for current TheBinMap Web3Forms traffic;
- system-notification routing for non-reply events;
- exact-mailbox reply safety;
- fail-closed outbound authority;
- tests based on real received form shapes.

Conversation Operator V1 starts after classification.

## Canonical flow

`Message / Intake Record`
→ `Thread + Entity Match`
→ `Structured Intent / Facts`
→ `Conversation State`
→ `Next Best Action`
→ `Draft / No-Reply / Human Decision`
→ `Governance Check`
→ `Send only when separately authorized`
→ `Waiting / Follow-up / Resolution`
→ `Outcome + Evidence`

## V1 work sequence

### Phase 1 — Structured conversation record

Add a compact record that can preserve, at minimum:

- tenant/company;
- mailbox profile;
- message/thread identity;
- sender/contact identity;
- matched business/listing/entity when available;
- intent/category;
- confidence;
- extracted factual request/change;
- commercial signal;
- risk/authority class;
- conversation state;
- recommended next action;
- evidence references.

Avoid storing giant prompt transcripts as operational state.

### Phase 2 — Thread and entity matching

Associate new messages with the correct prior conversation and, where possible, the relevant directory listing, practice, store, company, prospect, or customer.

Fail closed on uncertain identity matches that could cause consequential action.

### Phase 3 — Conversation state machine

Initial shared states:

- `received`
- `identified`
- `needs_info`
- `action_ready`
- `response_ready`
- `waiting_for_reply`
- `follow_up_due`
- `human_review`
- `resolved`
- `closed_not_interested`
- `suppressed`

Tenant-specific business intents remain policy data, not hard-coded architecture assumptions.

### Phase 4 — Next-action engine

Produce one bounded recommendation from current evidence and policy:

- no action;
- acknowledge;
- request missing information;
- prepare correction/claim/removal workflow;
- prepare commercial response;
- prepare follow-up;
- escalate to human;
- suppress/close.

### Phase 5 — Draft-only reply layer

Generate reviewable replies from tenant policy + actual thread context.

No new outbound authority is granted by this phase.

### Phase 6 — Historical replay evaluation

Use real historical TheBinMap and TherapistIndex conversations as regression/evaluation cases.

For each case ask:

1. Was tenant/mailbox identified correctly?
2. Was intent classified correctly?
3. Was the correct entity/thread matched?
4. Was the next action correct?
5. Would the response have been appropriate?
6. Was human judgment requested only when necessary?
7. Was follow-up state preserved?

### Phase 7 — Live shadow mode

Process permitted live traffic without sending. Record what the operator would have done and compare outcomes against policy/human review.

### Phase 8 — bounded autonomy

Only after evidence supports it, separately authorize narrowly defined low-risk transactional replies. Pricing, contracts, unusual partnerships, complaints, refunds, legal/compliance-sensitive matters, consequential profile/listing changes, credentials, spending, and novel cases remain human-gated unless explicitly governed later.

## Tenant examples

### TheBinMap

Expected intents include:

- store submission;
- listing claim;
- correction/update;
- owner/operator;
- supplier;
- advertiser/sponsorship;
- partnership;
- data/intelligence request;
- shopper question;
- alert/signup/system event;
- spam/irrelevant.

### TherapistIndex

Expected intents include:

- therapist/practice submission;
- listing claim;
- correction;
- removal request;
- practice/group inquiry;
- patient lead;
- license/data issue;
- partnership;
- marketing/advertising;
- system/moderation event;
- spam/irrelevant.

Higher-trust profile changes must preserve stronger identity/evidence gates than routine TheBinMap factual updates.

### QuantumShield Labs

V1 architecture must not prevent later use for:

- service inquiry;
- security review lead;
- repo/token scan customer;
- technical question;
- partnership;
- enterprise assessment;
- support;
- agent-commerce event.

## Operating metrics

Every evaluation/live-shadow run should be able to report:

- received;
- classified;
- matched to thread/entity;
- no-action/system events;
- draft candidates;
- human-review cases;
- commercial opportunities;
- follow-ups due;
- resolved;
- uncertain/blocked;
- policy violations;
- errors.

Primary value metric: **human attention bought back without loss of trust or evidence.**

## Mission UI / observability principle

**Surface live intelligence broadly; surface required human action narrowly.**

Primary Mission UI should answer: **What needs my attention right now?**

Operations and intelligence observability should answer: **What is the system seeing, deciding, and learning?**

Rich telemetry is desirable, but it should be progressive-disclosure telemetry. Human governance, approvals, blockers, uncertainty, and required action should be prominent in mission-critical surfaces. General metrics, trends, throughput, confidence, classifications, continuity quality, recommendation agreement rates, commercial signals, and system health belong in distinct but easily reachable observability surfaces.

## Engineering rules

1. Reuse existing Email Operations primitives before adding new infrastructure.
2. Prefer compact structured state over giant context windows.
3. One canonical implementation, tenant-specific policy packs.
4. Real historical messages are the primary evaluation set; synthetic fixtures supplement them.
5. Do not pause for progress approval during reversible branch work/tests/docs unless a real authority, safety, secret, or production gate is reached.
6. Do not clean unrelated repository state as part of this mission.
7. Never infer a commercial outcome that did not occur.
8. Never make the human solve the same routine conversation class twice: once understood and proven, capture it as policy/test evidence.

## Explicitly out of scope for V1 branch work without separate approval

- merge;
- production deployment;
- enabling scheduled polling where currently disabled;
- enabling outbound sending;
- changing credentials/secrets;
- spending money;
- sending campaigns;
- binding pricing or contractual commitments;
- destructive listing/profile actions;
- unrelated Virtuals/CrawDaddy work;
- generalized infrastructure that is not required by a real conversation case.

## Definition of the first useful milestone

V1 milestone 1 is complete when a set of real historical messages from both TheBinMap and TherapistIndex can be replayed through:

`classification → structured extraction → thread/entity context → conversation state → next action → draft/no-action/human gate`

with deterministic evidence-preserving output and no live outbound effect.

## Next implementation target

Start from the existing Email Operations queue and sorter. Implement the smallest schema/state extension necessary to represent one real TherapistIndex removal/correction case and one real TheBinMap submission/correction case end-to-end. Then generalize only what both cases prove reusable.

## Milestone 2 evidence — shadow evaluation + operator visibility

Completed on 2026-08-18 on `feat/directory-conversation-operator-v1` after Milestone 1 commit `988f6c928`.

- Added deterministic shadow-only evaluation for structured conversation records.
- Persisted `conversation-shadow-evaluation` beside `conversation-record` during Email Operations ingestion.
- Exposed conversation/shadow fields in the existing Email Operations queue and issue detail tab.
- Added bounded batch evaluation reporting for received/classified/conversation-created/no-human/human-review/draft/commercial/uncertain metrics.
- Expanded historical replay coverage to 16 representative cases: 8 TheBinMap and 8 TherapistIndex.
- Verified that automatic outcomes remain shadow-only or draft-only; directory changes, identity-sensitive changes, commercial commitments, uncertain cases, and follow-ups remain human-gated.

Milestone 2 verification:

- `..\..\..\node_modules\.bin\vitest.CMD run` from `packages/plugins/plugin-email`: 23 files passed, 522 tests passed.
- `node_modules\.bin\tsc.CMD --noEmit -p packages/plugins/plugin-email/tsconfig.json`: passed.
- `node esbuild.config.mjs` from `packages/plugins/plugin-email`: passed.

Repo-wide `pnpm -r typecheck` was attempted but pnpm repeatedly entered a dependency-recreation path and stalled after `Recreating ...\node_modules`; direct plugin typecheck/build/tests were used for completed milestone verification.

## Milestone 3 evidence — conversation continuity + outcome replay

Completed on 2026-08-18 on `feat/directory-conversation-operator-v1` after Milestone 2 commit `b40b43b51`.

- Added deterministic `conversation-continuity` records that span multiple issue/message records.
- Linkage uses exact message references, thread keys, entity identity, or subject+sender evidence; ambiguous linkage fails closed with candidates and uncertainty reasons.
- Later deterministic replies can inherit prior entity context with provenance; contradictory new entity evidence is preserved as uncertainty instead of overriding prior facts.
- Added bounded follow-up representation: waiting, follow-up due, resolved, closed not interested, suppressed, and human-policy-required.
- Added outcome comparison for shadow recommendation vs known/human outcome: agreement, disagreement, or unknown/no evidence.
- Exposed continuity in the existing Email Operations queue and Store Intake detail tab: conversation ID, prior-message count, current/previous state, transition, follow-up status, human attention, and uncertainty.
- Expanded replay tests with multi-message scenarios for TheBinMap and TherapistIndex, including positive replies, no-interest replies, unsubscribe, owner corrections, listing removal clarification, and profile-claim identity follow-up.

Milestone 3 verification:

- `..\..\..\node_modules\.bin\vitest.CMD run tests/conversation-replay.spec.ts tests/conversation-continuity.spec.ts` from `packages/plugins/plugin-email`: 2 files passed, 26 tests passed.
- `..\..\..\node_modules\.bin\vitest.CMD run` from `packages/plugins/plugin-email`: 24 files passed, 530 tests passed.
- `node_modules\.bin\tsc.CMD --noEmit -p packages/plugins/plugin-email/tsconfig.json`: passed.
- `node esbuild.config.mjs` from `packages/plugins/plugin-email`: passed.

Repo-wide pnpm verification was not repeated for Milestone 3 because the same workspace repeatedly stalled after `Recreating ...\node_modules` during Milestones 2–3 attempts. The directly affected email plugin was tested, typechecked, and built comprehensively.

## Milestone 4A evidence — read-only live shadow report

Completed on 2026-08-19 on `feat/directory-conversation-operator-v1` after Milestone 3 commit `fc871432e`.

- Added a pure read-only live-shadow aggregation module over existing Email Operations issue state.
- Exposed the report through the existing plugin data-provider bridge as `live-shadow-report`; report generation reads existing intake/conversation/shadow/continuity/review state only.
- No mailbox access, polling, outbound email, directory mutation, config changes, schema changes, deployment, or service restart are part of this milestone.
- The report summarizes total considered records, classification/conversation creation, continuity linkage, entity continuity, human attention, draft/commercial/suppression/no-interest/follow-up states, recommendation agreement/disagreement/unknown, and records lacking sufficient outcome evidence.
- Breakdowns are included by tenant, intent, conversation state, next action, shadow action, linkage status/method, and risk/authority class.
- Outcome evidence remains fail-closed: existing deterministic continuity comparisons are counted; explicit human review `approvedNextAction` values are compared when present; coarse outcomes without deterministic next-action evidence remain `unknown`.

Milestone 4A verification:

- `..\..\..\node_modules\.bin\vitest.CMD run tests/conversation-live-shadow-report.spec.ts` from `packages/plugins/plugin-email`: 1 file passed, 6 tests passed.
- `..\..\..\node_modules\.bin\vitest.CMD run tests/conversation-replay.spec.ts tests/conversation-continuity.spec.ts tests/conversation-live-shadow-report.spec.ts` from `packages/plugins/plugin-email`: 3 files passed, 32 tests passed.
- `..\..\..\node_modules\.bin\vitest.CMD run` from `packages/plugins/plugin-email`: 25 files passed, 536 tests passed.
- `node_modules\.bin\tsc.CMD --noEmit -p packages/plugins/plugin-email/tsconfig.json`: passed.
- `node esbuild.config.mjs` from `packages/plugins/plugin-email`: passed.

This is not live staging validation. Milestone 4B remains the first operator-approved staging-data read/report pass, still without mailbox polling or new intake creation unless separately approved.

## Milestone 4B precheck — staging runtime blocked before deploy

Precheck performed on 2026-08-19 after Milestone 4A commit `6b5cd3cca`.

Documented staging targets:

- staging deployment path: `/opt/paperclip-deployments/thebinmap-email-ops-staging`;
- staging service: `paperclip-thebinmap-staging.service`;
- staging API: `http://127.0.0.1:3101/api`;
- production service: `paperclip-thebinmap-prod.service`;
- production public health endpoint remains separate at `https://paperclip.quantumshieldlabs.dev/api/health`.

Precheck result:

- local branch was clean and aligned with `origin/feat/directory-conversation-operator-v1`;
- public production health was read-only checked and returned healthy;
- direct staging API access on `69.62.69.140:3101` timed out, consistent with loopback-only staging;
- SSH access to the host was denied for the available identities tested, including the documented local key path `C:\Users\mikeb\Hostinger\hostinger_sshkey.txt`;
- no staging deploy, restart, plugin invocation, mailbox access, polling, outbound email, directory mutation, or configuration change occurred.

Milestone 4B remains blocked until an operator provides a working staging access path or an established deployment mechanism that can verify service identity, current runtime health, rollback target, post-deploy health, and unchanged outbound/polling safety settings.
