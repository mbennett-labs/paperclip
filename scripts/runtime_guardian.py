#!/usr/bin/env python3
"""
Runtime Guardian V3 for Paperclip/Selarix

Recurring operational health monitor built on runtime_topology_report.py.
Produces a health score (healthy/warning/critical), writes timestamped logs,
and supports one-shot, JSON, and watch modes.

V2 adds --remediate flag to auto-generate remediation plans.
V3 adds --history flag to auto-record snapshots for trend analysis,
and --trends to show trend summary inline.

Read-only by default. No destructive actions. No auto-delete. No runtime mutation.

Usage:
    python scripts/runtime_guardian.py --once
    python scripts/runtime_guardian.py --json
    python scripts/runtime_guardian.py --watch --interval 300
    python scripts/runtime_guardian.py --once --fail-on-warning
    python scripts/runtime_guardian.py --once --remediate
    python scripts/runtime_guardian.py --once --history
    python scripts/runtime_guardian.py --once --history --trends
"""

import argparse
import json
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Import the topology report engine
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_topology_report import run_report, format_size, DEFAULT_INSTANCE_ROOT

# Thresholds
BACKUP_WARNING_HOURS = 24
BACKUP_CRITICAL_HOURS = 72
ORPHAN_WARNING_THRESHOLD = 1
ORPHAN_CRITICAL_THRESHOLD = 5
MISSING_METADATA_WARNING = 1
MISSING_METADATA_CRITICAL = 5
STALE_COMPANY_WARNING = 1
STORAGE_WARNING_GB = 1.0
STORAGE_CRITICAL_GB = 5.0

# Log directory (relative to repo root)
REPO_ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = REPO_ROOT / "logs" / "runtime-guardian"


class Check:
    """Single health check result."""

    def __init__(self, name: str, status: str, message: str, detail: dict | None = None):
        self.name = name
        self.status = status  # "healthy", "warning", "critical"
        self.message = message
        self.detail = detail or {}

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "status": self.status,
            "message": self.message,
            "detail": self.detail,
        }


def check_instance_exists(instance_root: Path) -> Check:
    """Verify the embedded Paperclip instance path exists."""
    if instance_root.exists():
        config_path = instance_root / "config.json"
        has_config = config_path.exists()
        return Check(
            "instance_path",
            "healthy" if has_config else "warning",
            f"Instance root exists{'' if has_config else ', but config.json missing'}",
            {"path": str(instance_root), "has_config": has_config},
        )
    return Check(
        "instance_path",
        "critical",
        f"Instance root not found: {instance_root}",
        {"path": str(instance_root)},
    )


def check_backup_freshness(report: dict) -> Check:
    """Check backup recency."""
    backups = report["backups"]
    if not backups["exists"]:
        return Check("backup_freshness", "critical", "Backup directory missing")

    if backups["archive_count"] == 0:
        return Check("backup_freshness", "critical", "No backup archives found")

    newest = datetime.fromisoformat(backups["newest"])
    hours_since = (datetime.now(tz=timezone.utc) - newest).total_seconds() / 3600

    if hours_since > BACKUP_CRITICAL_HOURS:
        status = "critical"
    elif hours_since > BACKUP_WARNING_HOURS:
        status = "warning"
    else:
        status = "healthy"

    return Check(
        "backup_freshness",
        status,
        f"Last backup {hours_since:.1f}h ago ({backups['archive_count']} archives, {backups['total_size_human']})",
        {
            "hours_since_last": round(hours_since, 1),
            "archive_count": backups["archive_count"],
            "total_size_bytes": backups["total_size_bytes"],
            "newest": backups["newest"],
            "oldest": backups["oldest"],
        },
    )


def check_orphan_count(report: dict) -> Check:
    """Check for orphaned runtime state."""
    total = report["orphans"]["total_orphans"]

    if total >= ORPHAN_CRITICAL_THRESHOLD:
        status = "critical"
    elif total >= ORPHAN_WARNING_THRESHOLD:
        status = "warning"
    else:
        status = "healthy"

    return Check(
        "orphan_count",
        status,
        f"{total} orphaned entries",
        {
            "total": total,
            "run_logs": len(report["orphans"]["orphaned_run_logs"]),
            "storage": len(report["orphans"]["orphaned_storage"]),
            "projects": len(report["orphans"]["orphaned_projects"]),
        },
    )


