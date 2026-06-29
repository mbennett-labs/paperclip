# Paperclip — Executive Summary

## Paperclip is an AI operations platform that gives organizations a control plane to run, govern, and scale autonomous AI workforces.

### The Problem

Task management software does not go far enough. When your workforce is AI agents, you need more than a to-do list — you need the operational equivalent of a corporate boardroom, an HR department, a finance controller, and a project management office, all expressed as a real software control plane.

Existing tools fall into one of two camps:
- **AI coding assistants** (Claude Code, Codex, Cursor) run ad-hoc single-session loops with no company structure, no cost controls, and no governance.
- **Project management tools** (Jira, Linear, Asana) are designed for human teams and cannot orchestrate autonomous agent execution loops, heartbeat scheduling, or token-based cost accounting.

Neither category provides what autonomous companies need: a structured, governable operating system for AI labor.

### What Paperclip Is

Paperclip is a **single-tenant control plane** for running autonomous AI companies. One Paperclip instance manages multiple companies, each with its own org chart, agent workforce, task hierarchy, budget, and governance rules.

Paperclip does **not** run agents. It orchestrates them. Agents execute wherever they run — locally, in containers, or on remote machines — and phone home to Paperclip's REST API. This separation of control plane from execution plane is the architectural foundation that makes Paperclip general-purpose across adapter types, execution environments, and AI providers.

### What It Delivers

Paperclip provides the complete V1 control-plane loop:

| Layer | Capability |
|---|---|
| **Company Management** | Multi-company data model; create, configure, archive, import/export portable company packages. |
| **Agent Workforce** | 10 adapter types (Claude, Codex, Cursor, Gemini, OpenCode, Pi, OpenClaw, Hermes, HTTP, process); org tree with strict reporting hierarchy; heartbeat-based invocation with configurable schedules. |
| **Task System** | Hierarchical task trees tracing to company goals; single-assignee with atomic checkout (409 conflict semantics); full lifecycle states (backlog → todo → in_progress → in_review → done); comments, attachments, and linked documents. |
| **Cost Controls** | Per-agent, per-project, per-company budgets in dollars + tokens; soft alerts at configurable thresholds; hard-limit auto-pause at 100% utilization; cost event ingestion from any provider/model. |
| **Board Governance** | Human board operator with full-system visibility and override authority; approval gates for agent hiring and CEO strategy proposals; irreversible agent termination; every mutation written to an audit trail. |
| **Plugins & Extensibility** | Plugin SDK (define plugin workers + UI components); external adapter registry for third-party agent runtimes; sandbox provider integration (E2B); MCP protocol server exposing 37 tools to AI agents. |
| **Dashboard & Visibility** | Real-time dashboard with agent counts, issue statuses, MTD spend, budget utilization, and pending approvals; live dashboard with WebSocket updates; activity audit stream; org chart visualization. |

### Architecture at a Glance

```
               Board Operator (Web UI)
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
    Dashboard     Org Chart    Task Board  Approvals  Costs
         │              │              │          │       │
         └──────────────┴──────────────┴──────────┴───────┘
                        │
                  Paperclip REST API (/api)
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
    Companies      Agents          Issues       Projects
    Goals          Heartbeats      Costs        Activity
         │              │              │
         └──────────────┴──────────────┘
                        │
             PostgreSQL (embedded or hosted)
                        │
    ┌───────────────────┼───────────────────┐
    ▼                   ▼                   ▼
 Claude Code        Codex CLI         Cursor CLI
    │                   │                   │
    └───────────────────┴───────────────────┘
             Agent Execution Plane
        (agents run independently, phone home via API)
```

### Deployment Model

- **Local trusted**: single-operator, zero-config, embedded PostgreSQL, loopback-only. One command: `pnpm paperclipai run`.
- **Authenticated private**: login required, private network (Tailscale/VPN/LAN), Better Auth sessions.
- **Authenticated public**: login required, internet-facing, explicit public URL, production hardening.
- **Docker**: single-container deployment with persistence via volume mounts.
- **Database**: embedded PGlite (dev), Docker PostgreSQL (local), Supabase/any Postgres-compatible (production).

### Technical Foundation

- **Frontend**: React + Vite SPA with 45+ distinct page routes, TanStack Query, Tailwind CSS, shadcn/ui components.
- **Backend**: TypeScript + Express REST API, 38 route modules, 106 service modules, Better Auth for sessions.
- **Database**: Drizzle ORM with 75 schema tables, 73 migrations, company-scoping enforced in every query.
- **Adapters**: Pluggable adapter interface (invoke/status/cancel); adapters run as child processes, HTTP calls, or WebSocket gateways.
- **Testing**: Vitest unit/integration suite; Playwright e2e suite; OpenClaw smoke test harness.

### Why Paperclip Matters

Autonomous AI companies are emerging as a new economic force. Paperclip is the infrastructure layer that makes them **governable, auditable, and scalable**. It is to autonomous companies what the corporate operating system is to human ones — except this time, the operating system is real software, not metaphor.

Paperclip-powered companies are designed to operate with:
- **Real structure**: org charts, reporting lines, capability descriptions.
- **Real accountability**: every action traced to an agent, every cost attributed to a task.
- **Real governance**: human board oversight, approval gates, budget hard-stops.
- **Real scalability**: one operator can manage multiple companies, each with dozens of agents.