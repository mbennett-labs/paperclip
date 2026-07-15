# SYSTEM_MENTAL_MODEL.md

A high-level conceptual model of how Paperclip operates, synthesized exclusively from Sprint 1 evidence.  
**Audience:** A senior engineer joining the project.  
**Constraint:** Read-only. No redesign. No recommendations.

---

## 1. What Problem Is Paperclip Solving?

Paperclip is the **control plane for autonomous AI companies**.

When a human's entire workforce is AI agents (Claude Code, Codex, OpenClaw, custom scripts), ordinary task managers fail. A human operator needs:

- **Org structure** — who reports to whom
- **Work assignment** — atomic checkout so two agents never do the same task
- **Cost control** — budgets per agent, automatic hard-stop when limits hit
- **Governance** — board approval for hires, strategy, and high-stakes decisions
- **Audit trail** — every mutation logged with actor attribution
- **Recovery** — when agents crash or go silent, the system surfaces the problem

Paperclip does not run agents. It **orchestrates** them. Agents live wherever they live and phone home. Paperclip decides when they wake, what context they receive, and whether they are allowed to spend more money.

*Sources:* `doc/GOAL.md`, `doc/PRODUCT.md`, `README.md`, `doc/SPEC-implementation.md`

---

## 2. What Are the Primary Entities?

| Entity | What It Is | Source Evidence |
|---|---|---|
| **Company** | The root isolation boundary. Every business record belongs to exactly one company. One Paperclip deployment hosts many companies. | `doc/SPEC-implementation.md` §7.1 |
| **Agent** | An AI employee. Has a name, role, title, reporting line (`reports_to`), adapter configuration, monthly budget, and status (`active`/`paused`/`terminated`). | `doc/SPEC-implementation.md` §7.2, `doc/PRODUCT.md` |
| **Goal** | Hierarchical objective (`company` → `team` → `agent` → `task`). Every task must trace back to a company goal. | `doc/SPEC-implementation.md` §7.4, `doc/PRODUCT.md` |
| **Project** | A container for related work. Linked to a goal. Has environments and workspaces. | `doc/SPEC-implementation.md` §7.5 |
| **Issue** | The universal work unit. Serves as task, blocker, recovery work, watchdog evaluation, and approval container all in one. Has status (`backlog` → `todo` → `in_progress` → `done`), single assignee, priority, and parent/child hierarchy. | `doc/SPEC-implementation.md` §7.6, `doc/execution-semantics.md` |
| **Comment** | A message on an issue. The only communication primitive in V1. No separate chat system. | `doc/SPEC-implementation.md` §7.7 |
| **Document** | Editable markdown document attached to an issue with revision history. | `doc/SPEC-implementation.md` §7.15, schema `documents.ts` |
| **Attachment** | File upload linked to an issue/comment. Stored via provider-backed object storage. | `doc/SPEC-implementation.md` §7.14, schema `assets.ts` |
| **Heartbeat Run** | A single invocation of an agent. Tracks `queued` → `running` → `succeeded`/`failed`/`cancelled`. Contains logs, cost, session state, and workspace context. | `doc/SPEC-implementation.md` §7.8, `server/src/services/heartbeat.ts` |
| **Approval** | A governance request (`hire_agent`, `approve_ceo_strategy`). Board must approve or reject. | `doc/SPEC-implementation.md` §7.10 |
| **Cost Event** | A token/cost report from an agent. Aggregated into budgets. | `doc/SPEC-implementation.md` §7.9 |
| **Budget Policy** | Monthly spending cap and threshold alerts. Hard limit auto-pauses the agent. | `doc/SPEC-implementation.md` §13, schema `budget_policies.ts` |
| **Activity Log** | Immutable audit record of every mutation. Actor type, entity, action, and details. | `doc/SPEC-implementation.md` §7.11 |
| **Routine** | Scheduled recurring work (cron/API/webhook). Each execution creates an issue and wakes an agent. | `ROADMAP.md` ✅ milestone, `server/src/services/routines.ts`, schema `routines.ts` |
| **Workspace** | Execution directory context. Can be project-primary, task-session, git-worktree, or agent-home. | `doc/execution-semantics.md`, `server/src/services/workspace-runtime.ts`, schema `execution_workspaces.ts` |
| **Environment** | Execution target (local process, SSH, sandbox, managed runtime). Resolved at wakeup time. | `server/src/services/environments.ts`, schema `environments.ts` |
| **Plugin** | Out-of-process extension with capability-gated host services, job scheduling, and UI contributions. | `doc/plugins/PLUGIN_SPEC.md`, `AGENTS.md` §11, `server/src/services/plugin-*.ts` |
| **Adapter** | Bridge between Paperclip and an agent runtime. Minimum contract: `invoke()`, `status()`, `cancel()`. | `doc/SPEC-implementation.md` §11, `server/src/adapters/types.ts` |
| **Secret** | Encrypted company-level value. Referenced by name in agent config; resolved at runtime. | `doc/DATABASE.md`, schema `company_secrets.ts` |
| **QSL Finding** | *(Custom fork)* Security/quality scan result requiring board review. Persistent review state in DB. | `packages/db/src/schema/qsl_findings.ts`, `server/src/services/qsl-review.ts` |
| **Governance Checkpoint** | *(Custom fork)* Chain-linked institutional memory snapshot with integrity hash. | `docs/GOVERNANCE_CHECKPOINT_MODEL.md`, `scripts/governance_checkpoint.py` |

