# Paperclip — Architecture Diagram

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           BOARD OPERATOR (HUMAN)                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │Dashboard │  │Org Chart │  │Task Board│  │Approvals │  │  Costs   │          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│       └──────────────┴────────────┴────────────┴────────────┘                   │
│                                       │                                          │
│                          React + Vite SPA (ui/)                                  │
│                          TanStack Query · Tailwind · shadcn/ui                  │
└───────────────────────────────────────┬─────────────────────────────────────────┘
                                        │
                          Better Auth Sessions / API Keys
                                        │
┌───────────────────────────────────────┴─────────────────────────────────────────┐
│                          PAPERCLIP REST API (/api)                               │
│                         Express · TypeScript · Zod                               │
│                                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │  Companies   │  │    Agents    │  │    Issues    │  │   Projects   │        │
│  │  GET/POST/   │  │  CRUD·Hire·  │  │  Full CRUD·  │  │  CRUD·       │        │
│  │  PATCH·      │  │  Wake·Keys·  │  │  Checkout·   │  │  Workspaces· │        │
│  │  Archive·    │  │  Config·     │  │  Comments·   │  │  Runtime     │        │
│  │  Export      │  │  Org Chart   │  │  Documents   │  │  Services    │        │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘        │
│         │                 │                 │                 │                  │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐        │
│  │    Goals     │  │  Heartbeats  │  │   Approvals  │  │    Costs     │        │
│  │  Hierarchy·  │  │  Invoke·     │  │  Hire·       │  │  Events·     │        │
│  │  Company→    │  │  Status·     │  │  Strategy·   │  │  Summary·    │        │
│  │  Team→Task   │  │  Cancel·     │  │  Approve·    │  │  Budget·     │        │
│  │              │  │  Scheduler   │  │  Reject      │  │  Quota       │        │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘        │
│         │                 │                 │                 │                  │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐        │
│  │   Activity   │  │   Secrets    │  │   Routines   │  │   Plugins    │        │
│  │  Audit Log·  │  │  CRUD·       │  │  Scheduled·  │  │  List·       │        │
│  │  All Mutations│  │  Rotation·   │  │  Cron·       │  │  Install·    │        │
│  │              │  │  Encryption  │  │  Triggers    │  │  Enable·     │        │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘        │
│         │                 │                 │                 │                  │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐        │
│  │   Access     │  │  Dashboard   │  │   Assets     │  │Environments  │        │
│  │  Members·    │  │  Agent/Iissue│  │  Upload·     │  │  CRUD·       │        │
│  │  Invites·    │  │  Cost Counts │  │  Serve·      │  │  Probe·      │        │
│  │  Permissions │  │  Pending     │  │  Attach      │  │  Drivers     │        │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘        │
│         │                 │                 │                 │                  │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐        │
│  │  MCP Server  │  │QSL Review   │  │   LLM Config │  │  Board       │        │
│  │  37 Tools    │  │  Bridge      │  │  Reflection  │  │  Export      │        │
│  │  for Agents  │  │              │  │  for Agents  │  │              │        │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘        │
└───────────────────────────────────────┬─────────────────────────────────────────┘
                                        │
                              106 Service Modules
                                        │
                          ┌─────────────┴─────────────┐
                          ▼                           ▼
              ┌───────────────────┐       ┌───────────────────┐
              │   Drizzle ORM     │       │  Plugin Workers   │
              │   75 Schema Tables│       │  (Sandboxed Node)  │
              │   73 Migrations   │       │  JSON-RPC Bridge   │
              └────────┬──────────┘       └────────┬──────────┘
                       │                           │
              ┌────────┴──────────┐       ┌────────┴──────────┐
              │    PostgreSQL     │       │ Plugin DB Namespace│
              │  · Embedded (Dev) │       │ (Per-Plugin SQLite)│
              │  · Docker Local   │       └───────────────────┘
              │  · Supabase/Cloud │
              │  · Secret Storage │
              │  · Asset Metadata │
              └───────────────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ Local Disk  │ │    S3       │ │  Encrypted  │
