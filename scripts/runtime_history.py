#!/usr/bin/env python3
"""
Runtime History V3 for Paperclip/Selarix

Historical operational intelligence: snapshot persistence, trend detection,
and governance reporting built on runtime_guardian.py.

Append-only. Deterministic schema. No destructive actions.

Usage:
    python scripts/runtime_history.py --summary
    python scripts/runtime_history.py --trends
    python scripts/runtime_history.py --last 10
    python scripts/runtime_history.py --json
    python scripts/runtime_history.py --record
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_topology_report import DEFAULT_INSTANCE_ROOT, format_size
from runtime_guardian import run_guardian

REPO_ROOT = Path(__file__).resolve().parent.parent
HISTORY_DIR = REPO_ROOT / "logs" / "runtime-history"
SNAPSHOTS_FILE = HISTORY_DIR / "snapshots.jsonl"

# Remediation directories for counting
REMEDIATION_DIR = REPO_ROOT / "logs" / "runtime-remediation"

# Schema version for forward compatibility
SNAPSHOT_SCHEMA_VERSION = 1


def ensure_dirs():
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)


def _count_remediation_state(state: str) -> int:
    """Count plans in a given state directory."""
    d = REMEDIATION_DIR / state
    if not d.exists():
        return 0
    return len(list(d.glob("REM-*.json")))


def _count_remediation_outcomes() -> dict:
    """Count remediation outcomes across all states."""
    return {
        "pending": _count_remediation_state("pending"),
        "approved": _count_remediation_state("approved"),
        "executed": _count_remediation_state("executed"),
        "failed": _count_remediation_state("failed"),
        "expired": _count_remediation_state("expired"),
    }


def create_snapshot(instance_root: Path) -> dict:
    """Create a historical snapshot from a guardian run."""
    result = run_guardian(instance_root)
    now = datetime.now(tz=timezone.utc)

    # Extract check details into flat metrics
    checks_by_name = {c["name"]: c for c in result["checks"]}

    backup_check = checks_by_name.get("backup_freshness", {})
    backup_detail = backup_check.get("detail", {})

    storage_check = checks_by_name.get("storage_size", {})
    storage_detail = storage_check.get("detail", {})

    stale_check = checks_by_name.get("stale_entities", {})
    stale_detail = stale_check.get("detail", {})

    orphan_check = checks_by_name.get("orphan_count", {})
    orphan_detail = orphan_check.get("detail", {})

    dup_check = checks_by_name.get("duplicate_agents", {})
    dup_detail = dup_check.get("detail", {})

    metadata_check = checks_by_name.get("missing_metadata", {})
    metadata_detail = metadata_check.get("detail", {})

    topo = result["topology_summary"]
    remediation = _count_remediation_outcomes()

    snapshot = {
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "timestamp": now.isoformat(),
        "health_score": result["overall_status"],
        "topology": {
            "companies": topo.get("companies", 0),
            "projects": topo.get("projects", 0),
            "agents": topo.get("agents", 0),
            "prompt_caches": topo.get("prompt_caches", 0),
            "backup_archives": topo.get("backup_archives", 0),
            "orphans": topo.get("orphans", 0),
        },
        "backup_freshness_hours": backup_detail.get("hours_since_last"),
        "backup_total_bytes": backup_detail.get("total_size_bytes", 0),
        "storage_total_bytes": storage_detail.get("total_bytes", 0),
        "storage_asset_bytes": storage_detail.get("storage_bytes", 0),
        "stale_companies": len(stale_detail.get("stale_companies", [])),
        "stale_agents": stale_detail.get("stale_agent_count", 0),
        "orphan_count": orphan_detail.get("total", 0),
        "duplicate_sets": dup_detail.get("count", 0),
        "missing_metadata": metadata_detail.get("count", 0),
        "remediation": remediation,
        "check_statuses": {c["name"]: c["status"] for c in result["checks"]},
    }

    return snapshot


def record_snapshot(snapshot: dict):
    """Append snapshot to the JSONL history file."""
    ensure_dirs()
    with open(SNAPSHOTS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(snapshot, separators=(",", ":")) + "\n")


def load_snapshots(last_n: int | None = None) -> list[dict]:
    """Load snapshots from JSONL file. Optionally limit to last N."""
    if not SNAPSHOTS_FILE.exists():
        return []

    snapshots = []
    with open(SNAPSHOTS_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    snapshots.append(json.loads(line))
                except json.JSONDecodeError:
                    continue

    if last_n is not None and last_n > 0:
        snapshots = snapshots[-last_n:]

    return snapshots


def load_snapshots_since(hours: float) -> list[dict]:
    """Load snapshots from the last N hours."""
    cutoff = datetime.now(tz=timezone.utc) - timedelta(hours=hours)
    all_snaps = load_snapshots()
    return [s for s in all_snaps if datetime.fromisoformat(s["timestamp"]) >= cutoff]


def compute_delta(current: dict, previous: dict) -> dict:
    """Compute delta between two snapshots."""
    delta = {}

    # Topology deltas
    for key in ["companies", "projects", "agents", "prompt_caches", "backup_archives", "orphans"]:
        cur = current["topology"].get(key, 0)
        prev = previous["topology"].get(key, 0)
        diff = cur - prev
        if diff != 0:
            delta[f"topology.{key}"] = {"previous": prev, "current": cur, "delta": diff}

    # Scalar metric deltas
    scalar_keys = [
        "backup_freshness_hours", "backup_total_bytes", "storage_total_bytes",
        "storage_asset_bytes", "stale_companies", "stale_agents",
        "orphan_count", "duplicate_sets", "missing_metadata",
    ]
    for key in scalar_keys:
        cur = current.get(key) or 0
        prev = previous.get(key) or 0
        if isinstance(cur, float):
            diff = round(cur - prev, 1)
        else:
            diff = cur - prev
        if diff != 0:
            delta[key] = {"previous": prev, "current": cur, "delta": diff}

    # Health score change
    if current["health_score"] != previous["health_score"]:
        delta["health_score"] = {
            "previous": previous["health_score"],
            "current": current["health_score"],
        }

    return delta


def detect_trends(snapshots: list[dict], label: str = "") -> dict:
    """Detect trends across a set of snapshots."""
    if len(snapshots) < 2:
        return {"label": label, "snapshot_count": len(snapshots), "trends": [], "anomalies": []}

    first = snapshots[0]
    last = snapshots[-1]
    trends = []
    anomalies = []

    # Storage growth
    first_storage = first.get("storage_total_bytes") or 0
    last_storage = last.get("storage_total_bytes") or 0
    if first_storage > 0:
        growth_pct = ((last_storage - first_storage) / first_storage) * 100
        if abs(growth_pct) > 10:
            severity = "warning" if growth_pct > 25 else "info"
            trends.append({
                "metric": "storage_total_bytes",
                "direction": "increasing" if growth_pct > 0 else "decreasing",
                "change_pct": round(growth_pct, 1),
                "first": first_storage,
                "last": last_storage,
                "severity": severity,
            })

    # Orphan count trend
    orphan_values = [s.get("orphan_count", 0) for s in snapshots]
    if len(set(orphan_values)) > 1:
        if orphan_values[-1] > orphan_values[0]:
            trends.append({
                "metric": "orphan_count",
                "direction": "increasing",
                "first": orphan_values[0],
                "last": orphan_values[-1],
                "severity": "warning",
            })

    # Duplicate agents trend
    dup_values = [s.get("duplicate_sets", 0) for s in snapshots]
    if len(set(dup_values)) > 1 and dup_values[-1] > dup_values[0]:
        trends.append({
            "metric": "duplicate_sets",
            "direction": "increasing",
            "first": dup_values[0],
            "last": dup_values[-1],
            "severity": "warning",
        })

    # Prompt cache growth
    cache_values = [s["topology"].get("prompt_caches", 0) for s in snapshots]
    if len(cache_values) >= 2 and cache_values[-1] > cache_values[0]:
        growth = cache_values[-1] - cache_values[0]
        if growth > 5:
            trends.append({
                "metric": "prompt_caches",
                "direction": "increasing",
                "first": cache_values[0],
                "last": cache_values[-1],
                "delta": growth,
                "severity": "info",
            })

    # Backup freshness instability (check if it went critical at any point)
    backup_hours = [s.get("backup_freshness_hours") for s in snapshots if s.get("backup_freshness_hours") is not None]
    if backup_hours:
        critical_count = sum(1 for h in backup_hours if h > 72)
        if critical_count > 0:
            anomalies.append({
                "metric": "backup_freshness_hours",
                "type": "instability",
                "critical_snapshots": critical_count,
                "total_snapshots": len(backup_hours),
                "severity": "warning" if critical_count < len(backup_hours) / 2 else "critical",
            })

    # Repeated remediation failures
    fail_counts = [s.get("remediation", {}).get("failed", 0) for s in snapshots]
    if len(fail_counts) >= 2 and fail_counts[-1] > fail_counts[0]:
        anomalies.append({
            "metric": "remediation_failures",
            "type": "increasing",
            "first": fail_counts[0],
            "last": fail_counts[-1],
            "severity": "warning",
        })

    # Topology churn (agents appearing/disappearing)
    agent_values = [s["topology"].get("agents", 0) for s in snapshots]
    if len(agent_values) >= 3:
        changes = sum(1 for i in range(1, len(agent_values)) if agent_values[i] != agent_values[i - 1])
        if changes > len(agent_values) / 2:
            anomalies.append({
                "metric": "topology.agents",
                "type": "churn",
                "changes": changes,
                "snapshots": len(agent_values),
                "severity": "info",
            })

    # Health trajectory
    health_values = [s["health_score"] for s in snapshots]
    health_map = {"healthy": 0, "warning": 1, "critical": 2}
    health_nums = [health_map.get(h, 0) for h in health_values]
    if health_nums[-1] > health_nums[0]:
        trends.append({
            "metric": "health_score",
            "direction": "degrading",
            "first": health_values[0],
            "last": health_values[-1],
            "severity": "warning",
        })
    elif health_nums[-1] < health_nums[0]:
        trends.append({
            "metric": "health_score",
            "direction": "improving",
            "first": health_values[0],
            "last": health_values[-1],
            "severity": "info",
        })

    return {
        "label": label,
        "snapshot_count": len(snapshots),
        "time_range": {
            "first": first["timestamp"],
            "last": last["timestamp"],
        },
        "trends": trends,
        "anomalies": anomalies,
    }


def compute_summary(snapshots: list[dict]) -> dict:
    """Compute overall summary statistics from snapshot history."""
    if not snapshots:
        return {"snapshot_count": 0}

    health_counts = {}
    for s in snapshots:
        h = s["health_score"]
        health_counts[h] = health_counts.get(h, 0) + 1

    # Remediation success rate
    last = snapshots[-1]
    rem = last.get("remediation", {})
    total_rem = rem.get("executed", 0) + rem.get("failed", 0)
    success_rate = (rem.get("executed", 0) / total_rem * 100) if total_rem > 0 else None

    # Backup reliability: % of snapshots where backup was healthy
    backup_healthy = sum(
        1 for s in snapshots
        if s.get("check_statuses", {}).get("backup_freshness") == "healthy"
    )
    backup_reliability = (backup_healthy / len(snapshots) * 100) if snapshots else None

    # Storage growth
    if len(snapshots) >= 2:
        first_storage = snapshots[0].get("storage_total_bytes") or 0
        last_storage = snapshots[-1].get("storage_total_bytes") or 0
        storage_growth = last_storage - first_storage
    else:
        storage_growth = 0

    return {
        "snapshot_count": len(snapshots),
        "time_range": {
            "first": snapshots[0]["timestamp"],
            "last": snapshots[-1]["timestamp"],
        },
        "health_distribution": health_counts,
        "current_health": snapshots[-1]["health_score"],
        "current_topology": snapshots[-1]["topology"],
        "remediation_totals": rem,
        "remediation_success_rate_pct": round(success_rate, 1) if success_rate is not None else None,
        "backup_reliability_pct": round(backup_reliability, 1) if backup_reliability is not None else None,
        "storage_growth_bytes": storage_growth,
        "storage_growth_human": format_size(abs(storage_growth)),
    }


def format_summary_text(summary: dict) -> str:
    """Format summary for human display."""
    lines = []
    lines.append("=" * 64)
    lines.append("  PAPERCLIP RUNTIME HISTORY - SUMMARY")
    lines.append("=" * 64)

    if summary["snapshot_count"] == 0:
        lines.append("  No snapshots recorded yet.")
        lines.append("  Run: python scripts/runtime_history.py --record")
        lines.append("=" * 64)
        return "\n".join(lines)

    tr = summary["time_range"]
    lines.append(f"  Snapshots:  {summary['snapshot_count']}")
    lines.append(f"  Range:      {tr['first'][:19]} to {tr['last'][:19]}")
    lines.append(f"  Current:    {summary['current_health'].upper()}")
    lines.append("-" * 64)

    # Health distribution
    lines.append("  HEALTH DISTRIBUTION:")
    for status in ["healthy", "warning", "critical"]:
        count = summary["health_distribution"].get(status, 0)
        pct = count / summary["snapshot_count"] * 100
        bar = "#" * int(pct / 5)
        lines.append(f"    {status:10s} {count:3d} ({pct:5.1f}%) {bar}")

    lines.append("-" * 64)

    # Topology
    topo = summary["current_topology"]
    lines.append("  CURRENT TOPOLOGY:")
    lines.append(f"    Companies: {topo['companies']}  Projects: {topo['projects']}  "
                 f"Agents: {topo['agents']}  Caches: {topo['prompt_caches']}")

    lines.append("-" * 64)

    # Key metrics
    lines.append("  KEY METRICS:")
    if summary["backup_reliability_pct"] is not None:
        lines.append(f"    Backup reliability:      {summary['backup_reliability_pct']}%")
    if summary["remediation_success_rate_pct"] is not None:
        lines.append(f"    Remediation success rate: {summary['remediation_success_rate_pct']}%")
    direction = "+" if summary["storage_growth_bytes"] >= 0 else "-"
    lines.append(f"    Storage growth:          {direction}{summary['storage_growth_human']}")

    # Remediation totals
    rem = summary.get("remediation_totals", {})
    if any(rem.values()):
        lines.append(f"    Remediations: {rem.get('executed', 0)} executed, "
                     f"{rem.get('failed', 0)} failed, "
                     f"{rem.get('pending', 0)} pending, "
                     f"{rem.get('expired', 0)} expired")

    lines.append("=" * 64)
    return "\n".join(lines)


def format_trends_text(trend_results: list[dict]) -> str:
    """Format trend results for human display."""
    lines = []
    lines.append("=" * 64)
    lines.append("  PAPERCLIP RUNTIME HISTORY - TRENDS")
    lines.append("=" * 64)

    for tr in trend_results:
        lines.append(f"\n  --- {tr['label']} ({tr['snapshot_count']} snapshots) ---")

        if tr["snapshot_count"] < 2:
            lines.append("    Insufficient data for trend analysis.")
            continue

        time_range = tr.get("time_range", {})
        if time_range:
            lines.append(f"    Range: {time_range['first'][:19]} to {time_range['last'][:19]}")

        if tr["trends"]:
            lines.append("    TRENDS:")
            for t in tr["trends"]:
                icon = "[!!]" if t["severity"] in ("warning", "critical") else "[--]"
                lines.append(f"      {icon} {t['metric']}: {t['direction']}"
                             f" ({t.get('first', '?')} -> {t.get('last', '?')})")
        else:
            lines.append("    No significant trends detected.")

        if tr["anomalies"]:
            lines.append("    ANOMALIES:")
            for a in tr["anomalies"]:
                icon = "[!!]" if a["severity"] in ("warning", "critical") else "[--]"
                lines.append(f"      {icon} {a['metric']}: {a['type']}")

    lines.append("")
    lines.append("=" * 64)
    return "\n".join(lines)


def format_snapshots_text(snapshots: list[dict]) -> str:
    """Format snapshot list for human display."""
    lines = []
    lines.append("=" * 64)
    lines.append("  PAPERCLIP RUNTIME HISTORY - SNAPSHOTS")
    lines.append("=" * 64)

    if not snapshots:
        lines.append("  No snapshots found.")
        lines.append("=" * 64)
        return "\n".join(lines)

    status_icon = {"healthy": "[OK]", "warning": "[WARN]", "critical": "[CRIT]"}
    for i, s in enumerate(snapshots):
        icon = status_icon.get(s["health_score"], "[??]")
        topo = s["topology"]
        lines.append(
            f"  {icon} {s['timestamp'][:19]}  "
            f"co={topo['companies']} ag={topo['agents']} "
            f"orph={s.get('orphan_count', 0)} "
            f"bkup={s.get('backup_freshness_hours', '?')}h "
            f"stor={format_size(s.get('storage_total_bytes', 0))}"
        )

    lines.append("")
    lines.append(f"  Total: {len(snapshots)} snapshots")
    lines.append("=" * 64)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Paperclip Runtime History V3 - Historical operational intelligence"
    )
    parser.add_argument("--instance-root", type=Path, default=DEFAULT_INSTANCE_ROOT)
    parser.add_argument("--record", action="store_true",
                        help="Record a new snapshot from current guardian state")
    parser.add_argument("--summary", action="store_true",
                        help="Show summary of all historical snapshots")
    parser.add_argument("--trends", action="store_true",
                        help="Show trend analysis (previous, 24h, 7d)")
    parser.add_argument("--last", type=int, metavar="N",
                        help="Show last N snapshots")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    args = parser.parse_args()

    # Default to --summary if nothing specified
    if not any([args.record, args.summary, args.trends, args.last]):
        args.summary = True

    if args.record:
        snapshot = create_snapshot(args.instance_root)
        record_snapshot(snapshot)

        if args.json:
            print(json.dumps(snapshot, indent=2))
        else:
            icon = {"healthy": "[OK]", "warning": "[WARN]", "critical": "[CRIT]"}
            print(f"  Recorded: {icon.get(snapshot['health_score'], '[??]')} "
                  f"{snapshot['health_score'].upper()} at {snapshot['timestamp'][:19]}")
            print(f"  History:  {SNAPSHOTS_FILE}")

    if args.summary:
        snapshots = load_snapshots()
        summary = compute_summary(snapshots)
        if args.json:
            print(json.dumps(summary, indent=2))
        else:
            print(format_summary_text(summary))

    if args.trends:
        all_snaps = load_snapshots()
        snaps_24h = load_snapshots_since(24)
        snaps_7d = load_snapshots_since(168)

        trend_results = []

        # Previous snapshot comparison
        if len(all_snaps) >= 2:
            delta = compute_delta(all_snaps[-1], all_snaps[-2])
            trend_results.append({
                "label": "vs. previous snapshot",
                "snapshot_count": 2,
                "time_range": {
                    "first": all_snaps[-2]["timestamp"],
                    "last": all_snaps[-1]["timestamp"],
                },
                "trends": [
                    {"metric": k, "direction": "changed",
                     "first": v.get("previous"), "last": v.get("current"),
                     "severity": "info"}
                    for k, v in delta.items()
                ],
                "anomalies": [],
            })

        trend_results.append(detect_trends(snaps_24h, "Last 24 hours"))
        trend_results.append(detect_trends(snaps_7d, "Last 7 days"))

        if args.json:
            print(json.dumps(trend_results, indent=2))
        else:
            print(format_trends_text(trend_results))

    if args.last is not None:
        snapshots = load_snapshots(last_n=args.last)
        if args.json:
            print(json.dumps(snapshots, indent=2))
        else:
            print(format_snapshots_text(snapshots))


if __name__ == "__main__":
    main()
