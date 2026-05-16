#!/usr/bin/env python3
"""
Runtime Export V4 for Paperclip/Selarix

Operational continuity export bundles: portable, verifiable packages of
topology, health, remediation, and governance state.

Purpose: migrations, incident recovery, governance review, cold storage,
cross-environment continuity.

Usage:
    python scripts/runtime_export.py --full --output DIR
    python scripts/runtime_export.py --history --output DIR
    python scripts/runtime_export.py --topology --output DIR
    python scripts/runtime_export.py --remediation --output DIR
    python scripts/runtime_export.py --verify EXPORT_PATH
    python scripts/runtime_export.py --json
"""

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_topology_report import DEFAULT_INSTANCE_ROOT, run_report, format_size
from runtime_guardian import run_guardian

REPO_ROOT = Path(__file__).resolve().parent.parent
LOGS_ROOT = REPO_ROOT / "logs"
HISTORY_DIR = LOGS_ROOT / "runtime-history"
REMEDIATION_DIR = LOGS_ROOT / "runtime-remediation"
GUARDIAN_DIR = LOGS_ROOT / "runtime-guardian"

EXPORT_VERSION = "4.0"


def _sha256_file(path: Path) -> str:
    """Compute SHA-256 hash of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_data(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _copy_if_exists(src: Path, dest: Path) -> bool:
    if src.exists():
        if src.is_dir():
            shutil.copytree(str(src), str(dest), dirs_exist_ok=True)
        else:
            shutil.copy2(str(src), str(dest))
        return True
    return False


def export_topology(instance_root: Path, export_dir: Path) -> dict:
    """Export current topology state."""
    topo_dir = export_dir / "topology"
    topo_dir.mkdir(parents=True, exist_ok=True)

    report = run_report(instance_root)
    report_path = topo_dir / "topology_report.json"
    report_data = json.dumps(report, indent=2).encode()
    report_path.write_bytes(report_data)

    # Export instance config (sanitized - no secrets)
    config_path = instance_root / "config.json"
    if config_path.exists():
        config = json.loads(config_path.read_text())
        # Remove sensitive fields
        for key in ["secrets", "auth"]:
            config.pop(key, None)
        sanitized_path = topo_dir / "instance_config_sanitized.json"
        sanitized_path.write_text(json.dumps(config, indent=2))

    return {
        "type": "topology",
        "files": [
            {"name": "topology_report.json", "hash": _sha256_data(report_data),
             "size": len(report_data)},
        ],
        "companies": len(report["companies"]),
        "agents": sum(c["agent_count"] for c in report["companies"]),
        "orphans": report["orphans"]["total_orphans"],
    }


def export_health(instance_root: Path, export_dir: Path) -> dict:
    """Export current health state."""
    health_dir = export_dir / "health"
    health_dir.mkdir(parents=True, exist_ok=True)

    result = run_guardian(instance_root)
    health_path = health_dir / "guardian_report.json"
    health_data = json.dumps(result, indent=2).encode()
    health_path.write_bytes(health_data)

    return {
        "type": "health",
        "files": [
            {"name": "guardian_report.json", "hash": _sha256_data(health_data),
             "size": len(health_data)},
        ],
        "overall_status": result["overall_status"],
    }


def export_history(export_dir: Path) -> dict:
    """Export historical snapshots."""
    history_dir = export_dir / "history"
    history_dir.mkdir(parents=True, exist_ok=True)

    files = []
    snapshots_src = HISTORY_DIR / "snapshots.jsonl"
    if snapshots_src.exists():
        dest = history_dir / "snapshots.jsonl"
        shutil.copy2(str(snapshots_src), str(dest))
        files.append({
            "name": "snapshots.jsonl",
            "hash": _sha256_file(dest),
            "size": dest.stat().st_size,
        })

    # Count snapshots
    count = 0
    if snapshots_src.exists():
        with open(snapshots_src, "r", encoding="utf-8") as f:
            count = sum(1 for line in f if line.strip())

    return {
        "type": "history",
        "files": files,
        "snapshot_count": count,
    }


def export_remediation(export_dir: Path) -> dict:
    """Export remediation state."""
    rem_dir = export_dir / "remediation"
    rem_dir.mkdir(parents=True, exist_ok=True)

    files = []
    counts = {}

    for state in ["pending", "approved", "executed", "failed", "expired"]:
        src = REMEDIATION_DIR / state
        if not src.exists():
            counts[state] = 0
            continue
        plan_files = list(src.glob("REM-*.json"))
        counts[state] = len(plan_files)
        if plan_files:
            dest_dir = rem_dir / state
            dest_dir.mkdir(exist_ok=True)
            for f in plan_files:
                dest = dest_dir / f.name
                shutil.copy2(str(f), str(dest))
                files.append({
                    "name": f"{state}/{f.name}",
                    "hash": _sha256_file(dest),
                    "size": dest.stat().st_size,
                })

    return {
        "type": "remediation",
        "files": files,
        "counts": counts,
    }


def export_backup_inventory(instance_root: Path, export_dir: Path) -> dict:
    """Export backup inventory (metadata only, not actual backups)."""
    inv_dir = export_dir / "backup-inventory"
    inv_dir.mkdir(parents=True, exist_ok=True)

    backup_dir = instance_root / "data" / "backups"
    inventory = []
    total_size = 0

    if backup_dir.exists():
        for f in sorted(backup_dir.iterdir()):
            if f.is_file():
                stat = f.stat()
                total_size += stat.st_size
                inventory.append({
                    "filename": f.name,
                    "size_bytes": stat.st_size,
                    "size_human": format_size(stat.st_size),
                    "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                    "hash": _sha256_file(f) if stat.st_size < 100 * 1024 * 1024 else "skipped_large_file",
                })

    inv_data = json.dumps({"archives": inventory, "total_size_bytes": total_size,
                           "total_size_human": format_size(total_size)}, indent=2).encode()
    inv_path = inv_dir / "backup_inventory.json"
    inv_path.write_bytes(inv_data)

    return {
        "type": "backup-inventory",
        "files": [{"name": "backup_inventory.json", "hash": _sha256_data(inv_data),
                    "size": len(inv_data)}],
        "archive_count": len(inventory),
        "total_size_bytes": total_size,
    }


def create_export(
    instance_root: Path,
    output_dir: Path,
    include_topology: bool = True,
    include_history: bool = True,
    include_remediation: bool = True,
) -> dict:
    """Create a full or partial export bundle."""
    now = datetime.now(tz=timezone.utc)
    timestamp = now.strftime("%Y%m%d-%H%M%S")
    export_dir = output_dir / f"paperclip-export-{timestamp}"
    export_dir.mkdir(parents=True, exist_ok=True)

    sections = []

    if include_topology:
        sections.append(export_topology(instance_root, export_dir))
        sections.append(export_health(instance_root, export_dir))
        sections.append(export_backup_inventory(instance_root, export_dir))

    if include_history:
        sections.append(export_history(export_dir))

    if include_remediation:
        sections.append(export_remediation(export_dir))

    # Build manifest
    all_files = []
    for section in sections:
        all_files.extend(section.get("files", []))

    manifest = {
        "export_version": EXPORT_VERSION,
        "created_at": now.isoformat(),
        "instance_root": str(instance_root),
        "export_dir": str(export_dir),
        "sections": sections,
        "file_count": len(all_files),
        "files": all_files,
        "integrity": {
            "algorithm": "sha256",
            "manifest_hash": None,  # Set after writing
        },
    }

    # Write manifest
    manifest_path = export_dir / "manifest.json"
    manifest_data = json.dumps(manifest, indent=2).encode()
    manifest["integrity"]["manifest_hash"] = _sha256_data(manifest_data)
    manifest_data = json.dumps(manifest, indent=2).encode()
    manifest_path.write_bytes(manifest_data)

    return manifest


def verify_export(export_path: Path) -> dict:
    """Verify an export bundle's integrity."""
    results = {
        "export_path": str(export_path),
        "verified_at": datetime.now(tz=timezone.utc).isoformat(),
        "valid": True,
        "checks": [],
        "errors": [],
    }

    # Check manifest exists
    manifest_path = export_path / "manifest.json"
    if not manifest_path.exists():
        results["valid"] = False
        results["errors"].append("manifest.json not found")
        return results

    results["checks"].append({"name": "manifest_exists", "status": "pass"})

    # Parse manifest
    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as e:
        results["valid"] = False
        results["errors"].append(f"manifest.json invalid JSON: {e}")
        return results

    results["checks"].append({"name": "manifest_valid_json", "status": "pass"})

    # Check export version
    version = manifest.get("export_version")
    if version:
        results["checks"].append({"name": "version_present", "status": "pass", "value": version})
    else:
        results["valid"] = False
        results["errors"].append("Missing export_version")

    # Verify each file hash
    files_ok = 0
    files_missing = 0
    files_mismatch = 0

    for file_entry in manifest.get("files", []):
        name = file_entry["name"]
        expected_hash = file_entry["hash"]
        file_path = export_path / name.split("/")[0]

        # Reconstruct path based on section
        # Files may be in subdirectories like topology/file.json or remediation/pending/REM-xxx.json
        actual_path = export_path / name
        if not actual_path.exists():
            # Try finding in section subdirectories
            found = False
            for section in manifest.get("sections", []):
                section_type = section.get("type", "")
                candidate = export_path / section_type / name
                if candidate.exists():
                    actual_path = candidate
                    found = True
                    break
            if not found:
                files_missing += 1
                results["errors"].append(f"File missing: {name}")
                continue

        actual_hash = _sha256_file(actual_path)
        if actual_hash == expected_hash:
            files_ok += 1
        else:
            files_mismatch += 1
            results["errors"].append(f"Hash mismatch: {name} (expected {expected_hash[:12]}..., got {actual_hash[:12]}...)")

    results["checks"].append({
        "name": "file_integrity",
        "status": "pass" if files_missing == 0 and files_mismatch == 0 else "fail",
        "files_ok": files_ok,
        "files_missing": files_missing,
        "files_mismatch": files_mismatch,
    })

    if files_missing > 0 or files_mismatch > 0:
        results["valid"] = False

    # Check remediation chain consistency
    rem_dir = export_path / "remediation"
    if rem_dir.exists():
        chain_errors = _verify_remediation_chain(rem_dir)
        results["checks"].append({
            "name": "remediation_chain",
            "status": "pass" if not chain_errors else "fail",
            "errors": chain_errors,
        })
        if chain_errors:
            results["errors"].extend(chain_errors)
            results["valid"] = False

    # Check snapshot continuity
    history_dir = export_path / "history"
    snapshots_path = history_dir / "snapshots.jsonl" if history_dir.exists() else None
    if snapshots_path and snapshots_path.exists():
        cont_errors = _verify_snapshot_continuity(snapshots_path)
        results["checks"].append({
            "name": "snapshot_continuity",
            "status": "pass" if not cont_errors else "warn",
            "issues": cont_errors,
        })

    return results


