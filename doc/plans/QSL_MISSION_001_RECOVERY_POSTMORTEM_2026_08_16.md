# QSL Mission #001 — Recovery Postmortem

Date: 2026-08-16
Status: **CLOSED — no runtime repair justified by retained evidence**
Scope: initial QSL-5 implementation failure and subsequent native recovery

## Executive finding

Mission #001 did not fail as a mission.

Its first native implementation heartbeat failed, but Paperclip's native continuation/recovery lifecycle subsequently produced implementation evidence, routed the issue through Sentinel review, and reconciled the operator mission to `completed` with review verdict `approved`.

The confirmed defect exposed by the test was in the **proof assumption**: the earlier harness treated failure of the original implementation run as equivalent to failure of the whole mission. Mission #001 proves that this is not a valid invariant for the native Paperclip lifecycle.

The low-level exception behind the first failed heartbeat is not present in the retained read-only diagnostic, so this postmortem does not invent one.

## Incident identity

- issue: `QSL-5`
- issue ID: `825b45f0-f24d-4064-9fb7-2c839e3a0491`
- mission ID: `LIVE-20260816T170208Z-20985`
- authority scope: `autonomous`
- original implementation run: `69107a1b-617d-48b5-bdeb-df4d3d78b028`
- Mission Control Director: `0db9b4e5-531b-4fe6-9e02-a28ccbe0b9f3`
- final Sentinel review run: `bf040aef-416b-4c80-a351-2dbb6406f0f4`
- proof HEAD: `1348c83d08f1dc2e1f6db728e79127953656ae3e`

## Initial symptom

The native Mission Control POST created implementation run:

```text
69107a1b-617d-48b5-bdeb-df4d3d78b028
```

The retained lifecycle events for that run are:

```text
run started
run failed
run scratch cleaned
```

This was initially interpreted by the external proof harness as a terminal implementation failure.

That interpretation was premature.

## What is ruled out

### 1. Mission dispatch failure — ruled out

The operator mission persisted the original implementation run as a native heartbeat dispatch with mechanism `native_heartbeat`.

Therefore Mission Control successfully crossed the orchestration boundary and created the intended implementation execution.

### 2. Provider credential resolution failure — ruled out

At `2026-08-16 17:02:12.017937+00`, Paperclip recorded successful resolution of `OPENROUTER_API_KEY` for the Mission Control Director correlated to the original implementation run.

Later Director and Sentinel recovery/review runs resolved the governed key successfully as well.

No raw secret value is needed to establish this fact.

### 3. Old workspace-permission failure — not supported

The evidence does not show the prior root-created `/tmp` workspace `EACCES` failure that affected earlier Hermes POCs.

Mission #001 progressed through multiple subsequent Hermes-backed Director and Sentinel runs, including successful implementation/review activity. There is therefore no evidence basis for reopening the already-repaired historical workspace-permission defect.

### 4. Persistent Hermes configuration failure — not supported

The inspected Director configuration was coherent and later executed successfully through the same governed lane:

```text
adapter_type=hermes_local
command_dialect=openclaw
hermes_command=/usr/local/bin/openclaw
provider=openrouter
model=openrouter/deepseek/deepseek-chat
timeout_sec=1800
max_turns=50
cwd_access=ro
```

The mission's later native runs succeeded using the same runtime family. A persistent adapter/configuration break would not fit the observed recovery and completion evidence.

## What the native runtime did after the failure

The final run lineage contains the following significant transitions:

```text
Mission Control Director | failed    | operator_mission_requested
Mission Control Director | succeeded | issue_continuation_needed
Sentinel Governor         | succeeded | execution_review_requested
Sentinel Governor         | succeeded | execution_review_participant_recovery
Sentinel Governor         | succeeded | source_scoped_recovery_action
Mission Control Director | succeeded | execution_changes_requested
Mission Control Director | succeeded | missing_issue_comment
Mission Control Director | cancelled | issue_continuation_needed
Mission Control Director | failed    | source_scoped_recovery_action
Sentinel Governor         | succeeded | execution_review_requested
```

This is not a simple retry loop. It is a multi-stage native lifecycle involving implementation continuation, governance review, participant recovery, requested changes, evidence/comment repair, deliberate cancellation while waiting for review, further scoped recovery, and final review.

## Evidence/comment recovery

The issue received the required implementation marker:

```text
QSL_IMPLEMENTATION_PROOF 20260816T170208Z-20985
```

