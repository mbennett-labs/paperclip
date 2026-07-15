# 01A — Custom Fork Change Map

Modifications that appear **unique to the `mbennett-labs` fork** of Paperclip, identified through file evidence, git history, and documentation audit. This map does **not** compare to upstream — it simply documents what exists in this fork that is not described in upstream-facing documentation.

---

## Methodology

Custom changes were identified by:
1. Cross-referencing `AGENTS.md` fork-specific notes
2. Examining git commit history on `master` and feature branches
3. Finding files and documentation not referenced in upstream-facing docs
4. Identifying schema migrations beyond the V1 spec baseline
5. Discovering Python operational tooling with no upstream equivalent

---

## 1. QSL Review Persistence Subsystem

**What it is:** A Quality & Security Layer (QSL) bridge that ingests security scan findings, persists review decisions in the database (not just files), and provides a UI for board-level security governance.

**Evidence:**
- `packages/db/src/migrations/0071_qsl_findings.sql` — Creates `qsl_findings` table
- `packages/db/src/migrations/0072_qsl_findings_review_states.sql` — Renames "acknowledged" → "approved"
- `packages/db/src/schema/qsl_findings.ts` — Drizzle schema definition
- `server/src/services/qsl-review.ts` — Persistence service with fingerprint-based dedup
- `server/src/routes/qsl-bridge.ts` — REST bridge with DB-first + file fallback strategy
- `ui/src/pages/QslReview.tsx` — Review UI with approve/deny/suppress/escalate actions
- `ui/src/api/qsl.ts` — API client
- `architecture_changelog.md` — Documents PR #5 (2026-05-12) transition: file-based → DB-backed

**Key architectural principle:** Human review decisions are durable institutional state. Bridge sync must not overwrite them.

**Status:** Active, in production. GR-003 (data confidence) and GR-005 (backup validation) identify remaining gaps.

---

## 2. Runtime Guardian V1–V4

**What it is:** Python-based operational health monitoring that replaces binary healthy/critical with weighted 0-100 scoring across 6 governance dimensions, plus governance escalation tracking.

**Evidence:**
- `scripts/runtime_guardian.py` — Health monitor (6 dimensions: Durability 25%, Governance 15%, Topology 15%, Remediation 15%, Backup 15%, Continuity 15%)
- `scripts/runtime_history.py` — Snapshot persistence, trend detection
- `scripts/runtime_remediator.py` — Approval-aware corrective workflows
- `scripts/runtime_rotation.py` — Deterministic log rotation with gzip archiving
- `scripts/runtime_export.py` — Operational continuity export bundles with SHA-256 manifests
- `scripts/runtime_topology_report.py` — Disk state enumeration
- `docs/RUNTIME_GUARDIAN_MODEL.md` — Health scoring specification
- `docs/RUNTIME_OPERATIONS_V4.md` — Full operational continuity spec (383 lines)
- `docs/RUNTIME_HISTORY_MODEL.md` — Snapshot persistence spec
- `docs/RUNTIME_REMEDIATION_MODEL.md` — Corrective workflow spec
- `docs/RUNTIME_TOPOLOGY_MODEL.md` — Topology enumeration spec
- `logs/runtime-guardian/` — Operational output directory
- `logs/runtime-history/` — Operational output directory
- `logs/runtime-remediation/` — Operational output directory
- `logs/exports/` — Operational output directory
- Git commits: `8c15510d7` (V1), `9641f127d` (V3), `8c1976384` (V4)

**Key architectural principle:** Operational state is institutional memory. If it exists only on one machine, it is fragile.

**Status:** Active. V4 is current. Deployment readiness checklist exists but completion status unknown from current evidence.

---

## 3. Governance Checkpoint Recorder

**What it is:** Chain-linked governance checkpoints with SHA-256 integrity hashes, dual JSON/markdown output, and deployment readiness assessment.

**Evidence:**
- `scripts/governance_checkpoint.py` — Checkpoint creation and listing
- `docs/GOVERNANCE_CHECKPOINT_MODEL.md` — Specification (174 lines)
- `logs/governance-checkpoints/` — Output directory
- Git commit: `23e0dc727` — "feat: add governance checkpoint recorder with continuity chains"

**Key architectural principle:** Append-only index, integrity hashes, continuity chain for tamper detection.

**Status:** Active. No evidence of automated triggers (deploy/incident) being configured.

---

## 4. Institutional Backup & Disaster Recovery

**What it is:** Framework for automatic DB backups with configurable intervals, retention, and disaster recovery procedures.

