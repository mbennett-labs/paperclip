# Email Company Operational Assessment — TheBinMap Intake Center

> **Status:** Assessment accepted as discovery deliverable. Board amendments applied. Awaiting Tier 1 implementation authorization.
> **Date:** 2026-07-29
> **Audience:** Board (QuantumShield Labs)
> **Mission ID:** PAPERCLIP-002
> **Repo branch:** `feat/qsl-current-upstream-integration`
> **Source files audited:** `packages/plugins/plugin-email/**`, `docs/qsl/**`, `doc/plans/**`, `server/**` templates
> **Board amendments applied:**
> 1. T1-C replaced: auto-close spam rejected. Recoverable spam-review state (`in_review`, Board disposition required) per §5.1 T1-C.
> 2. T1-G added: operator recommendation field per §5.1 T1-G.
> 3. Send-gate prohibition: agents draft, Board sends — non-negotiable invariant per §10.3.

---

## 1. Reality Discovery Report

### 1.1 Deployment Context

The Email Company is **one Paperclip company** (id `15f8fb0a-065d-4e2b-9d24-a49d986dcaf8`, prefix `EMA`) running on the QSL fork branch `feat/qsl-current-upstream-integration`. It is not a separate codebase, agent, or service. It is a usage pattern for a Paperclip company powered by the `@qsl/plugin-email` plugin.

| Dimension | Reality |
|---|---|
| Instance | `email-clean-20260719`, `127.0.0.1:3100`, `local_trusted` |
| Database | Embedded PGlite, hourly backups |
| Plugins | `qsl.email` v0.1.0 (workspace package, local-path install) |
| Mail profile | Gmail operational inbox (`mikebennett637@gmail.com`) via IMAP/SMTP |
| Secret binding | `gmail-operational-inbox-app-password` (local_encrypted) |
| Poll schedule | `poll-inbox` job, cron `*/5 * * * *` |
| Agents | Email Operations Lead (CEO), Intake Triage, Comms Drafter, Ops Analyst — all idle (test-only per R4) |
| Skills | `email-triage-sop`, `outbound-drafting-sop`, `escalation-and-approval-rules` |
| Routines | `morning-ops-brief`, `weekly-comms-review` — deferred to promotion gate |
| Budget | $50/mo company, per-agent budgets configured |
| Governance gate | Board-approved hires, Board-only sends |

### 1.2 Complete File Inventory

| Category | File | Lines | Role |
|---|---|---|---|
| **Worker** | `packages/plugins/plugin-email/src/worker.ts` | 508 | Core engine: poll, ingest, send-reply, actions, health |
| **Normalization** | `packages/plugins/plugin-email/src/mail/normalize.ts` | 187 | Classify (13 hints), venture routing, priority mapping |
| **IMAP** | `packages/plugins/plugin-email/src/mail/imap.ts` | 135 | Fetch unseen, mark seen/replied, validate connectivity |
| **SMTP** | `packages/plugins/plugin-email/src/mail/smtp.ts` | 54 | Send reply with threading headers, validate connectivity |
| **Constants** | `packages/plugins/plugin-email/src/constants.ts` | 39 | Plugin identity, DEFAULTS, JOB_KEYS, origin kind |
| **Manifest** | `packages/plugins/plugin-email/src/manifest.ts` | 144 | Plugin declaration, config schema, UI slots |
| **UI** | `packages/plugins/plugin-email/src/ui/index.tsx` | 193 | Issue tab, dashboard widget, Board send action |
| **Tests** | `packages/plugins/plugin-email/tests/normalize.spec.ts` | 338 | Classification, venture routing, priority, title/desc |
| **Docs** | `docs/qsl/implementation/EMAIL_COMPANY_COMPLETION_MISSION_2026-07-27.md` | 287 | Architecture, gap analysis, implementation log |
| **Docs** | `docs/qsl/implementation/EMAIL_COMPANY_LIVE_ARCHITECTURE_AND_PLAN_2026-07-19.md` | 259 | Original architecture design |
| **Docs** | `docs/qsl/audits/FIRST_PRODUCTION_LOOP_EVIDENCE_2026-07-27.md` | 77 | First loop evidence record |
| **Docs** | `docs/qsl/pins/TECHNICAL_PIN_2026_07_27_FIRST_GOVERNED_PRODUCTION_LOOP.md` | 234 | Milestone declaration |
| **Docs** | `doc/plans/2026-07-08-thebinmap-intelligence-constitution.md` | 621 | Venture constitution |
| **Docs** | `docs/qsl/operations/PAPERCLIP_OPERATOR_GUIDE.md` | 541 | Day-to-day operations |
| **Templates** | `server/QSL-Email-Triage-Template-v1.0.md` | — | Triage note template |
| **Templates** | `server/Email-Productivity-Implementation-Checklist.md` | — | Productivity checklist |

### 1.3 Data Flow (verified live)

