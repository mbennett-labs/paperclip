# 01B — Evidence Index

Comprehensive index of all files and directories examined during this audit.  
**Auditor Note:** This is not exhaustive — it prioritizes architectural-significant artifacts.

---

## Legend

| Importance | Meaning |
|---|---|
| 🔴 Critical | Core system file; understanding required |
| 🟡 High | Important subsystem or contract file |
| 🟢 Medium | Supporting documentation or utility |
| ⚪ Low | Noted for completeness |

---

## A. Root-Level Configuration & Meta

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `README.md` | Product overview, quickstart, features | 🔴 | Primary entrypoint for understanding Paperclip |
| `AGENTS.md` | Contributor guidelines, fork-specific notes | 🔴 | Contains fork identity (HenkDz → mbennett-labs), branch strategy, QoL patches |
| `package.json` | Root workspace manifest (pnpm monorepo) | 🔴 | Scripts: dev, build, test, db:migrate, release |
| `pnpm-workspace.yaml` | Workspace package definitions | 🟡 | |
| `tsconfig.base.json` | Shared TypeScript configuration | 🟢 | |
| `.env.example` | Environment variable template | 🟢 | |
| `Dockerfile` | Production container build | 🟢 | |
| `vitest.config.ts` | Test runner root config | 🟢 | |

---

## B. Strategic Documentation (`doc/`)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `doc/GOAL.md` | Vision statement and problem definition | 🔴 | "Paperclip is the backbone of the autonomous economy" |
| `doc/PRODUCT.md` | Core concepts, principles, user flow | 🔴 | Defines company, employee, task hierarchy |
| `doc/SPEC-implementation.md` | Concrete V1 build contract (2026-02-17) | 🔴 | 884 lines; canonical API contract, data model, state machines |
| `doc/DEVELOPING.md` | Dev setup, CLI reference, worktree system | 🔴 | 578 lines; extensive worktree dev tooling |
| `doc/DATABASE.md` | DB setup: embedded PG, Docker, Supabase | 🔴 | |
| `doc/execution-semantics.md` | Issue status, checkout, recovery semantics | 🔴 | 321 lines; crash recovery, watchdog, liveness |
| `doc/DEPLOYMENT-MODES.md` | `local_trusted` vs `authenticated` | 🟡 | Referenced by PRODUCT.md |
| `doc/CLI.md` | CLI command reference | 🟡 | |
| `doc/SPEC.md` | Long-horizon product spec | 🟢 | Out of scope for V1; referenced by SPEC-implementation.md |
| `doc/plans/` | Dated plan documents | 🟢 | Per AGENTS.md rule #5 |
| `doc/plugins/PLUGIN_SPEC.md` | Plugin system specification | 🟡 | Referenced by ROADMAP.md |

---

## C. Custom Fork Documentation (`docs/` — note: different dir from `doc/`)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `docs/RUNTIME_GUARDIAN_MODEL.md` | Runtime health monitoring spec | 🔴 | Custom fork addition; 6 governance dimensions |
| `docs/RUNTIME_OPERATIONS_V4.md` | Operational continuity, log rotation, export bundles | 🔴 | Custom fork addition; deployment readiness |
| `docs/GOVERNANCE_CHECKPOINT_MODEL.md` | Durable institutional memory snapshots | 🔴 | Custom fork addition; chain-linked checkpoints |
| `docs/RUNTIME_HISTORY_MODEL.md` | Snapshot persistence, trend detection | 🟡 | Custom fork addition |
| `docs/RUNTIME_REMEDIATION_MODEL.md` | Approval-aware corrective workflows | 🟡 | Custom fork addition |
| `docs/RUNTIME_TOPOLOGY_MODEL.md` | Disk state enumeration | 🟡 | Custom fork addition |

---

