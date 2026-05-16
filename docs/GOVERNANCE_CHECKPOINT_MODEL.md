# Governance Checkpoint Model

Durable institutional operational memory snapshots for Paperclip/Selarix. Checkpoints capture the full operational state at a point in time: health, topology, risks, escalation, remediation, export continuity, and deployment readiness.

## Purpose

Checkpoints serve as:

- **Governance review artifacts** -- Auditable records of operational state for stakeholder review
- **Continuity restoration points** -- Enough context to reconstruct operational understanding after disruption
- **Incident reconstruction aids** -- What was the state before/during/after an incident
- **Cross-model handoff context** -- Enable a new operator or model to understand current state without re-deriving everything
- **Deployment milestones** -- Record state before and after deploys for comparison

## Checkpoint Structure

```json
{
  "schema_version": 1,
  "checkpoint_id": "GCP-A1B2C3D4",
  "timestamp": "2026-05-16T14:00:00+00:00",
  "chain_id": "CHAIN-e3b0c44298fc",
  "previous_checkpoint": "GCP-E5F6G7H8",
  "integrity_hash": "sha256...",

  "overall_status": "warning",
  "health_score": 90.2,
  "health_dimensions": { ... },

  "topology": { "companies": 2, "agents": 13, ... },

  "active_risks": [
    { "check": "missing_metadata", "severity": "warning", "message": "..." }
  ],

  "escalation_level": "informational",
  "escalation_consecutive_criticals": 0,

  "remediation": { "pending": 2, "executed": 3, ... },

  "history_snapshot_count": 50,
  "backup_reliability_pct": 98.5,
  "remediation_success_rate_pct": 100.0,

  "export_continuity": { "last_export": "...", "manifest_valid": true },
  "deployment_readiness": { "ready": true, "checks": { ... }, "blockers": [] },

  "operator_notes": "Pre-deploy checkpoint",
  "integrity_hash": "sha256..."
}
```

## Continuity Chain

Each checkpoint links to its predecessor via `chain_id`:

```
GCP-A1B2C3D4 (GENESIS)
    |
    v
GCP-E5F6G7H8 (CHAIN-a1b2c3d4e5f6)
    |
    v
GCP-I9J0K1L2 (CHAIN-e5f6g7h8i9j0)
```

- The first checkpoint has `chain_id: "GENESIS"` and no `previous_checkpoint`
- Each subsequent checkpoint's `chain_id` is derived from the previous checkpoint's `integrity_hash`
- Chain integrity can be verified by walking the index and confirming each link

If the chain breaks (e.g., a checkpoint is deleted or corrupted), the next checkpoint starts a new chain from GENESIS. This is detectable but not prevented -- append-only design means breaks indicate tampering or data loss.

## Integrity Hashes

Each checkpoint includes a SHA-256 hash computed over its deterministic fields:

- `checkpoint_id`
- `timestamp`
- `overall_status`
- `health_score`
- `topology`
- `remediation`
- `escalation_level`

The hash is stored in `integrity_hash` and indexed for chain linking. It enables:

1. Tamper detection (did the checkpoint change after creation?)
2. Chain linking (does this checkpoint correctly reference its predecessor?)
3. Export verification (does the exported checkpoint match the original?)

## Checkpoint Index

An append-only JSONL file at `logs/governance-checkpoints/checkpoint-index.jsonl`:

```jsonl
{"checkpoint_id":"GCP-A1B2C3D4","timestamp":"2026-05-16T14:00:00+00:00","chain_id":"GENESIS","overall_status":"warning","health_score":90.2,...}
{"checkpoint_id":"GCP-E5F6G7H8","timestamp":"2026-05-16T15:00:00+00:00","chain_id":"CHAIN-a1b2c3d4e5f6","overall_status":"healthy","health_score":95.0,...}
```

Each index entry is a lightweight summary. Full checkpoint detail is in the individual `GCP-*.json` files. A markdown version (`GCP-*.md`) is generated alongside for human review.

## Commands

```bash
# Create a new checkpoint
python scripts/governance_checkpoint.py --create

# Create with operator notes
python scripts/governance_checkpoint.py --create --notes "Pre-deploy freeze"

# Show summary statistics
python scripts/governance_checkpoint.py --summary

# List all checkpoints
python scripts/governance_checkpoint.py --list

# JSON output
python scripts/governance_checkpoint.py --create --json
python scripts/governance_checkpoint.py --summary --json
```

## Deployment Readiness Assessment

Each checkpoint evaluates deployment readiness against five criteria:

| Check | Pass condition |
|-------|---------------|
| `health_acceptable` | Overall status is healthy or warning (not critical) |
| `no_critical_findings` | No individual check is critical |
| `no_failed_remediations` | Zero failed remediation plans |
| `backup_current` | Backup freshness check is healthy |
| `no_governance_hold` | Escalation level is not governance-review |

All five must pass for `deployment_readiness.ready = true`. Failing checks are listed in `blockers`.

## When to Create Checkpoints

| Event | Checkpoint notes |
|-------|-----------------|
| Before deploy | "Pre-deploy: version X.Y.Z" |
| After deploy | "Post-deploy: version X.Y.Z" |
| Incident start | "Incident: brief description" |
| Incident resolved | "Incident resolved: brief description" |
| Weekly governance | "Weekly governance review" |
| Before maintenance | "Pre-maintenance: what's planned" |
| After migration | "Post-migration: what changed" |

## Storage Layout

```
logs/governance-checkpoints/
  checkpoint-index.jsonl     # Append-only index (one entry per checkpoint)
  GCP-A1B2C3D4.json         # Full checkpoint data
  GCP-A1B2C3D4.md           # Human-readable markdown
  GCP-E5F6G7H8.json
  GCP-E5F6G7H8.md
```

## Auditability Guarantees

1. **Append-only index** -- Index entries are only appended, never modified
2. **Integrity hashes** -- Each checkpoint's content is hash-verified
3. **Continuity chain** -- Chain links enable tamper detection across checkpoints
4. **Dual format** -- Both JSON (machine) and markdown (human) for every checkpoint
5. **No AI summarization** -- All content is deterministically computed from operational state
6. **Operator notes preserved** -- Notes are stored verbatim, never modified

## Future Extensions

- **Signed checkpoints** -- Cryptographic signatures for non-repudiation
- **Multi-party attestation** -- Multiple operators sign the same checkpoint
- **Checkpoint diffing** -- Compare two checkpoints to see what changed
- **Automated checkpoint triggers** -- Create checkpoints on deploy/incident events
- **Remote checkpoint sync** -- Push checkpoints to external governance systems