def check_missing_metadata(report: dict) -> Check:
    """Check for missing metadata."""
    count = len(report["missing_metadata"])

    if count >= MISSING_METADATA_CRITICAL:
        status = "critical"
    elif count >= MISSING_METADATA_WARNING:
        status = "warning"
    else:
        status = "healthy"

    types = {}
    for issue in report["missing_metadata"]:
        t = issue["type"]
        types[t] = types.get(t, 0) + 1

    return Check(
        "missing_metadata",
        status,
        f"{count} entities missing metadata",
        {"count": count, "by_type": types},
    )


def check_stale_entities(report: dict) -> Check:
    """Check for stale companies and agents."""
    stale_companies = [c["company_id"] for c in report["companies"] if c["stale"]]
    stale_agents = []
    for c in report["companies"]:
        for a in c["agents"]:
            if a["stale"]:
                stale_agents.append(f"{c['company_id'][:8]}.../{a['agent_id'][:8]}...")

    total_stale = len(stale_companies) + len(stale_agents)

    if len(stale_companies) >= STALE_COMPANY_WARNING:
        status = "warning"
    else:
        status = "healthy"

    return Check(
        "stale_entities",
        status,
        f"{len(stale_companies)} stale companies, {len(stale_agents)} stale agents",
        {
            "stale_companies": stale_companies,
            "stale_agent_count": len(stale_agents),
        },
    )


def check_duplicate_agents(report: dict) -> Check:
    """Check for duplicate agent instruction sets."""
    count = len(report["duplicates"])

    return Check(
        "duplicate_agents",
        "warning" if count > 0 else "healthy",
        f"{count} duplicate instruction sets",
        {"count": count, "groups": report["duplicates"]},
    )


def check_storage_size(report: dict) -> Check:
    """Check total storage size across all assets + backups."""
    storage_bytes = sum(s["stats"]["total_size_bytes"] for s in report["storage"])
    backup_bytes = report["backups"].get("total_size_bytes", 0)
    total_bytes = storage_bytes + backup_bytes
    total_gb = total_bytes / (1024 * 1024 * 1024)

    if total_gb >= STORAGE_CRITICAL_GB:
        status = "critical"
    elif total_gb >= STORAGE_WARNING_GB:
        status = "warning"
    else:
        status = "healthy"

    return Check(
        "storage_size",
        status,
        f"Total data: {format_size(total_bytes)} (storage: {format_size(storage_bytes)}, backups: {format_size(backup_bytes)})",
        {
            "total_bytes": total_bytes,
            "storage_bytes": storage_bytes,
            "backup_bytes": backup_bytes,
        },
    )


def run_guardian(instance_root: Path) -> dict:
    """Run all guardian checks and produce a scored result."""
    now = datetime.now(tz=timezone.utc)

    # Run the topology report
    topology = run_report(instance_root)

    # Run all checks
    checks = [
        check_instance_exists(instance_root),
        check_backup_freshness(topology),
        check_orphan_count(topology),
        check_missing_metadata(topology),
        check_stale_entities(topology),
        check_duplicate_agents(topology),
        check_storage_size(topology),
    ]

    # Compute overall score
    statuses = [c.status for c in checks]
    if "critical" in statuses:
        overall = "critical"
    elif "warning" in statuses:
        overall = "warning"
    else:
        overall = "healthy"

    result = {
        "generated_at": now.isoformat(),
        "instance_root": str(instance_root),
        "overall_status": overall,
        "checks": [c.to_dict() for c in checks],
        "topology_summary": {
            "companies": len(topology["companies"]),
            "projects": len(topology["projects"]),
            "agents": sum(c["agent_count"] for c in topology["companies"]),
            "prompt_caches": sum(c["prompt_cache_count"] for c in topology["companies"]),
            "backup_archives": topology["backups"]["archive_count"],
            "orphans": topology["orphans"]["total_orphans"],
        },
    }

    return result


def format_text_output(result: dict) -> str:
    """Format guardian result as human-readable text."""
    lines = []
    status_icon = {"healthy": "[OK]", "warning": "[WARN]", "critical": "[CRIT]"}

    lines.append("=" * 60)
    lines.append("  PAPERCLIP RUNTIME GUARDIAN V3")
    lines.append("=" * 60)
    lines.append(f"  Time:     {result['generated_at']}")
    lines.append(f"  Instance: {result['instance_root']}")
    lines.append(f"  Status:   {status_icon[result['overall_status']]} {result['overall_status'].upper()}")
    lines.append("-" * 60)

    # Summary line
    s = result["topology_summary"]
    lines.append(f"  Topology: {s['companies']} companies, {s['agents']} agents, "
                 f"{s['projects']} projects, {s['backup_archives']} backups")
    lines.append("-" * 60)

    # Individual checks
    lines.append("  CHECKS:")
    for check in result["checks"]:
        icon = status_icon[check["status"]]
        lines.append(f"    {icon} {check['name']}: {check['message']}")

    lines.append("=" * 60)
    return "\n".join(lines)