│  Storage    │ │  (Cloud)    │ │  Secrets    │
└─────────────┘ └─────────────┘ └─────────────┘
```

## Agent Adapter Layer

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        AGENT ADAPTER REGISTRY                                     │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                       BUILT-IN ADAPTERS (8)                               │   │
│  │                                                                           │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │   │
│  │  │  Claude  │ │  Codex   │ │  Cursor  │ │  Gemini  │ │ OpenCode │       │   │
│  │  │  Local   │ │  Local   │ │  Local   │ │  Local   │ │  Local   │       │   │
│  │  │  --print │ │  stdin   │ │ agent -p │ │positional│ │opencode  │       │   │
│  │  │  stream  │ │  --search│ │  --resume│ │  skills/ │ │--format  │       │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘       │   │
│  │                                                                           │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐                                  │   │
│  │  │   Pi     │ │ OpenClaw │ │  HTTP    │  ┌──────────┐                    │   │
│  │  │  Local   │ │ Gateway  │ │ Adapter  │  │ Process  │                    │   │
│  │  │pi run    │ │WebSocket │ │POST URL │  │ shell    │                    │   │
│  │  │--provider│ │pair/auth │ │template │  │command   │                    │   │
│  │  └──────────┘ └──────────┘ └──────────┘  └──────────┘                    │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                     EXTERNAL PLUGIN ADAPTERS                              │   │
│  │                                                                           │   │
│  │  ┌──────────┐ ┌──────────────────────────────────────────────────────┐   │   │
│  │  │  Hermes  │ │  Third-Party Adapters (via plugin system)             │   │   │
│  │  │  Local   │ │  · npm: droid-paperclip-adapter                      │   │   │
│  │  │(external │ │  · file: ./my-adapter                                │   │   │
│  │  │ npm pkg) │ │  · Registered in ~/.paperclip/adapter-plugins.json   │   │   │
│  │  └──────────┘ └──────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                   ADAPTER INTERFACE CONTRACT                              │   │
│  │                                                                           │   │
│  │  invoke(agent, context) → InvokeResult    // Start agent's cycle          │   │
│  │  status(run) → RunStatus                  // Check if running/finished    │   │
│  │  cancel(run) → void                       // Graceful stop (SIGTERM)      │   │
│  │                                                                           │   │
│  │  Optional extensions:                                                     │   │
│  │  detectModel(config) → ModelInfo          // Model auto-detection         │   │
│  │  listSkills(agent) → Skill[]              // Skill inventory              │   │
│  │  syncSkills(agent) → void                 // Skill synchronization        │   │
│  │  sessionCodec → {encode, decode}          // Session state serialization   │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Data Model (V1 Core Tables)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           COMPANY-SCOPED DATA MODEL                              │
│                                                                                  │
│  companies ─────────────────────────────────────────────────────────────────────│
│  │  id, name, description, status (active|paused|archived)                      │
│  │                                                                               │
│  ├── agents ────────────────────────────────────────────────────────────────────│
│  │   id, company_id, name, role, title, status, reports_to,                     │
│  │   capabilities, adapter_type, adapter_config, context_mode,                  │
│  │   budget_monthly_cents, spent_monthly_cents, last_heartbeat_at               │
│  │   │                                                                           │
│  │   ├── agent_api_keys (hashed at rest, one-time display)                       │
│  │   │                                                                           │
│  │   ├── heartbeat_runs                                                          │
│  │   │   id, agent_id, invocation_source, status, started_at,                   │
│  │   │   finished_at, error, context_snapshot                                   │
│  │   │                                                                           │
│  │   └── agent_config_revisions (revision history)                               │
│  │                                                                               │
│  ├── goals ─────────────────────────────────────────────────────────────────────│
│  │   id, company_id, title, description, level (company|team|agent|task),       │
│  │   parent_id, owner_agent_id, status                                          │
│  │                                                                               │
│  ├── projects ──────────────────────────────────────────────────────────────────│
│  │   id, company_id, goal_id, name, description, status, lead_agent_id,         │
│  │   target_date, env (secret-aware env bindings)                                │
│  │                                                                               │
│  ├── issues (core task entity) ─────────────────────────────────────────────────│
│  │   id, company_id, project_id, goal_id, parent_id, title, description,        │
│  │   status (backlog|todo|in_progress|in_review|done|blocked|cancelled),        │
│  │   priority, assignee_agent_id, created_by_agent_id, request_depth,           │
│  │   billing_code, started_at, completed_at, cancelled_at                       │
│  │   │                                                                           │
│  │   ├── issue_comments (author_agent_id|author_user_id, body)                   │
│  │   ├── documents → document_revisions (markdown, append-only)                  │
│  │   ├── issue_attachments → assets (provider-backed object storage)             │
│  │   ├── issue_labels                                                           │
│  │   ├── issue_relations (blocker dependencies)                                  │
│  │   ├── issue_tree_holds (subtree pause gates)                                  │
│  │   └── issue_thread_interactions (confirm/ask/review lifecycle)                │
│  │                                                                               │
│  ├── approvals ─────────────────────────────────────────────────────────────────│
│  │   id, company_id, type (hire_agent|approve_ceo_strategy), status,            │
│  │   requested_by, payload (jsonb), decision_note, decided_by, decided_at       │
│  │                                                                               │
│  ├── cost_events ───────────────────────────────────────────────────────────────│
│  │   id, company_id, agent_id, issue_id, project_id, goal_id,                   │
│  │   provider, model, input_tokens, output_tokens, cost_cents, occurred_at      │
│  │                                                                               │
│  ├── budget_policies / budget_incidents (per-agent, per-company caps)            │
│  │                                                                               │
│  ├── activity_log ──────────────────────────────────────────────────────────────│
│  │   id, company_id, actor_type, actor_id, action, entity_type,                 │
│  │   entity_id, details (jsonb), created_at                                     │
│  │                                                                               │
│  ├── routines (scheduled automated tasks with cron triggers)                     │
│  ├── company_secrets → company_secret_versions (encrypted at rest)               │
│  ├── company_skills (skill documents per company)                                │
│  ├── assets → issue_attachments (provider-backed file storage)                   │
│  ├── company_memberships / invites / join_requests (access control)              │
│  ├── environments / execution_workspaces (execution isolation)                   │
│  └── plugins (installed plugins, config, state, jobs, webhooks)                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Request Flow: Agent Heartbeat Cycle

```
┌─────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│Scheduler│     │  Paperclip   │     │   Adapter    │     │    Agent     │
│ (Cron)  │     │   Server     │     │  (process/   │     │  (Claude/    │
│         │     │              │     │   http/etc)  │     │   Codex/etc) │
└────┬────┘     └──────┬───────┘     └──────┬───────┘     └──────┬───────┘
     │                 │                    │                    │
     │ intervalSec     │                    │                    │
     │ tick ──────────►│                    │                    │
     │                 │                    │                    │
     │                 │ Check preconditions│                    │
     │                 │ · agent not paused │                    │
     │                 │ · no active run    │                    │
     │                 │ · budget not hard  │                    │
     │                 │   capped           │                    │
     │                 │                    │                    │
     │                 │ Create run (queued)│                    │
     │                 │                    │                    │
     │                 │ Build context:     │                    │
     │                 │ · thin (IDs only)  │                    │
     │                 │ · fat (full state) │                    │
     │                 │                    │                    │
     │                 │ invoke(agent,ctx)──►                    │
     │                 │                    │                    │
     │                 │                    │ Spawn/HTTP call ──►│
     │                 │                    │                    │
     │                 │                    │                    │ Reads context
     │                 │                    │                    │ Fetches tasks
     │                 │                    │                    │
     │                 │                    │                    │ Works on tasks
     │                 │                    │                    │
     │                 │                    │                    │ Reports status
     │                 │                    │◄── API call ───────│
     │                 │                    │  · task updates    │
     │                 │                    │  · cost events     │
     │                 │                    │  · comments        │
     │                 │                    │                    │
     │                 │                    │ Process exit ◄─────│
     │                 │                    │                    │
     │                 │◄── status() ───────│                    │
     │                 │                    │                    │
     │                 │ Update run status  │                    │
     │                 │ (succeeded/failed) │                    │
     │                 │                    │                    │
     │                 │ Update agent state │                    │
     │                 │ · last_heartbeat_at│                    │
     │                 │ · spent_monthly    │                    │
     │                 │                    │                    │
     │                 │ Check budget       │                    │
     │                 │ · soft alert @80%  │                    │
     │                 │ · auto-pause @100% │                    │
     ▼                 ▼                    ▼                    ▼