```
TheBinMap Inbound (Web3Forms + Hostinger forward → Gmail)
        │
        ▼ IMAP UNSEEN (imapflow, UID cursor)
plugin-email worker poll-inbox
        │
        ▼ normalizeMessage() — identity, snippet, classHint, ventureHint
        │
        ▼ dedup: SHA-1(profile:messageId) → plugin.state
        │
        ▼ create issue → Intake project, assign Intake Triage
        │  originKind: plugin:qsl.email:intake
        │  originId: <message-id>           (idempotent replay)
        │  billingCode: mission:email-ops   (cost attribution)
        │
        ▼ markSeen (IMAP \Seen flag)
        │
        ▼ Intake Triage classifies → routes → may escalate to Drafter
        │
        ▼ Communications Drafter → reply-draft document (draft only)
        │
        ▼ Board reviews in UI "Email" tab → "Send approved reply"
        │
        ▼ SMTP (nodemailer, In-Reply-To/References threading)
        │  → issue comment as permanent send record
        │  → IMAP \Answered + archive move
        │
        ▼ done | cancelled (terminal disposition)
```

### 1.4 Classification System

The heuristic classifier in `normalize.ts:67-90` uses keyword matching against subject, fromAddress, and first 4,000 characters of body. It produces one of 13 `MessageClassHint` values returned as the `classHint` field. The Intake Triage agent assigns the **authoritative** class; the hint is pre-labeling for routing and metrics.

| Hint | Keywords/Patterns | Priority |
|---|---|---|
| `store_submission` | web3forms sender OR "store submission" OR ("store name" + "address") | medium |
| `listing_claim` | "claim" (in subject or body) OR web3forms + "role:" | **high** |
| `store_alert_signup` | "alert" OR "restock" OR "notify me" | medium |
| `newsletter_signup` | "newsletter" OR "subscribe" OR "stay in the loop" | medium |
| `intelligence_request` | "intelligence" OR "data report" | **high** |
| `contact_general` | "contact" OR "question" OR "inquiry" OR "hello" | medium |
| `partnership_affiliate` | "affiliate" OR "partner" OR "wholesale" OR "supplier" | medium |
| `spam_irrelevant` | "spam" OR "unsubscribe" | **low** |
| `correction` | "correction" OR "wrong" OR "error" | medium |
| `customer_inquiry` | "customer" OR "order" | medium |
| `sales_opportunity` | "sales" OR "opportunity" | medium |
| `support_request` | "support" OR "help" | medium |
| `unknown` | (catch-all fallback) | medium |

### 1.5 Venture Routing

`ventureOf()` in `normalize.ts:92-99` assigns one of three venture hints:
- **`thebinmap`**: To/From/Subject/Body contains `@thebinmap.com` or `thebinmap`
- **`qsl`**: To contains `@quantumshield` or `@qsl`
- **`unknown`**: no recognized domain

### 1.6 Current Limitations (by design, not omission)

1. **Single mailbox profile only** — the Gmail operational inbox. Per-mailbox Hostinger profiles are deferred to configuration, not a code change.
2. **No attachment ingestion** — body text only; attachments are invisible to the intake pipeline.
3. **No auto-acknowledgement** — every reply is Board-sent; there is no automated "we received your message" response.
4. **No Web3Forms direct webhook** — Web3Forms delivers to Gmail via notify+xxx@web3forms.com; no direct webhook intake exists.
5. **No calendar integration** — no scheduling of follow-ups from email.
6. **Test-only agents** — Intake Triage, Drafter, and Analyst are hired but idle (Board ruling R4).

---

## 2. Operational Assessment

### 2.1 What Works (Verified)

| Component | Status | Evidence |
|---|---|---|
| IMAP polling | Operational | EMA-7,8,9 created 2026-07-27 |
| Deduplication | Operational | SHA-1 key in plugin state; idempotent re-polls |
| Issue creation with metadata | Operational | originKind, originId, billingCode all populated |
| Classification (heuristic) | Operational | 13 hints tested in normalize.spec.ts |
| Venture routing | Operational | thebinmap/qsl/unknown tested |
| Board-gated send | Operational | send-reply action works; agents have no send tool |
| Thread metadata preservation | Operational | ThreadRecord stored per-issue |
| Dashboard widget | Operational | Email intake metrics rendered in UI |
| Issue detail tab | Operational | Inbound record, draft preview, send button |
| Activity logging | Operational | Every intake, poll, and send writes activity |
| Metrics | Operational | messages_ingested, replies_sent counters |

### 2.2 What Partially Works

| Component | Status | Gap |
|---|---|---|
| Agent loop | Proven (EMA-5, EMA-7/8/9) | Agents idle per R4; full production flow untested on real business email |
| Triage classification | DeepSeek classified correctly but failed API mechanics (EMA-8/9) | Model upgraded to kimi-k3 for Triage; V3.1 trial pending under R6 |
| Send path | Board UI works | No bulk-send; one issue at a time |
| Evidence capture | Loop evidence template exists | Populated only for EMA-7/8/9 test run; not automated |

### 2.3 What Is Missing

| # | Gap | Severity | Blocking? |
|---|---|---|---|
| G1 | Routines: `morning-ops-brief`, `weekly-comms-review` | Medium | Not blocking — agents can wake manually |
| G2 | No articulated workflow per category (TheBinMap-specific) | Medium | Not blocking — agents use SOPs; category routing is generic |
| G3 | No structured extraction (field parsing for store_names, addresses, etc.) | Medium | Not blocking — raw body is available; Triage can extract |
| G4 | No auto-classification confidence score | Low | Not blocking — hints are pre-labels |
| G5 | No operator dashboard for intake review (beyond widget) | Low | Not blocking — issue queue is the review surface |
| G6 | No attachment handling | Low | Not blocking — most inbound is text |
| G7 | No multi-venture dashboard filtering | Low | Not blocking — single venture (TheBinMap) today |
| G8 | No spam/irrelevant auto-close | Low | Not blocking — Triage handles |