def write_log(result: dict):
    """Write timestamped log entry to logs/runtime-guardian/."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d-%H%M%S")
    log_file = LOG_DIR / f"guardian-{timestamp}.json"
    log_file.write_text(json.dumps(result, indent=2))

    # Also append to rolling summary log
    summary_file = LOG_DIR / "guardian-latest.json"
    summary_file.write_text(json.dumps(result, indent=2))

    return log_file


def main():
    parser = argparse.ArgumentParser(
        description="Paperclip Runtime Guardian V1 - Operational health monitor"
    )
    parser.add_argument(
        "--instance-root", type=Path, default=DEFAULT_INSTANCE_ROOT,
        help="Path to instance root (default: ~/.paperclip/instances/default)",
    )
    parser.add_argument("--json", action="store_true", help="Output JSON only")
    parser.add_argument("--once", action="store_true", help="Run once and exit")
    parser.add_argument("--watch", action="store_true", help="Run in watch mode (repeating)")
    parser.add_argument(
        "--interval", type=int, default=300,
        help="Seconds between checks in watch mode (default: 300)",
    )
    parser.add_argument(
        "--fail-on-warning", action="store_true",
        help="Exit nonzero on warning (default: only on critical)",
    )
    parser.add_argument(
        "--no-log", action="store_true",
        help="Skip writing log files",
    )
    parser.add_argument(
        "--remediate", action="store_true",
        help="Auto-generate remediation plans for detected issues",
    )
    parser.add_argument(
        "--history", action="store_true",
        help="Record a history snapshot for trend analysis",
    )
    parser.add_argument(
        "--trends", action="store_true",
        help="Show trend summary after check (requires --history or existing snapshots)",
    )
    args = parser.parse_args()

    # Default to --once if neither --once nor --watch specified
    if not args.once and not args.watch:
        args.once = True

    # Graceful shutdown for watch mode
    running = True

    def handle_signal(signum, frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    iteration = 0
    exit_code = 0

    while running:
        iteration += 1
        result = run_guardian(args.instance_root)

        # Write log
        if not args.no_log:
            log_file = write_log(result)

        # Output
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            text = format_text_output(result)
            print(text)
            if not args.no_log:
                print(f"  Log: {log_file}")
            print()

        # Generate remediation plans if requested and issues found
        if args.remediate and result["overall_status"] != "healthy":
            from runtime_remediator import generate_plans_from_guardian, save_plan, format_plan_text
            # Re-use the guardian result by generating plans from a fresh scan
            plans = generate_plans_from_guardian(args.instance_root)
            for plan in plans:
                save_plan(plan)
            if args.json:
                result["remediation_plans"] = plans
                # Re-print with plans included
            else:
                print(f"  Generated {len(plans)} remediation plan(s):")
                print()
                for plan in plans:
                    print(format_plan_text(plan))
                    print()
                pending = [p for p in plans if p["requires_approval"]]
                if pending:
                    print("  Approve with:")
                    for p in pending:
                        print(f"    python scripts/runtime_remediator.py --approve {p['issue_id']}")
                    print()

        # Record history snapshot if requested
        if args.history:
            from runtime_history import create_snapshot, record_snapshot
            snapshot = create_snapshot(args.instance_root)
            record_snapshot(snapshot)
            if not args.json:
                print(f"  History snapshot recorded.")

        # Show trends if requested
        if args.trends:
            from runtime_history import load_snapshots_since, detect_trends, format_trends_text
            snaps_24h = load_snapshots_since(24)
            trend_result = detect_trends(snaps_24h, "Last 24 hours")
            if args.json:
                result["trends_24h"] = trend_result
            else:
                if trend_result["trends"] or trend_result["anomalies"]:
                    print(format_trends_text([trend_result]))
                else:
                    print("  Trends: No significant changes in last 24h.")
                print()

        # Determine exit code
        if result["overall_status"] == "critical":
            exit_code = 2
        elif result["overall_status"] == "warning" and args.fail_on_warning:
            exit_code = 1

        # One-shot mode
        if args.once:
            break

        # Watch mode: sleep until next interval
        if args.watch:
            if not args.json:
                print(f"  Next check in {args.interval}s (Ctrl+C to stop)\n")
            try:
                time.sleep(args.interval)
            except KeyboardInterrupt:
                running = False

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
