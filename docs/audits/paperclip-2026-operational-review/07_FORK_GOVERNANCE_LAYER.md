# 07 — Fork Governance Layer: Runtime Guardian & Checkpoint Recorder

> **Scope:** The fork-specific Python operational governance scripts: `runtime_guardian.py` and `governance_checkpoint.py`. These tools provide health monitoring, weighted scoring, escalation tracking, and deterministic checkpoint recording.
> **Status:** Read-only audit. All claims verified against implementation.

---

## 1. Runtime Guardian (`scripts/runtime_guardian.py`)

### 1.1 Design Philosophy

The Runtime Guardian is a **read-only, non-mutating** operational health monitor. It inspects the local Paperclip instance state (via `runtime_topology_report.py`), computes a weighted health score, tracks escalation state, and optionally generates remediation plans or history snapshots. It never modifies runtime state.

### 1.2 Health Check Dimensions

The guardian runs seven checks, each producing `healthy` / `warning` / `critical`:

| Check | Thresholds | Weight Dimension |
|---|---|---|
| `instance_path` | `config.json` present? | durability |
| `backup_freshness` | Warning >24h, Critical >72h | durability / backup_reliability |
| `orphan_count` | Warning ≥1, Critical ≥5 | topology_stability |
| `missing_metadata` | Warning ≥1, Critical ≥5 | governance |
| `stale_entities` | Warning ≥1 stale company | topology_stability |
| `duplicate_agents` | Warning if any duplicates | governance |
| `storage_size` | Warning ≥1GB, Critical ≥5GB | operational_continuity |

### 1.3 Weighted Scoring (0–100)

```python
SCORE_WEIGHTS = {
    "durability": 25,
    "governance": 15,
    "topology_stability": 15,
    "remediation_health": 15,
    "backup_reliability": 15,
    "operational_continuity": 15,
}
```

Dimension scores:
- **Durability** = average of `backup_freshness` + `instance_path`
- **Governance** = average of `missing_metadata` + `duplicate_agents`
- **Topology stability** = average of `orphan_count` + `stale_entities`
- **Remediation health** = computed from `logs/runtime-remediation/` file counts: `max(0, 100 - (failed * 20) - (pending * 5))` or `max(0, 100 - (pending * 10))` if no failures.
- **Backup reliability** = mirrors durability.
- **Operational continuity** = `storage_size` score.

Total = weighted sum, clamped to [0, 100].

### 1.4 Escalation State Machine

Escalation levels (`informational` → `critical` → `governance-review`):

```python
if consecutive_criticals >= 3:
    escalation_level = "governance-review"
elif consecutive_criticals >= 1:
    escalation_level = "critical"

if consecutive_warnings >= 5 and escalation_level not in ("critical", "governance-review"):
    escalation_level = "critical"
```

Special trigger: backup gap >7 days (`168h`) forces `governance-review` regardless of consecutive counts.

Escalation state is persisted to `logs/runtime-guardian/escalation-state.json` with:
- `consecutive_criticals`
- `consecutive_warnings`
- `escalations[]` (last 50 events)
- `last_check`, `last_level`

### 1.5 Modes of Operation

| Flag | Behavior |
|---|---|
| `--once` | Single check, print result, exit with status code. |
| `--watch --interval N` | Repeating checks every N seconds (default 300). |
| `--json` | Output JSON instead of human-readable text. |
| `--fail-on-warning` | Exit code 1 on warning, 2 on critical. |
| `--remediate` | Generate remediation plans from `runtime_remediator.py`. |
| `--history` | Record snapshot via `runtime_history.py`. |
| `--trends` | Show 24h trend analysis from history snapshots. |

### 1.6 Log Output

Every run writes:
- `logs/runtime-guardian/guardian-{YYYYMMDD-HHMMSS}.json` — full result.
- `logs/runtime-guardian/guardian-latest.json` — overwritten with latest result.

---

## 2. Governance Checkpoint Recorder (`scripts/governance_checkpoint.py`)

### 2.1 Purpose

Converts guardian/history/export/remediation state into **durable operational checkpoint records**. These are institutional memory snapshots for:
- Governance review
- Continuity restoration
- Incident reconstruction
- Cross-model handoff
- Deployment milestones

### 2.2 Checkpoint Schema

Each checkpoint is a JSON document with:

