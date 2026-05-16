#!/usr/bin/env python3
"""
Governance Checkpoint Recorder for Paperclip/Selarix

Converts guardian/history/export/remediation state into durable operational
checkpoint records. Deterministic only -- no AI summarization.

Checkpoints are institutional operational memory snapshots suitable for:
- governance review
- continuity restoration
- incident reconstruction
- cross-model handoff
- deployment milestones

Usage:
    python scripts/governance_checkpoint.py --create
    python scripts/governance_checkpoint.py --create --notes "Pre-deploy freeze"
    python scripts/governance_checkpoint.py --summary
    python scripts/governance_checkpoint.py --list
    python scripts/governance_checkpoint.py --json
"""

import argparse
import hashlib
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_topology_report import DEFAULT_INSTANCE_ROOT, run_report, format_size
from runtime_guardian import run_guardian, load_escalation_state
from runtime_history import load_snapshots, compute_summary, HISTORY_DIR, SNAPSHOTS_FILE

REPO_ROOT = Path(__file__).resolve().parent.parent
CHECKPOINT_DIR = REPO_ROOT / "logs" / "governance-checkpoints"
INDEX_FILE = CHECKPOINT_DIR / "checkpoint-index.jsonl"

REMEDIATION_DIR = REPO_ROOT / "logs" / "runtime-remediation"
EXPORT_DIR = REPO_ROOT / "logs" / "exports"

CHECKPOINT_SCHEMA_VERSION = 1


def ensure_dirs():
    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)


def generate_checkpoint_id() -> str:
    """Generate a short checkpoint ID."""
    return f"GCP-{uuid.uuid4().hex[:8].upper()}"


def generate_chain_id(previous_hash: str | None) -> str:
    """Generate a continuity chain ID linking to the previous checkpoint."""
    if previous_hash is None:
        return "GENESIS"
    return f"CHAIN-{previous_hash[:12]}"


def get_latest_checkpoint() -> dict | None:
    """Load the most recent checkpoint from the index."""
    if not INDEX_FILE.exists():
        return None
    last_line = None
    with open(INDEX_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                last_line = line
    if last_line:
        try:
            return json.loads(last_line)
        except json.JSONDecodeError:
            pass
    return None


def _count_plans(state: str) -> int:
    d = REMEDIATION_DIR / state
    if not d.exists():
        return 0
    return len(list(d.glob("REM-*.json")))


def _gather_active_risks(guardian_result: dict) -> list[dict]:
    """Extract active risks from guardian checks."""
    risks = []
    for check in guardian_result.get("checks", []):
        if check["status"] in ("warning", "critical"):
            risks.append({
                "check": check["name"],
                "severity": check["status"],
                "message": check["message"],
            })

    # Add escalation risks
    esc = guardian_result.get("escalation", {})
    if esc.get("level") and esc["level"] not in ("informational",):
        risks.append({
            "check": "escalation",
            "severity": esc["level"],
            "message": "; ".join(esc.get("reasons", [])),
        })

    return risks


def _assess_deployment_readiness(guardian_result: dict, remediation: dict) -> dict:
    """Assess deployment readiness from current state."""
    checks = {}

    # Guardian healthy or warning-only
    status = guardian_result.get("overall_status", "unknown")
    checks["health_acceptable"] = status in ("healthy", "warning")

    # No critical checks
    critical_checks = [c for c in guardian_result.get("checks", []) if c["status"] == "critical"]
    checks["no_critical_findings"] = len(critical_checks) == 0

    # No failed remediations
    checks["no_failed_remediations"] = remediation.get("failed", 0) == 0

    # Backup recent
    for c in guardian_result.get("checks", []):
        if c["name"] == "backup_freshness":
            checks["backup_current"] = c["status"] == "healthy"
            break
    else:
        checks["backup_current"] = False

    # Escalation not at governance-review
    esc_level = guardian_result.get("escalation", {}).get("level", "informational")
    checks["no_governance_hold"] = esc_level != "governance-review"

    # Overall
    ready = all(checks.values())

    return {
        "ready": ready,
        "checks": checks,
        "blockers": [k for k, v in checks.items() if not v],
    }


def _get_export_continuity() -> dict:
    """Check most recent export state."""
    if not EXPORT_DIR.exists():
        return {"last_export": None, "export_count": 0}

    exports = sorted(EXPORT_DIR.glob("paperclip-export-*"))
    if not exports:
        return {"last_export": None, "export_count": 0}

    latest = exports[-1]
    manifest_path = latest / "manifest.json"
    verified = False
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text())
            verified = "export_version" in manifest and "files" in manifest
        except (json.JSONDecodeError, OSError):
            pass

    return {
        "last_export": latest.name,
        "last_export_path": str(latest),
        "export_count": len(exports),
        "manifest_valid": verified,
    }


