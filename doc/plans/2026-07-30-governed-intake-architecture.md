# Governed Intake Platform — Architecture Evaluation

> **Status:** Awaiting Board approval
> **Date:** 2026-07-30
> **Audience:** Board (QuantumShield Labs)
> **Mission ID:** PAPERCLIP-004
> **Predecessors:**
> - [PAPERCLIP-002: Email Company Operational Assessment](./2026-07-29-email-company-operational-assessment.md)
> - [PAPERCLIP-003: Email Company Implementation Plan](./2026-07-30-email-company-implementation-plan.md)
> **Root authority:** [TheBinMap Intelligence Constitution](./2026-07-08-thebinmap-intelligence-constitution.md)
> **Repo branch:** `feat/qsl-current-upstream-integration`
> **Scope:** Architectural evaluation — no implementation. No code changes.

---

## 1. Reality Discovery

### 1.1 What We Actually Have

The Email Company (`@qsl/plugin-email` v0.1.0) is a **1,400-line Paperclip plugin** that implements a governed intake loop for email. It is not a separate codebase, agent, service, or company template. It is a usage pattern that demonstrates the viability of the core pattern.

| Layer | Component | Lines | Role |
|---|---|---|---|
| **Ingestion** | `imap.ts` | 135 | IMAP UNSEEN fetch via `imapflow`, UID cursor tracking, mailbox locking |
| **Normalization** | `normalize.ts` | 187 | Message → structured record, 13 heuristic categories, venture routing, priority mapping, field extraction |
| **Issue creation** | `worker.ts:175-231` | 57 | Paperclip issue creation with `originKind`, `originId`, `billingCode`, dedup, thread metadata |
| **Outbound** | `smtp.ts` + `worker.ts:398-481` | 138 | Board-gated SMTP send with threading headers, permanent send record as issue comment, IMAP reply flagging |
| **UI** | `ui/index.tsx` | 193 | Issue detail tab (inbound record, draft preview, send button), dashboard widget (metrics, poll control) |
| **Scheduling** | `worker.ts:329-340` | 12 | Cron `*/5 * * * *` poll job, manual poll action, cursor reset action |
| **Config** | `manifest.ts` | 144 | 14 config fields, company-scoped, profile-based (single engine, multiple mailboxes) |
| **Tests** | `normalize.spec.ts` | 338 | 28 test cases for classification, routing, normalization, send-gate verification |

### 1.2 The Core Pattern (Already Proven)

The Email Company demonstrates a pattern that is **not email-specific**:

```
SOURCE → INGEST → NORMALIZE → (DEDUP) → CREATE ISSUE → TRIAGE → REVIEW → RESOLVE
  │                                                                         │
  └─────────────────── AUDIT TRAIL (activity_log, cost_events) ─────────────┘
```

Every stage of this pattern is already generic:

| Stage | Email Implementation | Generic Equivalent |
|---|---|---|
| **SOURCE** | Gmail IMAP mailbox | Any data source (webhook, API, file, poll, event) |
| **INGEST** | `imapflow` UNSEEN fetch | Plugin SDK: `webhooks.receive`, `jobs.schedule`, `api.routes.register`, `events.subscribe` |
| **NORMALIZE** | `normalizeMessage()` → `NormalizedMessage` | Schema coercion: source payload → standardized intake record |
| **CLASSIFY** | `classify()` → 13 heuristic hints | Configurable classifier: source → `intakeCategory` + `confidence` |
| **DEDUP** | SHA-1(profile:messageId) + DB index | SHA-1(sourceKey:sourceId) + `originKind`/`originId` lookup |
| **CREATE ISSUE** | `ctx.issues.create()` with `originKind: plugin:qsl.email:intake` | `ctx.issues.create()` with `originKind: plugin:qsl.intake:<source>` |
| **TRIAGE** | Intake Triage agent via `email-triage-sop` | Intake Triage agent via `intake-triage-sop` (genericized) |
| **REVIEW** | Board reviews in Email tab → sends | Board reviews in Intake tab → approves/rejects/dispatches |
| **RESOLVE** | `in_review` → `done`/`cancelled` | Same Paperclip issue state machine |
| **OUTBOUND** | Board-gated SMTP send | Board-gated response action (SMTP, webhook callback, API response, comment) |

### 1.3 What Is Actually Email-Specific

Only **4 of 10 components** are tied to email:

| Component | Email-Specific? | What Makes It So |
|---|---|---|
| `imap.ts` | **Yes** | IMAP protocol, mailbox cursors, `\Seen`/`\Answered` flags |
| `smtp.ts` | **Yes** | SMTP protocol, threading headers (`In-Reply-To`, `References`) |
| `normalize.ts:classify()` | **Partially** | 13 categories are TheBinMap-specific, but the classification *mechanism* is generic (keyword → category) |
| `normalize.ts:normalizeMessage()` | **Partially** | IMAP envelope parsing is email-specific; the normalization *concept* is generic |
| `worker.ts:ingestMessage()` | **No** | Creates a Paperclip issue — this is the generic intake core |
| `worker.ts:send-reply` | **Yes** | SMTP send with threading — but the *send-gate pattern* is generic |
| `worker.ts:poll-inbox` | **Yes** | IMAP polling — but the *scheduled job pattern* is generic |
| `ui/index.tsx:EmailIssueTab` | **Partially** | "Inbound email" labels are email-specific; the *issue detail tab pattern* is generic |
| `ui/index.tsx:EmailMetricsWidget` | **Partially** | "messages_ingested"/"replies_sent" metrics are email-specific; the *dashboard widget pattern* is generic |
| `manifest.ts` | **No** | Config schema is generic (fields like `intakeProjectId`, `triageAgentId`, `billingCode` are not email-specific) |

