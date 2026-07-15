# 01 — Repository Map

Evidence-based inventory of every major subsystem in the `mbennett-labs/paperclip` fork.  
**Confidence levels:** `High` = directly read source; `Medium` = inferred from file tree + docs; `Low` = structural assumption based on naming.

---

## 1. Server / REST API

**Purpose:** Express-based REST API serving board UIs, agent integrations, plugin host services, heartbeat orchestration, and all business logic.

**Primary directories:**
- `server/src/` — application source
- `server/src/routes/` — 38 Express route modules
- `server/src/services/` — 106 service modules
- `server/src/adapters/` — adapter registry and built-in adapters
- `server/src/auth/` — authentication strategies
- `server/src/middleware/` — Express middleware
- `server/src/recovery/` — crash recovery services
- `server/src/__tests__/` — unit tests

**Key files:**
- `server/src/index.ts` — bootstrap
- `server/src/app.ts` — Express app configuration
- `server/src/config.ts` — runtime configuration
- `server/src/routes/index.ts` — route mount point
- `server/src/routes/companies.ts`, `agents.ts`, `issues.ts`, `approvals.ts`, `costs.ts` — core CRUD
- `server/src/routes/qsl-bridge.ts` — **custom fork: QSL findings bridge**
- `server/src/services/heartbeat.ts` — core heartbeat orchestration (~2000+ lines)
- `server/src/services/qsl-review.ts` — **custom fork: QSL persistence**
- `server/src/services/recovery/service.ts` — crash/stranded work recovery
- `server/src/adapters/registry.ts` — adapter registration
- `server/src/adapters/plugin-loader.ts` — dynamic external adapter loading

**Dependencies:**
- `express` (web framework)
- `drizzle-orm` + `postgres` (ORM)
- `@paperclipai/db`, `@paperclipai/shared`, `@paperclipai/adapter-utils` (workspace packages)
- Various adapter packages (see section 5)

**Related documentation:**
- `doc/SPEC-implementation.md` (API contract, Sections 10–11)
- `doc/execution-semantics.md` (checkout, recovery, watchdog)
- `doc/DEVELOPING.md` (dev server setup)
- `governance_risks.md` (operational risks of this subsystem)
- `liveness_report.md` (heartbeat/recovery assessment)

**Confidence:** **High** — Read entry files, route directories, key services, and adapter registry.

---

## 2. UI / Board Frontend

**Purpose:** React + Vite + TailwindCSS single-page application for board operators to manage companies, agents, tasks, approvals, costs, and system settings.

**Primary directories:**
- `ui/src/` — application source
- `ui/src/pages/` — 64 page components
- `ui/src/components/` — 145 reusable components
- `ui/src/api/` — API client functions
- `ui/src/context/` — React context providers
- `ui/src/hooks/` — Custom React hooks
- `ui/src/lib/` — Utilities
- `ui/src/plugins/` — Plugin UI contributions
- `ui/storybook/` — Storybook configuration

**Key files:**
- `ui/src/main.tsx` — React entry
- `ui/src/App.tsx` — Root routing
- `ui/src/pages/Dashboard.tsx`, `DashboardLive.tsx` — Main dashboards
- `ui/src/pages/Agents.tsx`, `AgentDetail.tsx`, `OrgChart.tsx` — Agent management
- `ui/src/pages/Issues.tsx`, `IssueDetail.tsx` — Task management
- `ui/src/pages/QslReview.tsx` — **custom fork: QSL findings review UI**
- `ui/src/components/Layout.tsx`, `Sidebar.tsx`, `CompanySwitcher.tsx` — App shell
- `ui/src/components/IssueChatThread.tsx`, `CommentThread.tsx` — Communication surface
- `ui/src/components/transcript/` — Run transcript display
- `ui/src/api/qsl.ts` — **custom fork: QSL API client**

**Dependencies:**
- `react`, `react-dom`, `react-router-dom`
- `@tanstack/react-query` — Server state management
- `tailwindcss`, `@radix-ui/*`, `shadcn/ui` components
- `lucide-react` — Icons
- `vite` — Build tool

**Related documentation:**
- `doc/SPEC-implementation.md` (UI Requirements, Section 14)
- `doc/PRODUCT.md` (design goals, progressive disclosure)
- `AGENTS.md` (Section 9: UI Expectations)
- `AGENTS.md` Section 11 (Fork QoL patches: stderr_group, tool_group, Dashboard excerpt)

