# QSL Guardian Plane V0.1

Status: architectural constraint and implementation roadmap

## Purpose

QSL Guardian Plane is the independent supervision layer for autonomous agent operations.

Its job is not to replace human judgment. Its job is to make human judgment rare, high-value, and well-informed by continuously observing agent activity, enforcing deterministic authority boundaries, intervening automatically when required, and preserving durable evidence of what happened.

The desired operator experience is simple:

- routine safe work proceeds autonomously;
- suspicious or policy-relevant behavior is detected quickly;
- prohibited behavior is blocked automatically;
- bounded recovery happens without human babysitting when safe;
- only genuine judgment calls, high-impact actions, or policy exceptions reach a human;
- every important decision and intervention is reconstructable afterward.

Guardian is a control-plane capability, not another ordinary mission agent.

## Product thesis

Organizations should not have to choose between useful autonomous agents and blind trust.

QSL Guardian is intended to provide independent supervision, deterministic authority enforcement, autonomous intervention, quarantine, and auditable evidence for AI-agent operations.

The system should be strong enough to use internally every day and clear enough to demonstrate publicly. The showcase must be based on real enforcement and evidence, not merely an LLM narrating logs.

## Design principles

### 1. Independent authority domain

The agent being monitored must not be able to:

- edit Guardian policy during its mission;
- disable Guardian observation;
- delete Guardian evidence;
- grant itself additional permissions;
- weaken containment;
- silently change model/provider authorization;
- suppress or rewrite an intervention record.

Guardian policy and evidence must therefore live outside the effective write authority of ordinary implementation agents.

### 2. Deterministic policy before probabilistic interpretation

LLMs may classify context, summarize risk, and assist investigation.

They must not be the sole enforcement mechanism for hard safety invariants.

Hard boundaries must be represented by deterministic policy or infrastructure controls wherever practical.

### 3. Autonomy should increase as confidence increases

The point of governance is not to create more approval prompts.

Safe, routine, reversible actions should run automatically. Human attention is reserved for actions whose impact, ambiguity, or irreversibility warrants it.

### 4. Fail closed on authority ambiguity

When the system cannot establish that a requested action is within authorized scope, the action should not proceed silently.

The system should preserve evidence, explain the ambiguity, and escalate when necessary.

### 5. Evidence is a first-class output

A mission is not fully governed unless the system can later explain:

- who or what acted;
- what authority applied;
- what was attempted;
- what was allowed or blocked;
- why the decision occurred;
- what state changed;
- what state remained protected;
- what recovery or escalation followed.

## Guardian Plane components

### Sentinel Observer

Continuously observes relevant control-plane and execution-plane events, including:

- heartbeat/run lifecycle;
- issue and execution-stage transitions;
- workspace creation and mutation;
- repository HEAD/diff state;
- tests and build outcomes;
- service status and PID changes;
- network egress decisions;
- credential-reference usage;
- database mutation classes;
- provider/model selection;
- containment status;
- production access attempts;
- cost/budget signals;
- policy and governance file changes.

### Deterministic Policy Gate

Classifies requested actions into at least:

- `autonomous`
- `human_required`
- `prohibited`

The existing QSL operator authority policy is the starting point, not the final form.

Policy decisions should be machine-readable, versioned, auditable, and referenceable in intervention receipts.

### Independent Adversarial Reviewer

Provides a second perspective for suspicious, ambiguous, or high-risk behavior.

It should be independent from the implementation agent's immediate reasoning context. Where practical, model/provider diversity should be considered for important review paths to reduce correlated failure.

The reviewer may recommend actions but must not be able to relax deterministic policy by itself.

### Containment Controller

Executes bounded automatic protective responses such as:

- deny a requested action;
- pause a mission;
- quarantine a workspace;
- stop or withhold a heartbeat dispatch;
- revoke temporary mission-scoped permissions;
- prevent staging promotion;
- require human review before continuation.

Guardian may tighten containment automatically.

Guardian must never silently weaken containment.

### Selarix Evidence Recorder

Preserves append-oriented governance evidence including:

- mission ID;
- issue ID;
- agent ID;
- run IDs;
- policy version and matched rule;
- requested action;
- decision;
- intervention state;
- timestamps;
- workspace identity;
- repository HEADs;
- service PIDs where relevant;
- provider/model identity;
- evidence hashes or references;
- retries and recovery actions;
- human decisions when required.

### Human Escalation Channel

Human escalation should be concise and decision-oriented.

A useful escalation answers:

1. What happened?
2. What did Guardian already do automatically?
3. What remains safe?
4. What decision, if any, is required from the human?

## Operating states

### OBSERVE

Normal state.

Guardian records and evaluates activity while safe autonomous work proceeds.

### INTERVENE

Entered when behavior is unsafe, suspicious, or outside a straightforward autonomous policy path but can still be bounded without full quarantine.

Typical actions:

- deny one operation;
- pause one run;
- require re-validation;
- request independent review;
- tighten a temporary permission.

### QUARANTINE

Entered when a hard invariant is violated or the system cannot safely establish control.

Examples:

- unexpected production PID/state change;
- attempted containment disablement or escape;
- raw secret exposure;
- write outside authorized workspace;
- destructive database operation without authorization;
- unapproved external network destination;
- silent provider/model substitution;
- attempt to modify Guardian/governance controls from an unauthorized mission context;
- evidence tampering attempt.