### 1.4 The Plugin SDK Already Supports Every Intake Mechanism

| Intake Channel | Plugin SDK Mechanism | Capability Required | Auth Model |
|---|---|---|---|
| **Email (IMAP polling)** | `jobs.schedule` (cron job) | `jobs.schedule` | Plugin-level (secret ref) |
| **Web form (Web3Forms)** | `webhooks.receive` | `webhooks.receive` | Public (signature-verified) |
| **GitHub Issues** | `webhooks.receive` | `webhooks.receive` | Public (HMAC-verified) |
| **Contact forms** | `webhooks.receive` | `webhooks.receive` | Public |
| **API submissions** | `api.routes.register` | `api.routes.register` | Board/Agent (authenticated) |
| **Bug reports** | `webhooks.receive` or `api.routes.register` | `webhooks.receive` or `api.routes.register` | Public or authenticated |
| **Feature requests** | `webhooks.receive` or `api.routes.register` | `webhooks.receive` or `api.routes.register` | Public or authenticated |
| **Partner inquiries** | `webhooks.receive` | `webhooks.receive` | Public |
| **Sales leads** | `webhooks.receive` | `webhooks.receive` | Public |
| **Directory submissions** | `webhooks.receive` or `api.routes.register` | `webhooks.receive` or `api.routes.register` | Public or authenticated |
| **Claim requests** | `webhooks.receive` or `api.routes.register` | `webhooks.receive` or `api.routes.register` | Public or authenticated |
| **Intelligence subscriptions** | `webhooks.receive` | `webhooks.receive` | Public |
| **Future connectors** | `events.subscribe` (platform events) | `events.subscribe` | Plugin-level |

### 1.5 The Issue Model Already Supports Generic Intake

The Paperclip `issues` table has all the fields needed for a generic intake object:

| Intake Requirement | Issue Field | How It's Used |
|---|---|---|
| **Source identity** | `originKind` (e.g., `plugin:qsl.intake:email`, `plugin:qsl.intake:webform`) | Tracks which intake channel created the issue |
| **Source deduplication** | `originId` (e.g., message ID, form submission ID, GitHub issue number) | Prevents duplicate intake from the same source event |
| **Source fingerprint** | `originFingerprint` | Groups related intake events (e.g., same sender, same thread) |
| **Normalized payload** | `description` (markdown) | Formatted intake record with metadata, body, extracted fields, recommendations |
| **Category** | `labels` (e.g., `category:store-submission`, `category:bug-report`) | Classification for routing and filtering |
| **Priority** | `priority` (`critical`/`high`/`medium`/`low`) | Urgency derived from category + confidence |
| **Routing** | `projectId` + `assigneeAgentId` | Which project and agent handle this intake |
| **Cost attribution** | `billingCode` (e.g., `mission:email-ops`, `mission:thebinmap-intake`) | Groups costs per intake channel |
| **Review state** | `status` (`todo`/`in_review`/`done`/`cancelled`) | Where in the review pipeline the intake is |
| **Response draft** | `issue_documents` with key `reply-draft` or `response-draft` | Board-approved response before sending |
| **Source evidence** | `issue_attachments` (files uploaded with the source payload) | Original form data, screenshots, email headers |
| **Agent context** | `workMode` (`standard`/`ask`/`planning`) | How the agent should approach the intake |
| **Audit trail** | `activity_log` entries | Every intake, review, and resolution event |
| **Cost tracking** | `cost_events` (per-agent run) | Token spend per intake category |

---

## 2. Current Architecture

### 2.1 Architecture Diagram (Current)