**Confidence:** **High** — Read page directories, key component files, and API client structure.

---

## 3. Database & Schema

**Purpose:** PostgreSQL data layer via Drizzle ORM with embedded PGlite fallback. Manages all persistent state including companies, agents, issues, runs, costs, approvals, activity logs, secrets, and custom fork tables.

**Primary directories:**
- `packages/db/src/schema/` — 75 table definition files
- `packages/db/src/migrations/` — 74 Drizzle migration SQL files
- `packages/db/src/` — Client, migration runner, backup utilities

**Key files:**
- `packages/db/src/schema/index.ts` — Schema exports
- `packages/db/src/schema/companies.ts`, `agents.ts`, `issues.ts` — Core entities
- `packages/db/src/schema/heartbeat_runs.ts` — Execution tracking
- `packages/db/src/schema/qsl_findings.ts` — **custom fork: QSL findings table**
- `packages/db/src/schema/approvals.ts`, `cost_events.ts`, `activity_log.ts` — Governance
- `packages/db/src/client.ts` — Drizzle client factory
- `packages/db/src/migrate.ts` — Migration runner
- `packages/db/src/backup-lib.ts` — Backup utilities
- `packages/db/drizzle.config.ts` — Drizzle configuration

**Dependencies:**
- `drizzle-orm` (ORM)
- `postgres` (PostgreSQL driver)
- `pglite` or `embedded-postgres` (embedded PostgreSQL for dev)

**Related documentation:**
- `doc/DATABASE.md` — Setup guide (embedded, Docker, Supabase)
- `doc/SPEC-implementation.md` (Sections 7–7.15: Canonical Data Model)
- `AGENTS.md` (Section 6: Database Change Workflow)

**Confidence:** **High** — Read schema directory listing, individual table files, and migration directory.

---

## 4. Shared Types, Constants & Validators

**Purpose:** Cross-package TypeScript contracts. Shared by `server/`, `ui/`, `cli/`, and adapters to prevent type drift.

**Primary directories:**
- `packages/shared/src/` — Source modules
- `packages/shared/src/types/` — Type definitions
- `packages/shared/src/validators/` — Zod schemas
- `packages/shared/src/telemetry/` — Telemetry types

**Key files:**
- `packages/shared/src/index.ts` — Main exports
- `packages/shared/src/constants.ts` — Shared constants (max concurrent runs, retry delays, etc.)
- `packages/shared/src/api.ts` — API path constants
- `packages/shared/src/adapter-type.ts` — Adapter type definitions
- `packages/shared/src/config-schema.ts` — Configuration schema
- `packages/shared/src/validators/` — Zod validators for API payloads

**Dependencies:**
- `zod` — Schema validation
- `typescript`

**Related documentation:**
- `AGENTS.md` (Section 2: Keep contracts synchronized)
- `doc/SPEC-implementation.md` (type references throughout)

**Confidence:** **Medium** — Read directory listing and key files; did not audit every validator.

---

## 5. Agent Adapters

**Purpose:** Abstract agent invocation. Each adapter implements a standard interface for invoking agents via process spawn (local CLIs) or HTTP request (external agents like OpenClaw).

**Primary directories:**
- `packages/adapters/` — One subdirectory per adapter
- `server/src/adapters/` — Registry, types, and built-in implementations

**Key adapters:**
- `packages/adapters/claude-local/` — Claude Code CLI adapter
- `packages/adapters/codex-local/` — OpenAI Codex CLI adapter
- `packages/adapters/cursor-local/` — Cursor adapter
- `packages/adapters/gemini-local/` — Google Gemini adapter
- `packages/adapters/opencode-local/` — OpenCode adapter
- `packages/adapters/openclaw-gateway/` — OpenClaw HTTP adapter
- `packages/adapters/pi-local/` — Pi adapter

**Key files:**
- `server/src/adapters/index.ts` — Registry and exports
- `server/src/adapters/registry.ts` — Built-in + plugin adapter registration
- `server/src/adapters/plugin-loader.ts` — Dynamic loading (zero hardcoded imports)
- `server/src/adapters/types.ts` — `AgentAdapter` interface
- `server/src/adapters/builtin-adapter-types.ts` — Enum of built-in types
- `server/src/adapters/process/` — Process adapter implementation
- `server/src/adapters/http/` — HTTP adapter implementation