---

## 3. Email Company Strengths

### 3.1 Architectural Strengths

1. **Config-driven, not code-driven.** The profile-based connector architecture means future mailboxes (privacy@, legal@, support@) are new profile rows in `extraProfilesJson` — zero code changes.

2. **Company-scoped by construction.** `resolveActiveCompanies()` iterates all companies with enabled config. A second Paperclip company gets email operations by writing its own config; the worker is untouched.

3. **Send-gate is structural, not instructional.** The plugin registers **no agent send tool**. Agents cannot send — they draft `reply-draft` documents. The Board invokes `send-reply` from the UI. This is stronger than instruction-level policy.

4. **Idempotent intake.** `originId: <message-id>` + `issues_company_origin_idx` prevents duplicate issues on re-poll, worker restart, or cursor reset. The SHA-1 dedup key in plugin state is a fast pre-check before the DB hit.

5. **Platform-native, not custom tables.** Email uses `issues`, `issue_comments`, `issue_documents`, `activity_log`, `plugins`, and `plugin.state` — no custom database tables. Upgrades, backups, and migrations are handled by the platform.

6. **Model-agnostic.** Models live only in `adapter_config` / issue overrides. No model ID appears in skill text, instructions, or code. Per R3 and R6.

7. **Evidence-first design.** Every intake writes activity + thread record. Every send writes activity + sent record + issue comment. Every poll writes activity + metrics + status. The complete loop is replayable from `activity_log` + `heartbeat_runs` + `cost_events`.

8. **Reusable as a capability, not a company.** The `@qsl/plugin-email` package is a self-contained connector with zero hardcoded assumptions about ventures, categories, or workflows. Future Mission Cells assemble it as one capability among many.

### 3.2 Operational Strengths

1. **15-minute review ritual is achievable.** The operator sees: dashboard widget (mail count), issue queue (what arrived), issue tabs (what was classified, what needs sending). Decision fatigue is low — send/no-send is the only Board action.

2. **Cost attribution is clear.** `billingCode: mission:email-ops` groups all email costs. Per-issue costs roll up through `cost_events`.

3. **Operator tooling exists.** Manual `poll-now`, `reset-cursor`, and `poll-inbox` scheduled job give the operator three levels of control.

4. **Dual-layer safety.** The plugin's dedup prevents double-intake. The DB's unique index on `(companyId, originKind, originId)` is the second safety layer.

5. **Audit trail is complete and immutable.** Send records are issue comments (never deleted). Intake records are activity entries. Thread metadata is preserved per-issue.

---

## 4. Operational Weaknesses

### 4.1 Classification System Weaknesses

1. **Heuristic-only classifier.** The `classify()` function in `normalize.ts:67-90` uses simple keyword substring matching. It has no:
   - Confidence scores (every match is binary)
   - Multi-label capability (a message cannot be both `store_submission` + `correction`)
   - Context awareness (order of checks matters — `listing_claim` is checked before `store_submission` for web3forms, which is correct but fragile)
   - Language/typo tolerance

2. **Store Submission vs. Claim confusion.** A web3forms message containing both "store name" and "claim" is classified as `listing_claim`; if it contains "store name" + "address" but also "wrong", it's still `store_submission` (not `correction`). The single-class hierarchy loses information.

3. **TheBinMap-specific categories are implicit.** The classifier knows about `store_submission`, `listing_claim`, `store_alert_signup` — but these are derived from keyword heuristics, not from TheBinMap's actual intake taxonomy. A "vendor contact" email and a "partnership inquiry" are both `partnership_affiliate` — no distinction.

4. **No classification validation feedback loop.** When the Intake Triage agent overrides a hint (e.g., reclassifies `contact_general` → `support_request`), the plugin never learns from this. The heuristic stays static.

### 4.2 Operational Workflow Weaknesses

5. **No per-category workflow templates.** Every email becomes an issue in the Intake project assigned to Intake Triage. The Triage agent has SOPs, but the SOPs are general. A `store_submission` should trigger a different workflow than a `partnership_affiliate` — different data to extract, different routing, different review criteria.

6. **No structured extraction.** The email body is stored verbatim (truncated at 20k chars). There is no extraction of structured fields: store name, address, hours, inventory, claim details, correction target, etc. The Triage agent must re-parse the raw email every time.

7. **No spam review workflow.** `spam_irrelevant` is assigned `low` priority but still enters the Triage agent's active queue. The operator has no dedicated spam review surface where suspected spam can be batch-reviewed and disposed. Auto-close was considered and explicitly rejected by the Board — all dispositions must be Board-reviewed.

8. **No SLA/timeliness tracking.** There is no concept of "response expected within X hours." A `listing_claim` from a store owner has different urgency than a `newsletter_signup`. The priority field (`high`/`medium`/`low`) is the only signal — no deadline.

9. **No duplicate thread detection.** Two emails from the same sender with `In-Reply-To: null` but the same subject are treated as independent. A sender who emails twice about the same listing claim creates two issues.

10. **No sender history/precedence.** The system does not check whether `fromAddress` has contacted before. A repeat customer and a first-time spammer look the same.

### 4.3 UI/Operator Experience Weaknesses

11. **Dashboard widget is metrics-only.** The `EmailMetricsWidget` shows counts — not what arrived recently, what needs action, or what's blocked. The operator must navigate to the Intake project's issue list.

