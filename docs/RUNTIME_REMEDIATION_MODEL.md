# Runtime Remediation Model V2

Approval-aware corrective workflow engine for Paperclip/Selarix operational health findings.

## Core Principle

> Guardian may DETECT and PREPARE remediation automatically.
> Guardian may only EXECUTE approved safe actions.
> No silent mutations. No destructive operations.

## Remediation Lifecycle

```
  DETECT          PLAN           APPROVE         EXECUTE
  ------          ----           -------         -------
  Guardian   ->   Remediator  ->  Operator   ->  Remediator
  finds issue     generates       reviews &      runs safe
                  plan JSON       approves       action
                       |                              |
                       v                              v
                  pending/          approved/     executed/
                                                  or failed/
```

### States

| State | Directory | Meaning |
|-------|-----------|---------|
| `pending` | `logs/runtime-remediation/pending/` | Plan generated, awaiting approval |
| `approved` | `logs/runtime-remediation/approved/` | Operator approved, ready to execute |
| `executed` | `logs/runtime-remediation/executed/` | Action completed successfully |
| `failed` | `logs/runtime-remediation/failed/` | Execution failed, error recorded |

Plans move between directories as their state changes. Each plan file is a self-contained JSON document with full audit trail.

## Plan Structure

```json
{
  "issue_id": "REM-A1B2C3D4",
  "action": "verify_backup_integrity",
  "description": "Verify latest backup archive is readable and non-empty",
  "severity": "critical",
  "detection_time": "2026-05-16T14:00:00+00:00",
  "recommended_action": "verify_backup_integrity",
  "requires_approval": false,
  "estimated_risk": "none",
  "estimated_runtime": "< 30s",
  "rollback_available": false,
  "evidence": { "check": "backup_freshness", "detail": { ... } },
  "instance_root": "C:\\Users\\...\\default",
  "state": "pending",
  "created_at": "...",
  "approved_at": null,
  "executed_at": null,
  "completed_at": null,
  "result": null
}
```

## Supported V1 Remediations

| Action | Risk | Approval | Rollback | Description |
|--------|------|----------|----------|-------------|
| `trigger_backup` | low | required | no | Trigger database backup via backup-db.sh |
| `verify_backup_integrity` | none | auto | no | Verify latest backup is readable and non-empty |
| `rotate_guardian_logs` | low | required | yes | Archive guardian logs older than 7 days |
| `archive_stale_run_logs` | low | required | yes | Archive stale agent run logs (preserves originals) |
| `rerun_topology_scan` | none | auto | no | Re-run topology report and save snapshot |
| `regenerate_health_snapshot` | none | auto | no | Re-run guardian and save fresh health snapshot |
| `verify_db_path` | none | auto | no | Verify embedded PostgreSQL data directory exists |

### What is NOT supported (by design)

- No file deletions
- No database mutations
- No agent modifications
- No configuration changes
- No backup deletions
- No automatic cleanup without approval

## Approval Model

### Auto-approved actions (risk: none)

Actions with `requires_approval: false` can be executed immediately:

```bash
python scripts/runtime_remediator.py --execute REM-A1B2C3D4
```

### Approval-required actions (risk: low+)

Actions with `requires_approval: true` must be explicitly approved:

```bash
# Step 1: Review the plan
python scripts/runtime_remediator.py --status REM-A1B2C3D4

# Step 2: Approve
python scripts/runtime_remediator.py --approve REM-A1B2C3D4

# Step 3: Execute
python scripts/runtime_remediator.py --execute REM-A1B2C3D4
```

## Auditability Model

Every remediation action produces a complete audit trail:

1. **Plan JSON** - Full plan with evidence, timestamps, and approval chain
2. **Execution log** - Captured stdout/stderr, return codes, result data
3. **Result summary** - Final state (executed/failed) with outcome details
4. **Topology/health snapshots** - Point-in-time state captured alongside remediation

All artifacts are written to `logs/runtime-remediation/` and organized by state. Plans are never deleted -- failed plans remain in `failed/` for post-mortem analysis.

### Replay and audit

```bash
# List all plans and their states
python scripts/runtime_remediator.py --list

# Inspect any plan by ID
python scripts/runtime_remediator.py --status REM-A1B2C3D4 --json

# Full JSON dump of all plans
python scripts/runtime_remediator.py --list --json
```

## Rollback Philosophy

1. **Prefer archiving over deleting.** Log rotation moves files to `archived/`. Stale run log archival copies to a dated directory and preserves originals.
2. **No irreversible actions in V1.** The most impactful action (trigger_backup) creates new data; it does not modify existing data.
3. **Manual cleanup after verification.** Archival actions leave originals in place. The operator decides when to remove the originals.
4. **Failed plans are preserved.** If an action fails, the plan moves to `failed/` with the error. Nothing is lost.

## Governance Boundaries

### What the remediator CAN do

- Read filesystem state
- Generate plans
- Move files between state directories
- Archive logs to subdirectories
- Copy run logs to dated archive directories
- Trigger existing backup scripts
- Verify file existence and integrity
- Write snapshot files

### What the remediator CANNOT do

- Delete any file or directory
- Modify database state directly
- Change agent configurations
- Alter instance config.json
- Send external notifications
- Execute arbitrary commands
- Bypass the approval workflow

## Integration with Guardian

```bash
# Guardian detects issues and generates plans in one step
python scripts/runtime_guardian.py --once --remediate

# Review generated plans
python scripts/runtime_remediator.py --list

# Approve and execute
python scripts/runtime_remediator.py --approve REM-XXXXXXXX
python scripts/runtime_remediator.py --execute REM-XXXXXXXX
```

## Future Escalation Architecture (V3+)

The remediation model is designed to support future governance integrations without architectural changes:

### Event logging (future)
Each state transition (pending -> approved -> executed) could emit structured events to an event log or message bus.

### Governance approvals (future)
The `requires_approval` flag and approval workflow map directly to multi-party approval systems. A future version could require approval from a Selarix governance board before critical remediations execute.

### Notification channels (future)
Plan generation could trigger Slack/Telegram/email notifications. The plan JSON contains all context needed for a notification payload.

### Board review workflows (future)
Critical severity plans could be routed to a board review queue, where multiple stakeholders must approve before execution. The state machine (pending -> approved -> executed -> failed) supports additional intermediate states.

### Selarix integration (future)
Remediation events could feed into Selarix's operational memory, building a history of what was detected, what was done, and what the outcome was. This creates institutional knowledge about operational patterns.

## Directory Layout

```
logs/runtime-remediation/
  pending/                       # Plans awaiting approval
    REM-A1B2C3D4.json
  approved/                      # Plans approved, ready to execute
    REM-E5F6G7H8.json
  executed/                      # Successfully executed plans
    REM-I9J0K1L2.json
  failed/                        # Failed execution attempts
    REM-M3N4O5P6.json
  topology-snapshots/            # Point-in-time topology reports
    topology-20260516-140000.json
  health-snapshots/              # Point-in-time health reports
    health-20260516-140000.json
```