**Dependencies:**
- `@paperclipai/shared`
- `@paperclipai/adapter-utils`
- Per-adapter: `child_process`, `node-fetch`, or provider SDKs

**Related documentation:**
- `doc/SPEC-implementation.md` (Section 11: Heartbeat and Adapter Contract)
- `AGENTS.md` (Section 11: Fork-specific Hermes externalization)
- `doc/OPENCLAW_ONBOARDING.md`
- `adapter-plugin.md` (root file)

**Confidence:** **High** — Read adapter directories, registry, types, and plugin-loader.

---

## 6. Adapter Utilities

**Purpose:** Shared runtime utilities used by multiple adapters: execution target resolution, sandbox management, billing utilities, session compaction, SSH helpers.

**Primary directory:** `packages/adapter-utils/src/`

**Key files:**
- `packages/adapter-utils/src/index.ts` — Exports
- `packages/adapter-utils/src/execution-target.ts` — Target resolution
- `packages/adapter-utils/src/sandbox-managed-runtime.ts` — Sandbox lifecycle
- `packages/adapter-utils/src/server-utils.ts` — Server-side helpers
- `packages/adapter-utils/src/session-compaction.ts` — Session rotation
- `packages/adapter-utils/src/billing.ts` — Cost normalization

**Dependencies:**
- `@paperclipai/shared`
- `ssh2` (for SSH runtime)

**Related documentation:**
- `doc/SPEC-implementation.md` (adapter contract)

**Confidence:** **Medium** — Read directory listing and key files.

---

## 7. Plugin System

**Purpose:** Out-of-process plugin host for extending Paperclip without forking. Supports capability-gated services, job scheduling, tool exposure, UI contributions, and external adapter loading.

**Primary directories:**
- `packages/plugins/sdk/` — Plugin SDK for authors
- `packages/plugins/create-paperclip-plugin/` — Scaffolding CLI
- `packages/plugins/sandbox-providers/` — Sandbox provider plugins
- `server/src/services/plugin-*.ts` — 15+ plugin host services

**Key files:**
- `server/src/services/plugin-loader.ts` — Plugin loading and initialization
- `server/src/services/plugin-worker-manager.ts` — Out-of-process worker orchestration
- `server/src/services/plugin-tool-registry.ts` — Tool registration
- `server/src/services/plugin-event-bus.ts` — Plugin event routing
- `server/src/services/plugin-host-services.ts` — Capability-gated host API
- `server/src/routes/plugins.ts` — Plugin HTTP routes
- `server/src/routes/plugin-ui-static.ts` — Plugin UI asset serving
- `ui/src/pages/PluginManager.tsx`, `PluginPage.tsx` — UI surfaces

**Dependencies:**
- `@paperclipai/plugins/sdk`
- `zod` (manifest validation)

**Related documentation:**
- `doc/plugins/PLUGIN_SPEC.md`
- `AGENTS.md` (Section 11: Plugin System)
- `ROADMAP.md` (✅ Plugin system milestone)

**Confidence:** **Medium** — Read plugin directories and service listing; did not audit full SDK implementation.

---

## 8. CLI (`cli/`)

**Purpose:** Command-line interface for setup, configuration, worktree management, database operations, and client-side control-plane commands.

**Primary directory:** `cli/src/`

**Key capabilities (from `doc/DEVELOPING.md` and `package.json`):**
- `paperclipai onboard` — First-time setup
- `paperclipai run` — One-command local run
- `paperclipai worktree init/make/repair/reseed` — Isolated dev instances
- `paperclipai configure` — Settings editor
- `paperclipai issue list/create/update` — Client CRUD
- `paperclipai db:backup` — Manual backup
- `paperclipai doctor` — Health checks

**Dependencies:**
- `tsx` — TypeScript execution
- Workspace packages for shared types

**Related documentation:**
- `doc/CLI.md` — Full command reference
- `doc/DEVELOPING.md` (Sections: Worktree CLI Reference, CLI Client Operations)

**Confidence:** **Medium** — Read directory listing and docs; did not audit CLI source in detail.

---

## 9. MCP Server (`packages/mcp-server/`)

**Purpose:** Model Context Protocol server exposing Paperclip entities to MCP clients.

**Primary directory:** `packages/mcp-server/src/`

**Key files:**
- `packages/mcp-server/src/index.ts` — Entry
- `packages/mcp-server/README.md` — Documentation

**Dependencies:**
- MCP SDK (not specified in audit)