---

## 3. How Does Work Move Through the System?

### Normal Lifecycle

**Step 1 — Board Creates a Company**
- Human defines company name, goal, brand color.
- System creates the company and one root `company`-level goal.

**Step 2 — Board Hires the CEO Agent**
- Human creates an agent with adapter type (e.g., `claude_local`, `http`), role (`CEO`), and adapter config (command, env, schedule).
- If governance requires, agent creation flows through an `approval(type=hire_agent)`.
- System generates a one-time API key for the agent.

**Step 3 — CEO Proposes Strategy**
- CEO agent receives a heartbeat with `context_mode: fat` or `thin`.
- CEO creates sub-goals, projects, and child issues.
- Before executing, CEO may need `approval(type=approve_ceo_strategy)`.

**Step 4 — Work Is Assigned**
- Issues are created with `status: todo`, linked to a goal and optionally a project.
- Each issue has a single `assignee_agent_id`.
- Agents can create sub-issues for delegation; `request_depth` increments to prevent infinite loops.

**Step 5 — Heartbeat Wakes the Agent**
- Scheduler checks every 30 seconds (`heartbeat.ts`).
- If agent is `active`, not paused, under budget, and no run is active → queue a heartbeat run.
- Adapter `invoke()` spawns a process or fires an HTTP request.
- Workspace is resolved (git clone if needed, worktree created, secrets injected).

**Step 6 — Agent Checks Out and Works**
- Agent calls `POST /issues/:id/checkout` with atomic SQL:
  ```sql
  UPDATE issues SET status='in_progress', assignee_agent_id=?
  WHERE id=? AND status IN ('todo','backlog','blocked') 
    AND (assignee_agent_id IS NULL OR assignee_agent_id=?)
  ```
- If 0 rows updated → `409 Conflict` (someone else got it).
- Agent writes comments, creates sub-issues, reports cost events.

**Step 7 — Run Completes or Fails**
- Adapter reports `succeeded`, `failed`, `cancelled`, or `timed_out`.
- Cost events are ingested and rolled up against agent/project/company budgets.
- If budget hard limit hit → agent auto-paused, runs cancelled.
- Run result summarized and posted as issue comment.

**Step 8 — Recovery If Stalled**
- On startup, recovery service reconciles:
  1. Reap orphaned `running` runs
  2. Resume persisted `queued` runs
  3. Reconcile stranded assigned work (`todo` or `in_progress` with no wake path)
  4. Scan silent active runs and create watchdog review issues
- Auto-recovery queues ONE retry. If that fails too, issue moved to `blocked` with visible comment.

**Step 9 — Board Reviews**
- Dashboard shows agent counts, issue status breakdown, budget utilization, pending approvals.
- Human approves/rejects hires, strategies, and escalations.
- Every click writes to `activity_log`.

*Sources:* `doc/SPEC-implementation.md`, `doc/execution-semantics.md`, `server/src/services/heartbeat.ts`, `server/src/services/recovery/`

---

## 4. How Do Humans Interact?

**Primary Surface: Board Web UI**
- React + Vite SPA served on same origin as API (in dev) or static build.
- Routes: Dashboard, Org Chart, Issues (kanban/list), Agents, Approvals, Costs, Activity, Company/Routine/Settings.
- Global company selector; all pages are company-scoped.
- Quick actions: pause/resume agent, create task, approve/reject.

