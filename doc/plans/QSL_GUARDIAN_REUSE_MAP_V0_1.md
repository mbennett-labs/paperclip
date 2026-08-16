# QSL Guardian Plane — Reuse Map V0.1

Date: 2026-08-16
Status: active implementation map
Applies to: `feat/qsl-native-mission-orchestration-v0-1`

## Purpose

Guardian Plane should be built by promoting proven QSL/Paperclip controls, not by creating a parallel security framework that duplicates existing runtime authority, liveness, secret, review, workspace, and evidence systems.

This document records:

- proven legacy QSL Guardian concepts worth preserving;
- current Paperclip primitives Guardian should reuse directly;
- legacy components that should **not** be wholesale cherry-picked;
- the gaps that remain Guardian-specific;
- the near-term implementation order while Mission Control V0.1 is still being hardened.

## Primary decision

**Do not wholesale cherry-pick the May 2026 Runtime Guardian stack into the current upstream-derived Paperclip branch.**

The old Guardian lineage and the current branch have materially diverged. The July preservation matrix correctly classified the standalone runtime Guardian/governance scripts as **PORT OR REIMPLEMENT**, while heartbeat/provider/approval changes required review against the evolved upstream implementation.

The implementation strategy is therefore:

1. preserve the legacy Guardian ideas and evidence model;
2. reuse current native Paperclip enforcement/audit primitives wherever they are stronger;
3. port only missing low-coupling concepts;
4. keep Guardian outside ordinary mission-agent write authority;
5. correlate evidence to mission/issue/run identifiers rather than timestamps alone;
6. avoid a second mission state machine, a second secret store, or a second liveness engine.

---

## Proven legacy QSL Guardian lineage worth preserving

### Runtime Guardian V4

Legacy `scripts/runtime_guardian.py` was read-only by default and provided:

- topology health checks;
- backup freshness checks;
- orphan/stale/duplicate detection;
- weighted health scoring across governance dimensions;
- governance escalation tracking;
- durable JSON operational logs.

**Reuse decision:** preserve these concepts as environment-health and continuity observation. Do not use the legacy Python process as the new Mission Control authority engine.

### Runtime Remediator V3

Legacy `scripts/runtime_remediator.py` established a useful separation:

- Guardian detects and prepares remediation automatically;
- safe/read-only actions can be automatic;
- mutating actions can require approval;
- plans carry issue fingerprints, occurrence counts, creator/approver/executor metadata;
- no silent destructive operations.

**Reuse decision:** preserve the detect → classify → prepare → approve/execute lifecycle as prior art for Guardian intervention receipts and bounded remediation.

### Governance Checkpoint Recorder

Legacy governance checkpoints provided:

- deterministic state capture;
- health/topology/risk/remediation/deployment-readiness summaries;
- SHA-256 integrity hashes;
- append-oriented checkpoint indexes;
- continuity chains;
- machine JSON and human Markdown views.

**Reuse decision:** preserve this as prior art for Selarix/Guardian evidence chains. Mission Control evidence itself should be sourced from current authoritative runtime/database state.

---

## Current Paperclip primitives Guardian should reuse directly

### 1. Native Mission Control heartbeat dispatch

Current Mission Control dispatch uses native `heartbeat.wakeup` and persists run identity/evidence. Shell orchestration is retained only as a manual/compatibility surface.

Guardian use:

- heartbeat run ID is the primary execution correlation ID;
- a null/skipped/deferred wake must not be represented as queued;
- Guardian evidence should attach to authoritative heartbeat state.

### 2. Native mission lifecycle reconciliation

Current mission reconciliation derives lifecycle state from issue + heartbeat runtime state and preserves terminal fail-closed outcomes.

Guardian use:

- consume native state instead of creating a second mission state machine;
- project intervention/evidence into mission receipts while leaving runtime truth with Paperclip.

### 3. Deterministic `human_required` dispatch gate

Mission POST now validates `authorityScope` and treats `human_required` as a durable pre-dispatch gate:

- mission record is persisted;
- authority-gate evidence is persisted;
- mission becomes `escalated`;
- terminal reason becomes `human_approval_required`;
- implementation heartbeat is withheld entirely.

Guardian use:

- this is the first direct Guardian-style authority gate in Mission Control;
- future policy classification should use the same enforce-before-dispatch pattern;
- an LLM must not be able to silently override this gate.

### 4. Native execution-policy/reviewer ownership

Mission Control uses Paperclip's execution stages and explicit reviewer dispatch. Reviewer wake is fail-closed when Paperclip does not queue a run.

Guardian use:

- typed reviewer/approver ownership remains authoritative;
- Guardian may observe, require, or escalate review;
- Guardian must not impersonate a typed reviewer or bypass its stage.

### 5. Task watchdog and server-enforced mutation scope