## D. Governance & Risk Artifacts (Root)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `governance_risks.md` | Active and mitigated governance risks | 🔴 | 6 risks (GR-001 through GR-006); hardening order defined |
| `liveness_report.md` | Liveness subsystem assessment (2026-05-12) | 🔴 | 88 lines; current architecture + 4 identified gaps |
| `architecture_changelog.md` | Significant architectural decisions | 🔴 | QSL persistence transition (PR #5); hardening order |
| `ROADMAP.md` | Extended roadmap beyond README preview | 🟡 | 97 lines; milestones with ✅ and ⚪ status |
| `CONTRIBUTING.md` | Contribution guidelines | 🟢 | |
| `SECURITY.md` | Security policy | 🟢 | |

---

## E. Server (`server/`)

### E.1 Entry & Configuration

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `server/src/index.ts` | Server bootstrap | 🔴 | |
| `server/src/app.ts` | Express application setup | 🔴 | |
| `server/src/config.ts` | Runtime configuration | 🔴 | |
| `server/src/config-file.ts` | Config file parsing | 🟡 | |
| `server/src/version.ts` | Version reporting | 🟢 | |
| `server/src/telemetry.ts` | Anonymous usage telemetry | 🟢 | |

### E.2 Routes (38 files)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `server/src/routes/index.ts` | Route registration hub | 🔴 | |
| `server/src/routes/companies.ts` | Company CRUD | 🔴 | |
| `server/src/routes/agents.ts` | Agent lifecycle | 🔴 | |
| `server/src/routes/issues.ts` | Issue/task CRUD | 🔴 | |
| `server/src/routes/issues-checkout-wakeup.ts` | Atomic checkout | 🔴 | |
| `server/src/routes/approvals.ts` | Approval workflows | 🔴 | |
| `server/src/routes/costs.ts` | Cost events, budgets | 🔴 | |
| `server/src/routes/heartbeat_runs.ts` | (implied by services) | 🔴 | Merged into agent routes |
| `server/src/routes/qsl-bridge.ts` | QSL findings bridge | 🔴 | **Custom fork addition**; DB-backed + bridge fallback |
| `server/src/routes/health.ts` | Health endpoint | 🟡 | |
| `server/src/routes/auth.ts` | Authentication | 🔴 | |
| `server/src/routes/authz.ts` | Authorization middleware | 🔴 | |
| `server/src/routes/dashboard.ts` | Dashboard aggregates | 🟡 | |
| `server/src/routes/activity.ts` | Activity log | 🟡 | |
| `server/src/routes/projects.ts` | Project CRUD | 🟡 | |
| `server/src/routes/goals.ts` | Goal hierarchy | 🟡 | |
| `server/src/routes/routines.ts` | Scheduled routines | 🟡 | |
| `server/src/routes/assets.ts` | File attachments | 🟡 | |
| `server/src/routes/secrets.ts` | Secret management | 🟡 | |
| `server/src/routes/plugins.ts` | Plugin system routes | 🟡 | |
| `server/src/routes/adapters.ts` | Adapter registry routes | 🟡 | |
| `server/src/routes/environments.ts` | Execution environments | 🟡 | |
| `server/src/routes/execution-workspaces.ts` | Workspace management | 🟡 | |

### E.3 Services (106 files — key subset)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `server/src/services/index.ts` | Service exports | 🔴 | |
| `server/src/services/agents.ts` | Agent CRUD | 🔴 | |
| `server/src/services/issues.ts` | Issue CRUD | 🔴 | |
| `server/src/services/heartbeat.ts` | Heartbeat orchestration | 🔴 | ~2000+ lines; core execution loop |
| `server/src/services/budgets.ts` | Budget enforcement | 🔴 | |
| `server/src/services/costs.ts` | Cost tracking | 🔴 | |
| `server/src/services/approvals.ts` | Approval workflows | 🔴 | |
| `server/src/services/activity-log.ts` | Audit logging | 🔴 | |
| `server/src/services/qsl-review.ts` | QSL findings persistence | 🔴 | **Custom fork addition**; 310 lines |
| `server/src/services/run-liveness.ts` | Run health classification | 🔴 | |
| `server/src/services/recovery/service.ts` | Crash recovery | 🔴 | |
| `server/src/services/recovery/run-liveness-continuations.ts` | Bounded retry logic | 🔴 | |
| `server/src/services/recovery/issue-graph-liveness.ts` | Stale issue recovery | 🟡 | |
| `server/src/services/recovery/pause-hold-guard.ts` | Pause protection | 🟡 | |
| `server/src/services/company-portability.ts` | Import/export | 🟡 | |
| `server/src/services/secrets.ts` | Secret resolution | 🟡 | |
| `server/src/services/workspace-runtime.ts` | Workspace lifecycle | 🟡 | |
| `server/src/services/environment-runtime.ts` | Environment execution | 🟡 | |
| `server/src/services/plugin-*.ts` | Plugin system services (15+ files) | 🟡 | |
| `server/src/services/institutional-backup.ts` | Disaster recovery | 🟡 | **Custom fork addition** |
| `server/src/services/governance-risks-export.ts` | Risk export for board | 🟡 | **Custom fork addition** |
| `server/src/services/heartbeat-run-summary.ts` | Run result summarization | 🟢 | |
| `server/src/services/run-log-store.ts` | Log storage abstraction | 🟢 | |
| `server/src/services/heartbeat-stop-metadata.ts` | Stop reason tracking | 🟢 | |

### E.4 Adapters (`server/src/adapters/`)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `server/src/adapters/index.ts` | Adapter registry | 🔴 | |
| `server/src/adapters/registry.ts` | Built-in + plugin adapter registration | 🔴 | |
| `server/src/adapters/plugin-loader.ts` | Dynamic plugin loading | 🔴 | Zero hardcoded imports |
| `server/src/adapters/builtin-adapter-types.ts` | Built-in adapter enum | 🟡 | |
| `server/src/adapters/types.ts` | Adapter interfaces | 🔴 | |
| `server/src/adapters/process/` | Process adapter implementation | 🟡 | |
| `server/src/adapters/http/` | HTTP adapter implementation | 🟡 | |

### E.5 Auth & Middleware

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `server/src/auth/` | Auth strategies | 🔴 | |
| `server/src/middleware/` | Express middleware stack | 🔴 | |
| `server/src/agent-auth-jwt.ts` | Agent JWT generation | 🟡 | |
| `server/src/board-claim.ts` | Board claim flow | 🟡 | |

---

## F. UI (`ui/`)

### F.1 Entry & Configuration

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `ui/src/main.tsx` | React entry | 🔴 | |
| `ui/src/App.tsx` | Root app component | 🔴 | |
| `ui/vite.config.ts` | Vite build config | 🟡 | |
| `ui/package.json` | UI package manifest | 🟡 | |

### F.2 Pages (64 files — key subset)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `ui/src/pages/Dashboard.tsx` | Main dashboard | 🔴 | |
| `ui/src/pages/DashboardLive.tsx` | Live activity dashboard | 🔴 | |
| `ui/src/pages/Agents.tsx` | Agent list | 🔴 | |
| `ui/src/pages/AgentDetail.tsx` | Agent detail | 🔴 | |
| `ui/src/pages/Issues.tsx` | Issue list/kanban | 🔴 | |
| `ui/src/pages/IssueDetail.tsx` | Issue detail/chat | 🔴 | |
| `ui/src/pages/OrgChart.tsx` | Organization chart | 🔴 | |
| `ui/src/pages/Approvals.tsx` | Approval queue | 🔴 | |
| `ui/src/pages/Costs.tsx` | Cost dashboard | 🔴 | |
| `ui/src/pages/QslReview.tsx` | QSL findings review | 🔴 | **Custom fork addition**; 386 lines |
| `ui/src/pages/AdapterManager.tsx` | External adapter management | 🟡 | |
| `ui/src/pages/PluginManager.tsx` | Plugin management | 🟡 | |
| `ui/src/pages/Routines.tsx` | Scheduled routines | 🟡 | |
| `ui/src/pages/CompanySettings.tsx` | Company configuration | 🟡 | |
| `ui/src/pages/InstanceSettings.tsx` | Instance-level settings | 🟡 | |
| `ui/src/pages/Inbox.tsx` | User inbox | 🟡 | |

### F.3 Components (145 files — key subset)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `ui/src/components/Layout.tsx` | App shell | 🔴 | |
| `ui/src/components/Sidebar.tsx` | Navigation sidebar | 🔴 | |
| `ui/src/components/CompanySwitcher.tsx` | Company selector | 🔴 | |
| `ui/src/components/IssueChatThread.tsx` | Comment thread UI | 🔴 | |
| `ui/src/components/CommentThread.tsx` | Legacy comment component | 🟡 | |
| `ui/src/components/KanbanBoard.tsx` | Kanban view | 🟡 | |
| `ui/src/components/AgentConfigForm.tsx` | Agent configuration | 🟡 | |
| `ui/src/components/BudgetPolicyCard.tsx` | Budget display | 🟡 | |
| `ui/src/components/ApprovalCard.tsx` | Approval item | 🟡 | |
| `ui/src/components/IssueRow.tsx` | Issue list item | 🟡 | |
| `ui/src/components/RunChatSurface.tsx` | Run transcript display | 🟡 | |
| `ui/src/components/transcript/` | Transcript sub-components | 🟡 | Contains stderr_group, tool_group (fork QoL) |
| `ui/src/components/**/RunTranscriptView.tsx` | Transcript view (QoL patches) | 🟡 | **Fork QoL**: stderr_group, tool_group accordions |
| `ui/src/components/**/LatestRunCard.tsx` | Dashboard excerpt card | 🟡 | **Fork QoL**: markdown strip, 3 lines/280 chars |

### F.4 API & Context

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `ui/src/api/` | API client functions | 🔴 | |
| `ui/src/api/qsl.ts` | QSL API client | 🔴 | **Custom fork addition** |
| `ui/src/context/CompanyContext.tsx` | Company selection state | 🔴 | |
| `ui/src/context/BreadcrumbContext.tsx` | Breadcrumb state | 🟢 | |
| `ui/src/hooks/` | Custom React hooks | 🟡 | |
| `ui/src/lib/queryKeys.ts` | React Query key definitions | 🟡 | |

---

## G. Database (`packages/db/`)

### G.1 Schema (75 table definition files)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `packages/db/src/schema/index.ts` | Schema exports | 🔴 | |
| `packages/db/src/schema/companies.ts` | Company table | 🔴 | |
| `packages/db/src/schema/agents.ts` | Agent table | 🔴 | |
| `packages/db/src/schema/issues.ts` | Issue/task table | 🔴 | |
| `packages/db/src/schema/heartbeat_runs.ts` | Run execution table | 🔴 | |
| `packages/db/src/schema/approvals.ts` | Approval table | 🔴 | |
| `packages/db/src/schema/cost_events.ts` | Cost tracking table | 🔴 | |
| `packages/db/src/schema/activity_log.ts` | Audit log table | 🔴 | |
| `packages/db/src/schema/qsl_findings.ts` | QSL findings table | 🔴 | **Custom fork addition**; migration 0071, 0072 |
| `packages/db/src/schema/heartbeat_run_watchdog_decisions.ts` | Watchdog decisions | 🟡 | |
| `packages/db/src/schema/issue_tree_holds.ts` | Issue tree hold state | 🟡 | |
| `packages/db/src/schema/environments.ts` | Execution environments | 🟡 | |
| `packages/db/src/schema/execution_workspaces.ts` | Workspace table | 🟡 | |
| `packages/db/src/schema/plugins.ts` | Plugin registry | 🟡 | |
| `packages/db/src/schema/routines.ts` | Scheduled routines | 🟡 | |
| `packages/db/src/schema/agent_api_keys.ts` | Agent auth keys | 🟡 | |
| `packages/db/src/schema/company_secrets.ts` | Secret metadata | 🟡 | |
| `packages/db/src/schema/company_secret_versions.ts` | Secret versions | 🟡 | |
| `packages/db/src/schema/documents.ts` | Issue documents | 🟡 | |
| `packages/db/src/schema/feedback_votes.ts` | Feedback voting | 🟢 | |
| `packages/db/src/schema/finance_events.ts` | Finance tracking | 🟢 | |

### G.2 Migrations (74 files in `packages/db/src/migrations/`)

| Migration | Description | Notes |
|---|---|---|
| `0000_mature_masked_marvel.sql` | Genesis migration | |
| `0029_plugin_tables.sql` | Plugin system schema | |
| `0054_draft_routines.sql` | Routines feature | |
| `0065_environments.sql` | Environment execution | |
| `0069_liveness_recovery_dedupe.sql` | Liveness hardening | |
| `0070_active_run_output_watchdog.sql` | Active run watchdog | |
| `0071_qsl_findings.sql` | QSL findings table | **Custom fork addition** |
| `0072_qsl_findings_review_states.sql` | QSL review states rename | **Custom fork addition** |
| `meta/` | Drizzle migration metadata | |

### G.3 Client & Utilities

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `packages/db/src/client.ts` | Drizzle client factory | 🔴 | |
| `packages/db/src/migrate.ts` | Migration runner | 🔴 | |
| `packages/db/src/embedded-postgres-error.ts` | PGlite error handling | 🟡 | |
| `packages/db/src/backup-lib.ts` | Backup utilities | 🟡 | |
| `packages/db/drizzle.config.ts` | Drizzle configuration | 🟡 | |

---

## H. Shared Types (`packages/shared/`)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `packages/shared/src/index.ts` | Shared exports | 🔴 | |
| `packages/shared/src/types/` | TypeScript type definitions | 🔴 | |
| `packages/shared/src/validators/` | Zod validators | 🔴 | |
| `packages/shared/src/constants.ts` | Shared constants | 🔴 | |
| `packages/shared/src/adapter-type.ts` | Adapter type definitions | 🟡 | |
| `packages/shared/src/api.ts` | API path constants | 🟡 | |
| `packages/shared/src/config-schema.ts` | Configuration schema | 🟡 | |
| `packages/shared/src/issue-references.ts` | Issue mention parsing | 🟢 | |
| `packages/shared/src/telemetry/` | Telemetry types | 🟢 | |

---

## I. Adapter Packages (`packages/adapters/`)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `packages/adapters/claude-local/` | Claude Code adapter | 🔴 | |
| `packages/adapters/codex-local/` | OpenAI Codex adapter | 🔴 | |
| `packages/adapters/cursor-local/` | Cursor adapter | 🔴 | |
| `packages/adapters/gemini-local/` | Google Gemini adapter | 🟡 | |
| `packages/adapters/opencode-local/` | OpenCode adapter | 🟡 | |
| `packages/adapters/pi-local/` | Pi adapter | 🟢 | |
| `packages/adapters/openclaw-gateway/` | OpenClaw HTTP adapter | 🔴 | |

**Note:** Hermes adapter is external-only in this fork (per `AGENTS.md`). No built-in `hermes_local` registration.

---

## J. Adapter Utilities (`packages/adapter-utils/`)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `packages/adapter-utils/src/index.ts` | Utility exports | 🟡 | |
| `packages/adapter-utils/src/execution-target.ts` | Target resolution | 🟡 | |
| `packages/adapter-utils/src/sandbox-managed-runtime.ts` | Sandbox runtime | 🟡 | |
| `packages/adapter-utils/src/server-utils.ts` | Server-side utilities | 🟡 | |
| `packages/adapter-utils/src/session-compaction.ts` | Session compaction | 🟢 | |

---

## K. Plugin System (`packages/plugins/`)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `packages/plugins/sdk/` | Plugin SDK | 🟡 | |
| `packages/plugins/create-paperclip-plugin/` | Plugin scaffolding | 🟢 | |
| `packages/plugins/sandbox-providers/` | Sandbox provider plugins | 🟡 | |
| `packages/plugins/examples/` | Example plugins | 🟢 | |

---

## L. MCP Server (`packages/mcp-server/`)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `packages/mcp-server/src/` | MCP server implementation | 🟡 | Model Context Protocol server |
| `packages/mcp-server/README.md` | MCP docs | 🟢 | |

---

## M. CLI (`cli/`)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `cli/src/index.ts` | CLI entry | 🟡 | |
| `cli/src/` | CLI commands (onboard, configure, worktree, etc.) | 🟡 | |
| `cli/package.json` | CLI package manifest | 🟢 | |

---

## N. Scripts (`scripts/`)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `scripts/dev-runner.ts` | Dev server runner | 🔴 | Watch mode, worktree support |
| `scripts/dev-service.ts` | Dev service manager | 🟡 | |
| `scripts/runtime_guardian.py` | Health monitor V1–V4 | 🔴 | **Custom fork addition** |
| `scripts/runtime_history.py` | Snapshot persistence | 🔴 | **Custom fork addition** |
| `scripts/runtime_remediator.py` | Corrective workflows | 🔴 | **Custom fork addition** |
| `scripts/runtime_rotation.py` | Log rotation | 🔴 | **Custom fork addition** |
| `scripts/runtime_export.py` | Export bundles | 🔴 | **Custom fork addition** |
| `scripts/runtime_topology_report.py` | Topology indexing | 🔴 | **Custom fork addition** |
| `scripts/governance_checkpoint.py` | Checkpoint recorder | 🔴 | **Custom fork addition** |
| `scripts/backup-db.sh` | DB backup script | 🟡 | |
| `scripts/release.sh` | Release orchestration | 🟡 | |
| `scripts/smoke/` | Smoke test scripts | 🟢 | OpenClaw join, Docker UI |

---

## O. Tests

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `tests/e2e/` | Playwright E2E tests | 🟡 | Browser automation |
| `tests/release-smoke/` | Release smoke tests | 🟡 | |
| `server/src/__tests__/` | Server unit tests | 🟡 | |
| `vitest.config.ts` | Test config (root) | 🟢 | |
| `ui/vitest.config.ts` | UI test config | 🟢 | |

---

## P. Operational Logs (`logs/`)

| Path | Purpose | Importance | Notes |
|---|---|---|---|
| `logs/runtime-guardian/` | Guardian JSON logs | 🔴 | **Custom fork addition** |
| `logs/runtime-history/` | Append-only snapshots | 🔴 | **Custom fork addition** |
| `logs/runtime-remediation/` | Plan lifecycle | 🔴 | **Custom fork addition** |
| `logs/governance-checkpoints/` | Checkpoint artifacts | 🔴 | **Custom fork addition** |
| `logs/exports/` | Continuity bundles | 🟡 | **Custom fork addition** |

---

*End of Evidence Index*