**Related documentation:**
- `packages/mcp-server/README.md`

**Confidence:** **Low** — Only read directory listing and README. Source not audited.

---

## 10. Operational Tooling (`scripts/`) — Custom Fork Additions

**Purpose:** Python-based runtime health monitoring, log rotation, operational export, governance checkpointing, and topology indexing. These are **custom to this fork** and not present in upstream documentation.

**Primary directory:** `scripts/`

**Key files:**
- `scripts/runtime_guardian.py` — Health monitor V1–V4 (weighted 0-100 scoring across 6 dimensions)
- `scripts/runtime_history.py` — Append-only snapshot persistence
- `scripts/runtime_remediator.py` — Approval-aware corrective workflows
- `scripts/runtime_rotation.py` — Log rotation with gzip archiving
- `scripts/runtime_export.py` — Operational continuity export bundles with SHA-256 manifests
- `scripts/runtime_topology_report.py` — Disk state enumeration
- `scripts/governance_checkpoint.py` — Chain-linked institutional memory snapshots

**Output directories:**
- `logs/runtime-guardian/` — JSON health logs + escalation state
- `logs/runtime-history/` — Append-only JSONL snapshots
- `logs/runtime-remediation/` — Plan lifecycle directories
- `logs/governance-checkpoints/` — Checkpoint artifacts (JSON + markdown)
- `logs/exports/` — Continuity bundles

**Dependencies:**
- Python 3 (runtime scripts)
- `gzip`, `json`, `hashlib` (stdlib)

**Related documentation:**
- `docs/RUNTIME_OPERATIONS_V4.md` — Full operational spec
- `docs/GOVERNANCE_CHECKPOINT_MODEL.md` — Checkpoint structure
- `docs/RUNTIME_GUARDIAN_MODEL.md` — Health scoring
- `docs/RUNTIME_HISTORY_MODEL.md` — Snapshot persistence
- `docs/RUNTIME_REMEDIATION_MODEL.md` — Corrective workflows
- `governance_risks.md` — Active risks (GR-002 through GR-006)
- `liveness_report.md` — Gap assessment

**Confidence:** **High** — Read all Python script files and operational documentation.

---

## 11. Tests

**Purpose:** Automated verification across unit, integration, and browser suites.

**Primary directories:**
- `tests/e2e/` — Playwright end-to-end tests
- `tests/release-smoke/` — Release validation tests
- `server/src/__tests__/` — Server unit/integration tests
- `ui/src/**/*.test.tsx` — UI component tests (Vitest + React Testing Library)

**Key files:**
- `vitest.config.ts` (root) — Unit test config
- `tests/e2e/playwright.config.ts` — E2E config
- `tests/release-smoke/playwright.config.ts` — Smoke config

**Dependencies:**
- `vitest` — Unit tests
- `@playwright/test` — Browser tests
- `@testing-library/react` — React component tests

**Related documentation:**
- `doc/SPEC-implementation.md` (Section 17: Testing Strategy)
- `doc/DEVELOPING.md` (Test Commands section)
- `AGENTS.md` (Section 7: Verification Before Hand-off)

**Confidence:** **Medium** — Read directory listings; did not audit individual test files.

---

## 12. Dev Infrastructure

**Purpose:** Build, development, and release automation.

**Primary directories:**
- `scripts/` (dev-specific subset)
- `.github/workflows/` — CI/CD
- `docker/` — Container configs

**Key files:**
- `scripts/dev-runner.ts` — Dev server with watch mode and worktree support
- `scripts/dev-service.ts` — Dev process management
- `scripts/release.sh` — Release orchestration
- `scripts/build-npm.sh` — Package building
- `scripts/ensure-workspace-package-links.ts` — Workspace linking
- `.github/PULL_REQUEST_TEMPLATE.md` — PR template (Model Used section required)
- `docker/docker-compose.quickstart.yml` — Docker Compose setup

**Dependencies:**
- `pnpm` — Package manager and workspace runner
- `esbuild` — Build tool
- `tsx` — TypeScript execution
- GitHub Actions — CI

**Related documentation:**
- `doc/DEVELOPING.md`
- `AGENTS.md` (Section 10: Pull Request Requirements)
- `doc/DOCKER.md`
- `doc/RELEASE-AUTOMATION-SETUP.md`

**Confidence:** **Medium** — Read script listings and CI templates; did not audit full workflows.

---

*End of Repository Map*
