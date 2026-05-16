# Runtime History Model V3

Historical operational intelligence for Paperclip/Selarix. Provides snapshot persistence, trend detection, remediation deduplication, and plan expiration.

## Architecture

```
runtime_topology_report.py    <-- enumerates disk state
        |
        v
runtime_guardian.py           <-- evaluates health, scores, logs
        |                          --history records snapshots
        |                          --trends shows inline analysis
        v
runtime_history.py            <-- snapshot persistence, trend detection
        |
        v
runtime_remediator.py         <-- approval workflows, dedup, expiration
        |
        v
logs/runtime-history/         <-- append-only JSONL snapshots
logs/runtime-remediation/     <-- plan lifecycle directories
```

## Snapshot Lifecycle

### Recording

Each guardian run can record a snapshot via `--history`:

```bash
python scripts/runtime_guardian.py --once --history
```

Or record directly:

```bash
python scripts/runtime_history.py --record
```

### Storage

Snapshots are stored as append-only JSONL in `logs/runtime-history/snapshots.jsonl`. One JSON object per line. Never modified after writing.

### Schema (v1)

```json
{
  "schema_version": 1,
  "timestamp": "2026-05-16T14:00:00+00:00",
  "health_score": "warning",
  "topology": {
    "companies": 2,
    "projects": 2,
    "agents": 13,
    "prompt_caches": 12,
    "backup_archives": 55,
    "orphans": 0
  },
  "backup_freshness_hours": 76.1,
  "backup_total_bytes": 910820634,
  "storage_total_bytes": 911846589,
  "storage_asset_bytes": 1025955,
  "stale_companies": 0,
  "stale_agents": 13,
  "orphan_count": 0,
  "duplicate_sets": 0,
  "missing_metadata": 2,
  "remediation": {
    "pending": 2,
    "approved": 0,
    "executed": 2,
    "failed": 0,
    "expired": 0
  },
  "check_statuses": {
    "instance_path": "healthy",
    "backup_freshness": "critical",
    "orphan_count": "healthy",
    "missing_metadata": "warning",
    "stale_entities": "healthy",
    "duplicate_agents": "healthy",
    "storage_size": "healthy"
  }
}
```

The schema is deterministic: the same runtime state always produces the same snapshot (modulo timestamp). The `schema_version` field enables forward-compatible parsing.

## Trend Methodology

Trends are computed by comparing snapshots across three windows:

| Window | Description | Use case |
|--------|-------------|----------|
| Previous | Last 2 snapshots | Detect immediate changes |
| 24 hours | All snapshots in last 24h | Detect intra-day drift |
| 7 days | All snapshots in last 7d | Detect weekly patterns |

### Trend types

| Trend | Detection method | Severity |
|-------|-----------------|----------|
| Storage growth spike | > 10% growth across window | info/warning |
| Increasing orphans | Count increasing first -> last | warning |
| Increasing duplicates | Count increasing first -> last | warning |
| Prompt cache growth | > 5 new caches across window | info |
| Health degradation | Score worsened (healthy -> warning -> critical) | warning |
| Health improvement | Score improved | info |

### Anomaly types

| Anomaly | Detection method | Severity |
|---------|-----------------|----------|
| Backup instability | Any snapshot had backup > 72h | warning/critical |
| Remediation failures increasing | Failed count increasing | warning |
| Topology churn | Agent count changing in > 50% of snapshots | info |

All trend calculations are deterministic and reproducible: given the same snapshot set, the same trends are detected.

## Remediation Deduplication Model

### Problem

Running `--remediate` multiple times for the same persistent issue creates duplicate pending plans.

### Solution: Fingerprinting

Each plan gets an `issue_fingerprint` computed from `action + check_name`. When creating a new plan:

1. Compute fingerprint for the proposed plan
2. Search `pending/` and `approved/` for an existing plan with the same fingerprint
3. If found: increment `occurrence_count`, update `last_seen`, update `evidence`
4. If not found: create new plan

### Fingerprint scope

The fingerprint is intentionally coarse-grained (action + check name, not specific metric values). This means:

- "backup_freshness is critical" at 76h and at 100h produce the same fingerprint
- A plan is only created once per issue type, regardless of how many times the guardian runs

### What is NOT deduplicated

- Plans in `executed/`, `failed/`, or `expired/` are not considered. A new plan is created even if an identical one was previously executed, because conditions may have changed.

## Expiration Philosophy

### Why expire?

Plans represent a point-in-time recommendation. A pending plan from 3 days ago may no longer be relevant -- the issue may have resolved itself, or conditions may have changed enough that the original plan is no longer appropriate.

### Rules

| State | Threshold | Reason |
|-------|-----------|--------|
| pending | 72 hours | Operator did not review in time |
| approved | 168 hours (7 days) | Operator approved but never executed |

