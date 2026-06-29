# Paperclip — Use Cases

## 1. Managed Service Providers (MSPs)

### Scenario

An MSP operates AI-powered service teams for multiple client organizations simultaneously. Each client needs its own isolated agent workforce, cost tracking, and governance — but the MSP needs a single pane of glass to manage everything.

### How Paperclip Delivers

- **Multi-company model**: Create one company per client. Each company has its own agents, projects, tasks, budgets, and approval flows. Company boundaries are enforced at the API and database layer — agents from Client A cannot see or mutate Client B's data.

- **Per-client cost isolation**: Each company has its own budget policies and cost-event tracking. The MSP can set per-client monthly spending caps, monitor burn rates per client, and receive budget-incident alerts when any client's agents approach or exceed limits.

- **Agent template reuse**: Export a client company as a portable package (markdown-first `COMPANY.md` + agents/configs/projects), then import it as a template for new clients with collision strategies (`rename`, `skip`, `replace`). The MSP can build a standard "AI support team" blueprint and instantiate it for each new client in minutes.

- **Activity audit for SLAs**: The activity log records every agent action, task transition, and cost event per company. The MSP can generate compliance reports showing exactly what each agent did, when, and at what cost — enabling SLA reporting and client billing transparency.

- **White-label potential**: Company branding endpoints (`PATCH /companies/:companyId/branding`) allow per-company visual customization. An MSP could potentially expose company-specific dashboards to each client.

### Key Paperclip Features Used

| Feature | How It Helps |
|---|---|
| Multi-company scoping | Isolate client data and agents |
| Company budgets + auto-pause | Prevent per-client cost overruns |
| Company portability (import/export) | Reusable agent team templates |
| Activity audit log | Compliance and SLA reporting |
| Plugin system | Custom MSP tools and integrations |

---

## 2. Security Operations (SOC / DevSecOps)

### Scenario

A security team uses AI agents to continuously monitor infrastructure, triage alerts, investigate anomalies, and remediate findings. Security work is sensitive — agents need access to secrets, their actions must be fully auditable, and cost spikes from investigation bursts must be controlled.

### How Paperclip Delivers

- **Agent hierarchy for escalation**: Define a security org chart — triage agents handle low-severity alerts, incident-response agents escalate to investigation leads, and a CISO agent monitors overall posture. The `reports_to` tree and cross-team task delegation with `request_depth` tracking models the escalation chain.

- **Secret management for credentials**: Agent environment variables use secret references (`company_secrets` + `company_secret_versions`) with local encryption at rest. API keys for cloud providers, SIEM systems, and ticketing platforms are never stored in plaintext in agent config. Strict mode (`PAPERCLIP_SECRETS_STRICT_MODE`) enforces that sensitive env keys must use secret references.

- **Executive summary via approvals**: A security-lead agent proposes investigation strategies as `approve_ceo_strategy` approvals. The CISO/human board reviews the plan, approves or rejects, and the agent executes against the approved scope. Before first strategy approval, agents may only draft tasks — they cannot transition them to active execution.

- **Budget hard-stops for investigation bursts**: An agent investigating an incident may spawn many sub-tasks and consume significant API tokens across multiple models. Per-agent monthly budgets with soft alerts at 80% and hard-stop auto-pause at 100% prevent runaway costs while ensuring investigation continuity within approved limits.

- **Complete audit trail**: Every agent action — task creation, status changes, cost reporting, comment posting — is written to `activity_log` with actor identity, entity reference, and JSON detail. Security auditors can reconstruct the exact sequence of events during an incident response.

- **Routines for scheduled scans**: Define routines (cron-triggered automated tasks) that run daily vulnerability scans, weekly compliance checks, or hourly threat-intelligence refreshes. Routine execution is tracked like any other agent heartbeat.

### Key Paperclip Features Used

| Feature | How It Helps |
|---|---|
| Secret references + encryption | Secure credential management |
| Approval gates | Scoped investigation authorization |
| Budget hard-stop auto-pause | Prevent cost runaway during incidents |
| Activity audit log | SOC 2 / compliance audit trail |
| Routines (cron triggers) | Scheduled security scans |
| Hierarchical task trees | Alert triage → investigation → remediation lifecycle |

---

## 3. Content Operations

### Scenario

A content operation runs AI agents that research topics, draft articles, create social media posts, produce marketing copy, and generate documentation — all at scale, across multiple brands or product lines. The operation needs brand-level isolation, editorial review gates, and per-brand cost tracking.

### How Paperclip Delivers

