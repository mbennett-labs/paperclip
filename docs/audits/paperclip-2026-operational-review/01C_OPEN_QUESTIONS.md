# 01C — Open Questions

Questions that **cannot yet be answered** from the evidence examined during this audit.  
**Rule:** Do not answer them. List only.

---

## Q1. Upstream Sync State
**Question:** What is the current delta between this fork (`master` at commit `bb5f60ef2`) and upstream `paperclipai/paperclip` `master`?  
**Evidence gap:** Upstream branch `remotes/upstream/master` exists but was not diffed. `sync/upstream-2026-06` branch suggests a sync was attempted in June 2026 but its merge status is unknown.  
**Implication:** Cannot determine if custom fork changes will conflict with upstream features.

---

## Q2. Production Deployment Topology
**Question:** Is this fork running in production, staging, or development-only? What infrastructure hosts it?  
**Evidence gap:** No deployment manifests, terraform, or hosting configuration found. `docs/RUNTIME_OPERATIONS_V4.md` describes VPS deployment but no evidence that it has been applied.  
**Implication:** Cannot assess operational readiness or environment-specific risks.

---

## Q3. Governance Checkpoint Automation
**Question:** Are governance checkpoints created automatically on deploy/incident, or only manually via `python scripts/governance_checkpoint.py --create`?  
**Evidence gap:** `GOVERNANCE_CHECKPOINT_MODEL.md` lists "Future Extensions: Automated checkpoint triggers" suggesting this is not yet implemented. No systemd timer, cron job, or CI step found that invokes checkpoint creation.  
**Implication:** Manual-only checkpoints may miss critical state capture.

---

## Q4. Runtime Guardian Scheduling
**Question:** Is `runtime_guardian.py` running on a schedule (systemd/PM2/cron), or only executed manually?  
**Evidence gap:** `RUNTIME_OPERATIONS_V4.md` provides systemd timer configs but they are documentation-only — no evidence they are deployed. `logs/runtime-guardian/` directory exists but no log timestamps were examined to confirm recent execution.  
**Implication:** If not scheduled, the operational health monitoring is theoretical.

---

## Q5. QSL Bridge Source
**Question:** What tool or process generates the QSL bridge files (`issues.json`, `state.json`, `approvals.jsonl`) consumed by `qsl-bridge.ts`?  
**Evidence gap:** No source code for a QSL scanner/bridge producer was found in the repository. `QSL_BRIDGE_PATH` env var is referenced but the producer is external.  
**Implication:** The QSL subsystem depends on an undocumented external component.

---

## Q6. Data Confidence Layer
**Question:** What is the current status of the `feat/data-confidence-layer` branch? Is the data confidence classification feature (per GR-003) implemented or abandoned?  
**Evidence gap:** Branch exists in git (`remotes/origin/feat/data-confidence-layer`) but its contents were not examined. No evidence in `master` of `confidence_level` field on `qsl_findings`.  
**Implication:** GR-003 may already have a partial implementation in a feature branch.

---

## Q7. Active Company Count
**Question:** How many companies, agents, and active heartbeat runs exist in the production/live instance?  
**Evidence gap:** No database dump, metrics export, or admin panel evidence examined. `server/src/services/telemetry.ts` exists but its data destination and retention are unknown.  
**Implication:** Cannot assess scale, performance, or utilization.

---

## Q8. Test Coverage Gaps
**Question:** What is the current test coverage percentage? Are the custom fork additions (QSL, guardian, checkpoints) covered by tests?  
**Evidence gap:** `vitest.config.ts` and `tests/` directories exist but no coverage reports were generated or examined. No test files found for `qsl-review.ts`, `runtime_guardian.py`, or `governance_checkpoint.py`.  
**Implication:** Custom additions may lack regression protection.

---

## Q9. Plugin Ecosystem State
**Question:** What external plugins are currently installed/loaded in the active instance? Is the Hermes adapter actually loaded via the plugin system?  
**Evidence gap:** No `~/.paperclip/adapter-plugins.json` content examined. No plugin registry dump or runtime plugin list endpoint audited.  
**Implication:** Cannot confirm the external-only Hermes architecture is functional.

---

## Q10. Backup and Restore Validation
**Question:** Has the backup/restore path been validated end-to-end, including the `qsl_findings` table (per GR-005)?  
**Evidence gap:** `scripts/backup-db.sh` exists. `doc/DEVELOPING.md` describes auto-backups. No evidence of a restore-from-backup test. No test files for backup/restore logic.  
**Implication:** Disaster recovery capability is unverified.

