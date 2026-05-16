# Runtime Guardian V4

Recurring operational health monitor for Paperclip/Selarix runtime state. Built on `runtime_topology_report.py`, the guardian evaluates topology data against health thresholds, produces both categorical (healthy/warning/critical) and weighted (0-100) health scores, and tracks governance escalation.

V2: `--remediate` for remediation plan generation.
V3: `--history` for snapshots, `--trends` for inline analysis.
V4: Weighted health scoring (0-100), governance escalation tracking, operational continuity tooling. See [RUNTIME_OPERATIONS_V4.md](RUNTIME_OPERATIONS_V4.md).

Read-only by default. No destructive actions. No auto-delete. No runtime mutation.

## Architecture

```
runtime_topology_report.py    <-- enumerates disk state
        |
        v
runtime_guardian.py (V4)      <-- health checks, weighted scoring, escalation
        |                          --history records snapshots
        |                          --trends shows inline analysis
        |                          --remediate generates plans
        v
runtime_history.py            <-- snapshot persistence, trend detection
runtime_remediator.py         <-- approval workflows, dedup, expiration
runtime_rotation.py (V4)      <-- deterministic log retention
runtime_export.py (V4)        <-- operational continuity bundles
        |
        v
logs/runtime-guardian/        <-- timestamped JSON logs + escalation state
logs/runtime-history/         <-- append-only JSONL snapshots
logs/runtime-remediation/     <-- plan lifecycle directories
logs/runtime-archives/        <-- compressed rotation archives
logs/exports/                 <-- continuity export bundles
```

## Health Checks

| Check | Warning | Critical |
|-------|---------|----------|
| `instance_path` | config.json missing | Instance root missing |
| `backup_freshness` | Last backup > 24h ago | Last backup > 72h ago |
| `orphan_count` | >= 1 orphaned entry | >= 5 orphaned entries |
| `missing_metadata` | >= 1 missing | >= 5 missing |
| `stale_entities` | >= 1 stale company | -- |
| `duplicate_agents` | >= 1 duplicate set | -- |
| `storage_size` | Total > 1 GB | Total > 5 GB |

### Scoring

- **healthy** - All checks pass
- **warning** - At least one warning, no criticals
- **critical** - At least one critical

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | healthy (or warning without `--fail-on-warning`) |
| 1 | warning (with `--fail-on-warning`) |
| 2 | critical |

## Usage

### One-shot check (default)

```bash
python scripts/runtime_guardian.py --once
```

### JSON output

```bash
python scripts/runtime_guardian.py --json
```

### Watch mode (repeating)

```bash
python scripts/runtime_guardian.py --watch --interval 300
```

Runs every 300 seconds (5 minutes). Ctrl+C to stop gracefully.

### CI gate

```bash
python scripts/runtime_guardian.py --once --fail-on-warning
# Exit 0 = healthy, 1 = warning, 2 = critical
```

### Skip log files

```bash
python scripts/runtime_guardian.py --once --no-log
```

### Custom instance root

```bash
python scripts/runtime_guardian.py --once --instance-root /path/to/instance
```

### Auto-generate remediation plans

```bash
python scripts/runtime_guardian.py --once --remediate
```

When issues are detected, generates structured remediation plans in `logs/runtime-remediation/pending/`. Plans are deduplicated by fingerprint. Prints approval commands for plans that require manual approval. See [RUNTIME_REMEDIATION_MODEL.md](RUNTIME_REMEDIATION_MODEL.md).

### Record history snapshot

```bash
python scripts/runtime_guardian.py --once --history
```

Records a snapshot to `logs/runtime-history/snapshots.jsonl` for trend analysis.

### Show inline trends

```bash
python scripts/runtime_guardian.py --once --history --trends
```

Records snapshot and displays 24h trend analysis inline.

### Full operational cycle

```bash
python scripts/runtime_guardian.py --once --history --trends --remediate
```

Health check + history recording + trend analysis + remediation plan generation in a single run.

## Log Output

Logs are written to `logs/runtime-guardian/`:

```
logs/runtime-guardian/
  guardian-20260516-130000.json   # Timestamped snapshot
  guardian-latest.json            # Always the most recent run
```

Each log file contains the full guardian result: overall status, all check results with detail, and topology summary.

## Runbook: Runtime Guardian

### When to use

- **Daily operations** - Run `--once` as a morning health check
- **CI/CD gates** - Run `--once --fail-on-warning` before deploys
- **Incident monitoring** - Run `--watch --interval 60` during active incidents
- **Post-maintenance** - Run `--once` after backup restores, migrations, or cleanup

### Interpreting results

1. **Start with overall status.** If `healthy`, no action needed.
2. **Read each check's message.** The message includes key numbers (hours since backup, orphan count, etc).
3. **Use `--json` for scripting.** Parse `overall_status` and individual `checks[].status` fields.

### Responding to warnings

| Check | Response |
|-------|----------|
| `backup_freshness` (warning) | Verify backup scheduler is running. Check `config.json` backup settings. |
| `orphan_count` (warning) | Run `runtime_topology_report.py` for details. Cross-reference with DB. |
| `missing_metadata` (warning) | Check if projects/agents were partially created. Re-deploy if needed. |
| `stale_entities` (warning) | Verify with stakeholders whether stale companies are still needed. |
| `duplicate_agents` (warning) | May be intentional (shared template). Document if so. |
| `storage_size` (warning) | Review backup retention. Archive old backups externally. |

### Responding to criticals

| Check | Response |
|-------|----------|
| `instance_path` (critical) | Instance root is gone. Check disk, mounts, and permissions. |
| `backup_freshness` (critical) | Backups are 72h+ stale. Immediate investigation required. |
| `orphan_count` (critical) | 5+ orphans suggest a failed bulk operation. Audit and clean up. |
| `missing_metadata` (critical) | 5+ entities missing metadata. Possible corruption or incomplete migration. |
| `storage_size` (critical) | Disk pressure imminent. Purge stale caches, archive old backups. |

### Thresholds reference

These are compile-time constants at the top of `runtime_guardian.py`:

```python
BACKUP_WARNING_HOURS = 24
BACKUP_CRITICAL_HOURS = 72
ORPHAN_WARNING_THRESHOLD = 1
ORPHAN_CRITICAL_THRESHOLD = 5
MISSING_METADATA_WARNING = 1
MISSING_METADATA_CRITICAL = 5
STALE_COMPANY_WARNING = 1
STORAGE_WARNING_GB = 1.0
STORAGE_CRITICAL_GB = 5.0
```

Adjust these to match your operational environment. For example, if hourly backups are expected, lower `BACKUP_WARNING_HOURS` to 2.

### Watch mode considerations

- Watch mode holds a Python process open. On Windows, use Ctrl+C to exit.
- Each iteration writes a new log file. At `--interval 60`, that is 1440 files/day. Use `--no-log` or raise the interval for long runs.
- Watch mode respects SIGINT and SIGTERM for graceful shutdown.