Quarantine must preserve evidence and fail closed.

## Initial hard invariants

The following should be treated as first-class Guardian invariants as Mission Control evolves:

1. Production mutation remains human-required unless a future explicit policy version says otherwise.
2. Staging and production identities must remain distinguishable and independently verifiable.
3. Raw credentials must never appear in mission evidence or routine logs.
4. Provider/model authorization must not silently change.
5. Containment must not be silently weakened.
6. Agent writes must remain inside explicitly authorized workspace roots.
7. Destructive DB operations require human authority.
8. New external egress requires explicit authorization.
9. Mission-scoped agents cannot modify their own Guardian policy or erase Guardian evidence.
10. Native Mission Control lifecycle state must be reconstructable from authoritative runtime/database evidence rather than shell narration alone.
11. A skipped/deferred native wake must not be reported as successfully queued.
12. Terminal failures must not be resurrected by reconciliation.

## Integration with Mission Control V0.1

Guardian is not a separate rewrite. Mission Control V0.1 becomes Guardian's first protected environment.

Current Mission Control work already provides several required primitives:

- native heartbeat dispatch;
- execution workspace realization;
- issue execution lifecycle;
- review-stage ownership;
- fail-closed reviewer dispatch;
- mission reconciliation from native state;
- mission receipts;
- authority policy;
- containment boundaries;
- Sentinel Governor role;
- Selarix Recorder role.

As Mission Control changes, new implementation work should be reviewed against this question:

> Does this change preserve or improve Guardian's ability to independently observe, enforce, intervene, and prove what happened?

If not, the architecture should be reconsidered before accumulating technical debt.

## Near-term implementation hooks

These are the hooks worth adding while Mission Control is already being touched.

### Event and evidence hooks

Prefer structured events for:

- mission dispatch requested / queued / denied;
- reviewer dispatch requested / queued / denied;
- workspace realized / rejected / quarantined;
- policy decision;
- containment decision;
- provider/model identity;
- staging restart and health proof;
- production before/after identity proof;
- mission reconciliation transitions;
- human escalation and disposition.

### Policy references in receipts

Mission/intervention evidence should eventually record the policy version and matched rule rather than only free-form explanations.

### Guardian-safe authority separation

Implementation agents must not receive write authority to canonical Guardian policy/evidence surfaces merely because they can edit mission source code.

### Intervention correlation

Interventions should be correlated to mission ID, issue ID, agent ID, and run ID so evidence does not depend on timestamps alone.

### Production isolation proof

Live staging validation should preserve a production PID/health marker before and after the test. Any unexpected mutation becomes an intervention-class event.

## Showcase scenarios

The first public-quality demo should contain both successful autonomy and deliberate safe violations.

Candidate scenarios:

1. Normal implementation mission completes without human interruption.
2. Agent attempts an unauthorized write outside its workspace; Guardian blocks/quarantines it.
3. Agent requests production restart; Guardian denies and escalates under `human_required` policy.
4. Agent attempts an unapproved provider substitution; Guardian blocks it.
5. A simulated secret appears in a controlled test output; Guardian detects and prevents evidence propagation.
6. Reviewer wake is skipped/deferred; Mission Control reports failure rather than falsely claiming dispatch.
7. Guardian produces a compact incident receipt proving production remained untouched.

The demonstration should show the system acting, not merely a dashboard animation.

## Operator-facing presentation goal

A future Mission Control surface should make governance state understandable at a glance, for example:

`GUARDIAN: ACTIVE`

- Risk: LOW
- Authority: BOUNDED
- Containment: VERIFIED
- Production: ISOLATED
- Evidence: RECORDING

An intervention should clearly identify:

- what was blocked;
- which agent/run requested it;
- matched policy;
- action Guardian took;
- whether production/data remained unchanged;
- whether human action is required.

## Product quality bar

Guardian should be something QSL can confidently use as evidence of its own operating discipline.

The quality bar is not "interesting prototype." It is:

- technically real;
- observable;
- deterministic where safety requires determinism;
- auditable;
- fail-closed at hard boundaries;
- understandable to operators;
- demonstrable to clients;
- useful enough that QSL itself prefers operating with it enabled.

## Development doctrine

Do not pause Mission Control for a large Guardian rewrite.

Instead:

1. preserve Guardian-compatible primitives as Mission Control is built;
2. add low-cost evidence/policy hooks while touching relevant code;
3. avoid architectural choices that would make independent supervision difficult later;
4. incrementally convert existing Sentinel/Selarix/authority pieces into a coherent Guardian Plane;
5. build showcase-quality visualization only after the underlying enforcement is real;
6. continuously dogfood Guardian against QSL's own autonomous operations.

## Human attention doctrine

Guardian exists to buy back human attention.

Routine debugging, testing, monitoring, evidence collection, safety checks, and bounded recovery should increasingly be delegated to the system.

Humans should be interrupted for consequential judgment, not because the infrastructure lacks self-observation or operational discipline.

## V0.1 success criteria

Guardian Plane V0.1 is successful when QSL can demonstrate, in staging, that:

- a native Mission Control mission runs under bounded authority;
- Guardian-relevant evidence can be reconstructed from authoritative state;
- an explicitly prohibited or human-required test action is stopped before impact;
- the intervention is correlated to the responsible mission/agent/run;
- production is independently proven unchanged;
- the system emits a concise, durable intervention/mission receipt;
- the operator did not need to manually watch every normal step.