| Section | Content |
|---|---|
| `checkpoint_id` | `GCP-{uuid[:8]}` |
| `timestamp` | ISO 8601 UTC |
| `chain_id` | `GENESIS` or `CHAIN-{previous_hash[:12]}` |
| `previous_checkpoint` | Previous checkpoint ID |
| `overall_status` / `health_score` | From guardian |
| `topology` | Company/agent/project/backup counts |
| `active_risks` | List of warning/critical checks + escalation |
| `escalation_level` / `escalation_consecutive_*` / `escalation_total` |
| `remediation` | Counts of plans by state (pending/approved/executed/failed/expired) |
| `history_snapshot_count` / `history_health_distribution` / `backup_reliability_pct` / `remediation_success_rate_pct` |
| `export_continuity` | Last export path, count, manifest validity |
| `deployment_readiness` | Boolean readiness with per-check breakdown |
| `operator_notes` | Free text from `--notes` flag |
| `integrity_hash` | SHA-256 of canonical subset of fields |

### 2.3 Chain Integrity

Checkpoints form a **hash chain**:

```python
def generate_chain_id(previous_hash):
    if previous_hash is None:
        return "GENESIS"
    return f"CHAIN-{previous_hash[:12]}"

def compute_checkpoint_hash(checkpoint):
    hashable = {
        "checkpoint_id": checkpoint["checkpoint_id"],
        "timestamp": checkpoint["timestamp"],
        "overall_status": checkpoint["overall_status"],
        "health_score": checkpoint["health_score"],
        "topology": checkpoint["topology"],
        "remediation": checkpoint["remediation"],
        "escalation_level": checkpoint["escalation_level"],
    }
    raw = json.dumps(hashable, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()
```

The `summary` command verifies chain integrity by comparing each checkpoint’s `chain_id` against the expected `CHAIN-{previous.integrity_hash[:12]}`.

### 2.4 Index File

`logs/governance-checkpoints/checkpoint-index.jsonl` is an append-only NDJSON index:

```json
{"checkpoint_id":"GCP-A1B2C3D4","timestamp":"2026-07-14T12:00:00Z","chain_id":"GENESIS","overall_status":"healthy","health_score":92.5,"risk_count":0,"escalation_level":"informational","deployment_ready":true,"integrity_hash":"abcd...","notes":""}
```

This allows fast listing without loading full checkpoint files.

### 2.5 Deployment Readiness Assessment

```python
def _assess_deployment_readiness(guardian_result, remediation):
    checks = {
        "health_acceptable": status in ("healthy", "warning"),
        "no_critical_findings": len(critical_checks) == 0,
        "no_failed_remediations": remediation["failed"] == 0,
        "backup_current": backup_check_status == "healthy",
        "no_governance_hold": escalation_level != "governance-review",
    }
    return {
        "ready": all(checks.values()),
        "checks": checks,
        "blockers": [k for k, v in checks.items() if not v],
    }
```

All five checks must pass for `ready: true`.

### 2.6 Output Formats

| Command | Output |
|---|---|
| `--create` | Console text + saved `.json` + `.md` + index append |
| `--list` | Index table with status icons |
| `--summary` | Aggregate statistics, health distribution, score trajectory, chain integrity |
| `--json` (with any command) | JSON output instead of text |

---

## 3. Relationship to Core Paperclip

### 3.1 No DB Dependency

Both scripts operate entirely on the filesystem:
- `~/.paperclip/instances/<id>/` for topology.
- `logs/` for checkpoint/guardian/history/remediation/export state.
- They do not import `@paperclipai/db` or connect to PostgreSQL.

### 3.2 No Runtime Mutation

The scripts are explicitly read-only:
- No agent status changes.
- No issue creation or updates.
- No wakups enqueued.
- Remediation plans are written to `logs/runtime-remediation/` for human review/approval.

### 3.3 Cross-Model Handoff Support

The checkpoint format is designed for deterministic reconstruction:
- All data is JSON-serializable.
- Hash chain provides tamper detection.
- `operator_notes` allows human context injection.
- Markdown output is human-readable for board review.

---

## 4. Architectural Contradictions

1. **Guardian escalation is local-state only.** `escalation-state.json` lives in `logs/` and is not replicated or backed up by Paperclip’s backup system. A host failure resets escalation history.

2. **Remediation health score reads from filesystem glob counts.** `len(list((rem_dir / "pending").glob("REM-*.json")))` is O(n) and races with concurrent writers. There is no file-locking.

3. **Checkpoint hash excludes `active_risks` and `deployment_readiness`.** The integrity hash only covers summary fields, not the full checkpoint. A malicious or buggy modification to `active_risks` would not break the chain.

4. **No retention policy on checkpoints or guardian logs.** `guardian-{timestamp}.json` files accumulate indefinitely. The `checkpoint-index.jsonl` also grows without bound.

5. **Chain integrity check in `--summary` is O(n²) in the worst case.** It iterates all entries and recomputes expected chain IDs. With thousands of checkpoints, this becomes slow.

6. **Guardian and checkpoint recorder share Python module imports but have no shared API contract.** `runtime_topology_report.py`, `runtime_guardian.py`, `runtime_history.py`, `runtime_remediator.py` are separate modules with ad-hoc calling conventions. Refactoring one can silently break the others.