```

## Governance & Approval Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            BOARD GOVERNANCE LAYER                                 │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                        APPROVAL GATES                                     │   │
│  │                                                                           │   │
│  │  HIRE AGENT                          CEO STRATEGY                         │   │
│  │  ┌──────────────┐                    ┌──────────────┐                    │   │
│  │  │ Agent/Board  │                    │  CEO Agent   │                    │   │
│  │  │ requests     │                    │  proposes    │                    │   │
│  │  │ new agent    │                    │  strategic   │                    │   │
│  │  └──────┬───────┘                    │  breakdown   │                    │   │
│  │         │                            └──────┬───────┘                    │   │
│  │         ▼                                   ▼                            │   │
│  │  ┌──────────────┐                    ┌──────────────┐                    │   │
│  │  │  Approval    │                    │  Approval    │                    │   │
│  │  │  (pending)   │                    │  (pending)   │                    │   │
│  │  └──────┬───────┘                    └──────┬───────┘                    │   │
│  │         │                                   │                            │   │
│  │         └───────────────┬───────────────────┘                            │   │
│  │                         ▼                                                │   │
│  │                  ┌──────────────┐                                        │   │
│  │                  │ Board Review │                                        │   │
│  │                  └──┬───────┬───┘                                        │   │
│  │                     │       │                                            │   │
│  │              ┌──────▼┐  ┌───▼────┐                                      │   │
│  │              │Approve│  │ Reject │                                      │   │
│  │              └──┬────┘  └────────┘                                      │   │
│  │                 │                                                        │   │
│  │    ┌────────────┴────────────┐                                           │   │
│  │    ▼                         ▼                                           │   │
│  │ Create agent row      No action                                          │   │
│  │ Generate API key      Log decision                                      │   │
│  │ Log hire activity     Activity audit                                    │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                      BOARD OVERRIDE POWERS                                │   │
│  │                                                                           │   │
│  │  · Pause / Resume / Terminate any agent (termination is irreversible)     │   │
│  │  · Reassign or cancel any task                                           │   │
│  │  · Edit any budget at any level                                           │   │
│  │  · Approve / Reject / Cancel any pending approval                         │   │
│  │  · Force-release stale checkout locks (admin/force-release endpoint)      │   │
│  │  · Bypass hire approval; create agents directly                            │   │
│  │  · All board actions recorded in activity_log                             │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                     BUDGET ENFORCEMENT CHAIN                              │   │
│  │                                                                           │   │
│  │  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐              │   │
│  │  │Cost Event    │     │ Monthly      │     │Threshold     │              │   │
│  │  │Reported by   │────►│ Rollup       │────►│Check         │              │   │
│  │  │Agent (API)   │     │(agent+co.)   │     │              │              │   │
│  │  └──────────────┘     └──────────────┘     └──┬───────┬───┘              │   │
│  │                                               │       │                  │   │
│  │                                        ┌──────▼┐  ┌───▼────┐            │   │
│  │                                        │  <80% │  │ ≥80%   │            │   │
│  │                                        │Normal │  │Soft    │            │   │
│  │                                        │       │  │Alert   │            │   │
│  │                                        └───────┘  └───┬────┘            │   │
│  │                                                       │                  │   │
│  │                                                       ▼                  │   │
│  │                                                ┌──────────────┐          │   │
│  │                                                │ ≥100%        │          │   │
│  │                                                │ HARD STOP    │          │   │
│  │                                                │ · Pause agent│          │   │
│  │                                                │ · Block new  │          │   │
│  │                                                │   invocations│          │   │
│  │                                                │ · Log incident│          │   │
│  │                                                └──────────────┘          │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Plugin & Extension Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           PLUGIN SYSTEM                                           │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                     PLUGIN SDK (@paperclipai/plugin-sdk)                   │   │
│  │                                                                           │   │
│  │  Entry Points:                                                            │   │
│  │  · @paperclipai/plugin-sdk        → definePlugin(), runWorker()           │   │
│  │  · @paperclipai/plugin-sdk/ui     → usePluginData(), slots                │   │
│  │  · @paperclipai/plugin-sdk/testing → createTestHarness()                  │   │
│  │  · @paperclipai/plugin-sdk/bundlers → esbuild/rollup presets              │   │
│  │  · @paperclipai/plugin-sdk/dev-server → static UI + SSE reload            │   │
│  │                                                                           │   │
│  │  Plugin Context APIs (20+):                                               │   │
│  │  · Config · Events · Jobs · Launchers · DB · HTTP · Secrets               │   │
│  │  · Activity · State · Entities · Projects · Companies · Issues            │   │
│  │  · Agents · Goals · Data · Actions · Streams · Tools · Metrics            │   │
│  │  · Telemetry · Logger                                                     │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                           PLUGIN TYPES                                    │   │
│  │                                                                           │   │
│  │  Adapter Plugins           Tool Plugins            Sandbox Providers      │   │
│  │  · Register new agent      · Expose capabilities   · E2B integration      │   │
│  │    types at runtime        · Called by agents      · Environment drivers  │   │
│  │  · invoke/status/cancel    · JSON-RPC dispatch     · Lifecycle hooks      │   │
│  │  · External npm packages   · Worker sandbox        · Custom providers     │   │
│  │                                                                           │   │
│  │  UI Plugins                Event Plugins           Job Plugins            │   │
│  │  · Global toolbar slots    · React to lifecycle    · Scheduled work       │   │
│  │  · Custom pages/routes     · Hook into mutations   · Cron triggers        │   │
│  │  · Panel contributions     · Stream processing     · Job coordination     │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                     MCP SERVER (@paperclipai/mcp-server)                   │   │
│  │                                                                           │   │
│  │  37 MCP Tools:                                                            │   │
│  │  ┌─────────────────────┐  ┌─────────────────────────────────────┐        │   │
│  │  │  22 READ TOOLS     │  │  15 WRITE TOOLS                      │        │   │
│  │  │                    │  │                                      │        │   │
│  │  │ · list agents      │  │ · create/update issues               │        │   │
│  │  │ · list issues      │  │ · checkout issues                    │        │   │
│  │  │ · get issue detail │  │ · add comments                       │        │   │
│  │  │ · list projects    │  │ · create suggestions                 │        │   │
│  │  │ · list goals       │  │ · create confirmations               │        │   │
│  │  │ · list approvals   │  │ · manage documents                   │        │   │
│  │  │ · get documents    │  │ · start/stop workspace services      │        │   │
│  │  │ · get comments     │  │ · manage approvals                   │        │   │
│  │  │ · workspace status │  │ · paperclipApiRequest (escape hatch) │        │   │
│  │  │ · heartbeat context│  │                                      │        │   │
│  │  │ · inbox queries    │  │                                      │        │   │
│  │  └─────────────────────┘  └─────────────────────────────────────┘        │   │
│  │                                                                           │   │
│  │  Transport: stdio (MCP protocol)                                          │   │
│  │  Auth: PAPERCLIP_API_KEY environment variable                             │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```