12. **No "Needs My Action" view.** The operator has no single surface showing: unreviewed intake, drafts awaiting send, replies overdue. The issue queue is the review surface, but it's not filtered by urgency.

13. **No batch send.** The operator must open each issue → Email tab → Confirm send. For 5 newsletter signups that all need the same "Welcome" template, this is repetitive.

14. **No template library.** Reply drafts are produced fresh by the Comms Drafter. Common replies (welcome to newsletter, store submission received, claim verification) have no reusable templates.

15. **The Email tab renders with raw inline styles.** The UI works but does not use Paperclip's design tokens — it uses raw CSS with hardcoded hex values (`#c0392b`, `#1e8449`, `rgba(127,127,127,0.35)`). This violates the design system token-only rule.

### 4.4 Evidence and Replay Weaknesses

16. **No screenshot/artifact capture.** The first-loop evidence record (EMA-7/8/9) is in a markdown file with manual field population. There is no automated evidence capture or artifact attachment to loop-completion.

17. **No loop-completion check.** An issue with `classHint: intelligence_request` and `priority: high` that sits in `todo` for 8 hours has no alert. There is no watchdog monitoring the email issue queue.

18. **No weekly metrics summary.** The `weekly-comms-review` routine is deferred. There is no automated report on: intake volume by category, average time-to-review, send rate, cost per category.

### 4.5 Coverage Gaps in TheBinMap Categories

The mission calls out 10 TheBinMap-specific categories. Let me map each to the current system:

| Category | Classification | Extraction | Workflow | Approval | Gap |
|---|---|---|---|---|---|
| Store submissions | `store_submission` | Raw body only | Generic → Triage | Standard review | No field extraction; no submission confirmation template |
| Listing claims | `listing_claim` | Raw body only | Generic → Triage | Standard review | No claim verification workflow; no ownership validation |
| Store corrections | `correction` | Raw body only | Generic → Triage | Standard review | No correction verification; no source update path |
| Newsletter signups | `newsletter_signup` | Raw body only | Generic → Triage | Standard review | No signup-list add action; no welcome template |
| Intelligence subscriptions | `intelligence_request` | Raw body only | Generic → Triage | Standard review | No subscription tier mapping; no deliverable path |
| Partnership inquiries | `partnership_affiliate` | Raw body only | Generic → Triage | Standard review | No qualification checklist; conflated with vendor contacts |
| Customer support | `support_request` | Raw body only | Generic → Triage | Standard review | No ticket tracking; no resolution SLA |
| Vendor contacts | `partnership_affiliate` | Raw body only | Generic → Triage | Standard review | Conflated with partnership; different workflow needed |
| Unknown email | `unknown` | Raw body only | Generic → Triage | Standard review | No "what is this" classification prompt |
| Spam/irrelevant | `spam_irrelevant` | Raw body only | Generic → Triage, spam-review state recommended (T1-C) | Board spam review | Creates an issue that requires operator disposition; recoverable review state proposed |

---

## 5. Recommended Improvements

Improvements are presented in three tiers. **Tier 1** items are self-contained, low-risk, backward-compatible, and operationally valuable — candidates for immediate approval. **Tier 2** items require moderate design work and are candidates for the next sprint. **Tier 3** items are architectural and deferred.

### 5.1 Tier 1 — Immediate (self-contained, low risk, high value)

#### T1-A: Heuristic Classifier Refinement

**What:** Expand `classify()` in `normalize.ts` with additional keyword patterns and fix ordering edge cases.

**Changes:** 3-5 lines per new keyword group. Add:
- "vendor" + "supply" → `partnership_affiliate` (separate from generic "partner")
- "claim" + "wrong" + "correct" → `correction` (override `listing_claim`)  
- "signup" + "intelligence" → `intelligence_request` (separate from `newsletter_signup`)
- "bug" OR "broken" → `support_request` (wider net)
- Add `contact_general` check for `spr_irrelevant` false positives ("unsubscribe" in footer ≠ spam)

**Risk:** Very low. Existing tests cover all categories. Add 5-8 new test cases.
**Files touched:** `normalize.ts` (5-10 lines), `normalize.spec.ts` (30-50 lines)
**Backward compatible:** Yes — adds precision, does not change existing match ordering.

#### T1-B: Add `confidence` field to `MessageClassHint` output

**What:** `classify()` currently returns one of 13 strings with no confidence indicator. Add a `confidence: "high" | "medium" | "low"` field to `NormalizedMessage` based on how many keyword signals matched.

**Example:**
- "store name" + "address" + web3forms sender = confidence "high"
- "store name" only = confidence "medium"
- catch-all "unknown" = confidence "low"

**Risk:** Very low. Additive field, no schema change. The Triage agent can use it for priority.
**Files touched:** `normalize.ts` (10-15 lines), `normalize.spec.ts` (15-20 lines)
**Backward compatible:** Yes — new optional field, existing consumers unaffected.

#### T1-C: Recoverable Spam-Review State (replaces original auto-close proposal)

> **Board amendment:** Auto-close is rejected. Spam must never be closed without explicit Board review. Replace with a recoverable spam-review state where the operator can batch-dispose quickly while preserving the audit trail.

**What:** When `classHint === "spam_irrelevant"` AND `confidence === "high"`, create the issue as `in_review` with a "Needs spam review" label or workflow tag. The issue description includes an "Operator recommendation: review for spam — high confidence heuristic match." The operator sees these in the dashboard widget as a distinct count ("Awaiting spam review") and can batch-dispose them with a single Board action per issue. The issue is **never** auto-closed — the Board always makes the final disposition.