- **Brand-level isolation via companies**: Create one company per brand or product line. Each has its own agents (e.g., researcher, writer, editor, social media manager), projects (campaigns, editorial calendars), and goals (brand voice, content strategy). Agents in the "Acme Corp" company cannot see "Beta Inc" content.

- **Editorial review via issue status workflow**: Content tasks flow through `backlog → todo → in_progress → in_review → done`. The `in_review` status is the editorial gate — a writer agent completes a draft, transitions the issue to `in_review`, and an editor agent (or human board operator) reviews and either approves (`done`) or sends back (`in_progress`).

- **Documents as first-class work products**: Every issue can have linked documents (`documents` + `document_revisions` with `issue_documents` keyed by type: `plan`, `design`, `notes`). Content drafts are stored as revision-controlled markdown documents attached to content tasks. The document diff viewer enables side-by-side comparison between revisions.

- **Per-brand cost attribution**: Each content task carries a `billing_code`. When a research agent creates subtasks for a writer agent, the cross-team `billing_code` tracks writer costs back to the research task. Per-brand company budgets and per-agent budgets mean the content operation can track exactly which brand's content production costs what.

- **Routines for recurring content**: Define weekly newsletter routines, daily social-media routines, or monthly report routines. Each routine creates structured tasks on schedule, and agents pick them up during their heartbeat cycles.

- **Output-first workflow**: Attachments and documents let agents produce and attach finished content (images, PDFs, HTML) to tasks. The board operator can review outputs directly in the UI.

### Key Paperclip Features Used

| Feature | How It Helps |
|---|---|
| Multi-company isolation | Per-brand content operations |
| Issue status workflow | Editorial review gates |
| Documents + revisions | Content draft versioning |
| Billing codes | Per-brand cost attribution |
| Routines | Recurring content schedules |
| Attachments | Final content delivery |

---

## 4. Directory Operations (Agent Directory / Marketplace Operations)

### Scenario

An organization maintains and operates a directory of available AI agents — similar to an app store or talent marketplace. Users browse agent profiles, review capabilities, and request agents. The directory operator uses Paperclip internally to manage the agent catalog and the systems that power the directory.

### How Paperclip Delivers

- **Agent registry as source of truth**: Every agent in the directory has a Paperclip agent record with `name`, `role`, `title`, `capabilities` description, `adapter_type`, and configuration. The registry is the canonical database for the directory — the marketplace frontend reads from it, and operators manage it through Paperclip.

- **Skills management for discoverability**: Company-level skills (`company_skills`, `GET /api/skills/index`, `GET /api/skills/paperclip`) provide structured skill documents per company. Agents publish their skills, and other agents discover them. For a directory operator, this becomes the "agent capabilities catalog."

- **Hiring flow as onboarding**: The `hire_agent` approval flow models the directory onboarding process. A new agent listing is proposed as an approval request → reviewed by the board → approved, which creates the agent row and generates an API key. This mirrors a marketplace listing → review → publish workflow.

- **Agent health monitoring**: Heartbeat runs, agent statuses (`active | paused | idle | running | error | terminated`), and `last_heartbeat_at` timestamps provide real-time health data. A directory operator can surface "agent uptime" or "agent reliability" metrics based on Paperclip's heartbeat run history.

- **Silent active-run watchdog**: The watchdog system detects agents with running processes but no observable output, classifying them as `ok`, `suspicious`, or `critical`. For a directory operator, this answers "is this agent actually working or just stuck?" and creates explicit review issues when agents go silent.

- **Plugin system for directory-specific tooling**: Build directory-specific plugins — e.g., a ratings/reviews plugin, a usage-analytics plugin, or a billing plugin — using the plugin SDK. These run as sandboxed workers with access to the Paperclip API without modifying core code.

### Key Paperclip Features Used

| Feature | How It Helps |
|---|---|
| Agent registry + capabilities | Agent catalog / marketplace backend |
| Skills system | Agent capability discoverability |
| Hire approval flow | Listing review and approval |
| Heartbeat monitoring | Agent health and uptime metrics |
| Silent-run watchdog | Detect stuck/unresponsive agents |
| Plugin SDK | Custom directory tooling |

---

## 5. Multi-Company Orchestration

### Scenario

A holding company or venture studio manages a portfolio of autonomous AI companies, each pursuing a different product, market, or business model. The operator needs to oversee all companies from one control plane, compare performance across the portfolio, and reallocate resources (agents, budget) between companies as needed.

### How Paperclip Delivers

- **Multi-company dashboard**: The `GET /api/companies/:companyId/dashboard` endpoint delivers per-company metrics (active/running/paused/error agent counts, open/in-progress/blocked/done issue counts, month-to-date spend, budget utilization, pending approvals count). The UI's company rail and switcher enable rapid context switching between portfolio companies.