**Secondary Surface: CLI**
- `paperclipai onboard` → one-command setup
- `paperclipai run` → start server
- `paperclipai worktree init` → isolated dev instance
- `paperclipai issue list/create/update` → client CRUD

**Auth Modes:**
- `local_trusted` — single implicit board operator, no login (default for local)
- `authenticated` — session-based auth, supports multi-human users

**Governance Touchpoints:**
- Approve/reject pending approvals
- Pause/terminate agents
- Set budgets
- Force-release stuck issue checkouts (`POST /issues/:id/admin/force-release`)
- Review QSL findings (custom fork)
- Create governance checkpoints (custom fork)

*Sources:* `doc/SPEC-implementation.md` §9, §14, `doc/DEVELOPING.md`, `doc/DEPLOYMENT-MODES.md`, `ui/src/pages/`

---

## 5. How Do Agents Interact?

**Authentication:** Bearer API key (`agent_api_keys`), hashed at rest. Each key maps to exactly one agent in exactly one company. Agent keys cannot access other companies.

**API Contract:**
- Read org/task/company context for own company
- Read/write own assigned issues and comments
- Create issues/comments for delegation
- Report heartbeat status and cost events
- **Cannot:** bypass approval gates, modify company budgets, mutate auth/keys

**Execution Model:**
- Agent receives heartbeat via adapter-specific channel:
  - **Process adapter:** Paperclip spawns child process; streams stdout/stderr; tracks exit code.
  - **HTTP adapter:** Paperclip POSTs to agent URL; agent calls back to mark complete.
- Context delivery modes:
  - `thin` — IDs and pointers only; agent fetches full context via API
  - `fat` — summary, assignments, budget snapshot, recent comments embedded in payload
- Session persistence: adapters maintain session IDs across heartbeats so agents resume context.

**Feedback Loop:**
- Agent reports costs → budget service checks thresholds.
- Agent creates issues → approval workflow may gate execution.
- Agent goes silent → liveness detection → recovery wake or explicit review issue.

*Sources:* `doc/SPEC-implementation.md` §9.2, §9.3, §11, `AGENTS.md` §8

---

## 6. Where Is State Stored?

| Layer | Technology | What Lives There |
|---|---|---|
| **Primary Database** | PostgreSQL (embedded PGlite in dev, Docker/Supabase in prod) | All business entities: companies, agents, goals, issues, comments, approvals, costs, activity logs, secrets, heartbeat runs, documents, QSL findings, plugins, routines, workspaces, environments |
| **Schema Management** | Drizzle ORM + SQL migrations | 74 migration files in `packages/db/src/migrations/`. Schema source of truth in `packages/db/src/schema/` (75 table files) |
| **File/Object Storage** | `local_disk` (dev) or S3-compatible (prod) | Attachments, work products, logo images. Metadata in `assets` table; bytes in storage provider |
| **Local Secrets** | `local_encrypted` provider | AES-encrypted with master key at `~/.paperclip/instances/default/secrets/master.key` |
| **Run Logs** | SQLite (per-run) or provider storage | Full stdout/stderr transcripts, bounded compaction |
| **Operational State** *(Custom fork)* | Append-only JSON/JSONL files in `logs/` | Guardian health reports, history snapshots, remediation plans, governance checkpoints, export bundles |
| **Config** | JSON files (`config.json`) + env vars | Instance settings, adapter plugin registry (`~/.paperclip/adapter-plugins.json`), worktree metadata |

**Critical Invariant:** Every business record is company-scoped. No cross-company queries without explicit authorization checks.

*Sources:* `doc/DATABASE.md`, `doc/SPEC-implementation.md` §6.2, `packages/db/src/`, `AGENTS.md` §6

---

## 7. What Parts Appear Designed to Be Extended?

**Adapter System**
- New agent runtimes plug in by implementing `AgentAdapter` interface (`invoke`, `status`, `cancel`).
- External adapters load dynamically via `plugin-loader.ts` with zero hardcoded imports.
- Adapter provides its own `config-schema` + `ui-parser.js` for board UI rendering.
- Examples: Hermes (external plugin only in this fork), Droid (npm plugin).

**Plugin System**
- Out-of-process workers with capability-gated host services.
- Plugins contribute: UI routes/components, HTTP endpoints, background jobs, tools, database namespaces.
- Host manages worker lifecycle, event bus, job scheduling, and sandbox.