Current Paperclip has an opt-in task watchdog that verifies stopped issue subtrees. The most important reusable security property is the **server-side scope envelope**, not merely the watchdog prompt.

Current scope enforcement:

- derives watchdog scope from persisted heartbeat-run context;
- validates run/agent/company identity;
- requires an active persisted watchdog record;
- restricts mutation to the watched issue subtree;
- rejects cross-company/out-of-subtree mutation;
- custom instructions cannot expand server authority.

Guardian use:

- strong prior art for a future Guardian run envelope;
- Guardian reviewers/monitors should receive persisted server-verified scope, not prompt-granted authority;
- ordinary mission agents must not be able to mutate Guardian policy/evidence merely because their instructions say they can.

### 6. Secret binding and native secret-access audit

Current `secretService` enforces binding context and records `secretAccessEvents` when secrets are resolved.

Safe access-event metadata can include:

- company ID;
- secret ID;
- secret version;
- provider;
- responsible-user / credential-owner metadata where applicable;
- actor type and actor ID;
- consumer type and consumer ID;
- config path;
- issue ID;
- heartbeat run ID;
- plugin ID;
- outcome;
- error code.

The plaintext value is not part of the access-event record.

Guardian use:

- credential provenance should be derived primarily from native binding/access events;
- provider dashboard `last used` timestamps are corroborating telemetry, not sole causal proof;
- receipts can safely state which secret reference/version/provider was resolved for a run without disclosing the value;
- unexplained substitution or access from the wrong run/consumer is an intervention-class signal.

See also `QSL_GUARDIAN_CREDENTIAL_PROVENANCE_NOTE_2026_08_16.md`.

### 7. Secret provider/vault controls

Current Paperclip supports provider-vault metadata, explicit vault selection, external references, health checks, binding enforcement, and response redaction.

Guardian use:

- do not create a separate Guardian credential store;
- observe the selected provider/vault/reference and native access events;
- raw provider credentials remain outside ordinary mission evidence.

### 8. Agent invokability and org-chain validation

Current `agent-invokability.ts` blocks direct invocation for paused, terminated, pending-approval, missing, unknown-status, and invalid reporting-chain states.

Guardian use:

- reuse this as a precondition rather than creating a Guardian-specific agent-status check;
- a quarantined/paused agent should naturally become non-invokable through native state;
- invalid org chains are already fail-closed execution signals.

### 9. Budget/cost enforcement

Current `costs.ts` records provider/run costs and evaluates budget policy after cost events. Current `budgets.ts` supports:

- company/project/agent scopes;
- warning and hard-stop thresholds;
- budget incidents;
- approval generation for hard thresholds;
- scope pause;
- optional cancellation of active work;
- audited budget state.

Guardian use:

- consume this instead of adding a second spending limiter;
- budget hard-stop is already a useful intervention primitive;
- future Guardian UI can surface native budget incidents as Guardian interventions when appropriate.

### 10. Authorization service

Current authorization evaluates board/agent identity, company boundaries, explicit grants, low-trust boundaries, assignment restrictions, protected-agent requirements, and unsupported/ambiguous policy fail-closed paths.

Guardian use:

- Guardian policy must compose with native authorization rather than bypass it;
- mission-specific authority may narrow existing rights but should not silently broaden them;
- unknown/unsupported policy should remain fail-closed.

### 11. Execution workspace policy and workspace lifecycle

Current workspace services already provide:

- execution workspace realization and persistence;
- shared/isolated/operator/adapter-managed strategies;
- git-worktree branch coherence checks;
- workspace validation/recovery;
- quarantine-restore semantics;
- project/issue authorization/runtime policy surfaces;
- runtime service tracking.

Guardian use:

- do not create a second workspace manager;
- observe/enforce through native workspace IDs and validation state;
- promote existing quarantine/recovery concepts into Guardian intervention semantics;
- write-root containment remains an infrastructure/runtime responsibility, with Guardian observing and reacting to violations.

### 12. Heartbeat liveness and recovery

Current `heartbeat.ts` already composes:

- run liveness classification;
- issue re-wake throttling;
- recovery services;
- successful-run handoff recovery;
- pause-hold suppression;
- task watchdog reconciliation;
- agent invokability;
- budget enforcement;
- secret resolution;
- execution workspaces;
- low-trust runtime containment;
- redaction;
- effective-run config fingerprints.

Guardian use:

- do not resurrect the legacy Guardian as another scheduler;
- consume native heartbeat/recovery signals;
- Guardian should intervene only where native recovery cannot safely decide or where a hard security/governance invariant is crossed.

### 13. Effective run configuration fingerprints

Current heartbeat imports effective-run config fingerprinting, including secret-manifest typing.

Guardian use:

- treat configuration fingerprint drift as a first-class observation signal;
- correlate provider/model/secret-reference configuration with the run that actually executed;
- do not expose secret values while comparing runtime identity.