**Evidence:**
- `server/src/services/institutional-backup.ts` — Backup service
- `doc/DEVELOPING.md` — "Automatic DB Backups" section (60-min interval, 30-day retention)
- `scripts/backup-db.sh` — Backup script
- Git commit: `137dd161f` — "feat: add institutional backup and disaster recovery framework"
- Environment variables: `PAPERCLIP_DB_BACKUP_ENABLED`, `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES`, etc.

**Status:** Active. GR-005 notes that restore path has not been validated with `qsl_findings` table.

---

## 5. Provider Routing Infrastructure (Stage 0)

**What it is:** Foundation for provider-aware routing of agent execution, touching adapter registry, sandbox runtime, and workspace operations.

**Evidence:**
- `server/src/services/provider-routing.ts` — Routing logic
- `server/src/services/provider-routing-policy.ts` — Policy definitions
- `server/src/routes/adapters.ts` — Adapter registry routes
- Git commit: `cd9998f62` — "feat(routing): add provider routing infrastructure (Stage 0)"
- Git commit: `ef1406970` — Merge of provider-routing-stage0 branch
- `governance_risks.md` GR-006 flags this as "high severity" and recommends completing liveness hardening first

**Status:** Stage 0 complete. Stage 1+ blocked per GR-006 pending liveness/deadlock hardening.

---

## 6. Liveness / Deadlock Hardening Sprint

**What it is:** Comprehensive hardening of the heartbeat liveness detection, run continuation, and crash recovery subsystems.

**Evidence:**
- `server/src/services/recovery/service.ts` — Recovery orchestration
- `server/src/services/recovery/run-liveness-continuations.ts` — Bounded retry with idempotency
- `server/src/services/recovery/issue-graph-liveness.ts` — Stale issue tree recovery
- `server/src/services/recovery/pause-hold-guard.ts` — Pause protection during recovery
- `server/src/services/run-liveness.ts` — Run health classification
- `server/src/services/heartbeat.ts` — Core heartbeat (contains liveness thresholds)
- `liveness_report.md` — Full assessment with 4 identified gaps
- `governance_risks.md` GR-002 — "Liveness/deadlock detection gaps" (High severity)
- Git commit: `e9050cdba` — "feat(recovery): harden liveness/deadlock detection subsystem"
- Git commit: `228616272` — Merge of liveness-deadlock-hardening branch
- Migration `0069_liveness_recovery_dedupe.sql` — Recovery deduplication
- Migration `0070_active_run_output_watchdog.sql` — Active run watchdog

**Key thresholds (from `liveness_report.md` and source):**
- Heartbeat interval: 30s
- Suspicion threshold: 1 hour
- Critical threshold: 4 hours
- Max continuation attempts: 2
- Issue-graph auto-recovery staleness: 24 hours

**Status:** Sprint complete per merge history. GR-002 remains active with recommended actions not yet implemented.

---

## 7. Approval Governance Rules & Deduplication

**What it is:** Enhanced approval system with deduplication logic and governance review packets for board-level decision support.

**Evidence:**
- `server/src/services/approvals.ts` — Approval service
- `server/src/services/issue-approvals.ts` — Issue-linked approvals
- `server/src/routes/approvals.ts` — Approval routes
- `server/src/services/governance-risks-export.ts` — Risk export for board review
- `ui/src/pages/Approvals.tsx` — Approval queue UI
- `ui/src/components/ApprovalCard.tsx` — Approval display
- Git commit: `d2570432e` — "feat: add approval deduplication and governance review packet"
- Git commit: `c988ce0d0` — "feat: add governance risks export for board review"
- Git commit: `33d12bc61` — Merge of approval-governance-rules branch

**Status:** Active in production.

---

## 8. Fork QoL Patches (UI)

**What it is:** Three local UI modifications that improve operator experience, documented in `AGENTS.md` as "not in upstream."

**Evidence:**
- `AGENTS.md` Section 11, "Fork QoL Patches" explicitly lists:
  1. **`stderr_group`** — amber accordion for MCP init noise in `RunTranscriptView.tsx`
  2. **`tool_group`** — accordion for consecutive non-terminal tools (write, read, search, browser)
  3. **`Dashboard excerpt`** — `LatestRunCard` strips markdown, shows first 3 lines/280 chars
- `ui/src/components/transcript/` — Contains transcript subcomponents (presumably includes these patches)
- Git history does not isolate these as separate commits; they appear to be part of base fork state

**Status:** Active in UI.

---

## 9. External-Only Hermes Adapter

**What it is:** Hermes adapter is **not** built into core. Must be loaded via Adapter Plugin manager.

**Evidence:**
- `AGENTS.md` Section 11, "Fork-Specific: HenkDz/paperclip" — "core has **no** `hermes-paperclip-adapter` dependency"
- `AGENTS.md`: "Register through **Board → Adapter manager**"
- No `packages/adapters/hermes-local/` directory exists (confirmed in directory listing)
- `server/src/adapters/plugin-loader.ts` — Dynamic adapter loading (zero hardcoded imports)
- `ui/src/pages/AdapterManager.tsx` — Generic adapter configuration UI