At least one successful run ended without an issue comment, and Paperclip queued a follow-up wake specifically to require the missing comment. That follow-up mechanism is represented by the `missing_issue_comment` wake reason in the final lineage.

This is important: a completed agent invocation without durable issue evidence is not treated as sufficient mission completion.

## Review-state recovery

The issue thread later recorded that Paperclip had automatically retried continuation after the live execution disappeared but had no live execution path while waiting on review. The latest cause was recorded as:

```text
issue_continuation_waiting_on_review
```

The system moved the issue to `blocked` so that the condition was visible for intervention rather than silently spinning.

The recovery owner subsequently recorded that the implementation proof existed and the task had completed successfully.

Sentinel then produced the required approval marker and review disposition.

## Terminal state

The later reconciliation call transformed the previously stale operator-mission record into the exact terminal state supported by the issue/run evidence:

```text
ISSUE_STATUS=done
MISSION_STATUS=completed
TERMINAL_STATUS=completed
REVIEW_VERDICT=approved
REVIEW_RUN_ID=bf040aef-416b-4c80-a351-2dbb6406f0f4
```

This proves the mission converged.

## Confirmed root cause: proof-harness assumption

The confirmed root cause of the *test failure interpretation* was:

> The proof harness assumed that the originally returned implementation run ID was the complete mission lifecycle and treated its failed status as an immediate terminal verdict.

That assumption conflicts with native Paperclip behavior, where an issue can legitimately spawn continuation, recovery, review, evidence-repair, and reviewer-recovery heartbeats after an intermediate run ends.

For native Mission Control tests, the durable unit of success is therefore the **operator mission + source issue terminal convergence**, not the status of the first heartbeat alone.

## Low-level first-run cause: unresolved from retained evidence

The retained diagnostic preserves only the lifecycle event `run failed` for `69107a1b-617d-48b5-bdeb-df4d3d78b028`. It does not preserve the associated low-level exception, stderr payload, or adapter error body.

The recovery thread itself states that retry failure details may be withheld from the issue thread and should be inspected on the linked run.

Therefore the low-level first-run cause is classified as:

**UNKNOWN FROM RETAINED EVIDENCE — NON-BLOCKING AFTER SUCCESSFUL NATIVE RECOVERY**

This is deliberately different from declaring the failure unimportant. It means there is not enough evidence to justify changing runtime configuration or adapter code.

## Corrective action

### Required

1. Proof harnesses must follow the operator mission/source issue to terminal convergence.
2. Intermediate heartbeat failures must be recorded but must not automatically terminate the proof when native recovery remains active.
3. Final validation must require durable implementation evidence and Sentinel review evidence, not merely a successful process exit.
4. Reconciliation should be invoked/read before declaring a mission terminal when the issue/recovery graph has continued after the original run.
5. Guardian authority tests must independently assert zero implementation runs and zero provider-secret resolutions for `human_required` requests.

### Not justified

Based on current evidence, do **not**:

- change Hermes provider/model configuration;
- alter OpenRouter credential bindings;
- reopen the historical workspace-permission repair;
- disable native continuation/recovery;
- replace native orchestration with manual wakeups;
- add broad retry behavior merely to force a green test;
- change production.

## Optional future observability improvement

A future non-emergency improvement may preserve a sanitized failure classification/code for every failed heartbeat in durable mission evidence, while keeping sensitive stderr/secret material out of issue comments.

That would make a later forensic review able to distinguish, for example, provider, adapter, tool, API-contract, workspace, or policy failures without requiring access to ephemeral run scratch data.

This is an observability enhancement, not a prerequisite for accepting Mission #001.

## Lessons

1. **Mission state is larger than process state.** One failed heartbeat does not imply a failed mission.
2. **Recovery is part of the architecture.** A valid proof must observe it rather than race against it.
3. **Evidence is part of completion.** Missing durable issue evidence legitimately triggers follow-up work.
4. **Governance is part of execution.** Sentinel review and recovery are native lifecycle participants.
5. **Fail-closed authority remains separate.** The QSL-6 Guardian proof withheld `human_required` dispatch before heartbeat creation or secret resolution.
6. **Do not repair what the evidence does not show is broken.** The low-level first-run cause remains unknown, while the mission-level architecture is proven.

## Closure decision

**CLOSE the Mission #001 incident as a successful native recovery validation with a corrected proof-harness model.**

No runtime repair is required before accepting the Mission #001 result.

Any investigation into the first run's exact low-level exception should be a narrowly scoped observability/forensics task and must not disturb the now-proven native lifecycle.