```
┌──────────────────────────────────────────────────────────────────┐
│                    @qsl/plugin-email v0.1.0                       │
│                                                                   │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │  IMAP    │  │  Normalize   │  │  Issue       │  │  SMTP    │ │
│  │  Poll    │→│  + Classify  │→│  Create      │  │  Send    │ │
│  │  (cron)  │  │  (heuristic) │  │  (originKind)│  │  (Board) │ │
│  └──────────┘  └──────────────┘  └──────┬───────┘  └──────────┘ │
│                                          │                        │
│  ┌──────────────────────────────────────┘                        │
│  │  Plugin State (thread records, cursor, metrics)               │
│  │  Activity Log (intake events, send events, poll events)       │
│  │  UI (Email tab, Dashboard widget)                             │
│  └───────────────────────────────────────────────────────────────│
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Paperclip Platform                              │
│                                                                   │
│  Issues (EMA-1..32+)  │  Comments  │  Documents  │  Attachments  │
│  Approvals  │  Activity Log  │  Cost Events  │  Heartbeat Runs   │
│  Agents (CEO, Triage, Drafter, Analyst)  │  Routines (deferred)  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Architecture Characteristics

| Characteristic | Current State |
|---|---|
| **Plugin boundary** | Monolithic. All intake logic (IMAP, normalize, classify, issue creation, SMTP, UI) is in one plugin package. |
| **Classification** | Hardcoded 13-category heuristic in `normalize.ts`. TheBinMap-specific categories are embedded in code. |
| **Config model** | Good. Profile-based, company-scoped, secret-ref-aware. Adding a second mailbox is a config row. |
| **UI** | Email-specific. Tab labeled "Email", widget labeled "Email Intake", metrics named "messages_ingested"/"replies_sent". |
| **Outbound** | Single-channel. Only SMTP send. The send-gate pattern is correct but hardcoded to email. |
| **Dedup** | Dual-layer. SHA-1(profile:messageId) in plugin.state + DB-level `originKind`/`originId` lookups. |
| **Evidence** | Platform-native. Every intake/send writes activity_log. Thread records in plugin.state. Send records as immutable issue comments. |
| **Reusability** | Good for email. The profile-based architecture means any company can add email intake by writing config. But the classification, UI, and outbound are email-coupled. |

### 2.3 What Would Break If We Generalized

| Component | Risk of Generalization | What Would Break |
|---|---|---|
| `classify()` | **Medium** | 13 email categories become generic intake categories. TheBinMap-specific labels ("store_submission", "listing_claim") would need to move to config, not code. |
| `normalizeMessage()` | **Low** | IMAP envelope parsing is email-specific, but the normalization *concept* (raw payload → structured record) is generic. Email normalization stays in `plugin-email`; generic normalization goes in a shared layer. |
| `ingestMessage()` | **Low** | Issue creation logic is already generic. The only email-specific part is the `ThreadRecord` storage. |
| `send-reply` | **Low** | SMTP-specific. The *send-gate pattern* (draft → Board review → confirm → send) is generic and can be extracted. |
| `EmailIssueTab` | **Low** | The "Inbound email" label and SMTP-specific UI are email-specific. The *pattern* (source record, draft preview, review action) is generic. |
| `EmailMetricsWidget` | **Low** | Email-specific metrics names. The *pattern* (intake volume, queue depth, pending actions) is generic. |

---

## 3. Proposed Generic Intake Architecture

---
### Proving Ground Principle

The Governed Intake Platform itself is subject to the Proving Ground Principle.

New abstractions should emerge from repeated operational evidence rather than anticipated future needs.

The shared intake engine should therefore be extracted only after multiple independent intake adapters demonstrate common patterns that justify consolidation.

Operational evidence precedes architectural standardization.

---

### 3.1 Core Principle: One Intake Abstraction, Many Sources

The Email Company is a **specific instance** of a general pattern. The Governed Intake Platform generalizes that pattern into a reusable framework.

```
GOVERNED INTAKE PLATFORM (reusable across all QSL companies)