def _verify_remediation_chain(rem_dir: Path) -> list[str]:
    """Verify remediation plan consistency."""
    errors = []
    for state in ["pending", "approved", "executed", "failed", "expired"]:
        state_dir = rem_dir / state
        if not state_dir.exists():
            continue
        for f in state_dir.glob("REM-*.json"):
            try:
                plan = json.loads(f.read_text())
                # Check state matches directory
                if plan.get("state") != state:
                    errors.append(f"{f.name}: state='{plan.get('state')}' but in {state}/ directory")
                # Check required fields
                for field in ["issue_id", "action", "created_at"]:
                    if field not in plan:
                        errors.append(f"{f.name}: missing required field '{field}'")
            except json.JSONDecodeError:
                errors.append(f"{f.name}: invalid JSON")
    return errors


def _verify_snapshot_continuity(snapshots_path: Path) -> list[str]:
    """Verify snapshot timestamps are monotonically increasing."""
    issues = []
    prev_ts = None
    line_num = 0

    with open(snapshots_path, "r", encoding="utf-8") as f:
        for line in f:
            line_num += 1
            line = line.strip()
            if not line:
                continue
            try:
                snap = json.loads(line)
                ts = datetime.fromisoformat(snap["timestamp"])
                if prev_ts is not None and ts < prev_ts:
                    issues.append(f"Line {line_num}: timestamp goes backward ({ts} < {prev_ts})")
                prev_ts = ts
            except (json.JSONDecodeError, KeyError) as e:
                issues.append(f"Line {line_num}: parse error: {e}")

    return issues