**Recoverable design:** Issues marked for spam review remain `in_review`, visible in the operator's queue, and reopenable. The operator can:
- Confirm spam → set `done` with comment "Board confirmed: spam"
- Reclassify → change status back to `todo` for Triage, remove spam-review label
- Defer — leave in `in_review` for later batch review

**Risk:** Very low. Creates issues in `in_review` instead of `todo` for spam-like mail; the Triage agent is not woken for these. The operator still has final say. The audit trail is preserved for every disposition.
**Files touched:** `worker.ts` (10-15 lines), `normalize.ts` (confidence field from T1-B), `ui/index.tsx` (dashboard spam count)
**Backward compatible:** Yes — spam was already `low` priority; now it surfaces in a review queue instead of the active work queue.

#### T1-D: Operator "Needs Action" Dashboard Widget Enhancement

**What:** Enhance `EmailMetricsWidget` to show:
1. Count of issues in `todo`/`in_review` in the Intake project
2. Count of issues with `reply-draft` documents awaiting Board send
3. Time since last poll and next scheduled poll

**Risk:** Low. Read-only UI enhancement. No new API calls (data already available through plugin data providers).
**Files touched:** `ui/index.tsx` (30-50 lines)
**Backward compatible:** Yes — additive widget content.

#### T1-E: Sender History Check

**What:** Before creating a new intake issue, check if `fromAddress` has previous issues in the company (search by `originId` pattern or check thread records). Include sender history in the issue description: "**Previous contact:** EMA-12 (2026-07-15, listing_claim), EMA-8 (2026-07-10, store_submission)".

**Risk:** Medium. Requires cross-issue state lookup. The plugin has company-scoped state access. Implementation: iterate plugin state keys for thread records matching fromAddress, or add a `sender-index` state namespace.
**Files touched:** `worker.ts` (20-30 lines)
**Backward compatible:** Yes — additive metadata on new issues.

#### T1-F: Structured Extraction for Store Submissions and Claims

**What:** Add a lightweight extraction function in `normalize.ts` that attempts to parse structured fields from the email body when `classHint` matches known patterns:

For `store_submission`:
- store_name (regex: `store name[:\s]+(.+)`)
- address (regex: `address[:\s]+(.+)`)
- city, state, zip
- hours
- description

For `listing_claim`:
- store_name (same pattern)
- claimer_name, claimer_email
- role (owner, employee, manager)
- evidence_provided (free text)

**Risk:** Low. No schema change — extracted fields are appended to the issue description as a structured markdown table. The extraction is best-effort; the Triage agent validates.
**Files touched:** `normalize.ts` (40-60 lines), `normalize.spec.ts` (40-60 lines)
**Backward compatible:** Yes — additive description content.

#### T1-G: Operator Recommendation Field

> **Board amendment:** Every intake issue must include an operator-facing recommendation so the Board can triage at a glance without reading the full email body.

**What:** Add an `operatorRecommendation` field to the issue description produced by `issueDescriptionFor()`. Based on `classHint`, `confidence`, and sender history, the plugin suggests one of:

| Recommendation | Condition | Meaning |
|---|---|---|
| `review-immediately` | `priority: high` OR `classHint: intelligence_request, listing_claim` | Urgent — open now |
| `review-soon` | `priority: medium`, sender is known, non-spam | Within 24 hours |
| `review-when-available` | `priority: medium`, sender is unknown, low confidence | Backlog material |
| `needs-spam-review` | `classHint: spam_irrelevant` | Board spam review queue |
| `no-action-required` | `newsletter_signup`, `store_alert_signup` | Archive, no reply needed |
| `needs-reply` | Any category where inbound expects a response | Drafter should prepare |
| `unknown-needs-triage` | `classHint: unknown`, low confidence | Triage agent must classify first |

The recommendation is rendered as a prominent callout at the top of the issue description:

```
> **Operator recommendation:** review-soon — medium priority, known sender, likely store submission.
```

**Risk:** Very low. Additive field in issue description; heuristic-only recommendation; the Board always overrides.
**Files touched:** `normalize.ts` (20-30 lines for recommendation logic), `normalize.spec.ts` (15-20 lines)
**Backward compatible:** Yes — additive description content.

### 5.2 Tier 2 — Next Sprint (moderate design, high value)

#### T2-A: Per-Category Workflow Templates

**What:** Each `classHint` maps to a workflow template that the issue description includes as SOP directives. Instead of the generic "Triage per email-triage-sop", include category-specific instructions:

```
## Workflow: store_submission
1. Verify store does not already exist in TheBinMap DB
2. Extract: name, address, hours, description, source
3. Create verification task for field team (if applicable)
4. Draft acknowledgement to submitter (template: store-submission-received)
5. Assign to Intake Triage for classification review
6. Board reviews and sends acknowledgement
```

The template text lives in a constants map in `normalize.ts`, not in agent instructions.

**Risk:** Low. Additive description content. Templates are human-authored and Board-reviewed.
**Files touched:** `normalize.ts` (80-120 lines for template map)
**Backward compatible:** Yes — additive.

#### T2-B: Reply Template Library

**What:** Store common reply templates as `issue_documents` with key `reply-template:<category>`. The Comms Drafter reads the template and customizes it instead of drafting from scratch.