- **Company lifecycle management**: Companies have statuses (`active | paused | archived`). A venture studio can create companies in `active` state for live ventures, `pause` companies under strategic review, and `archive` companies that have completed their mission or been shut down. Archive preserves data for historical analysis.

- **Portfolio-level cost visibility**: Per-company cost summaries (`GET /api/companies/:companyId/costs/summary`, `by-agent`, `by-project`) enable portfolio-wide cost comparison. The operator can identify which company has the highest burn rate, which agents are most expensive, and where budget reallocation would have the most impact.

- **Company portability for spin-offs**: Export a successful company as a portable package (markdown + `.paperclip.yaml`). Import it into a separate Paperclip instance (e.g., a dedicated instance for a spun-off venture). The export strips environment-specific paths and secrets while preserving org structure, agent configurations, and project templates.

- **Cross-company agent transfer**: An operator can terminate an agent in one company and hire an equivalent agent in another, using the export/import flow or direct agent creation. Budget can be shifted from one company to another by adjusting per-company monthly budgets on the board UI.

- **Board as portfolio manager**: The single human board operator has full read/write across all companies in the deployment. They can pause entire companies, reassign critical tasks between companies (manually), adjust budgets across the portfolio, and review approval queues from multiple companies in one session.

### Key Paperclip Features Used

| Feature | How It Helps |
|---|---|
| Multi-company data model | Manage portfolio of autonomous companies |
| Company status lifecycle | Active / paused / archived management |
| Per-company cost dashboards | Portfolio-level financial comparison |
| Company portability (export/import) | Spin-off and migrate companies |
| Board override authority | Cross-company resource reallocation |
| Global company selector in UI | Rapid context switching |

---

## Summary: Feature → Use Case Mapping

| Feature | MSP | SOC | Content | Directory | Multi-Co |
|---|---|---|---|---|---|
| Multi-company scoping | ✓ | | ✓ | | ✓ |
| Agent hierarchy (org tree) | ✓ | ✓ | ✓ | | |
| Task hierarchy + status workflow | ✓ | ✓ | ✓ | | |
| Atomic checkout | ✓ | ✓ | | | |
| Heartbeat + scheduler | ✓ | ✓ | ✓ | ✓ | ✓ |
| Cost tracking + budgets | ✓ | ✓ | ✓ | | ✓ |
| Budget hard-stop auto-pause | ✓ | ✓ | | | |
| Approval gates (hire + strategy) | | ✓ | ✓ | ✓ | |
| Activity audit log | ✓ | ✓ | | | |
| Secret management + encryption | | ✓ | | | |
| Documents + revisions | | | ✓ | | |
| Routines (cron) | | ✓ | ✓ | | |
| Company portability | ✓ | | | | ✓ |
| Plugin system | ✓ | | | ✓ | |
| Silent-run watchdog | | | | ✓ | |
| Board override authority | ✓ | ✓ | ✓ | ✓ | ✓ |

---

## Production-Grade Deployment Patterns

### Pattern 1: Local Trusted (Solo Operator)

```
┌─────────────────────────────────┐
│       Developer Workstation     │
│  ┌───────────────────────────┐  │
│  │    Paperclip Server       │  │
│  │    localhost:3100         │  │
│  │    Embedded PostgreSQL    │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │  Agent Processes (local)  │  │
│  │  Claude / Codex / Cursor  │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

### Pattern 2: Authenticated Private (Team / Tailscale)

```
┌──────────────────────┐    ┌──────────────────────┐
│   Operator Laptop    │    │   Team Member        │
│   Browser → :3100    │    │   Browser → :3100    │
└──────────┬───────────┘    └──────────┬───────────┘
           │  Tailscale VPN            │
           └───────────┬───────────────┘
                       │
           ┌───────────┴───────────┐
           │   Paperclip Server    │
           │   bind=tailnet        │
           │   authenticated       │
           │   private             │
           │   Docker PostgreSQL   │
           └───────────────────────┘
```

### Pattern 3: Authenticated Public (Production / Cloud)

```
                    Internet
           ┌───────────┴───────────┐
           │    Reverse Proxy      │
           │    (nginx / Caddy)    │
           │    HTTPS termination  │
           └───────────┬───────────┘
                       │
           ┌───────────┴───────────┐
           │   Paperclip Server    │
           │   bind=loopback       │
           │   authenticated       │
           │   public              │
           └───────────┬───────────┘
                       │
           ┌───────────┴───────────┐
           │   Supabase / Cloud    │
           │   PostgreSQL          │
           │   S3 Object Storage   │
           └───────────────────────┘
```