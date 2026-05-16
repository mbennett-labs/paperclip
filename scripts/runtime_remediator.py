#!/usr/bin/env python3
"""
Runtime Remediator V2 for Paperclip/Selarix

Approval-aware corrective workflow engine for guardian findings.
Generates structured remediation plans, manages approval lifecycle,
and executes only safe, auditable actions.

Core principle:
  Guardian DETECTS and PREPARES remediation automatically.
  Guardian may only EXECUTE approved safe actions.
  No silent mutations. No destructive operations.

Usage:
    python scripts/runtime_remediator.py --list
    python scripts/runtime_remediator.py --approve ISSUE_ID
    python scripts/runtime_remediator.py --execute ISSUE_ID
    python scripts/runtime_remediator.py --status ISSUE_ID
    python scripts/runtime_remediator.py --json
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Import guardian and topology
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_topology_report import DEFAULT_INSTANCE_ROOT, run_report, format_size
from runtime_guardian import run_guardian

REPO_ROOT = Path(__file__).resolve().parent.parent
REMEDIATION_DIR = REPO_ROOT / "logs" / "runtime-remediation"
PENDING_DIR = REMEDIATION_DIR / "pending"
APPROVED_DIR = REMEDIATION_DIR / "approved"
EXECUTED_DIR = REMEDIATION_DIR / "executed"
FAILED_DIR = REMEDIATION_DIR / "failed"

# Guardian log directory (for log rotation remediation)
GUARDIAN_LOG_DIR = REPO_ROOT / "logs" / "runtime-guardian"

# Supported V1 remediation actions
SUPPORTED_ACTIONS = {
    "trigger_backup": {
        "description": "Trigger database backup via backup-db.sh",
        "requires_approval": True,
        "estimated_risk": "low",
        "rollback_available": False,
    },
    "verify_backup_integrity": {
        "description": "Verify latest backup archive is readable and non-empty",
        "requires_approval": False,
        "estimated_risk": "none",
        "rollback_available": False,
    },
    "rotate_guardian_logs": {
        "description": "Archive guardian logs older than N days",
        "requires_approval": True,
        "estimated_risk": "low",
        "rollback_available": True,
    },
    "archive_stale_run_logs": {
        "description": "Archive stale agent run logs to a dated tarball",
        "requires_approval": True,
        "estimated_risk": "low",
        "rollback_available": True,
    },
    "rerun_topology_scan": {
        "description": "Re-run topology report and save output",
        "requires_approval": False,
        "estimated_risk": "none",
        "rollback_available": False,
    },
    "regenerate_health_snapshot": {
        "description": "Re-run guardian and save fresh health snapshot",
        "requires_approval": False,
        "estimated_risk": "none",
        "rollback_available": False,
    },
    "verify_db_path": {
        "description": "Verify embedded PostgreSQL data directory exists",
        "requires_approval": False,
        "estimated_risk": "none",
        "rollback_available": False,
    },
}


def ensure_dirs():
    """Create remediation directory structure."""
    for d in [PENDING_DIR, APPROVED_DIR, EXECUTED_DIR, FAILED_DIR]:
        d.mkdir(parents=True, exist_ok=True)


def generate_issue_id() -> str:
    """Generate a short, human-friendly issue ID."""
    return f"REM-{uuid.uuid4().hex[:8].upper()}"


def create_plan(
    action: str,
    severity: str,
    evidence: dict,
    instance_root: Path = DEFAULT_INSTANCE_ROOT,
) -> dict:
    """Create a structured remediation plan."""
    action_meta = SUPPORTED_ACTIONS[action]
    issue_id = generate_issue_id()
    now = datetime.now(tz=timezone.utc).isoformat()

    plan = {
        "issue_id": issue_id,
        "action": action,
        "description": action_meta["description"],
        "severity": severity,
        "detection_time": now,
        "recommended_action": action,
        "requires_approval": action_meta["requires_approval"],
        "estimated_risk": action_meta["estimated_risk"],
        "estimated_runtime": "< 30s",
        "rollback_available": action_meta["rollback_available"],
        "evidence": evidence,
        "instance_root": str(instance_root),
        "state": "pending",
        "created_at": now,
        "approved_at": None,
        "executed_at": None,
        "completed_at": None,
        "result": None,
    }

    return plan


def save_plan(plan: dict) -> Path:
    """Save a plan to the pending directory."""
    ensure_dirs()
    path = PENDING_DIR / f"{plan['issue_id']}.json"
    path.write_text(json.dumps(plan, indent=2))
    return path


def load_plan(issue_id: str) -> tuple[dict | None, Path | None]:
    """Find and load a plan by issue ID from any state directory."""
    ensure_dirs()
    for d in [PENDING_DIR, APPROVED_DIR, EXECUTED_DIR, FAILED_DIR]:
        path = d / f"{issue_id}.json"
        if path.exists():
            return json.loads(path.read_text()), path
    return None, None


def move_plan(plan: dict, old_path: Path, new_dir: Path) -> Path:
    """Move a plan file to a new state directory."""
    new_path = new_dir / old_path.name
    plan_json = json.dumps(plan, indent=2)
    new_path.write_text(plan_json)
    if old_path.exists() and old_path != new_path:
        old_path.unlink()
    return new_path


def approve_plan(issue_id: str) -> dict:
    """Approve a pending plan."""
    plan, path = load_plan(issue_id)
    if plan is None:
        return {"error": f"Plan {issue_id} not found"}
    if plan["state"] != "pending":
        return {"error": f"Plan {issue_id} is in state '{plan['state']}', expected 'pending'"}

    plan["state"] = "approved"
    plan["approved_at"] = datetime.now(tz=timezone.utc).isoformat()
    move_plan(plan, path, APPROVED_DIR)
    return {"ok": True, "issue_id": issue_id, "state": "approved"}


def execute_plan(issue_id: str) -> dict:
    """Execute an approved plan (or auto-approved if requires_approval=False)."""
    plan, path = load_plan(issue_id)
    if plan is None:
        return {"error": f"Plan {issue_id} not found"}
    if plan["state"] not in ("approved", "pending"):
        return {"error": f"Plan {issue_id} is in state '{plan['state']}', cannot execute"}
    if plan["state"] == "pending" and plan["requires_approval"]:
        return {"error": f"Plan {issue_id} requires approval first. Run: python scripts/runtime_remediator.py --approve {issue_id}"}

    # If pending but doesn't require approval, auto-approve
    if plan["state"] == "pending":
        plan["state"] = "approved"
        plan["approved_at"] = datetime.now(tz=timezone.utc).isoformat()
        path = move_plan(plan, path, APPROVED_DIR)

    plan["executed_at"] = datetime.now(tz=timezone.utc).isoformat()
    instance_root = Path(plan["instance_root"])

    try:
        result = _execute_action(plan["action"], instance_root, plan)
        plan["state"] = "executed"
        plan["completed_at"] = datetime.now(tz=timezone.utc).isoformat()
        plan["result"] = result
        move_plan(plan, path, EXECUTED_DIR)
        return {"ok": True, "issue_id": issue_id, "state": "executed", "result": result}
    except Exception as e:
        plan["state"] = "failed"
        plan["completed_at"] = datetime.now(tz=timezone.utc).isoformat()
        plan["result"] = {"error": str(e)}
        move_plan(plan, path, FAILED_DIR)
        return {"ok": False, "issue_id": issue_id, "state": "failed", "error": str(e)}


def _execute_action(action: str, instance_root: Path, plan: dict) -> dict:
    """Execute a specific remediation action. Returns result dict."""

    if action == "trigger_backup":
        return _action_trigger_backup()

    elif action == "verify_backup_integrity":
        return _action_verify_backup_integrity(instance_root)

    elif action == "rotate_guardian_logs":
        return _action_rotate_guardian_logs()

    elif action == "archive_stale_run_logs":
        return _action_archive_stale_run_logs(instance_root)

    elif action == "rerun_topology_scan":
        return _action_rerun_topology_scan(instance_root)

    elif action == "regenerate_health_snapshot":
        return _action_regenerate_health_snapshot(instance_root)

    elif action == "verify_db_path":
        return _action_verify_db_path(instance_root)

    else:
        raise ValueError(f"Unknown action: {action}")


def _action_trigger_backup() -> dict:
    """Trigger backup via backup-db.sh."""
    backup_script = REPO_ROOT / "scripts" / "backup-db.sh"
    if not backup_script.exists():
        return {"status": "skipped", "reason": "backup-db.sh not found"}

    try:
        result = subprocess.run(
            ["bash", str(backup_script)],
            capture_output=True, text=True, timeout=120,
            cwd=str(REPO_ROOT),
        )
        return {
            "status": "completed" if result.returncode == 0 else "failed",
            "returncode": result.returncode,
            "stdout": result.stdout[-500:] if result.stdout else "",
            "stderr": result.stderr[-500:] if result.stderr else "",
        }
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "reason": "Backup timed out after 120s"}


def _action_verify_backup_integrity(instance_root: Path) -> dict:
    """Verify the latest backup is readable and non-empty."""
    backup_dir = instance_root / "data" / "backups"
    if not backup_dir.exists():
        return {"status": "failed", "reason": "Backup directory missing"}

    archives = sorted(backup_dir.glob("*.sql.gz"))
    if not archives:
        return {"status": "failed", "reason": "No backup archives found"}

    latest = archives[-1]
    stat = latest.stat()

    # Basic integrity: file exists, non-empty, reasonable size (> 1KB)
    checks = {
        "file": str(latest.name),
        "size_bytes": stat.st_size,
        "size_human": format_size(stat.st_size),
        "non_empty": stat.st_size > 0,
        "reasonable_size": stat.st_size > 1024,
        "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
    }
    ok = checks["non_empty"] and checks["reasonable_size"]
    return {"status": "passed" if ok else "failed", "checks": checks}


def _action_rotate_guardian_logs(max_age_days: int = 7) -> dict:
    """Archive guardian logs older than max_age_days."""
    if not GUARDIAN_LOG_DIR.exists():
        return {"status": "skipped", "reason": "Guardian log directory missing"}

    now = datetime.now(tz=timezone.utc)
    archived = []
    archive_dir = GUARDIAN_LOG_DIR / "archived"
    archive_dir.mkdir(exist_ok=True)

    for f in sorted(GUARDIAN_LOG_DIR.glob("guardian-2*.json")):
        stat = f.stat()
        mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
        age_days = (now - mtime).days
        if age_days > max_age_days:
            dest = archive_dir / f.name
            shutil.move(str(f), str(dest))
            archived.append(f.name)

    return {
        "status": "completed",
        "archived_count": len(archived),
        "archived_to": str(archive_dir),
        "files": archived[:20],
    }


def _action_archive_stale_run_logs(instance_root: Path, max_age_days: int = 30) -> dict:
    """Archive stale run logs to a dated directory."""
    run_logs_dir = instance_root / "data" / "run-logs"
    if not run_logs_dir.exists():
        return {"status": "skipped", "reason": "Run logs directory missing"}

    now = datetime.now(tz=timezone.utc)
    archive_name = f"run-logs-archived-{now.strftime('%Y%m%d')}"
    archive_dir = instance_root / "data" / archive_name
    archived_count = 0

    for company_dir in run_logs_dir.iterdir():
        if not company_dir.is_dir():
            continue
        for agent_dir in company_dir.iterdir():
            if not agent_dir.is_dir():
                continue
            # Check most recent file in this agent's log dir
            most_recent = None
            for f in agent_dir.rglob("*"):
                if f.is_file():
                    mtime = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc)
                    if most_recent is None or mtime > most_recent:
                        most_recent = mtime

            if most_recent and (now - most_recent).days > max_age_days:
                dest = archive_dir / company_dir.name / agent_dir.name
                dest.mkdir(parents=True, exist_ok=True)
                shutil.copytree(str(agent_dir), str(dest), dirs_exist_ok=True)
                archived_count += 1

    return {
        "status": "completed",
        "archived_agent_logs": archived_count,
        "archive_location": str(archive_dir) if archived_count > 0 else None,
        "note": "Original logs preserved. Manual cleanup after verification.",
    }


def _action_rerun_topology_scan(instance_root: Path) -> dict:
    """Re-run topology report and save output."""
    report = run_report(instance_root)

    output_dir = REMEDIATION_DIR / "topology-snapshots"
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d-%H%M%S")
    output_file = output_dir / f"topology-{timestamp}.json"
    output_file.write_text(json.dumps(report, indent=2))

    return {
        "status": "completed",
        "companies": len(report["companies"]),
        "agents": sum(c["agent_count"] for c in report["companies"]),
        "orphans": report["orphans"]["total_orphans"],
        "output_file": str(output_file),
    }


def _action_regenerate_health_snapshot(instance_root: Path) -> dict:
    """Re-run guardian and save fresh snapshot."""
    result = run_guardian(instance_root)

    output_dir = REMEDIATION_DIR / "health-snapshots"
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d-%H%M%S")
    output_file = output_dir / f"health-{timestamp}.json"
    output_file.write_text(json.dumps(result, indent=2))

    return {
        "status": "completed",
        "overall_status": result["overall_status"],
        "checks_passed": sum(1 for c in result["checks"] if c["status"] == "healthy"),
        "checks_total": len(result["checks"]),
        "output_file": str(output_file),
    }


def _action_verify_db_path(instance_root: Path) -> dict:
    """Verify embedded PostgreSQL data directory exists and has expected structure."""
    db_dir = instance_root / "db"
    checks = {
        "db_dir_exists": db_dir.exists(),
        "has_base": (db_dir / "base").exists() if db_dir.exists() else False,
        "has_pg_wal": (db_dir / "pg_wal").exists() if db_dir.exists() else False,
        "has_pg_xact": (db_dir / "pg_xact").exists() if db_dir.exists() else False,
    }
    ok = all(checks.values())
    return {"status": "passed" if ok else "failed", "path": str(db_dir), "checks": checks}


def generate_plans_from_guardian(instance_root: Path) -> list[dict]:
    """Run guardian and generate remediation plans for detected issues."""
    guardian_result = run_guardian(instance_root)
    plans = []

    for check in guardian_result["checks"]:
        if check["status"] == "healthy":
            continue

        severity = check["status"]
        name = check["name"]

        if name == "backup_freshness":
            if severity == "critical":
                plans.append(create_plan(
                    "trigger_backup", severity,
                    {"check": name, "detail": check["detail"]},
                    instance_root,
                ))
            plans.append(create_plan(
                "verify_backup_integrity", severity,
                {"check": name, "detail": check["detail"]},
                instance_root,
            ))

        elif name == "instance_path":
            plans.append(create_plan(
                "verify_db_path", severity,
                {"check": name, "detail": check["detail"]},
                instance_root,
            ))

        elif name == "missing_metadata":
            plans.append(create_plan(
                "rerun_topology_scan", severity,
                {"check": name, "detail": check["detail"]},
                instance_root,
            ))

        elif name == "stale_entities":
            plans.append(create_plan(
                "archive_stale_run_logs", severity,
                {"check": name, "detail": check["detail"]},
                instance_root,
            ))

        elif name == "orphan_count":
            plans.append(create_plan(
                "rerun_topology_scan", severity,
                {"check": name, "detail": check["detail"]},
                instance_root,
            ))

    # Always add a health snapshot regeneration
    plans.append(create_plan(
        "regenerate_health_snapshot", "info",
        {"reason": "Post-remediation health snapshot"},
        instance_root,
    ))

    return plans


def list_all_plans() -> list[dict]:
    """List all plans across all states."""
    ensure_dirs()
    plans = []
    for state, d in [("pending", PENDING_DIR), ("approved", APPROVED_DIR),
                     ("executed", EXECUTED_DIR), ("failed", FAILED_DIR)]:
        for f in sorted(d.glob("REM-*.json")):
            try:
                plan = json.loads(f.read_text())
                plans.append(plan)
            except (json.JSONDecodeError, OSError):
                continue
    return plans


def format_plan_text(plan: dict) -> str:
    """Format a single plan for human display."""
    lines = []
    state_icon = {
        "pending": "[PEND]", "approved": "[APPR]",
        "executed": "[DONE]", "failed": "[FAIL]",
    }
    icon = state_icon.get(plan["state"], "[????]")

    lines.append(f"  {icon} {plan['issue_id']} - {plan['description']}")
    lines.append(f"         Severity: {plan['severity']} | Risk: {plan['estimated_risk']} | "
                 f"Approval: {'required' if plan['requires_approval'] else 'auto'}")
    lines.append(f"         Created: {plan['created_at']}")

    if plan["state"] == "pending" and plan["requires_approval"]:
        lines.append(f"         >> python scripts/runtime_remediator.py --approve {plan['issue_id']}")

    if plan["state"] == "approved":
        lines.append(f"         >> python scripts/runtime_remediator.py --execute {plan['issue_id']}")

    if plan["result"]:
        status = plan["result"].get("status", "unknown")
        lines.append(f"         Result: {status}")

    return "\n".join(lines)


def format_list_text(plans: list[dict]) -> str:
    """Format all plans for human display."""
    if not plans:
        return "  No remediation plans found."

    lines = []
    lines.append("=" * 64)
    lines.append("  PAPERCLIP RUNTIME REMEDIATOR V2")
    lines.append("=" * 64)

    by_state = {}
    for p in plans:
        by_state.setdefault(p["state"], []).append(p)

    for state in ["pending", "approved", "executed", "failed"]:
        state_plans = by_state.get(state, [])
        if state_plans:
            lines.append(f"\n  --- {state.upper()} ({len(state_plans)}) ---")
            for p in state_plans:
                lines.append(format_plan_text(p))

    lines.append("")
    lines.append("=" * 64)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Paperclip Runtime Remediator V2 - Approval-aware corrective workflows"
    )
    parser.add_argument("--instance-root", type=Path, default=DEFAULT_INSTANCE_ROOT)
    parser.add_argument("--list", action="store_true", help="List all remediation plans")
    parser.add_argument("--approve", type=str, metavar="ISSUE_ID", help="Approve a pending plan")
    parser.add_argument("--execute", type=str, metavar="ISSUE_ID", help="Execute an approved plan")
    parser.add_argument("--status", type=str, metavar="ISSUE_ID", help="Show status of a plan")
    parser.add_argument("--scan", action="store_true", help="Scan for issues and generate plans")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    args = parser.parse_args()

    # Default to --list if no action specified
    if not any([args.list, args.approve, args.execute, args.status, args.scan]):
        args.list = True

    if args.scan:
        plans = generate_plans_from_guardian(args.instance_root)
        for plan in plans:
            save_plan(plan)

        if args.json:
            print(json.dumps(plans, indent=2))
        else:
            print(f"\n  Generated {len(plans)} remediation plan(s):\n")
            for plan in plans:
                print(format_plan_text(plan))
                print()
            # Print approval commands for plans that need them
            pending_approval = [p for p in plans if p["requires_approval"]]
            auto_execute = [p for p in plans if not p["requires_approval"]]
            if pending_approval:
                print("  Plans requiring approval:")
                for p in pending_approval:
                    print(f"    python scripts/runtime_remediator.py --approve {p['issue_id']}")
                print()
            if auto_execute:
                print("  Plans ready for immediate execution:")
                for p in auto_execute:
                    print(f"    python scripts/runtime_remediator.py --execute {p['issue_id']}")
                print()

    elif args.approve:
        result = approve_plan(args.approve)
        if args.json:
            print(json.dumps(result, indent=2))
        elif "error" in result:
            print(f"  ERROR: {result['error']}")
            sys.exit(1)
        else:
            print(f"  Approved: {args.approve}")
            print(f"  Execute:  python scripts/runtime_remediator.py --execute {args.approve}")

    elif args.execute:
        result = execute_plan(args.execute)
        if args.json:
            print(json.dumps(result, indent=2))
        elif not result.get("ok"):
            print(f"  ERROR: {result.get('error', 'Unknown error')}")
            sys.exit(1)
        else:
            print(f"  Executed: {args.execute}")
            res = result.get("result", {})
            print(f"  Status:   {res.get('status', 'unknown')}")

    elif args.status:
        plan, path = load_plan(args.status)
        if plan is None:
            print(f"  Plan {args.status} not found.")
            sys.exit(1)
        if args.json:
            print(json.dumps(plan, indent=2))
        else:
            print(format_plan_text(plan))

    elif args.list:
        plans = list_all_plans()
        if args.json:
            print(json.dumps(plans, indent=2))
        else:
            print(format_list_text(plans))


if __name__ == "__main__":
    main()
