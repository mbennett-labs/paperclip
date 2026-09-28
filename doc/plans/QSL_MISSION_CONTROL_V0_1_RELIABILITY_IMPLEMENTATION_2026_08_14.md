# QSL Mission Control V0.1 Reliability Implementation — 2026-08-14

## Purpose

Repair the control-plane defects exposed by the first live QSL Mission Control flight (`QSL-1 — Mission 001 — Finish Operator Loop V0.1`) without manually completing the mission for the Director.

The benchmark stays **BLOCKED** until this reliability slice is deployed and verified in staging.

## First-flight root causes confirmed in source

### 1. Hermes starts contained workers in an empty run sandbox

For contained `hermes_local` runs, the adapter resolves an operator/runtime `cwd`, but starts the child process in the run-specific containment workspace. The real `cwd` is mounted as an extra read-only path.

That is safe for an orchestrator, but the first-flight Director was not told the canonical staging repository path and therefore reasoned from an empty OpenClaw workspace and invented filesystem expectations.

### 2. Director authority was not paired with a working control-plane channel

The QSL Director has Paperclip worker-creation authority, but its V0 adapter config inherited `allowPaperclipApiAccess: false` from the synthetic Hermes lane.

Even if that flag is enabled, current Hermes containment with the OpenRouter preset only permits `openrouter.ai:443`. A contained Director therefore cannot reach the staging Paperclip API at `127.0.0.1:3101` unless that exact loopback target is added to the sandbox network allowlist.

This explains why the first flight stayed concentrated in repeated Director runs instead of assembling temporary Mission Cells.

### 3. `adapter_failed` is globally treated as transient with three continuation attempts

`server/src/services/recovery/service.ts` classifies `adapter_failed` as transient infrastructure and assigns `CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS = 3`.

The recovery loop counts failed `issue_continuation_needed` runs and blocks only after that platform retry allowance is exhausted. QSL-1's prose instruction `Maximum one bounded repair retry` was never machine-readable, so runtime recovery could not enforce it.

### 4. Main issues have no structured acceptance-criteria field

The main create/update issue schema accepts `executionPolicy` but not top-level structured acceptance criteria. Child issue creation has an `acceptanceCriteria` convenience field, but the primary mission does not.

Continuation therefore had to infer acceptance criteria from prose and the first-flight summary lost all nine.

### 5. Execution policy already provides the correct persistence seam

`issues.execution_policy` is JSONB and `issueExecutionPolicySchema` is the governed validator. This allows a backward-compatible structured `missionContract` extension without a database migration.

## V0.1 design

### A. Governed mission contract

Add optional `executionPolicy.missionContract`:

- `version: 1`
- `objective`
- `authorityLevel` (`L0`-`L4`)
- `acceptanceCriteria[]` with stable `{id,text}` records
- `maxRepairRetries`
- `requiredStages[]` (`implementation`, `verification`, `sentinel_review`, `provenance_receipt`)
- `provider`
- `model`
- `productionIsolationRequired`

The contract is additive and optional for ordinary Paperclip issues.

### B. Retry budget must be a hard cap

Recovery keeps Paperclip's normal failure classification, but when a mission contract supplies `maxRepairRetries`, the effective continuation retry allowance is:

`min(platform retry allowance, mission contract maxRepairRetries)`

A mission contract may make recovery stricter. It may never make platform recovery looser.

For `QSL-1`, `maxRepairRetries = 1` means:

1. source run fails;
2. one bounded continuation retry may run;
3. if that retry fails, transition to `BLOCKED` with one meaningful escalation.

### C. Contained Paperclip API access is exact and loopback-only

When `allowPaperclipApiAccess` is true under Hermes containment:

- require the configured Paperclip API URL to be HTTP and loopback (`127.0.0.1` or `localhost`);
- add only its exact host/port to the existing sandbox allowlist;
- preserve OpenRouter as the only external provider egress;
- fail closed for a non-loopback Paperclip API URL.

No broad network access is introduced.

### D. Director is an orchestrator, not the default coding worker

The persistent Director remains in an ephemeral writable sandbox with the canonical staging repo mounted read-only.

Its managed instructions must explicitly identify the governed staging repository and require discovery of real source-controlled evidence before diagnosing missing files.

For coding missions the Director should create temporary specialists:

- **Staging Engineer** — canonical staging repository as its contained writable workspace; bounded L0/L1 implementation authority.
- **Verification Engineer** — independent read-only inspection of the canonical repo/work product; no implementation role.

Sentinel Governor and Selarix Recorder remain persistent control-plane participants.

### E. Resource manifest

Mission Control receives an explicit resource/capability manifest rather than relying on guessed paths. V0.1 must at minimum describe:

- canonical staging repo path;
- expected branch at dispatch time;
- production service as read-only evidence only;
- staging service as governed L1 operational surface;
- allowed model/provider lane;
- Paperclip staging API as the internal coordination channel;
- company skills and persistent control-plane members;
- prohibited broad process termination and production mutation.

The manifest must distinguish available, read-only, writable, executable, and human-gated resources.

## Deployment contract

1. Work on an isolated local reliability branch created from the **current staging HEAD**, not stale GitHub `master` or the older remote integration ref.
2. Capture production service/PID/health before modification.
3. Apply source changes fail-closed; abort on unexpected source shapes.
4. Run targeted unit tests plus typecheck/build appropriate to touched packages.
5. Restart **only** `paperclip-thebinmap-staging.service` by exact unit name.
6. Verify staging health.
7. Verify production service/PID/health continuity.
8. Commit the reliability slice on the local branch.
9. Update QSL Mission Control persistent-member configurations/instructions idempotently.
10. Do not unblock or rerun QSL-1 until all deployment checks pass.

## Benchmark retry acceptance

The second flight of the same Operator Loop mission must demonstrate:

1. canonical staging repo resolved before diagnosis;
2. nine acceptance criteria preserved as structured mission state;
3. retry allowance machine-enforced at one;
4. Director delegates implementation to a temporary Staging Engineer;
5. independent Verification Engineer participates;
6. Sentinel review is visible;
7. Selarix final receipt/provenance is visible;
8. unsupported filesystem assumptions do not become root-cause facts;
9. production remains untouched with continuity evidence;
10. terminal result is verified `COMPLETED` or one meaningful `BLOCKED` escalation.

## Non-goals

- Do not create the model-invented missing files from the first flight.
- Do not wholesale-merge current upstream Paperclip.
- Do not expose staging publicly.
- Do not add external egress beyond the already-approved provider lane.
- Do not build Observatory UI until this execution contract produces trustworthy activity to observe.