**Templates needed:**
- `store-submission-received`: "Thanks for submitting... we'll review..."
- `listing-claim-received`: "Thanks for claiming... verification in progress..."
- `newsletter-welcome`: "Welcome to TheBinMap newsletter..."
- `correction-received`: "Thanks for the correction... we'll verify..."
- `general-inquiry-received`: "Thanks for contacting TheBinMap..."

**Risk:** Low. Uses existing `issue_documents` mechanism. Templates are Markdown files.
**Files touched:** New template files (company skills or issue documents), `ui/index.tsx` (template selector)
**Backward compatible:** Yes — additive.

#### T2-C: Routine Activation (`morning-ops-brief`, `weekly-comms-review`)

**What:** Activate the two deferred routines. These use Paperclip's native routine system (cron → issue).

**Risk:** Low (platform feature, already designed). The routines were deferred only due to staged rollout (R4), not risk.
**Files touched:** Routine configuration (board action via API), no code
**Backward compatible:** Yes — new issue paths, no code changes.

#### T2-D: Per-Category Issue Routing (not just Intake project)

**What:** Based on `classHint`, create the intake issue in a category-specific project or with category-specific labels:
- `store_submission` → Intake project + label `category:store-submission`
- `listing_claim` → Intake project + label `category:listing-claim`  
- `partnership_affiliate` → separate `Partnerships` project (when created)
- `customer_inquiry`/`support_request` → `Support` project (when created)

**Risk:** Medium. Requires config for project mapping or a convention-based approach. Single-project Intake works today; multi-project is future optimization.
**Files touched:** `worker.ts` (10-20 lines), `manifest.ts` (new config field), `normalize.ts` (project hint)
**Backward compatible:** Yes — default is current behavior (all → Intake).

#### T2-E: UI Token Standardization

**What:** Replace raw CSS inline styles in `ui/index.tsx` with Paperclip design tokens (CSS custom properties from `ui/src/index.css`).

**Risk:** Low. Pure style change. The plugin SDK has access to the host's CSS context.
**Files touched:** `ui/index.tsx` (style object replacement)
**Backward compatible:** Yes — visual only.

### 5.3 Tier 3 — Architectural (deferred, requires design review)

#### T3-A: Plugin-Level Classification Model

A small classification model (or LLM call with structured output) that replaces the heuristic classifier. Accepts `from`, `subject`, `body`, and returns `{ classHint, confidence, extracted_fields, suggested_priority, suggested_routing }`. Runs at plugin level, not agent level — classification happens before issue creation, not after.

#### T3-B: Web3Forms Direct Webhook Intake

A `webhooks.receive` endpoint in the plugin that receives Web3Forms POSTs directly, bypassing Gmail. Eliminates the Gmail polling dependency for the primary intake channel.

#### T3-C: Attachment Ingestion

Parse MIME attachments from IMAP fetches and attach them to the created issue as `issue_attachments`. Requires `bodyParts` fetch beyond `text` and integration with Paperclip's asset storage.

#### T3-D: Auto-Acknowledgement Engine

A Board-configured auto-reply for specific categories (newsletter signup, store submission) that sends an immediate acknowledgement while the full review is pending. Still Board-authorized (per-category enable/disable), but automated execution.

#### T3-E: Sender Reputation System

A scoring system based on sender history: reply rate, spam report rate, correction accuracy. New senders start at neutral; repeat valid submitters gain trust; repeat spammers are auto-filtered.

---

## 6. Priority-Ranked Roadmap

### Now (this sprint, Tier 1)

| # | Item | Effort | Impact | Risk |
|---|---|---|---|---|
| 1 | T1-A: Heuristic classifier refinement | 1h | Medium | Very low |
| 2 | T1-B: Confidence field | 30m | Medium | Very low |
| 3 | T1-C: Recoverable spam-review state | 1h | High | Very low |
| 4 | T1-D: Dashboard "Needs Action" | 1h | High | Very low |
| 5 | T1-E: Sender history check | 1h | Medium | Medium |
| 6 | T1-F: Structured extraction (store_submission, listing_claim) | 2h | High | Low |
| 7 | T1-G: Operator recommendation field | 45m | High | Very low |

**Total Tier 1: ~7.25 hours engineering, zero architecture risk.**

### Next (next sprint, Tier 2)

| # | Item | Effort | Impact | Risk |
|---|---|---|---|---|
| 7 | T2-A: Per-category workflow templates | 3h | High | Low |
| 8 | T2-B: Reply template library | 2h | High | Low |
| 9 | T2-C: Routine activation | 30m | Medium | Very low |
| 10 | T2-D: Per-category routing | 1h | Medium | Medium |
| 11 | T2-E: UI token standardization | 1h | Low | Very low |

**Total Tier 2: ~7.5 hours.**

### Later (deferred, Tier 3)

| # | Item |
|---|---|
| 12 | T3-A: Classification model |
| 13 | T3-B: Web3Forms webhook |
| 14 | T3-C: Attachment ingestion |
| 15 | T3-D: Auto-acknowledgement |
| 16 | T3-E: Sender reputation |

---

## 7. Reusable Capability Inventory

These are capabilities that can be extracted from the Email Company and reused by future Mission Cells. They are identified by function, not by file.

### 7.1 Classifiers