### 14. Current CI validation lane

`.github/workflows/qsl-mission-control-validation.yml` now validates the feature branch automatically on Node 22 with:

- frozen dependency installation;
- server typecheck;
- focused Mission Control tests;
- server build;
- native shell-boundary proof.

Guardian use:

- routine validation should happen automatically rather than consume operator attention;
- CI output becomes supporting evidence for staging promotion;
- live staging proof remains separate because CI cannot prove runtime/service isolation on the VPS.

---

## What Guardian still needs that current primitives do not fully provide

### A. Versioned Guardian policy decisions

Need a machine-readable decision record such as:

- policy version;
- rule ID;
- requested action class;
- decision: `allow | human_required | prohibit`;
- reason code;
- subject/mission/run IDs.

Free-form text alone is insufficient for durable policy evidence.

### B. First-class intervention records

Need a durable structure for:

- intervention ID;
- mission/issue/run/agent correlation;
- trigger/evidence references;
- matched policy rule;
- action taken;
- state before/after;
- human decision if required;
- resolution status.

This can begin as structured mission evidence/activity records before a dedicated table is justified.

### C. Explicit Guardian quarantine contract

Paperclip has several quarantine/recovery concepts, but Guardian needs a coherent product-level contract:

- what is quarantined: run, mission, workspace, agent, or promotion;
- which native state change implements it;
- what evidence is mandatory;
- what can auto-release vs requires human release;
- Guardian may tighten containment automatically but may not silently weaken it.

### D. Guardian-specific server scope envelope

Task-watchdog scope is strong prior art, but Guardian eventually needs a distinct persisted scope envelope for independent reviewers/monitors that cannot be broadened by prompts.

### E. Production isolation observer

Need a deterministic before/after environment identity proof for staging operations:

- production service identity/PID/start marker;
- staging service identity/PID/start marker;
- expected changes vs unexpected changes;
- unexpected production mutation becomes an intervention-class event.

### F. Credential provenance reconciliation

Need a Guardian read model that can answer:

> Which non-secret credential reference/version/provider was authorized and actually resolved for this run?

Primary source: Paperclip secret binding + `secretAccessEvents` + run config fingerprints.

Secondary corroboration: provider-side request/key usage metadata where available.

### G. Tamper-evident Guardian/Selarix evidence chain

Legacy governance checkpoints proved the concept. Current Mission Control receipts should eventually gain:

- stable canonical serialization;
- content hash;
- optional previous-receipt hash;
- export/verification tooling;
- later signing/attestation if warranted.

Do not delay V0.1 live proof for full cryptographic signing.

---

## Near-term implementation order

### Gate 1 — Mission Control source/CI safety

- native dispatch and reviewer paths;
- `human_required` pre-dispatch gate;
- focused CI/typecheck/build;
- shell-boundary regression;
- keep PR draft.

### Gate 2 — Staging data-safety proof

Read-only staging inspection before schema mutation:

- prove exact staging/prod service identities;
- query embedded PostgreSQL for duplicate `(company_id, mission_id)` rows;
- inspect current `operator_missions` indexes;
- inspect non-secret staging provider/model/secret binding metadata;
- inspect relevant native secret-access events without secret material;
- prove production unchanged.

### Gate 3 — DB uniqueness hardening

Only if Gate 2 proves no duplicates:

- add a **new** migration for DB-level uniqueness;
- do not rewrite migration `0183`;
- run CI automatically;
- deploy/restart staging only;
- prove schema/startup health and production isolation.

### Gate 4 — Live native lifecycle proof

Controlled staging-only mission:

- mission record;
- native implementation heartbeat run;
- workspace realization;
- secret/provider/model provenance evidence;
- native review transition and reviewer run;
- mission reconciliation;
- receipt;
- production unchanged.

### Gate 5 — Guardian intervention proof

After the normal lifecycle is proven:

- execute one safe `human_required` or prohibited test scenario;
- prove implementation dispatch is withheld before impact;
- produce correlated intervention evidence;
- show concise operator-facing result.

---

## Anti-duplication rules

Guardian V0.1 must **not** introduce:

- another mission scheduler;
- another agent liveness engine;
- another workspace manager;
- another secret store;
- another budget ledger;
- another authorization system;
- another reviewer state machine;
- an LLM-only safety gate;
- production mutation authority hidden inside a monitor agent.

If a native primitive exists, Guardian should observe, compose, narrow, or escalate it.

---

## Product interpretation

The strongest Guardian story is not "QSL built a security bot."

It is:

> QSL turns the native execution, authorization, secret, workspace, cost, review, recovery, and evidence primitives of an agent platform into an independent supervision plane that can prove what autonomous systems were allowed to do, what they actually did, what was blocked, and why.

That is the architecture to dogfood internally and eventually demonstrate to clients.