def format_manifest_text(manifest: dict) -> str:
    """Format export manifest for human display."""
    lines = []
    lines.append("=" * 64)
    lines.append("  PAPERCLIP RUNTIME EXPORT")
    lines.append("=" * 64)
    lines.append(f"  Version:  {manifest['export_version']}")
    lines.append(f"  Created:  {manifest['created_at'][:19]}")
    lines.append(f"  Output:   {manifest['export_dir']}")
    lines.append(f"  Files:    {manifest['file_count']}")
    lines.append("-" * 64)

    for section in manifest["sections"]:
        stype = section["type"]
        fcount = len(section.get("files", []))
        extra = ""
        if stype == "topology":
            extra = f" ({section.get('companies', 0)} companies, {section.get('agents', 0)} agents)"
        elif stype == "health":
            extra = f" ({section.get('overall_status', 'unknown')})"
        elif stype == "history":
            extra = f" ({section.get('snapshot_count', 0)} snapshots)"
        elif stype == "remediation":
            c = section.get("counts", {})
            extra = (f" ({c.get('pending', 0)}p/{c.get('executed', 0)}e/"
                     f"{c.get('failed', 0)}f/{c.get('expired', 0)}x)")
        elif stype == "backup-inventory":
            extra = (f" ({section.get('archive_count', 0)} archives, "
                     f"{format_size(section.get('total_size_bytes', 0))})")

        lines.append(f"  [{stype}] {fcount} files{extra}")

    lines.append("=" * 64)
    return "\n".join(lines)


