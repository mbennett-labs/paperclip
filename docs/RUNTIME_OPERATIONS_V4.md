# Runtime Operations V4

Operational continuity, governance escalation, and deployment readiness for Paperclip/Selarix.

## Architecture

```
runtime_topology_report.py    <-- enumerates disk state
        |
        v
runtime_guardian.py (V4)      <-- health checks, weighted scoring, escalation
        |
        v
runtime_history.py            <-- snapshot persistence, trend detection
runtime_remediator.py         <-- approval workflows, dedup, expiration
runtime_rotation.py (V4)      <-- deterministic retention management
runtime_export.py (V4)        <-- operational continuity bundles
        |
        v
logs/runtime-guardian/        <-- timestamped JSON logs + escalation state
logs/runtime-history/         <-- append-only JSONL snapshots
logs/runtime-remediation/     <-- plan lifecycle directories
logs/runtime-archives/        <-- compressed rotation archives
logs/exports/                 <-- continuity export bundles
```

## Operational Continuity Philosophy

Operational state is institutional memory. If it exists only on one machine, in one process, or in one person's head, it is fragile. V4 makes runtime state:

1. **Exportable** - Portable bundles for migration, recovery, and review
2. **Rotatable** - Deterministic retention with compressed archives
3. **Verifiable** - SHA-256 integrity manifests, chain consistency checks
4. **Scorable** - Weighted health dimensions (0-100) beyond binary healthy/critical
5. **Escalatable** - Governance-aware severity progression

## Weighted Health Scoring

V4 replaces the binary healthy/warning/critical with a weighted 0-100 score across six governance dimensions:

| Dimension | Weight | Inputs |
|-----------|--------|--------|
| Durability | 25% | Backup freshness, instance path |
| Governance | 15% | Missing metadata, duplicate agents |
| Topology Stability | 15% | Orphan count, stale entities |
| Remediation Health | 15% | Pending/failed remediation ratio |
| Backup Reliability | 15% | Backup archive state |
| Operational Continuity | 15% | Storage size, overall state |

### Score interpretation

| Score | Status | Meaning |
|-------|--------|---------|
| 90-100 | Healthy | All dimensions strong |
| 70-89 | Good | Minor issues, no action needed |
| 50-69 | Warning | One or more dimensions degraded |
| 25-49 | Critical | Significant operational risk |
| 0-24 | Emergency | Immediate intervention required |

The `overall_status` field (healthy/warning/critical) is preserved for backward compatibility. The weighted score provides finer granularity.

## Governance Escalation Model

### Escalation levels

| Level | Trigger | Meaning |
|-------|---------|---------|
| informational | Default state | No issues |
| warning | 1+ consecutive warnings | Degradation detected |
| critical | 1+ critical findings | Operational risk |
| governance-review | 3+ consecutive criticals, or backup gap > 7 days | Requires stakeholder review |

### Escalation tracking

Escalation state is persisted in `logs/runtime-guardian/escalation-state.json`:

```json
{
  "consecutive_criticals": 3,
  "consecutive_warnings": 0,
  "last_level": "governance-review",
  "escalations": [
    {
      "timestamp": "2026-05-16T14:00:00+00:00",
      "level": "governance-review",
      "reasons": ["3 consecutive critical findings"],
      "overall_status": "critical"
    }
  ]
}
```

Escalations are:
- Tracked locally (no external notifications yet)
- Included in guardian output and history snapshots
- Auditable via escalation-state.json
- Never auto-executed (only recorded)

## Log Rotation

### Commands

```bash
# Preview what would be rotated
python scripts/runtime_rotation.py --dry-run

# Execute rotation (archive + compress + reclaim)
python scripts/runtime_rotation.py --confirm

# JSON output
python scripts/runtime_rotation.py --json
```

### Retention windows

| Log type | Retention | Archive format |
|----------|-----------|---------------|
| Guardian logs | 30 days | .json.gz |
| History snapshots | Monthly rollover | .jsonl.gz |
| Executed remediation | 60 days | .json.gz |
| Expired remediation | 30 days | .json.gz |
| Topology exports | 30 days | .json.gz |

### Rotation behavior

1. Files older than retention are compressed with gzip
2. Compressed archives are stored in `logs/runtime-archives/YYYY-MM/`
3. An archive manifest is written for each rotation
4. History JSONL is rolled over by month (old months archived, current month retained)
5. No files are silently deleted -- everything is archived first

## Export Bundles

### Commands

```bash
# Full export (topology + health + history + remediation + backup inventory)
python scripts/runtime_export.py --full --output /path/to/exports

# Selective exports
python scripts/runtime_export.py --topology --output DIR
python scripts/runtime_export.py --history --output DIR
python scripts/runtime_export.py --remediation --output DIR

# Verify an export bundle
python scripts/runtime_export.py --verify /path/to/paperclip-export-20260516-140000

# JSON manifest
python scripts/runtime_export.py --json
```

### Bundle contents

```
paperclip-export-20260516-140000/
  manifest.json                    # Integrity manifest (SHA-256 hashes)
  topology/
    topology_report.json           # Current topology state
    instance_config_sanitized.json # Config (secrets removed)
  health/
    guardian_report.json           # Current health state
  history/
    snapshots.jsonl                # Historical snapshots
  remediation/
    pending/                       # Active plans
    approved/
    executed/
    failed/
    expired/
  backup-inventory/
    backup_inventory.json          # Backup file list + sizes + hashes
```