### What happens on expiration

1. Plan moves to `expired/` directory
2. `state` set to `"expired"`
3. `completed_at` set to expiration time
4. `expiration_reason` records why (e.g., "pending > 72h")
5. Plan is preserved for audit -- never deleted

### Running expiration

```bash
python scripts/runtime_remediator.py --expire-stale
```

This is a manual action. Expiration never runs automatically.

## Governance Metadata

V3 adds governance fields to every plan:

| Field | Description |
|-------|-------------|
| `issue_fingerprint` | Stable hash for deduplication |
| `occurrence_count` | How many times this issue was detected |
| `last_seen` | Timestamp of most recent detection |
| `created_by` | Who/what created the plan (e.g., "runtime_guardian") |
| `approved_by` | Who approved (e.g., "operator", "auto") |
| `executed_by` | Who executed (e.g., "operator") |
| `expiration_reason` | Why expired, if applicable |

### Future governance fields (not yet implemented)

- `approved_by_list` -- multi-party approval signatures
- `escalation_chain` -- who was notified and when
- `board_review_id` -- link to governance board review
- `signature` -- cryptographic proof of approval

## Operational Governance Progression

```
V1: Visibility
    - What exists on disk?
    - What's the health status?

V2: Remediation
    - What should we do about it?
    - Who approved?
    - What happened?

V3: Intelligence (current)
    - How is health trending?
    - Are we seeing the same issues repeatedly?
    - Are plans being actioned or expiring?

V4: Governance (future)
    - Multi-party approvals
    - Escalation chains
    - Audit compliance
    - Cryptographic signing
```

## Auditability Guarantees

1. **Append-only history.** Snapshots are appended to JSONL. No rewriting.
2. **Plans never deleted.** Plans move between state directories but are never removed.
3. **Every state transition logged.** created_at, approved_at, executed_at, completed_at.
4. **Expiration is explicit.** No silent expiration. Manual command required.
5. **Deduplication is traceable.** occurrence_count and last_seen show when issues recurred.
6. **Schema versioned.** Future schema changes are backward-compatible via schema_version.

## Commands Reference

```bash
# Record a snapshot
python scripts/runtime_history.py --record

# View summary
python scripts/runtime_history.py --summary

# View trends (previous, 24h, 7d)
python scripts/runtime_history.py --trends

# View last N snapshots
python scripts/runtime_history.py --last 10

# JSON output
python scripts/runtime_history.py --summary --json

# Guardian with auto-history
python scripts/runtime_guardian.py --once --history

# Guardian with inline trends
python scripts/runtime_guardian.py --once --history --trends

# Expire stale plans
python scripts/runtime_remediator.py --expire-stale

# Scan with deduplication
python scripts/runtime_remediator.py --scan
```

## Scheduled Governance

### Windows Task Scheduler

```xml
<!-- Save as guardian-check.xml, import via Task Scheduler -->
<Task>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT1H</Interval>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Actions>
    <Exec>
      <Command>python</Command>
      <Arguments>scripts/runtime_guardian.py --once --history --remediate</Arguments>
      <WorkingDirectory>C:\Users\mikeb\paperclip</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
```

### cron (Linux/macOS)

```cron
# Every hour: record health + generate remediation plans
0 * * * * cd /home/user/paperclip && python scripts/runtime_guardian.py --once --history --remediate >> /var/log/guardian.log 2>&1

# Daily at 6am: expire stale plans
0 6 * * * cd /home/user/paperclip && python scripts/runtime_remediator.py --expire-stale >> /var/log/guardian.log 2>&1
```

### systemd timer

```ini
# /etc/systemd/system/paperclip-guardian.timer
[Unit]
Description=Paperclip Runtime Guardian hourly check

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/paperclip-guardian.service
[Unit]
Description=Paperclip Runtime Guardian check

[Service]
Type=oneshot
WorkingDirectory=/home/user/paperclip
ExecStart=/usr/bin/python3 scripts/runtime_guardian.py --once --history --remediate
```

### Recommended intervals

| Task | Interval | Rationale |
|------|----------|-----------|
| Guardian health check | 1 hour | Matches backup interval |
| History snapshot | 1 hour (with guardian) | Sufficient for trend detection |
| Plan expiration | Daily | Keeps pending queue clean |
| Trend review | Weekly (manual) | Inform operational decisions |
| Full topology report | On-demand | Before upgrades, after incidents |

### Log retention guidance

| Log type | Suggested retention | Notes |
|----------|-------------------|-------|
| Guardian logs | 30 days | Rotate with `--expire-stale` or `rotate_guardian_logs` |
| History snapshots | 90 days | JSONL grows ~1 KB/snapshot |
| Remediation plans | Indefinite | Kept for audit trail |
| Topology snapshots | 30 days | Large files, prune manually |