| Capability | Source | Input → Output | Reuse Pattern |
|---|---|---|---|
| `heuristicEmailClassifier` | `normalize.ts:classify()` | (subject, from, body) → category + confidence | Any intake pipeline (form submissions, chat, support tickets) |
| `domainVentureRouter` | `normalize.ts:ventureOf()` | (to, from, subject, body) → venture | Multi-venture deployments with domain-based routing |
| `priorityMapper` | `normalize.ts:priorityFor()` | category → priority | Any triage system with category→urgency mapping |

### 7.2 Parsers and Extractors

| Capability | Source | Input → Output | Reuse Pattern |
|---|---|---|---|
| `emailNormalizer` | `normalize.ts:normalizeMessage()` | raw IMAP envelope → NormalizedMessage | Any IMAP-based intake (support, monitoring, alerts) |
| `addressExtractor` | `normalize.ts:firstAddress()` | raw address header → normalized email | Any email processing pipeline |
| `structuredFieldExtractor` | T1-F (to build) | body + pattern → { field: value } | Form submissions, structured reports, alert parsing |
| `operatorRecommender` | T1-G (to build) | (classHint, confidence, senderHistory) → recommendation | Any intake pipeline needing operator triage hints |
| `replyDraftParser` | `worker.ts:parseReplyDraft()` | markdown body → { to, subject, text } | Any draft-to-send pipeline |

### 7.3 Validators

| Capability | Source | Input → Output | Reuse Pattern |
|---|---|---|---|
| `dedupByIdentity` | `worker.ts:seenKey()` + `ingestMessage()` | (namespace, id) → boolean (seen?) | Any idempotent intake pipeline |
| `idempotentOriginCheck` | `issues.originKind` + `originId` DB index | (originKind, originId) → existing issue | Any event-sourced intake |

### 7.4 Routing Logic

| Capability | Source | Input → Output | Reuse Pattern |
|---|---|---|---|
| `configScopedRouting` | `worker.ts:buildProfiles()` + `resolveActiveCompanies()` | company config → active profiles | Multi-tenant connectors with per-tenant config |
| `categoryToAssignee` | `worker.ts:ingestMessage()` → `assigneeAgentId` from config | category → triage agent | Any intake → specialized handler routing |
| `categoryToProject` | T2-D (to build) | category → project | Any multi-project intake pipeline |

### 7.5 Workflow Templates

| Capability | Source | Input → Output | Reuse Pattern |
|---|---|---|---|
| `boardGatedSend` | `worker.ts:send-reply` | issue + draft → SMTP send + audit | Any outbound communication from governed system |
| `draftReviewSendLoop` | Drafter agent → reply-draft → Board sends | inbound → draft → review → send | Any governed communication workflow |
| `categoryWorkflowTemplate` | T2-A (to build) | category → SOP checklist in issue body | Any triage pipeline with category-specific SOPs |

---

## 8. Mission Cell Opportunities

The Email Company is one Mission Cell. The reusable capabilities above can be assembled into future Mission Cells:

### 8.1 Immediate: TheBinMap Intelligence Intake Cell

**Assembles:** `heuristicEmailClassifier` + `structuredFieldExtractor` + `categoryWorkflowTemplate` + `boardGatedSend`

**Purpose:** Production-grade intake for TheBinMap's store submissions, claims, and corrections. This is the Email Company with Tier 1 improvements applied.

**New code needed:** Zero (all in Tier 1). Configuration only.

### 8.2 Near-Term: QSL Security Operations Intake Cell

**Assembles:** `emailNormalizer` + `domainVentureRouter` (route qsl) + `heuristicEmailClassifier` (new categories: `security_alert`, `vulnerability_report`, `client_onboarding`) + `boardGatedSend`

**Purpose:** Intake for security client communications, vulnerability reports, and operational alerts.

**New code needed:** New classHint categories for security domain. Plugin config for qsl venture profile. ~2 hours.

### 8.3 Near-Term: Partnership & Vendor Intake Cell

**Assembles:** `heuristicEmailClassifier` + `categoryToProject` + `categoryWorkflowTemplate` + `boardGatedSend`

**Purpose:** Dedicated intake pipeline for partnership inquiries, vendor contacts, and affiliate applications. Splits `partnership_affiliate` into `partnership_inquiry` and `vendor_contact`.

**New code needed:** Two new classHint categories. Separate project. ~1 hour.

### 8.4 Medium-Term: Customer Support Intake Cell

**Assembles:** `emailNormalizer` + `senderHistoryCheck` + `autoAcknowledgement` (Tier 3) + `boardGatedSend` + ticket tracking

**Purpose:** Full support ticket pipeline with auto-acknowledgement, SLA tracking, and resolution workflows.

**New code needed:** SLA tracking (new), auto-acknowledgement (Tier 3), ticket state machine. ~1 day.

### 8.5 Medium-Term: Newsletter & Intelligence Subscription Cell

**Assembles:** `heuristicEmailClassifier` + `structuredFieldExtractor` (email only) + `autoAcknowledgement` (Tier 3) + subscription list integration

**Purpose:** Automated newsletter signup and intelligence subscription management with welcome sequences.

**New code needed:** Auto-acknowledgement (Tier 3), subscription list integration (external API or manual). ~4 hours.

### 8.6 Long-Term: Generic Email Intake Cell (template)

**Assembles:** ALL capabilities from §7, configured per venture.

**Purpose:** A configurable template Mission Cell that any new Paperclip company can instantiate. Plugin config defines: mailbox profiles, categories, classification rules, workflow templates, routing, and approval gates.

