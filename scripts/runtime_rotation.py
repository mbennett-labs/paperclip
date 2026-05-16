#!/usr/bin/env python3
"""
Runtime Rotation V4 for Paperclip/Selarix

Deterministic retention management for guardian, history, and remediation logs.
Monthly JSONL rollover, compressed archives, configurable retention windows.

No silent deletion. Every rotation logged. Archive manifests produced.

Usage:
    python scripts/runtime_rotation.py --dry-run
    python scripts/runtime_rotation.py --confirm
    python scripts/runtime_rotation.py --json
"""

import argparse
import gzip
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_topology_report import format_size

REPO_ROOT = Path(__file__).resolve().parent.parent
LOGS_ROOT = REPO_ROOT / "logs"

GUARDIAN_DIR = LOGS_ROOT / "runtime-guardian"
HISTORY_DIR = LOGS_ROOT / "runtime-history"
REMEDIATION_DIR = LOGS_ROOT / "runtime-remediation"
ARCHIVE_DIR = LOGS_ROOT / "runtime-archives"

# Retention windows (days)
GUARDIAN_LOG_RETENTION_DAYS = 30
HISTORY_SNAPSHOT_RETENTION_DAYS = 90
REMEDIATION_EXECUTED_RETENTION_DAYS = 60
REMEDIATION_EXPIRED_RETENTION_DAYS = 30
TOPOLOGY_EXPORT_RETENTION_DAYS = 30


def _file_age_days(path: Path) -> float:
    """Get file age in days."""
    mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    return (datetime.now(tz=timezone.utc) - mtime).total_seconds() / 86400


def _dir_size(path: Path) -> int:
    """Total size of files in a directory."""
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def plan_guardian_rotation() -> list[dict]:
    """Plan rotation for guardian log files."""
    actions = []
    if not GUARDIAN_DIR.exists():
        return actions

    for f in sorted(GUARDIAN_DIR.glob("guardian-2*.json")):
        age = _file_age_days(f)
        if age > GUARDIAN_LOG_RETENTION_DAYS:
            actions.append({
                "type": "archive_compress",
                "source": str(f),
                "source_name": f.name,
                "category": "guardian-logs",
                "age_days": round(age, 1),
                "size_bytes": f.stat().st_size,
                "retention_days": GUARDIAN_LOG_RETENTION_DAYS,
            })

    # Also check archived/ subdirectory
    archived_dir = GUARDIAN_DIR / "archived"
    if archived_dir.exists():
        for f in sorted(archived_dir.glob("*.json")):
            age = _file_age_days(f)
            if age > GUARDIAN_LOG_RETENTION_DAYS * 2:  # Double retention for already-archived
                actions.append({
                    "type": "archive_compress",
                    "source": str(f),
                    "source_name": f.name,
                    "category": "guardian-archived",
                    "age_days": round(age, 1),
                    "size_bytes": f.stat().st_size,
                    "retention_days": GUARDIAN_LOG_RETENTION_DAYS * 2,
                })

    return actions