**Execution Environments**
- Environment abstraction supports: local process, SSH remote, Docker sandbox, managed cloud sandbox.
- New drivers added without changing heartbeat core.

**Worktree/Dev Instances**
- Isolated git worktrees with seeded databases enable parallel development.
- Provision commands are project-defined; each repo bootstraps itself.

**Routines**
- Cron, webhook, or API-triggered recurring tasks.
- Each execution creates an issue — routine itself is declarative, work is standard issue lifecycle.

*Sources:* `doc/SPEC-implementation.md` §11, `AGENTS.md` §11, `doc/plugins/PLUGIN_SPEC.md`, `server/src/adapters/plugin-loader.ts`, `server/src/services/plugin-*.ts`

---

## 8. Foundational vs Optional Concepts

### Foundational (V1 Core — the system collapses without these)

- **Company** — root isolation boundary
- **Agent** — the employee
- **Issue** — the work unit
- **Comment** — the communication primitive
- **Heartbeat Run** — the execution atom
- **Cost Event / Budget** — the economic constraint
- **Approval** — the governance gate
- **Activity Log** — the audit trail

These are all listed in `doc/SPEC-implementation.md` §5.1 "In Scope" and §7 "Canonical Data Model". They exist in the earliest migrations (0000–0010).

### Optional / Plugin-Edge (system operates without, but is richer with)

- **Plugin system** — explicitly deferred post-V1 in `SPEC-implementation.md` §5.2
- **Knowledge / Memory** — deferred post-V1
- **Marketplace (ClipHub)** — deferred post-V1
- **CEO Chat / Conference Room** — roadmap item, not in V1 spec
- **Artifacts & Work Products** — roadmap item, partially present as `issue_work_products`
- **QSL subsystem** — **custom fork addition**, not in upstream V1 spec
- **Runtime Guardian / Checkpoints** — **custom fork addition**, external Python tooling
- **Governance Risk Register** — **custom fork addition**, operational process artifact

*Sources:* `doc/SPEC-implementation.md` §5.1–5.2, `ROADMAP.md`, `architecture_changelog.md`

---

## 9. What Architectural Principles Repeatedly Appear?

### 1. Company Is the Castle
Every entity belongs to exactly one company. Every query filters by `company_id`. Agent keys cannot cross company boundaries. This is the single most repeated invariant in the codebase.

*Evidence:* `doc/SPEC-implementation.md` §7.1 invariant, `AGENTS.md` §5 Rule 1, authz middleware.

### 2. Control Plane, Not Execution Plane
Paperclip never runs agent code. It schedules heartbeats, resolves workspaces, injects secrets, and tracks outcomes. The agent runtime is external.

*Evidence:* `doc/GOAL.md` §2.2, `doc/PRODUCT.md` §6 Core Principle 5, `doc/SPEC-implementation.md` §11.

### 3. Atomic Operations or Explicit Failure
Task checkout uses single SQL `UPDATE ... WHERE` with status filter. Budget checks are atomic. Approvals are transactional. If another actor won the race, the system returns `409 Conflict` with current state — never silent overwrite.

*Evidence:* `doc/SPEC-implementation.md` §10.4.1, §13.2 (budget hard-stop), `server/src/services/heartbeat.ts`.

### 4. Every Mutation Is Auditable
The `activity_log` table captures actor type, actor ID, action, entity type, entity ID, and JSON details for every mutating request. This is not an afterthought; it is a hard requirement.

*Evidence:* `doc/SPEC-implementation.md` §7.11, §9.1, §15.3, `AGENTS.md` §5 Rule 3.

### 5. Thin Core, Rich Edges
The V1 spec explicitly defers plugins, knowledge, marketplace, and fine-grained RBAC. The philosophy is to keep the control plane minimal and let plugins handle optional capabilities.

*Evidence:* `doc/PRODUCT.md` §8 "Thin core, rich edges", `doc/SPEC-implementation.md` §5.2, `ROADMAP.md` plugin milestone.

### 6. Human Review Decisions Are Durable
*(Custom fork principle, potentially upstream-worthy)*
In the QSL subsystem, bridge sync must never overwrite a human's approve/deny decision. Fingerprint-based upsert preserves review state while updating occurrence counts.

*Evidence:* `architecture_changelog.md` §2026-05-12, `server/src/services/qsl-review.ts`, `governance_risks.md` GR-001.