def format_verify_text(results: dict) -> str:
    """Format verification results for human display."""
    lines = []
    lines.append("=" * 64)
    lines.append("  EXPORT VERIFICATION")
    lines.append("=" * 64)
    lines.append(f"  Path:     {results['export_path']}")
    lines.append(f"  Valid:    {'YES' if results['valid'] else 'NO'}")
    lines.append("-" * 64)

    for check in results["checks"]:
        icon = "[OK]" if check["status"] == "pass" else "[!!]"
        lines.append(f"  {icon} {check['name']}: {check['status']}")

    if results["errors"]:
        lines.append("-" * 64)
        lines.append("  ERRORS:")
        for e in results["errors"]:
            lines.append(f"    - {e}")

    lines.append("=" * 64)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Paperclip Runtime Export V4 - Operational continuity bundles"
    )
    parser.add_argument("--instance-root", type=Path, default=DEFAULT_INSTANCE_ROOT)
    parser.add_argument("--output", type=Path, default=LOGS_ROOT / "exports",
                        help="Output directory for export bundle")
    parser.add_argument("--full", action="store_true", help="Export everything")
    parser.add_argument("--topology", action="store_true", help="Export topology + health + backup inventory")
    parser.add_argument("--history", action="store_true", help="Export historical snapshots")
    parser.add_argument("--remediation", action="store_true", help="Export remediation plans")
    parser.add_argument("--verify", type=Path, metavar="EXPORT_PATH",
                        help="Verify an existing export bundle")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    args = parser.parse_args()

    if args.verify:
        results = verify_export(args.verify)
        if args.json:
            print(json.dumps(results, indent=2))
        else:
            print(format_verify_text(results))
        sys.exit(0 if results["valid"] else 1)

    # Default to --full if nothing specified
    if not any([args.full, args.topology, args.history, args.remediation]):
        args.full = True

    include_topo = args.full or args.topology
    include_hist = args.full or args.history
    include_rem = args.full or args.remediation

    manifest = create_export(
        args.instance_root, args.output,
        include_topology=include_topo,
        include_history=include_hist,
        include_remediation=include_rem,
    )

    if args.json:
        print(json.dumps(manifest, indent=2))
    else:
        print(format_manifest_text(manifest))


if __name__ == "__main__":
    main()