def compute_checkpoint_hash(checkpoint: dict) -> str:
    """Compute deterministic hash of checkpoint content (excluding the hash itself)."""
    # Hash a stable subset of fields
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


def create_checkpoint(instance_root: Path, notes: str = "") -> dict:
    """Create a governance checkpoint from current operational state."""
    now = datetime.now(tz=timezone.utc)

    # Gather all state
    guardian_result = run_guardian(instance_root)
    history_snapshots = load_snapshots()
    history_summary = compute_summary(history_snapshots) if history_snapshots else {"snapshot_count": 0}
    escalation_state = load_escalation_state()
    export_continuity = _get_export_continuity()

    remediation = {
        "pending": _count_plans("pending"),
        "approved": _count_plans("approved"),
        "executed": _count_plans("executed"),
        "failed": _count_plans("failed"),
        "expired": _count_plans("expired"),
    }

    active_risks = _gather_active_risks(guardian_result)
    deployment = _assess_deployment_readiness(guardian_result, remediation)

    # Continuity chain
    previous = get_latest_checkpoint()
    previous_hash = previous.get("integrity_hash") if previous else None
    chain_id = generate_chain_id(previous_hash)

    checkpoint_id = generate_checkpoint_id()

    checkpoint = {
        "schema_version": CHECKPOINT_SCHEMA_VERSION,
        "checkpoint_id": checkpoint_id,
        "timestamp": now.isoformat(),
        "chain_id": chain_id,
        "previous_checkpoint": previous.get("checkpoint_id") if previous else None,

        # Health
        "overall_status": guardian_result["overall_status"],
        "health_score": guardian_result.get("health_score"),
        "health_dimensions": guardian_result.get("health_dimensions", {}),

        # Topology
        "topology": guardian_result.get("topology_summary", {}),

        # Risks
        "active_risks": active_risks,
        "risk_count": len(active_risks),

        # Escalation
        "escalation_level": guardian_result.get("escalation", {}).get("level", "informational"),
        "escalation_consecutive_criticals": escalation_state.get("consecutive_criticals", 0),
        "escalation_consecutive_warnings": escalation_state.get("consecutive_warnings", 0),
        "escalation_total": len(escalation_state.get("escalations", [])),

        # Remediation
        "remediation": remediation,
        "remediation_total": sum(remediation.values()),

        # History
        "history_snapshot_count": history_summary.get("snapshot_count", 0),
        "history_health_distribution": history_summary.get("health_distribution", {}),
        "backup_reliability_pct": history_summary.get("backup_reliability_pct"),
        "remediation_success_rate_pct": history_summary.get("remediation_success_rate_pct"),

        # Export continuity
        "export_continuity": export_continuity,

        # Deployment readiness
        "deployment_readiness": deployment,

        # Operator notes
        "operator_notes": notes,

        # Integrity
        "integrity_hash": None,
    }

    checkpoint["integrity_hash"] = compute_checkpoint_hash(checkpoint)

    return checkpoint