**New code needed:** Configuration schema additions. Zero worker changes — the same `plugin-email` serves all.

---

## 9. Risk Assessment

### 9.1 Operational Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Poll failure (IMAP down, credential expired) | Medium | High | Worker logs error; dashboard shows failed profile; operator alerted via routine |
| Duplicate issues from cursor corruption | Low | Medium | `issues_company_origin_idx` DB index is the safety net; SHA-1 dedup in plugin state is the fast path |
| Agent loop (classification failure) | Low | High | Budget hard-stop ($50/mo); per-agent budget ($8-$20/mo); recovery engine + productivity review escalation native to platform |
| Accidental send (operator error) | Low | High | UI confirmation dialog; permanent send record immutable; no agent send tool exists |
| Credential leak in logs | Very low | Critical | Secret resolved at execution only; never stored in code, config files, or state; `secret_access_events` audited |
| Spam flood overwhelming Triage | Medium | Medium | Spam-review state (T1-C) surfaces spam to operator for batch review; maxMessagesPerPoll=20; Triage budget cap |
| Classification drift (heuristic becomes stale) | Medium | Low | Triage agent always assigns authoritative class; hints are pre-labels only |

### 9.2 Implementation Risks (for Tier 1 improvements)

| Risk | Mitigation |
|---|---|
| Classification changes break existing tests | All 13 categories have existing tests; add new test cases before modifying |
| Confidence field breaks type contracts | Additive field; TypeScript compilation catches type errors |
| Auto-close spam misses legitimate email | **REMOVED — Board rejected auto-close. Replaced with T1-C recoverable spam-review state requiring explicit Board disposition.** |
| Spam review false positive creates unnecessary review | Issue is `in_review`, not `done`; operator can reclassify back to `todo` for Triage; no data is lost |
| Dashboard changes break widget rendering | Pure UI; no API changes; RPC bridge already handles extra fields |
| Structured extraction produces wrong data | Best-effort extraction; Triage agent validates; raw body always preserved |
| Sender history query is slow for many issues | Limit to recent N issues; use plugin state index |

### 9.3 Strategic Risks

| Risk | Mitigation |
|---|---|
| Email Company becomes a one-off, not a reference | Reusable capability inventory (§7) is the prevention; every improvement adds to the inventory |
| TheBinMap-specific logic leaks into generic plugin | Plugin is venture-agnostic by design; venture routing is domain-based; classification is configurable |
| Agent model changes break classification quality | Model-agnostic mandate (R3); models in config only; per-issue override available |
| Board becomes bottleneck (must approve every send) | Auto-acknowledgement (Tier 3) defers this; current volume is low (<20/day) |

---

## 10. Board Approval Request

### 10.1 Request

The assessment above identifies **seven Tier 1 improvements** that are:

- Low risk
- Self-contained (no architectural refactoring)
- Backward compatible
- Operationally valuable

**I request Board approval to implement Tier 1 items T1-A through T1-G.**

### 10.2 What Changes

| Item | What Happens |
|---|---|---|
| T1-A | Classifier gets 5-8 new keyword patterns; 5-8 new test cases |
| T1-B | `NormalizedMessage` gains optional `confidence` field |
| T1-C | High-confidence spam created as `in_review` in a recoverable spam-review state — Board always makes final disposition |
| T1-D | Dashboard widget shows pending actions count and next poll time |
| T1-E | New issues include sender history in description |
| T1-F | Store submissions and claims get structured field extraction |
| T1-G | Every issue includes an operator recommendation field for at-a-glance triage |

### 10.3 What Does NOT Change

> **Board ruling: The send gate is non-negotiable.** The send-gate pattern — agents draft, only the Board sends — is a structural invariant of the Email Company and all future Mission Cells derived from it. No Tier 1, Tier 2, or Tier 3 improvement may weaken this gate. Specifically:
>
> - **No agent send tool.** The plugin must never register an agent-accessible send tool. `send-reply` remains a Board-invoked UI action only.
> - **No auto-send.** No improvement may automate outbound email without explicit Board approval per message. Auto-acknowledgement (T3-D), if ever implemented, must use per-category Board opt-in with a visible "auto-send enabled" indicator and per-message audit records — and even then, it must be Board-revocable at any time.
> - **No draft-as-send.** The `reply-draft` document must never be treated as authorization to send. The Board must explicitly invoke `send-reply` for every outbound message.
> - **No bypass.** No plugin action, API endpoint, or agent instruction may circumvent the Board send confirmation dialog.
>
> This gate is the Email Company's primary safety control for outbound communication. It is architectural, not instructional, and must survive all future refinements.

- No new database tables or migrations
- No agent model changes
- No changes to the send-gate (agents still cannot send)
- No changes to the company budget or governance
- No new plugin dependencies
- No core Paperclip modifications

### 10.4 Verification Plan

1. Run existing test suite: `pnpm --filter @qsl/plugin-email test`
2. Run new test cases for all Tier 1 items
3. Typecheck: `pnpm --filter @qsl/plugin-email typecheck`
4. Manual smoke test: poll-now against Gmail, verify new fields in issue description

### 10.5 Decision

**Approve / Request Changes / Defer** — The Board's decision determines whether Tier 1 implementation proceeds now or awaits further review.

---

*Assessment complete. Stopping for Board approval as directed by STOP CONDITION.*