### Integrity verification

```bash
python scripts/runtime_export.py --verify /path/to/export

# Checks:
# - manifest.json exists and is valid JSON
# - Export version present
# - Every file hash matches manifest
# - Remediation plans match their directory state
# - Snapshot timestamps are monotonically increasing
```

### Use cases

| Scenario | Export type | Purpose |
|----------|-----------|---------|
| VPS migration | --full | Complete operational state transfer |
| Incident recovery | --topology --remediation | Restore governance state |
| Governance review | --full | Board audit package |
| Cold storage | --history | Long-term operational record |
| Environment promotion | --topology | Topology baseline for new env |

## Retention Strategy

### Active retention (on-disk)

| Data | Retention | Rationale |
|------|-----------|-----------|
| Guardian logs | 30 days | Daily operational reference |
| History snapshots | Current month | Trend analysis window |
| Pending/approved plans | Until executed/expired | Active governance |
| Executed plans | 60 days | Post-execution audit |
| Expired plans | 30 days | Expiration audit |

### Archive retention (compressed)

| Data | Retention | Rationale |
|------|-----------|-----------|
| Guardian archives | 90 days | Extended troubleshooting |
| History archives | 1 year | Trend analysis, governance |
| Remediation archives | 90 days | Audit compliance |

### Permanent retention (export bundles)

Export bundles created for governance review or migration should be retained indefinitely in cold storage.

## Infrastructure Separation Principles

### Development

- Single instance, relaxed thresholds
- Backup interval: 4 hours
- Log retention: 7 days
- No escalation tracking

### Staging

- Mirrors production topology
- Backup interval: 1 hour
- Log retention: 14 days
- Escalation tracking enabled

### Production

- Full guardian cycle (health + history + remediation + rotation)
- Backup interval: 1 hour
- Log retention: 30 days
- Escalation tracking enabled
- Weekly exports to cold storage
- Governance-review escalation for 3+ consecutive criticals

## Runbook: Deployment Readiness

### Transitioning from local runtime to persistent infrastructure

#### VPS deployment

```bash
# 1. Export current state
python scripts/runtime_export.py --full --output /tmp/migration

# 2. Transfer to VPS
rsync -avz /tmp/migration/paperclip-export-* user@vps:/opt/paperclip/imports/

# 3. On VPS: verify import
cd /opt/paperclip
python scripts/runtime_export.py --verify imports/paperclip-export-*

# 4. Set up guardian cron (see below)
```

#### systemd timer (recommended for Linux VPS)

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
WorkingDirectory=/opt/paperclip
ExecStart=/usr/bin/python3 scripts/runtime_guardian.py --once --history --remediate
```

```ini
# /etc/systemd/system/paperclip-rotation.timer
[Unit]
Description=Paperclip log rotation daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/paperclip-rotation.service
[Unit]
Description=Paperclip log rotation

[Service]
Type=oneshot
WorkingDirectory=/opt/paperclip
ExecStart=/usr/bin/python3 scripts/runtime_rotation.py --confirm
```

#### PM2 (alternative for Node.js environments)

```javascript
// ecosystem.guardian.config.cjs
module.exports = {
  apps: [{
    name: 'paperclip-guardian',
    script: 'python',
    args: 'scripts/runtime_guardian.py --watch --interval 3600 --history --remediate',
    cwd: '/opt/paperclip',
    autorestart: true,
    max_restarts: 10,
  }]
};
```

#### Windows Task Scheduler

```bash
# Create hourly guardian task
schtasks /create /tn "PaperclipGuardian" /tr "python scripts/runtime_guardian.py --once --history --remediate" /sc hourly /sd %date% /st 00:00

# Create daily rotation task
schtasks /create /tn "PaperclipRotation" /tr "python scripts/runtime_rotation.py --confirm" /sc daily /sd %date% /st 03:00
```

#### Recommended storage layout

```
/opt/paperclip/                    # Application code
  scripts/                         # Guardian, history, remediator, etc.
  logs/                            # Operational logs (gitignored)
    runtime-guardian/
    runtime-history/
    runtime-remediation/
    runtime-archives/              # Compressed rotated logs
    exports/                       # Continuity export bundles

~/.paperclip/instances/default/    # Runtime state
  companies/
  projects/
  data/
    backups/                       # SQL backup archives
    storage/                       # Uploaded assets
  db/                              # Embedded PostgreSQL
```

### Deployment readiness checklist

- [ ] Guardian runs on schedule (hourly recommended)
- [ ] History snapshots recording with each guardian run
- [ ] Remediation plans generating for detected issues
- [ ] Log rotation running daily
- [ ] Weekly export bundles to cold storage
- [ ] Backup scheduler running (1-hour interval)
- [ ] Escalation state being tracked
- [ ] Retention windows configured for environment
- [ ] Export verification passing

## Audit Guarantees

1. **Every rotation produces a manifest** in `logs/runtime-archives/YYYY-MM/`
2. **Every export includes SHA-256 hashes** for all bundled files
3. **Escalation events are append-only** in escalation-state.json
4. **History snapshots are append-only** in snapshots.jsonl
5. **Remediation plans are never deleted** -- only moved between state directories
6. **Rotation archives, not deletes** -- compressed copies before removal
7. **Export verification is deterministic** -- same bundle always produces same result