### 7. Operational State Is Institutional Memory
*(Custom fork principle)*
The runtime guardian, checkpoint recorder, and history persistence treat operational health data as append-only, hash-verified, exportable institutional memory — not disposable logs.

*Evidence:* `docs/RUNTIME_OPERATIONS_V4.md` §Operational Continuity Philosophy, `docs/GOVERNANCE_CHECKPOINT_MODEL.md` §Auditability Guarantees.

---

## 10. If Someone Removed Every Implementation Detail and Kept Only the Concepts, What Would Remain?

A **company-centric control plane** with these concepts:

1. **Organization** — A company has goals, projects, and an org chart of agents.
2. **Work** — Issues carry the only communication model (comments). Every issue traces to a goal. Single assignee. Atomic checkout.
3. **Execution** — Agents wake on heartbeat. The control plane decides when, where, and with what context. Agents decide what to do.
4. **Economics** — Costs roll up. Budgets hard-stop. No hidden spend.
5. **Governance** — Board approves hires and strategy. Nothing ships without sign-off. Every action leaves a durable record.
6. **Recovery** — When execution breaks, the system retries once, then surfaces the problem visibly. It does not silently reassign or hide failures.
7. **Isolation** — One deployment, many companies. Complete data separation.
8. **Extensibility** — Adapters connect any runtime. Plugins add any capability. The core stays thin.

Remove PostgreSQL, remove Express, remove React, remove Python scripts — and these 8 concepts still describe what Paperclip *is*.

---

## Five Things That Were NOT Obvious Before Sprint 1

### 1. The Fork Runs an Entire Parallel Governance Layer in Python
The Node.js application handles the control plane, but this fork has 6 Python scripts (`runtime_guardian.py`, `runtime_history.py`, `runtime_remediator.py`, `runtime_rotation.py`, `runtime_export.py`, `governance_checkpoint.py`) and 4 operational log directories that form a completely separate institutional-memory system. This is not mentioned in any upstream-facing doc (`README.md`, `SPEC-implementation.md`, `PRODUCT.md`). It is entirely a fork addition.

*Evidence:* `scripts/runtime_*.py`, `docs/RUNTIME_OPERATIONS_V4.md`, `logs/`, `architecture_changelog.md`.

### 2. "Issues" Are Not Just Tasks — They Are the Universal Work Primitive
An issue can be: a task, a blocker dependency, a recovery work item, a watchdog evaluation, an approval container, a routine execution result, and a QSL finding review task. The same `issues` table and status machine serves all these purposes. Before this audit, one might assume separate tables for "tasks," "blockers," and "incidents." They are all issues.

*Evidence:* `doc/execution-semantics.md` §6, §8, §10, `server/src/services/recovery/service.ts`, `server/src/services/qsl-review.ts`.

### 3. Heartbeats Are Not Simple Pings — They Are Full Execution Contracts
A heartbeat involves: workspace resolution (git clone, worktree creation), environment lease acquisition, secret resolution and injection, skill loading, adapter config merging, session compaction decisions, bounded transient retry scheduling, run log streaming with base64 redaction, cost event ingestion, and atomic issue checkout. A "heartbeat" is closer to a full CI pipeline invocation than a cron job.

*Evidence:* `server/src/services/heartbeat.ts` (~2000+ lines), `doc/execution-semantics.md` §5, §7, `server/src/services/workspace-runtime.ts`.

### 4. The Core Has Zero Knowledge of Hermes
Despite Hermes being a primary adapter in upstream Paperclip discourse, this fork's core (`server/`, `ui/`) contains no Hermes imports, types, or hardcoded handling. Hermes loads entirely through the external plugin system via generic config-schema + ui-parser.js. The core treats it identically to Droid or any other external adapter.

*Evidence:* `AGENTS.md` §11, absence of `packages/adapters/hermes-local/`, `server/src/adapters/plugin-loader.ts` zero-import design.

### 5. Liveness Recovery Is Intentionally Conservative — by Design
The system could auto-reassign stuck work to other agents. It does not. The recovery model preserves ownership, retries exactly once for execution continuity loss, then creates an explicit recovery issue or escalates to the board. This is not a missing feature; it is an explicit product decision to avoid agent confusion and preserve accountability.

*Evidence:* `doc/execution-semantics.md` §11, §12, `liveness_report.md`, `governance_risks.md` GR-002, `server/src/services/recovery/run-liveness-continuations.ts` (max 2 attempts).

---

*End of System Mental Model*