def save_checkpoint(checkpoint: dict) -> Path:
    """Save checkpoint to disk and append to index."""
    ensure_dirs()

    # Save full checkpoint
    cp_id = checkpoint["checkpoint_id"]
    cp_path = CHECKPOINT_DIR / f"{cp_id}.json"
    cp_path.write_text(json.dumps(checkpoint, indent=2))

    # Save markdown version
    md_path = CHECKPOINT_DIR / f"{cp_id}.md"
    md_path.write_text(format_checkpoint_markdown(checkpoint))

    # Append to index
    index_entry = {
        "checkpoint_id": checkpoint["checkpoint_id"],
        "timestamp": checkpoint["timestamp"],
        "chain_id": checkpoint["chain_id"],
        "overall_status": checkpoint["overall_status"],
        "health_score": checkpoint["health_score"],
        "risk_count": checkpoint["risk_count"],
        "escalation_level": checkpoint["escalation_level"],
        "deployment_ready": checkpoint["deployment_readiness"]["ready"],
        "integrity_hash": checkpoint["integrity_hash"],
        "notes": checkpoint["operator_notes"][:100] if checkpoint["operator_notes"] else "",
    }
    with open(INDEX_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(index_entry, separators=(",", ":")) + "\n")

    return cp_path


def load_index() -> list[dict]:
    """Load checkpoint index."""
    if not INDEX_FILE.exists():
        return []
    entries = []
    with open(INDEX_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return entries


def format_checkpoint_markdown(cp: dict) -> str:
    """Generate markdown checkpoint document."""
    lines = []
    lines.append(f"# Governance Checkpoint: {cp['checkpoint_id']}")
    lines.append("")
    lines.append(f"**Timestamp:** {cp['timestamp']}")
    lines.append(f"**Chain:** {cp['chain_id']}")
    if cp.get("previous_checkpoint"):
        lines.append(f"**Previous:** {cp['previous_checkpoint']}")
    lines.append(f"**Integrity:** `{cp['integrity_hash'][:16]}...`")
    lines.append("")

    # Health
    lines.append("## Health Status")
    lines.append("")
    lines.append(f"- **Overall:** {cp['overall_status'].upper()}")
    lines.append(f"- **Score:** {cp.get('health_score', 'N/A')}/100")
    dims = cp.get("health_dimensions", {})
    if dims:
        lines.append("- **Dimensions:**")
        for dim, val in dims.items():
            lines.append(f"  - {dim}: {val}")
    lines.append("")

    # Topology
    lines.append("## Topology")
    lines.append("")
    topo = cp.get("topology", {})
    lines.append(f"| Metric | Value |")
    lines.append(f"|--------|-------|")
    for k, v in topo.items():
        lines.append(f"| {k} | {v} |")
    lines.append("")

    # Active risks
    lines.append("## Active Risks")
    lines.append("")
    if cp["active_risks"]:
        for risk in cp["active_risks"]:
            lines.append(f"- **[{risk['severity'].upper()}]** {risk['check']}: {risk['message']}")
    else:
        lines.append("No active risks.")
    lines.append("")

    # Escalation
    lines.append("## Escalation Status")
    lines.append("")
    lines.append(f"- **Level:** {cp['escalation_level']}")
    lines.append(f"- **Consecutive criticals:** {cp['escalation_consecutive_criticals']}")
    lines.append(f"- **Consecutive warnings:** {cp['escalation_consecutive_warnings']}")
    lines.append(f"- **Total escalation events:** {cp['escalation_total']}")
    lines.append("")

    # Remediation
    lines.append("## Remediation Summary")
    lines.append("")
    rem = cp["remediation"]
    lines.append(f"| State | Count |")
    lines.append(f"|-------|-------|")
    for state in ["pending", "approved", "executed", "failed", "expired"]:
        lines.append(f"| {state} | {rem.get(state, 0)} |")
    lines.append(f"| **total** | **{cp['remediation_total']}** |")
    lines.append("")
    if cp.get("remediation_success_rate_pct") is not None:
        lines.append(f"- **Success rate:** {cp['remediation_success_rate_pct']}%")
    lines.append("")

    # History
    lines.append("## Operational History")
    lines.append("")
    lines.append(f"- **Snapshots recorded:** {cp['history_snapshot_count']}")
    if cp.get("backup_reliability_pct") is not None:
        lines.append(f"- **Backup reliability:** {cp['backup_reliability_pct']}%")
    dist = cp.get("history_health_distribution", {})
    if dist:
        lines.append(f"- **Health distribution:** " + ", ".join(f"{k}: {v}" for k, v in dist.items()))
    lines.append("")

    # Export continuity
    lines.append("## Export Continuity")
    lines.append("")
    exp = cp.get("export_continuity", {})
    lines.append(f"- **Last export:** {exp.get('last_export', 'none')}")
    lines.append(f"- **Export count:** {exp.get('export_count', 0)}")
    lines.append(f"- **Manifest valid:** {exp.get('manifest_valid', False)}")
    lines.append("")

    # Deployment readiness
    lines.append("## Deployment Readiness")
    lines.append("")
    dep = cp["deployment_readiness"]
    lines.append(f"- **Ready:** {'YES' if dep['ready'] else 'NO'}")
    for check_name, passed in dep["checks"].items():
        icon = "[OK]" if passed else "[!!]"
        lines.append(f"  - {icon} {check_name}")
    if dep["blockers"]:
        lines.append(f"- **Blockers:** {', '.join(dep['blockers'])}")
    lines.append("")

    # Operator notes
    if cp.get("operator_notes"):
        lines.append("## Operator Notes")
        lines.append("")
        lines.append(cp["operator_notes"])
        lines.append("")

    return "\n".join(lines)


def format_checkpoint_text(cp: dict) -> str:
    """Format checkpoint for console display."""
    lines = []
    lines.append("=" * 64)
    lines.append("  GOVERNANCE CHECKPOINT")
    lines.append("=" * 64)
    lines.append(f"  ID:       {cp['checkpoint_id']}")
    lines.append(f"  Time:     {cp['timestamp'][:19]}")
    lines.append(f"  Chain:    {cp['chain_id']}")
    lines.append(f"  Hash:     {cp['integrity_hash'][:16]}...")
    score = cp.get("health_score", "?")
    lines.append(f"  Status:   {cp['overall_status'].upper()} (score: {score}/100)")
    lines.append("-" * 64)

    # Topology
    topo = cp.get("topology", {})
    lines.append(f"  Topology: {topo.get('companies', 0)} companies, "
                 f"{topo.get('agents', 0)} agents, "
                 f"{topo.get('projects', 0)} projects")

    # Risks
    lines.append(f"  Risks:    {cp['risk_count']} active")
    for risk in cp.get("active_risks", []):
        lines.append(f"    [{risk['severity'].upper():4s}] {risk['check']}: {risk['message']}")

    # Escalation
    esc = cp["escalation_level"]
    if esc != "informational":
        lines.append(f"  Escalation: {esc.upper()}")

    # Remediation
    rem = cp["remediation"]
    lines.append(f"  Remediation: {rem.get('pending', 0)}p/{rem.get('executed', 0)}e/"
                 f"{rem.get('failed', 0)}f/{rem.get('expired', 0)}x")

    # Deployment
    dep = cp["deployment_readiness"]
    ready_str = "READY" if dep["ready"] else f"BLOCKED ({', '.join(dep['blockers'])})"
    lines.append(f"  Deploy:   {ready_str}")

    # Notes
    if cp.get("operator_notes"):
        lines.append(f"  Notes:    {cp['operator_notes'][:60]}")

    lines.append("=" * 64)
    return "\n".join(lines)


def format_index_text(entries: list[dict]) -> str:
    """Format checkpoint index for console display."""
    lines = []
    lines.append("=" * 64)
    lines.append("  GOVERNANCE CHECKPOINT INDEX")
    lines.append("=" * 64)

    if not entries:
        lines.append("  No checkpoints recorded yet.")
        lines.append("  Run: python scripts/governance_checkpoint.py --create")
        lines.append("=" * 64)
        return "\n".join(lines)

    status_icon = {"healthy": "[OK]", "warning": "[WARN]", "critical": "[CRIT]"}
    for e in entries:
        icon = status_icon.get(e.get("overall_status", ""), "[??]")
        score = e.get("health_score", "?")
        dep = "R" if e.get("deployment_ready") else "B"
        notes = f' "{e["notes"][:30]}..."' if e.get("notes") else ""
        lines.append(
            f"  {icon} {e['checkpoint_id']} {e['timestamp'][:19]} "
            f"s={score} r={e.get('risk_count', 0)} "
            f"esc={e.get('escalation_level', '?')[:4]} "
            f"dep={dep}{notes}"
        )

    lines.append("")
    lines.append(f"  Total: {len(entries)} checkpoints")
    lines.append("=" * 64)
    return "\n".join(lines)


def format_summary_text(entries: list[dict]) -> str:
    """Format checkpoint summary statistics."""
    lines = []
    lines.append("=" * 64)
    lines.append("  GOVERNANCE CHECKPOINT SUMMARY")
    lines.append("=" * 64)

    if not entries:
        lines.append("  No checkpoints recorded.")
        lines.append("=" * 64)
        return "\n".join(lines)

    lines.append(f"  Total checkpoints: {len(entries)}")
    lines.append(f"  First: {entries[0]['timestamp'][:19]} ({entries[0]['checkpoint_id']})")
    lines.append(f"  Latest: {entries[-1]['timestamp'][:19]} ({entries[-1]['checkpoint_id']})")
    lines.append("-" * 64)

    # Health distribution
    health_counts = {}
    for e in entries:
        s = e.get("overall_status", "unknown")
        health_counts[s] = health_counts.get(s, 0) + 1

    lines.append("  HEALTH DISTRIBUTION:")
    for status in ["healthy", "warning", "critical"]:
        count = health_counts.get(status, 0)
        pct = count / len(entries) * 100
        lines.append(f"    {status:10s} {count:3d} ({pct:5.1f}%)")

    # Deployment readiness
    ready_count = sum(1 for e in entries if e.get("deployment_ready"))
    lines.append("-" * 64)
    lines.append(f"  Deployment ready: {ready_count}/{len(entries)} "
                 f"({ready_count / len(entries) * 100:.0f}%)")

    # Score trajectory
    scores = [e.get("health_score") for e in entries if e.get("health_score") is not None]
    if scores:
        lines.append(f"  Score range: {min(scores):.1f} - {max(scores):.1f}")
        lines.append(f"  Latest score: {scores[-1]:.1f}/100")

    # Chain integrity
    chain_intact = True
    for i in range(1, len(entries)):
        expected_chain = f"CHAIN-{entries[i - 1].get('integrity_hash', '')[:12]}"
        if entries[i].get("chain_id") != expected_chain:
            chain_intact = False
            break

    lines.append("-" * 64)
    chain_status = "INTACT" if chain_intact else "BROKEN"
    lines.append(f"  Continuity chain: {chain_status}")

    lines.append("=" * 64)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Paperclip Governance Checkpoint Recorder"
    )
    parser.add_argument("--instance-root", type=Path, default=DEFAULT_INSTANCE_ROOT)
    parser.add_argument("--create", action="store_true",
                        help="Create a new governance checkpoint")
    parser.add_argument("--notes", type=str, default="",
                        help="Operator notes for the checkpoint")
    parser.add_argument("--summary", action="store_true",
                        help="Show checkpoint summary statistics")
    parser.add_argument("--list", action="store_true",
                        help="List all checkpoints")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    args = parser.parse_args()

    if not any([args.create, args.summary, args.list]):
        args.summary = True

    if args.create:
        checkpoint = create_checkpoint(args.instance_root, notes=args.notes)
        cp_path = save_checkpoint(checkpoint)

        if args.json:
            print(json.dumps(checkpoint, indent=2))
        else:
            print(format_checkpoint_text(checkpoint))
            print(f"  Saved: {cp_path}")
            print(f"  Markdown: {cp_path.with_suffix('.md')}")
            print()

    if args.list:
        entries = load_index()
        if args.json:
            print(json.dumps(entries, indent=2))
        else:
            print(format_index_text(entries))

    if args.summary:
        entries = load_index()
        if args.json:
            # Build summary dict
            if not entries:
                print(json.dumps({"checkpoint_count": 0}))
            else:
                scores = [e.get("health_score") for e in entries if e.get("health_score") is not None]
                print(json.dumps({
                    "checkpoint_count": len(entries),
                    "first": entries[0]["timestamp"],
                    "latest": entries[-1]["timestamp"],
                    "latest_status": entries[-1].get("overall_status"),
                    "latest_score": entries[-1].get("health_score"),
                    "deployment_ready_count": sum(1 for e in entries if e.get("deployment_ready")),
                    "score_range": [min(scores), max(scores)] if scores else None,
                }, indent=2))
        else:
            print(format_summary_text(entries))


if __name__ == "__main__":
    main()