┌─────────────────────────────────────────────────────────────────┐
│                    plugin-intake (core engine)                    │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Intake       │  │  Classifier  │  │  Issue Factory       │   │
│  │  Normalizer   │  │  (config)    │  │  (originKind,        │   │
│  │  (source→     │  │  (category   │  │   billingCode,       │   │
│  │   IntakeItem) │  │   +confidence│  │   priority, labels)  │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Router       │  │  Review      │  │  Evidence            │   │
│  │  (category→   │  │  Manager     │  │  Preserver           │   │
│  │   project,    │  │  (spam state, │  │  (activity_log,      │   │
│  │   assignee,   │  │   review      │  │   thread records,    │   │
│  │   labels)     │  │   queue)      │  │   source snapshots)  │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Intake UI (shared)                                       │    │
│  │  • Intake Dashboard Widget (queue depth, pending review)  │    │
│  │  • Intake Issue Tab (source record, response draft,       │    │
│  │    review action, send confirmation)                       │    │
│  │  • Intake Metrics (per-source, per-category)              │    │
│  └──────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌──────────────────────┐
│ plugin-email    │  │ plugin-webform  │  │ plugin-github-intake │
│ (source adapter)│  │ (source adapter)│  │ (source adapter)     │
│                 │  │                 │  │                      │
│ • IMAP ingest   │  │ • Webhook       │  │ • Webhook ingest     │
│ • SMTP outbound │  │   ingest        │  │ • Issue sync         │
│ • Email classify│  │ • Form field    │  │ • PR/commit intake   │
│ • Thread mgmt   │  │   extraction    │  │ • Label mapping      │
│ • Reply drafting│  │ • Redirect/     │  │ • Status sync        │
│                 │  │   confirm       │  │                      │
└─────────────────┘  └─────────────────┘  └──────────────────────┘
```

### 3.2 The Common Intake Object

Every source produces an `IntakeItem` that is source-agnostic by the time it reaches the core engine:

```typescript
interface IntakeItem {
  // Identity
  sourceKind: string;          // "email" | "webform" | "github" | "api" | ...
  sourceId: string;            // message-id, form-submission-id, issue-number, ...
  sourceFingerprint?: string;  // for grouping related intake (thread, sender, repo)

  // Content
  title: string;               // issue title
  description: string;         // formatted markdown (source record + body + metadata)
  body: string;                // raw body/source payload
  sender?: { name: string; address: string; };  // who submitted

  // Classification (source adapter provides hints; Triage agent provides authoritative)
  categoryHint: string;        // heuristic category from source adapter
  categoryConfidence: "high" | "medium" | "low";
  ventureHint: string;         // which venture this belongs to

  // Operator context
  operatorRecommendation: string;  // "review-immediately" | "review-soon" | ...
  priority: "critical" | "high" | "medium" | "low";

  // Source evidence
  sourceMetadata: Record<string, unknown>;  // source-specific data preserved
  rawPayload?: string;         // original JSON/XML/headers for audit
  attachments?: Array<{        // source-provided files
    filename: string;
    contentType: string;
    data: Buffer;
  }>;

  // Response (optional — source may expect a response)
  responseExpected: boolean;   // does the source want a reply?
  responseChannel: string;     // "email" | "webhook" | "none" | ...
  responseMetadata: Record<string, unknown>;  // thread info, callback URL, etc.

  // Routing
  suggestedProjectId?: string;
  suggestedAssigneeId?: string;
  suggestedLabels?: string[];

  // Audit
  ingestedAt: string;          // ISO timestamp
  billingCode: string;         // cost attribution
}
```

### 3.3 Source Adapters Are Thin

A source adapter has exactly **one responsibility**: convert an external event into an `IntakeItem` and hand it to the core engine. Everything else (issue creation, routing, review, evidence, UI) is handled by the core.

| Adapter | Ingestion Mechanism | Normalization | Response Channel | Lines (estimated) |
|---|---|---|---|---|
| **plugin-email** | `jobs.schedule` (IMAP poll) | Email envelope → IntakeItem | SMTP (Board-gated) | ~200 (down from 1,400) |
| **plugin-webform** | `webhooks.receive` (Web3Forms POST) | Form fields → IntakeItem | Redirect confirmation | ~100 |
| **plugin-github-intake** | `webhooks.receive` (GitHub webhook) | Issue/PR payload → IntakeItem | GitHub API callback | ~150 |
| **plugin-contact-form** | `webhooks.receive` | Form fields → IntakeItem | Email auto-ack (Board-gated) | ~100 |
| **plugin-api-intake** | `api.routes.register` | JSON body → IntakeItem | JSON response | ~80 |
| **plugin-partner-intake** | `webhooks.receive` | Form fields → IntakeItem | Email (Board-gated) | ~100 |

**Total adapter code (6 adapters): ~730 lines.** The core engine (plugin-intake) replaces the ~1,000 lines currently in `plugin-email`'s worker.ts, normalize.ts, and ui/index.tsx that are not email-specific.

### 3.4 The Core Engine (plugin-intake)

The core engine is a new Paperclip plugin (`@qsl/plugin-intake`) that source adapters depend on or call into. It handles:

| Module | Responsibility | Lines (estimated) |
|---|---|---|
| **Intake Normalizer** | `IntakeItem` → issue description, labels, priority, routing | ~150 |
| **Classifier** | Configurable category taxonomy (not hardcoded). Source adapters provide hints; the engine computes confidence and recommendations. | ~200 |
| **Issue Factory** | `ctx.issues.create()` with standardized `originKind`, `originId`, `billingCode`, dedup, thread/state storage | ~100 |
| **Router** | Category → project, assignee, labels (config-driven) | ~80 |
| **Review Manager** | Spam-review state, confidence-based routing, operator recommendation | ~100 |
| **Evidence Preserver** | Activity log, source snapshots, thread records, metrics | ~80 |
| **Intake UI** | Shared dashboard widget, issue detail tab, metrics (source-agnostic) | ~300 |
| **Config Schema** | Intake taxonomy, category routing, workflow templates, source profiles | ~150 |
| **Total** | | **~1,160** |

### 3.5 What Stays Email-Specific in plugin-email

After extracting the core engine, `plugin-email` retains:

| Component | Description |
|---|---|
| **IMAP ingestion** | `imap.ts` — poll, fetch, cursor, mailbox locking |
| **SMTP outbound** | `smtp.ts` — send with threading headers, reply flagging |
| **Email normalization** | IMAP envelope → email-specific `IntakeItem` fields (threading, message-ID, references) |
| **Email classification hints** | Email-specific keyword heuristics (TheBinMap taxonomy) |
| **Email UI labels** | "Inbound email" instead of "Inbound message", "Send approved reply" instead of "Send response" |
| **Email metrics** | "messages_ingested" / "replies_sent" (email-specific metric names) |

### 3.6 The Unified Intake Lifecycle

Regardless of source, every intake item follows the same lifecycle:

```
INTAKE ITEM CREATED
    │
    ▼
CLASSIFY (heuristic hint from source adapter + core confidence scoring)
    │
    ├── High confidence + spam → IN_REVIEW (spam queue, Board disposition required)
    │
    ├── High confidence + non-spam → TODO (assigned to Triage, workflow template applied)
    │
    ├── Medium confidence → TODO (assigned to Triage, "needs verification" flag)
    │
    └── Low confidence → TODO (assigned to Triage, "unknown-needs-triage" recommendation)
    │
    ▼
TRIAGE (Triage agent: authoritative classification, extraction, routing)
    │
    ▼
RESPONSE DRAFT (if responseExpected: Drafter agent creates response-draft document)
    │
    ▼
BOARD REVIEW (Board reviews intake, response draft, and disposition)
    │
    ├── Approve + send → IN_REVIEW (response sent, issue moves to done)
    ├── Reject → CANCELLED (with reason)
    ├── Reclassify → back to TODO (wrong category, re-assign)
    └── Defer → IN_REVIEW (leave for later batch review)
    │
    ▼
RESOLVED (done | cancelled)
    │
    ▼
EVIDENCE (activity_log, cost_events, source snapshot, response record — all preserved)
```

This lifecycle is **identical** for email, webforms, GitHub issues, bug reports, feature requests, API submissions, directory submissions, claim requests, intelligence subscriptions, and future connectors.

### 3.7 Plugin Package Architecture

```
packages/plugins/
├── plugin-intake/                    # Core engine (shared)
│   ├── src/
│   │   ├── engine.ts                 # IntakeItem → issue creation pipeline
│   │   ├── classifier.ts             # Configurable classification
│   │   ├── normalizer.ts             # IntakeItem → issue description
│   │   ├── router.ts                 # Category → project/assignee/labels
│   │   ├── review-manager.ts         # Spam state, confidence routing
│   │   ├── evidence.ts               # Activity log, metrics, snapshots
│   │   ├── types.ts                  # IntakeItem, SourceConfig, Taxonomy
│   │   ├── manifest.ts               # Plugin declaration
│   │   ├── ui/
│   │   │   ├── IntakeDashboard.tsx    # Shared dashboard widget
│   │   │   ├── IntakeIssueTab.tsx     # Shared issue detail tab
│   │   │   └── IntakeMetrics.tsx      # Shared metrics
│   │   └── worker.ts                 # Core engine setup
│   ├── tests/
│   │   ├── engine.spec.ts
│   │   ├── classifier.spec.ts
│   │   └── normalizer.spec.ts
│   └── package.json
│
├── plugin-email/                     # Email source adapter
│   ├── src/
│   │   ├── mail/imap.ts              # (unchanged from current)
│   │   ├── mail/smtp.ts              # (unchanged from current)
│   │   ├── mail/normalize.ts         # Email-specific: IMAP envelope → IntakeItem
│   │   ├── mail/classify.ts          # Email-specific: TheBinMap keyword classification
│   │   ├── manifest.ts               # Depends on plugin-intake
│   │   ├── ui/
│   │   │   └── index.tsx             # Email-specific UI labels (thin wrapper around core UI)
│   │   └── worker.ts                 # IMAP job + SMTP action + delegation to core engine
│   ├── tests/
│   │   └── normalize.spec.ts         # (unchanged from current)
│   └── package.json
│
├── plugin-webform/                   # Web form source adapter
│   ├── src/
│   │   ├── webhook.ts                # Web3Forms POST handler
│   │   ├── normalize.ts              # Form fields → IntakeItem
│   │   ├── manifest.ts               # webhooks.receive declaration
│   │   └── worker.ts                 # Webhook handler setup
│   └── package.json
│
├── plugin-github-intake/             # GitHub source adapter
│   ├── src/
│   │   ├── webhook.ts                # GitHub webhook handler (HMAC verification)
│   │   ├── normalize.ts              # GitHub payload → IntakeItem
│   │   ├── manifest.ts               # webhooks.receive + http.outbound
│   │   └── worker.ts                 # Webhook handler + optional issue sync
│   └── package.json
│
├── plugin-contact-form/              # Contact form adapter
├── plugin-api-intake/                # API submission adapter
├── plugin-partner-intake/            # Partner inquiry adapter
│
└── plugin-sdk/                       # (unchanged — Paperclip SDK)
```

### 3.8 Config-Driven Taxonomy

Instead of hardcoded 13 categories in `normalize.ts`, the core engine reads a configurable taxonomy:

```json
{
  "taxonomy": {
    "schemaVersion": 1,
    "categories": {
      "store_submission": {
        "displayName": "Store Submission",
        "priority": "medium",
        "workflow": "store-submission-workflow",
        "responseTemplate": "store-submission-received",
        "routing": {
          "projectId": "intake-project-id",
          "assigneeAgentId": "intake-triage-agent-id",
          "labels": ["category:store-submission"]
        },
        "reviewRequired": false,
        "spamReview": false
      },
      "listing_claim": {
        "displayName": "Listing Claim",
        "priority": "high",
        "workflow": "listing-claim-workflow",
        "responseTemplate": "listing-claim-received",
        "routing": {
          "projectId": "intake-project-id",
          "assigneeAgentId": "intake-triage-agent-id",
          "labels": ["category:listing-claim"]
        },
        "reviewRequired": false,
        "spamReview": false
      },
      "bug_report": {
        "displayName": "Bug Report",
        "priority": "high",
        "workflow": "bug-report-workflow",
        "responseTemplate": "bug-report-received",
        "routing": {
          "projectId": "engineering-project-id",
          "assigneeAgentId": "cto-agent-id",
          "labels": ["category:bug-report", "needs-triaging"]
        },
        "reviewRequired": true,
        "spamReview": false
      },
      "feature_request": {
        "displayName": "Feature Request",
        "priority": "medium",
        "workflow": "feature-request-workflow",
        "responseTemplate": "feature-request-received",
        "routing": {
          "projectId": "product-project-id",
          "assigneeAgentId": "cpo-agent-id",
          "labels": ["category:feature-request"]
        },
        "reviewRequired": false,
        "spamReview": false
      },
      "spam_irrelevant": {
        "displayName": "Spam / Irrelevant",
        "priority": "low",
        "workflow": null,
        "responseTemplate": null,
        "spamReview": true,
        "reviewRequired": true
      }
    }
  }
}
```

This is company-scoped config in `plugin_config`. Each QSL company (TheBinMap, QSL Security Ops, SELARIX) writes its own taxonomy. The core engine enforces the taxonomy; source adapters only provide hints.

### 3.9 The Issue → Workflow → Human Review → Resolution Pattern

This pattern **remains identical regardless of the communication source**. The proof:

| Stage | Email | Webform | GitHub | API | Contact Form |
|---|---|---|---|---|---|
| **Issue** | `originKind: intake:email` | `originKind: intake:webform` | `originKind: intake:github` | `originKind: intake:api` | `originKind: intake:contact` |
| **Workflow** | Category-specific SOP in description | Category-specific SOP in description | Category-specific SOP in description | Category-specific SOP in description | Category-specific SOP in description |
| **Human Review** | Board reviews in issue tab, reviews response draft, confirms send | Board reviews in issue tab, reviews response, confirms action | Board reviews in issue tab, decides (close/add label/reply) | Board reviews in issue tab, decides (accept/reject) | Board reviews in issue tab, reviews response draft, confirms send |
| **Resolution** | `done` (reply sent) / `cancelled` (spam) | `done` (processed) / `cancelled` (spam) | `done` (triaged) / `cancelled` (spam) | `done` (accepted) / `cancelled` (rejected) | `done` (replied) / `cancelled` (spam) |

The only difference is the **response channel** and the **review action label**:
- Email: "Send approved reply" (SMTP)
- Webform: "Confirm submission" (redirect/email)
- GitHub: "Add comment" (API callback)
- API: "Accept" (JSON response)
- Contact form: "Send response" (email)

This is a UI label difference, not an architectural difference.

---

## 4. Migration Strategy

### 4.1 Non-Breaking, Incremental, Reversible

The migration from `plugin-email` (monolithic) to `plugin-intake` (core) + `plugin-email` (adapter) follows three phases. Each phase is independently deployable and reversible.

### 4.2 Phase M1: Extract Core Engine (backward compatible)

**Goal:** Create `plugin-intake` without changing `plugin-email`.

**What happens:**
1. Create `@qsl/plugin-intake` package with the core engine
2. The core engine is a **new** plugin — it does not replace `plugin-email`
3. The core engine can be installed alongside `plugin-email` with no interference
4. Test the core engine with a dummy source adapter to verify the pipeline
5. `plugin-email` continues to operate unchanged

**Risk:** None. `plugin-intake` is additive. `plugin-email` is untouched.

**Exit gate:** `plugin-intake` installed and healthy. Dummy intake → issue creation works. Tests pass.

### 4.3 Phase M2: Refactor plugin-email to Use Core Engine

**Goal:** `plugin-email` becomes a thin source adapter that delegates to `plugin-intake`.

**What happens:**
1. `plugin-email`'s `ingestMessage()` calls `plugin-intake`'s core engine instead of directly creating issues
2. `plugin-email`'s classification logic moves to config (taxonomy) in `plugin-intake`
3. `plugin-email`'s UI imports from `plugin-intake`'s shared UI components
4. Existing `plugin-email` config is migrated to `plugin-intake` taxonomy format
5. All existing `plugin-email` tests continue to pass (they test normalization, not the core engine)

**What changes for the operator:**
- `plugin-intake` taxonomy config replaces `plugin-email` classification config
- The dashboard widget and issue tab may look slightly different (shared UI components)
- The email loop continues to work identically

**What does NOT change:**
- IMAP polling, SMTP sending, thread management
- Issue `originKind` (still `plugin:qsl.email:intake` for backward compatibility)
- Existing EMA-1..32+ issues — they are untouched
- Secret bindings, budget, governance

**Exit gate:** `plugin-email` tests pass. Manual poll → issue created with correct fields. Same classification, same routing, same send flow.

### 4.4 Phase M3: Add New Source Adapters

**Goal:** New intake channels (webform, GitHub, API, etc.) are added as thin source adapters.

**What happens:**
1. `plugin-webform` created: Web3Forms webhook handler → `IntakeItem` → `plugin-intake` core engine
2. `plugin-github-intake` created: GitHub webhook handler → `IntakeItem` → `plugin-intake` core engine
3. Additional adapters as needed
4. Each adapter is independently installable/uninstallable

**Risk:** None. Each adapter is a new plugin. Removal of any adapter only affects that channel.

**Exit gate:** Each adapter passes its own tests. Webhook → issue created. Classification, routing, review all work through the core engine.

### 4.5 Migration Compatibility Matrix

| Component | Before Phase M1 | After Phase M1 | After Phase M2 | After Phase M3 |
|---|---|---|---|---|
| **plugin-email** | Standalone (v0.1.0) | Standalone (v0.1.0) | Thin adapter (v0.2.0) | Thin adapter (v0.2.0) |
| **plugin-intake** | Does not exist | New (v0.1.0) | Core engine (v0.1.0) | Core engine (v0.1.0) |
| **plugin-webform** | Does not exist | Does not exist | Does not exist | New (v0.1.0) |
| **plugin-github-intake** | Does not exist | Does not exist | Does not exist | New (v0.1.0) |
| **EMA issues** | Normal | Normal | Normal (same originKind) | Normal + new originKinds |
| **Email loop** | Works | Works | Works (identical) | Works (identical) |
| **New intake channels** | Not available | Not available | Not available | Available |

---

## 5. Risk Analysis

### 5.1 Architectural Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| A1 | The core engine abstraction is wrong — the `IntakeItem` interface misses source-specific requirements | Medium | High | Each source adapter retains its own `sourceMetadata` field (free-form JSON). The core engine passes it through unchanged. If a source needs special handling, the adapter can pre-process before calling the core engine. |
| A2 | Plugin-to-plugin dependency (plugin-email → plugin-intake) is fragile | Medium | Medium | Paperclip's plugin system supports plugin dependencies in the manifest. `plugin-intake` exposes a stable API for source adapters. Version pinning prevents breaking changes. |
| A3 | Config migration from plugin-email to plugin-intake taxonomy is lossy | Low | Medium | Phase M2 keeps both configs active during migration. The taxonomy is additive (new fields). Existing classification behavior is preserved through config mapping. |
| A4 | Performance regression from plugin-to-plugin RPC calls | Low | Low | The core engine runs in the same worker process as the source adapter (plugin-intake is a library, not a separate worker). The `IntakeItem` → issue pipeline is a local function call, not an RPC. |
| A5 | The `plugin.intake:*` originKind namespace conflicts with existing `plugin:qsl.email:intake` | Low | Low | Adapters choose their own `originKind`. Migration preserves existing `plugin:qsl.email:intake`. New adapters can use `plugin:qsl.intake:webform`, `plugin:qsl.intake:github`, etc. |

### 5.2 Migration Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| M1 | plugin-email refactor breaks existing email intake | Medium | **Critical** | Phase M1 leaves plugin-email completely untouched. Phase M2 refactors with a full test pass. Manual smoke test with real email before accepting. Phase M2 is reversible (reinstall plugin-email v0.1.0). |
| M2 | Existing EMA issues (EMA-1..32+) have stale thread records that the core engine can't read | Low | Medium | Thread records are in `plugin.state` scoped to `plugin-email`. The core engine reads from the same state namespace (configurable). No data migration is needed. |
| M3 | Operator confusion during taxonomy migration | Medium | Low | Phase M2 includes a migration guide. The operator configures taxonomy in one place (plugin-intake config) instead of two (plugin-email config + plugin-email code). The dashboard shows which version is active. |
| M4 | Send-gate accidentally weakened during refactor | Low | **Critical** | The send-gate is structural, not instructional. Phase M2 preserves the Board-only UI action. No agent send tool is registered. Tests verify the send-gate after every phase. |

### 5.3 Strategic Risks

| # | Risk | Mitigation |
|---|---|---|
| S1 | The abstraction layer adds complexity without proportional benefit | The core engine replaces ~1,000 lines of duplicated logic across future adapters. At 2+ adapters, the abstraction pays for itself. At 1 adapter (email only), the abstraction is premature. The decision to build the core engine should be gated on having at least 2 source adapters. |
| S2 | TheBinMap-specific logic leaks into the core engine | The taxonomy is config, not code. TheBinMap categories are one taxonomy instance. QSL Security Ops and SELARIX get their own taxonomies. The core engine enforces the taxonomy structure; it does not hardcode category names. |
| S3 | The intake platform becomes a maintenance burden | Each source adapter is ~100-200 lines. The core engine is ~1,000 lines. Total code: ~1,700 lines for 6 adapters vs. 1,400 lines for email alone. The multiplier is high: each new adapter costs ~100 lines, not 1,400. |
| S4 | Paperclip plugin system changes break the dependency chain | Plugin SDK is versioned. The core engine targets a specific SDK API version. Source adapters target the same version. SDK upgrades are coordinated across all intake plugins. |

---

## 6. Capability Harvest

Reusable capabilities extracted from the Email Company and generalized for the Intake Platform:

### 6.1 Core Capabilities (plugin-intake)

| Capability | Source | Input → Output | Reuse Pattern |
|---|---|---|---|
| `intakeNormalizer` | `worker.ts:ingestMessage()` + `normalize.ts:issueDescriptionFor()` | `IntakeItem` → formatted issue description with metadata, body, recommendations, workflow template | Every intake pipeline |
| `configurableClassifier` | `normalize.ts:classify()` → generalized to config-driven taxonomy | (sourceMetadata, taxonomy) → (category, confidence, priority) | Every intake pipeline |
| `intakeRouter` | `worker.ts:ingestMessage()` config fields | (category, taxonomy) → (projectId, assigneeAgentId, labels) | Every intake pipeline |
| `reviewManager` | `worker.ts:ingestMessage()` spam logic | (category, confidence) → (status, reviewRequired, spamReview) | Every intake pipeline |
| `evidencePreserver` | `worker.ts` activity log + metrics writes | (IntakeItem, issueId) → activity_log, metrics, source snapshot | Every intake pipeline |
| `intakeDashboard` | `ui/index.tsx:EmailMetricsWidget` → generalized | (companyId) → (queue depth, pending review, per-source metrics) | Every intake pipeline |
| `intakeIssueTab` | `ui/index.tsx:EmailIssueTab` → generalized | (issueId) → (source record, response draft, review action) | Every intake pipeline |
| `boardSendGate` | `worker.ts:send-reply` → generalized | (issueId, draft) → (response action, audit record) | Every governed outbound pipeline |

### 6.2 Source Adapter Capabilities (per adapter)

| Capability | Adapter | Reuse Pattern |
|---|---|---|
| `imapIngestion` | plugin-email | Any IMAP-based intake (support, monitoring, alerts) |
| `smtpOutbound` | plugin-email | Any SMTP-based response (governed send) |
| `webhookIngestion` | plugin-webform, plugin-github-intake | Any webhook-based intake (forms, GitHub, Stripe, Linear) |
| `apiIngestion` | plugin-api-intake | Any authenticated API intake (internal tools, partner integrations) |
| `eventIngestion` | (future) | Any platform-event-based intake (issue.created → sync to external system) |

---

## 7. Recommended PAPERCLIP-005 Implementation Phases

### 7.1 Gating Decision

Before any implementation, the Board must decide:

**Condition for building the Governed Intake Platform:**

> The core engine (`plugin-intake`) should be built when QSL has **at least 2 active intake channels** (email + one additional). If email is the only intake channel for the foreseeable future, the core engine is premature — `plugin-email` alone is sufficient.

**Today's reality:** Email is the only active intake channel. Webform intake (Web3Forms) is a future need. GitHub intake is speculative. The Board should decide whether to proceed with the core engine now or defer until a second intake channel is actually needed.

### 7.2 Recommended Phases (if Board approves)

| Phase | Item | Effort | Dependencies | Risk |
|---|---|---|---|---|
| **PAPERCLIP-005.1** | **plugin-intake core engine** | 8h | None (new plugin) | Medium (first plugin-to-plugin dependency) |
| PAPERCLIP-005.1a | Core engine: IntakeItem types, normalizer, issue factory | 3h | None | Low |
| PAPERCLIP-005.1b | Core engine: Configurable classifier + taxonomy validation | 2h | 005.1a | Low |
| PAPERCLIP-005.1c | Core engine: Router, review manager, evidence preserver | 2h | 005.1a, 005.1b | Low |
| PAPERCLIP-005.1d | Core engine: Shared UI (dashboard, issue tab, metrics) | 3h | 005.1a (can be parallel) | Low |
| PAPERCLIP-005.1e | Core engine: Tests (engine, classifier, normalizer, router) | 3h | 005.1a-d | Low |
| **PAPERCLIP-005.2** | **plugin-email refactor to use core engine** | 4h | 005.1 | Medium (must not break email loop) |
| PAPERCLIP-005.2a | Extract email classifier to config (taxonomy) | 1h | 005.1b | Low |
| PAPERCLIP-005.2b | Refactor ingestMessage() to call core engine | 1h | 005.1a | Medium |
| PAPERCLIP-005.2c | Refactor UI to use shared components | 1h | 005.1d | Low |
| PAPERCLIP-005.2d | Config migration + backward compatibility | 1h | 005.2a-c | Medium |
| **PAPERCLIP-005.3** | **plugin-webform (Web3Forms adapter)** | 3h | 005.1 | Low |
| **PAPERCLIP-005.4** | **plugin-github-intake (GitHub adapter)** | 3h | 005.1 | Low |
| **PAPERCLIP-005.5** | **Additional adapters as needed** | 2-3h each | 005.1 | Low |

**Total PAPERCLIP-005 (including email refactor):** ~25 hours
**PAPERCLIP-005.1 only (core engine, no email refactor):** ~16 hours

### 7.3 Alternative: Deferred Approach

If the Board decides to defer the core engine, the recommended approach is:

1. **Complete PAPERCLIP-003** (Email Company Tier 1+2 improvements) — this makes plugin-email as good as it can be standalone
2. **Build the first non-email source adapter** (e.g., plugin-webform) as a standalone plugin that copies the intake pattern from plugin-email
3. **When a second non-email adapter is needed**, extract the common pattern into plugin-intake

This approach defers the abstraction cost until the duplication is real. It is the lower-risk, lower-investment path.

---

## 8. Decision Matrix

| Approach | Effort | Risk | Reusability | Time to Value |
|---|---|---|---|---|
| **A: Build core engine now (PAPERCLIP-005.1)** | 16h | Medium | High (all future adapters benefit) | 2-3 weeks (no immediate new intake channel) |
| **B: Build core engine + refactor email (PAPERCLIP-005.1-2)** | 20h | Medium-High | High | 3-4 weeks (email benefit is UX unification only) |
| **C: Defer core engine, build standalone adapters** | 3-6h per adapter | Low | Low (duplication per adapter) | 1 week per adapter |
| **D: Defer entirely, complete PAPERCLIP-003 first** | 0h (architecture) | None | N/A | Immediate (PAPERCLIP-003 delivers value now) |

**Recommended: Approach D (defer) → Approach C (first new adapter) → Approach A (second adapter triggers core engine extraction).**

This is TheBinMap's own engineering doctrine in action: "Reuse before build. New code is the LAST option." The core engine is a `needs-build` item. We have not yet proven that options 1-4 (existing capability, existing fork, OSS, extension) are insufficient because we have not yet attempted to build a second intake adapter. The right time to extract the core engine is when we have actual duplication, not anticipated duplication.

---

## Relationship to the Organizational Operating Loop

The Governed Intake Platform operates within the Organizational Operating Loop adopted by QuantumShield Labs.

Its primary responsibility is to transform external events into structured organizational evidence.

Once normalized into an IntakeItem, work proceeds through the organization's standard operational lifecycle of proposal, execution, review, closure, and harvest.

The Intake Platform is therefore an operational subsystem of the Organizational Operating Loop rather than an independent workflow.

---

## 9. Conclusion

### 9.1 The Answer

**Yes, the Email Company architecture can evolve into the canonical Governed Intake Platform for QuantumShield Labs.** The pattern is proven, the plugin SDK supports every intake mechanism, the issue model is already generic, and the email-specific code is clearly bounded (4 of 10 components, ~500 of 1,400 lines).

### 9.2 The Timing

**Not yet.** The core engine abstraction is correct but premature. The rule is: extract the abstraction when you have 2+ concrete implementations that share the pattern. Today we have 1 (email). The first non-email adapter (webform, GitHub, API) should be built as a standalone plugin that copies the pattern. When the second non-email adapter is needed, the common pattern is extracted into the core engine.

### 9.3 The Invariant

**The `Issue → Workflow → Human Review → Resolution` pattern is identical regardless of the communication source.** The intake lifecycle is source-agnostic. The only differences are the ingestion mechanism and the response channel — both of which are adapter-level concerns, not core engine concerns.

### 9.4 The Path Forward

1. **Complete PAPERCLIP-003** (Email Company Tier 1+2 improvements). Make plugin-email the best reference implementation it can be.
2. **Build the first non-email adapter** (e.g., plugin-webform for Web3Forms) as a standalone plugin. Learn from the duplication.
3. **When a second non-email adapter is needed**, extract the Governed Intake Platform core engine (plugin-intake) from the three concrete implementations.
4. **Migrate plugin-email and the standalone adapters** to use the core engine.

---

---

## Human Board Resolution

**Status:** APPROVED WITH AMENDMENTS

PAPERCLIP-004 is adopted as the architectural direction for future governed intake capabilities.

The existing Email Company remains the canonical reference implementation until multiple operational intake adapters justify extraction of a shared intake engine.

Implementation shall continue to follow the Proving Ground Principle.

Approved by:

Human Board

Date:

2026-07-30

---
*Architecture evaluation complete. Stopping for Board approval as directed by STOP CONDITION.*