---

## Q11. Security Boundary Testing
**Question:** Has the agent API key authorization been penetration tested? Are there company boundary violations in edge cases?  
**Evidence gap:** `server/src/routes/authz.ts` and `server/src/services/access.ts` exist but were not audited for security flaws. `doc/SPEC-implementation.md` Section 16 lists security requirements but no security audit document found for this fork.  
**Implication:** Authorization enforcement is assumed correct but not independently verified.

---

## Q12. Cost and Budget Accuracy
**Question:** Are the cost event ingestion and budget rollup calculations accurate under concurrent load?  
**Evidence gap:** `server/src/services/costs.ts` and `server/src/services/budgets.ts` exist but were not audited for race conditions. No stress test or load test evidence found.  
**Implication:** Budget hard-stop may have edge cases under heavy concurrency.

---

## Q13. Migration Compatibility
**Question:** Can the 72+ migrations be safely run in order on a fresh database? Are there any migration conflicts or destructive operations?  
**Evidence gap:** Migration files were listed but not individually audited for safety. `doc/SPEC-implementation.md` Section 15.2 states "no destructive migration in-place for V1 upgrade path" but this was not verified against actual SQL.  
**Implication:** New instance bootstrap may encounter migration failures.

---

## Q14. Hermes Adapter Externalization Completeness
**Question:** Are there any remaining hardcoded references to `hermes_local` in server or UI code that would break if the external plugin is not loaded?  
**Evidence gap:** `AGENTS.md` claims "no Hermes imports in `server/` or `ui/` source" but a full grep for "hermes" was not performed across the entire codebase.  
**Implication:** May have hidden coupling to Hermes that breaks external-only architecture.

---

## Q15. Worktree Instance Quarantine Effectiveness
**Question:** Does the worktree quarantine logic (disabling agent heartbeats, resetting running agents, blocking issues) reliably prevent cross-instance work duplication?  
**Evidence gap:** `doc/DEVELOPING.md` describes quarantine behavior but no test verification was found. No evidence of worktree isolation being validated.  
**Implication:** Developer worktree instances could interfere with production work.

---

## Q16. Board Export Data Completeness
**Question:** What data is included in board exports? Are secrets properly scrubbed? Are export bundles encrypted at rest?  
**Evidence gap:** `server/src/services/board-export.ts` exists but was not audited. `doc/SPEC-implementation.md` Section 21 describes export behavior but implementation fidelity unknown.  
**Implication:** Export security boundary is unverified.

---

## Q17. Runtime Log Volume and Rotation
**Question:** What is the current daily log volume in `logs/`? Is rotation keeping disk usage bounded?  
**Evidence gap:** `logs/` directory structure was listed but sizes and file counts were not examined. `scripts/runtime_rotation.py` exists but no evidence it runs automatically.  
**Implication:** Unbounded log growth could cause disk exhaustion.

---

## Q18. Provider Routing Stage 0 Impact
**Question:** What runtime behavior changes when provider routing is active? Is it gated behind a feature flag?  
**Evidence gap:** `server/src/services/provider-routing.ts` exists but its integration points were not audited. No feature flag reference found in `config.ts` or environment docs.  
**Implication:** Provider routing may partially activate without explicit operator intent.

---

## Q19. E2E and Smoke Test Status
**Question:** When were the E2E and release-smoke tests last run? Do they pass on `master`?  
**Evidence gap:** `tests/e2e/` and `tests/release-smoke/` directories exist but no CI run history or test results were examined. GitHub Actions workflow files exist under `.github/workflows/` but were not read.  
**Implication:** Test suite health is unknown.

---

## Q20. Selarix Relationship
**Question:** Multiple operational documents reference "Selarix" (e.g., `docs/RUNTIME_OPERATIONS_V4.md`). What is the relationship between Paperclip and Selarix? Is Selarix a company running on Paperclip, a separate product, or a codename?  
**Evidence gap:** No definition of Selarix found in any strategic document (`GOAL.md`, `PRODUCT.md`, `SPEC.md`). References appear only in operational docs and git commit messages.  
**Implication:** Operational documentation may refer to a deployment context not documented in product docs.

---

*End of Open Questions — 20 items*