**Status:** Active. Hermes must be installed as external plugin.

---

## 10. Worktree Dev System

**What it is:** Sophisticated isolated development instance system using git worktrees with database seeding, port auto-detection, and UI branding.

**Evidence:**
- `doc/DEVELOPING.md` — Extensive "Worktree-local Instances" section (200+ lines)
- `server/src/dev-runner-worktree.ts` — Worktree-aware dev runner
- `server/src/worktree-config.ts` — Worktree configuration
- Commands: `paperclipai worktree init`, `worktree:make`, `worktree repair`, `worktree reseed`
- Environment variables: `PAPERCLIP_IN_WORKTREE`, `PAPERCLIP_WORKTREE_NAME`, `PAPERCLIP_WORKTREE_COLOR`
- `scripts/provision-worktree.sh` — Worktree provisioning

**Status:** Likely upstream feature (referenced in upstream branch names like `feature/worktree-support`). However, NTFS-specific workarounds may be fork-specific. Marked here for completeness but confidence of being "custom" is medium.

---

## 11. NTFS-Specific Dev Workarounds

**What it is:** Development environment patches for Windows/NTFS compatibility.

**Evidence:**
- `AGENTS.md` Section 11: "`npx vite build` hangs on NTFS — use `node node_modules/vite/bin/vite.js build` instead"
- `AGENTS.md`: "Server startup from NTFS takes 30-60s — don't assume failure immediately"
- `AGENTS.md`: "Kill ALL paperclip processes before starting: `pkill -f ...`"
- `AGENTS.md`: "Vite cache survives `rm -rf dist` — delete both: `rm -rf ui/dist ui/node_modules/.vite`"
- `AGENTS.md`: Fork runs on port 3101+ (auto-detects if 3100 taken)

**Status:** Active operational knowledge. No direct file modifications identified for NTFS workarounds; appears to be runtime/CLI behavior notes.

---

## 12. Board Export / Intelligence Features

**What it is:** Enhanced export capabilities for board-level operational intelligence, risk review, and governance reporting.

**Evidence:**
- `server/src/services/board-export.ts` — Export service
- `server/src/services/governance-risks-export.ts` — Risk export
- `server/src/routes/board-export.ts` — Export routes
- `ui/src/pages/CompanyExport.tsx` — Export UI
- `ui/src/components/AccountingModelCard.tsx` — Financial display component
- Git commit: `c988ce0d0` — "feat: add governance risks export for board review"
- Git commit: `fac05d85a` — Merge of board-intelligence-export branch

**Status:** Active.

---

## Summary Table

| # | Custom Addition | Files/Dirs | Confidence |
|---|---|---|---|
| 1 | QSL Review Persistence | `schema/qsl_findings.ts`, `services/qsl-review.ts`, `routes/qsl-bridge.ts`, `pages/QslReview.tsx`, migs 0071-0072 | High |
| 2 | Runtime Guardian V1–V4 | `scripts/runtime_*.py` (6 files), `docs/RUNTIME_*.md` (5 files), `logs/runtime-*/` | High |
| 3 | Governance Checkpoint Recorder | `scripts/governance_checkpoint.py`, `docs/GOVERNANCE_CHECKPOINT_MODEL.md`, `logs/governance-checkpoints/` | High |
| 4 | Institutional Backup/DR | `services/institutional-backup.ts`, `scripts/backup-db.sh`, docs | High |
| 5 | Provider Routing (Stage 0) | `services/provider-routing*.ts`, commits, GR-006 | High |
| 6 | Liveness/Deadlock Hardening | `services/recovery/`, `services/run-liveness.ts`, migs 0069-0070, `liveness_report.md` | High |
| 7 | Approval Governance Rules | `services/approvals.ts`, `services/issue-approvals.ts`, `governance-risks-export.ts` | High |
| 8 | Fork QoL Patches | `ui/src/components/transcript/`, `AGENTS.md` documentation | Medium |
| 9 | External-Only Hermes | Absence of `packages/adapters/hermes-local/`, `AGENTS.md` | High |
| 10 | Worktree Dev System | `doc/DEVELOPING.md`, `server/src/dev-runner-worktree.ts`, `scripts/provision-worktree.sh` | Medium (likely upstream) |
| 11 | NTFS Dev Workarounds | `AGENTS.md` notes only | Medium |
| 12 | Board Export/Intelligence | `services/board-export.ts`, `services/governance-risks-export.ts`, `pages/CompanyExport.tsx` | High |

---

*End of Custom Fork Change Map*
