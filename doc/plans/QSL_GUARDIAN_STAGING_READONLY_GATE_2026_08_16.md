# QSL Guardian / Mission Control — Staging Read-Only Gate Evidence

Date: 2026-08-16
Status: PASS
Scope: TheBinMap Email Operations staging instance only
Production mutation: none
Database mutation: none
Service restart: none

## Purpose

Establish the data-safety and credential-provenance preconditions required before adding database-level mission identity uniqueness and before the live native Mission Control lifecycle proof.

## Service identity baseline and final proof

The read-only gate captured service identity before and after all inspection.

Staging:

- service: `paperclip-thebinmap-staging.service`
- active: yes
- PID before: `92865`
- PID after: `92865`
- start timestamp before: `Sat 2026-08-15 16:17:04 UTC`
- start timestamp after: `Sat 2026-08-15 16:17:04 UTC`

Production:

- service: `paperclip-thebinmap-prod.service`
- active: yes
- PID before: `796`
- PID after: `796`
- start timestamp before: `Fri 2026-08-14 12:52:44 UTC`
- start timestamp after: `Fri 2026-08-14 12:52:44 UTC`

Verdict: neither service identity changed during the gate. Production remained untouched.

## Repository identity

At inspection time:

- staging checkout branch: `feat/qsl-native-mission-orchestration-v0-1`
- staging checkout HEAD: `3a60dfcd1cac4ef586edee6363b1ccd5a6c3dda4`
- remote branch HEAD: `63e21a6fc27490f74d893a95770366bfe8ad54fe`
- working tree: clean

Interpretation: the live staging service was intentionally still running the previously validated checkout. New Guardian/authority/documentation work existed on the remote branch but had not yet been deployed or restarted into staging.

## Embedded PostgreSQL identity

Confirmed:

- mode: `embedded-postgres`
- configured/live port: `54330`
- database: `paperclip`
- database user: `paperclip`
- listener: loopback (`127.0.0.1` / `::1`)
- data directory: `/home/paperclip-thebinmap-staging/.paperclip-staging/instances/thebinmap-email-ops-staging/db`
- PostgreSQL PID: `92922`
- inspection transaction state: `transaction_read_only=on`

Required tables were present:

- `operator_missions`
- `secret_access_events`
- `company_secret_bindings`
- `heartbeat_runs`

## Mission identity uniqueness precondition

`operator_missions` row count: `9`.

Duplicate query over `(company_id, mission_id)` returned **0 rows**.

Hard gate result:

`duplicate_company_mission_pairs=0`

Therefore the staging data is clean for a new database-level unique index migration.

Current indexes at inspection time included:

- `operator_missions_pkey` — unique on `id`
- `operator_missions_company_issue_id_idx`
- `operator_missions_company_status_idx`
- `operator_missions_company_mission_id_idx` — **non-unique** on `(company_id, mission_id)`

Decision: do not rewrite migration `0183_operator_missions.sql`. Add a new migration that creates database-level uniqueness and removes the redundant non-unique index only after uniqueness is established.

## Safe credential binding evidence

No secret values were queried or printed.

The staging database showed an active `OPENROUTER_API_KEY` company secret for QSL Mission Control, bound to:

- Selarix Recorder
- Mission Control Director
- Sentinel Governor

The secret provider is `local_encrypted`, version selector is `latest`, and the configuration path is `env.OPENROUTER_API_KEY`.

A separate TheBinMap Email Operations OpenRouter secret remained bound to the Hermes POC agent.

## Native credential provenance evidence

`secret_access_events` for the prior 24-hour window showed successful QSL Mission Control OpenRouter secret resolutions by the **Mission Control Director**, with each access record correlated to both:

- a Paperclip issue ID; and
- a Paperclip heartbeat run ID.

The most recent such staging event occurred at approximately `2026-08-15 19:56:33 UTC`.

This proves that Paperclip can provide causal, non-secret credential provenance at the execution-run level.

## Provider dashboard correlation finding

Operator-supplied OpenRouter dashboard evidence on 2026-08-16 showed:

- the newer Mission Control key last used roughly 19 hours earlier; and
- another older key used recently;
- recent OpenRouter generation rows labeled `OpenClaw` and `QuantumShieldCore`.

The staging database inspection showed:

- no Mission Control `secret_access_events` newer than the prior-day run window; and
- **0 heartbeat runs in the last 3 hours** for this staging database.

Inference: the recent older-key/provider traffic is **not attributable to the inspected Mission Control staging runtime**. The timing of Mission Control's last native secret-resolution event is instead consistent with the newer key's approximately 19-hour provider-side last-use indication.

This is strong evidence for the Guardian credential-provenance requirement: provider-level key activity must be correlated to runtime-native run and secret-access evidence before assigning causal ownership.

## Gate verdict

PASS.

The read-only gate proved:

1. staging and production service identities remained unchanged;
2. the correct embedded staging database was inspected read-only;
3. mission identity duplicates do not exist;
4. the existing company+mission index is non-unique;
5. native secret-access events provide heartbeat-run credential provenance without exposing secret values;
6. recent unrelated provider traffic can be distinguished from Mission Control staging activity;
7. the branch is ready for a new `0184` uniqueness migration, followed by automated validation and then a staging-only deployment/restart proof.

## Next gate

After the new migration is prepared and CI-green:

- update the staging checkout to the validated branch head;
- restart **staging only**;
- prove migration/startup health;
- verify the unique index exists;
- recheck production identity unchanged;
- then execute the controlled native Mission Control lifecycle proof and Guardian `human_required` intervention proof.