def plan_history_rotation() -> list[dict]:
    """Plan monthly rollover for history JSONL."""
    actions = []
    snapshots_file = HISTORY_DIR / "snapshots.jsonl"
    if not snapshots_file.exists():
        return actions

    # Check if file has entries older than retention
    lines = []
    cutoff = datetime.now(tz=timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    old_lines = []
    current_lines = []

    with open(snapshots_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                snap = json.loads(line)
                ts = datetime.fromisoformat(snap["timestamp"])
                if ts < cutoff:
                    old_lines.append(line)
                else:
                    current_lines.append(line)
            except (json.JSONDecodeError, KeyError):
                current_lines.append(line)  # Keep unparseable lines in current

    if old_lines:
        # Group old lines by month
        months = {}
        for line in old_lines:
            try:
                snap = json.loads(line)
                ts = datetime.fromisoformat(snap["timestamp"])
                month_key = ts.strftime("%Y-%m")
            except (json.JSONDecodeError, KeyError):
                month_key = "unknown"
            months.setdefault(month_key, []).append(line)

        for month_key, month_lines in months.items():
            total_size = sum(len(l.encode()) for l in month_lines)
            actions.append({
                "type": "history_rollover",
                "month": month_key,
                "snapshot_count": len(month_lines),
                "category": "history-snapshots",
                "size_bytes": total_size,
                "current_remaining": len(current_lines),
            })

    return actions


def plan_remediation_rotation() -> list[dict]:
    """Plan rotation for executed/expired remediation plans."""
    actions = []

    for subdir, retention in [
        ("executed", REMEDIATION_EXECUTED_RETENTION_DAYS),
        ("expired", REMEDIATION_EXPIRED_RETENTION_DAYS),
    ]:
        d = REMEDIATION_DIR / subdir
        if not d.exists():
            continue
        for f in sorted(d.glob("REM-*.json")):
            age = _file_age_days(f)
            if age > retention:
                actions.append({
                    "type": "archive_compress",
                    "source": str(f),
                    "source_name": f.name,
                    "category": f"remediation-{subdir}",
                    "age_days": round(age, 1),
                    "size_bytes": f.stat().st_size,
                    "retention_days": retention,
                })

    # Topology and health snapshots
    for subdir in ["topology-snapshots", "health-snapshots"]:
        d = REMEDIATION_DIR / subdir
        if not d.exists():
            continue
        for f in sorted(d.glob("*.json")):
            age = _file_age_days(f)
            if age > TOPOLOGY_EXPORT_RETENTION_DAYS:
                actions.append({
                    "type": "archive_compress",
                    "source": str(f),
                    "source_name": f.name,
                    "category": f"remediation-{subdir}",
                    "age_days": round(age, 1),
                    "size_bytes": f.stat().st_size,
                    "retention_days": TOPOLOGY_EXPORT_RETENTION_DAYS,
                })

    return actions


def plan_rotation() -> dict:
    """Plan all rotation actions."""
    guardian = plan_guardian_rotation()
    history = plan_history_rotation()
    remediation = plan_remediation_rotation()

    all_actions = guardian + history + remediation
    total_reclaimable = sum(a.get("size_bytes", 0) for a in all_actions)

    return {
        "planned_at": datetime.now(tz=timezone.utc).isoformat(),
        "actions": all_actions,
        "summary": {
            "guardian_logs": len(guardian),
            "history_rollovers": len(history),
            "remediation_archives": len(remediation),
            "total_actions": len(all_actions),
            "total_reclaimable_bytes": total_reclaimable,
            "total_reclaimable_human": format_size(total_reclaimable),
        },
    }


def execute_rotation(plan: dict) -> dict:
    """Execute a rotation plan. Returns manifest."""
    now = datetime.now(tz=timezone.utc)
    month_str = now.strftime("%Y-%m")
    archive_subdir = ARCHIVE_DIR / month_str
    archive_subdir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "executed_at": now.isoformat(),
        "archive_dir": str(archive_subdir),
        "actions_executed": 0,
        "actions_failed": 0,
        "bytes_reclaimed": 0,
        "files_archived": [],
        "errors": [],
    }

    for action in plan["actions"]:
        try:
            if action["type"] == "archive_compress":
                src = Path(action["source"])
                if not src.exists():
                    continue
                dest = archive_subdir / f"{action['category']}--{src.name}.gz"
                with open(src, "rb") as f_in:
                    with gzip.open(dest, "wb") as f_out:
                        shutil.copyfileobj(f_in, f_out)
                size = src.stat().st_size
                src.unlink()
                manifest["bytes_reclaimed"] += size
                manifest["files_archived"].append({
                    "source": action["source_name"],
                    "archive": str(dest.name),
                    "size_bytes": size,
                    "category": action["category"],
                })
                manifest["actions_executed"] += 1

            elif action["type"] == "history_rollover":
                _execute_history_rollover(action, archive_subdir, manifest)

        except Exception as e:
            manifest["actions_failed"] += 1
            manifest["errors"].append({"action": action.get("source_name", "unknown"), "error": str(e)})

    # Write manifest
    manifest_path = archive_subdir / f"manifest-{now.strftime('%Y%m%d-%H%M%S')}.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    manifest["manifest_path"] = str(manifest_path)

    return manifest


def _execute_history_rollover(action: dict, archive_subdir: Path, manifest: dict):
    """Execute history JSONL rollover for a specific month."""
    snapshots_file = HISTORY_DIR / "snapshots.jsonl"
    if not snapshots_file.exists():
        return

    month_key = action["month"]
    cutoff = datetime.now(tz=timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    old_lines = []
    current_lines = []

    with open(snapshots_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                snap = json.loads(line)
                ts = datetime.fromisoformat(snap["timestamp"])
                if ts < cutoff:
                    old_lines.append(line)
                else:
                    current_lines.append(line)
            except (json.JSONDecodeError, KeyError):
                current_lines.append(line)

    if old_lines:
        # Write old lines to compressed archive
        archive_name = f"history-snapshots--{month_key}.jsonl.gz"
        archive_path = archive_subdir / archive_name
        with gzip.open(archive_path, "wt", encoding="utf-8") as f:
            for line in old_lines:
                f.write(line + "\n")

        # Rewrite current file with only current lines
        with open(snapshots_file, "w", encoding="utf-8") as f:
            for line in current_lines:
                f.write(line + "\n")

        size = sum(len(l.encode()) for l in old_lines)
        manifest["bytes_reclaimed"] += size
        manifest["files_archived"].append({
            "source": "snapshots.jsonl (rollover)",
            "archive": archive_name,
            "size_bytes": size,
            "category": "history-rollover",
            "snapshots_archived": len(old_lines),
            "snapshots_retained": len(current_lines),
        })
        manifest["actions_executed"] += 1


def format_plan_text(plan: dict) -> str:
    """Format rotation plan for human display."""
    lines = []
    lines.append("=" * 64)
    lines.append("  PAPERCLIP RUNTIME ROTATION")
    lines.append("=" * 64)

    s = plan["summary"]
    lines.append(f"  Planned:    {plan['planned_at'][:19]}")
    lines.append(f"  Actions:    {s['total_actions']}")
    lines.append(f"  Reclaimable: {s['total_reclaimable_human']}")
    lines.append("-" * 64)

    if s["total_actions"] == 0:
        lines.append("  Nothing to rotate. All logs within retention windows.")
        lines.append("=" * 64)
        return "\n".join(lines)

    lines.append(f"  Guardian logs:    {s['guardian_logs']}")
    lines.append(f"  History rollover: {s['history_rollovers']}")
    lines.append(f"  Remediation:      {s['remediation_archives']}")
    lines.append("-" * 64)

    for action in plan["actions"]:
        if action["type"] == "archive_compress":
            lines.append(f"  [ROT] {action['source_name']}")
            lines.append(f"        {action['category']} | {action['age_days']}d old | "
                         f"{format_size(action['size_bytes'])} | retain: {action['retention_days']}d")
        elif action["type"] == "history_rollover":
            lines.append(f"  [ROL] snapshots.jsonl month={action['month']}")
            lines.append(f"        {action['snapshot_count']} snapshots | "
                         f"{format_size(action['size_bytes'])} | "
                         f"{action['current_remaining']} retained")

    lines.append("=" * 64)
    return "\n".join(lines)


def format_manifest_text(manifest: dict) -> str:
    """Format execution manifest for human display."""
    lines = []
    lines.append("=" * 64)
    lines.append("  ROTATION COMPLETE")
    lines.append("=" * 64)
    lines.append(f"  Executed:  {manifest['actions_executed']} actions")
    lines.append(f"  Failed:    {manifest['actions_failed']} actions")
    lines.append(f"  Reclaimed: {format_size(manifest['bytes_reclaimed'])}")
    lines.append(f"  Archive:   {manifest['archive_dir']}")

    if manifest.get("manifest_path"):
        lines.append(f"  Manifest:  {manifest['manifest_path']}")

    if manifest["errors"]:
        lines.append("-" * 64)
        lines.append("  ERRORS:")
        for e in manifest["errors"]:
            lines.append(f"    {e['action']}: {e['error']}")

    lines.append("=" * 64)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Paperclip Runtime Rotation V4 - Deterministic log retention management"
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be rotated without executing")
    parser.add_argument("--confirm", action="store_true",
                        help="Execute rotation (archive + compress + reclaim)")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    args = parser.parse_args()

    if not args.dry_run and not args.confirm:
        args.dry_run = True

    rotation_plan = plan_rotation()

    if args.dry_run:
        if args.json:
            print(json.dumps(rotation_plan, indent=2))
        else:
            print(format_plan_text(rotation_plan))
            if rotation_plan["summary"]["total_actions"] > 0:
                print("\n  To execute: python scripts/runtime_rotation.py --confirm\n")

    elif args.confirm:
        if rotation_plan["summary"]["total_actions"] == 0:
            if args.json:
                print(json.dumps({"status": "nothing_to_rotate"}, indent=2))
            else:
                print("  Nothing to rotate. All logs within retention windows.")
            sys.exit(0)

        manifest = execute_rotation(rotation_plan)
        if args.json:
            print(json.dumps(manifest, indent=2))
        else:
            print(format_manifest_text(manifest))


if __name__ == "__main__":
    main()
