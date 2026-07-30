# Email Company Implementation Plan — PAPERCLIP-003

> **Status:** Awaiting Board approval
> **Date:** 2026-07-30
> **Audience:** Board (QuantumShield Labs)
> **Mission ID:** PAPERCLIP-003
> **Predecessor:** [PAPERCLIP-002 Operational Assessment](./2026-07-29-email-company-operational-assessment.md)
> **Root authority:** [TheBinMap Intelligence Constitution](./2026-07-08-thebinmap-intelligence-constitution.md)
> **Repo branch:** `feat/qsl-current-upstream-integration`
> **Core files:** `packages/plugins/plugin-email/src/**`, `packages/plugins/plugin-email/tests/**`
> **Zero core modifications.** All changes are plugin-contained.

---

## 1. Reality Discovery Summary

### 1.1 What the Email Company Actually Is

The Email Company is **one Paperclip company** (id `15f8fb0a-065d-4e2b-9d24-a49d986dcaf8`, prefix `EMA`) running on the QSL fork branch. It serves as TheBinMap Intelligence's operational intake center and is powered by `@qsl/plugin-email` v0.1.0 — a self-contained, workspace-local Paperclip plugin with zero core modifications.

| Dimension | Current Reality |
|---|---|
| **Plugin package** | `packages/plugins/plugin-email/` — 487 lines worker, 187 lines classifier, 135 lines IMAP, 54 lines SMTP, 193 lines UI, 338 lines tests |
| **Mail profile** | Single Gmail operational inbox via IMAP/SMTP; profile-based architecture (future mailboxes = new config rows, zero code) |
| **Intake pipeline** | IMAP UNSEEN poll (cron `*/5 * * * *`) → normalize → classify (13 heuristic hints) → dedup (SHA-1 + DB index) → issue creation → mark seen |
| **Classification** | Heuristic keyword matching only (no confidence scores, single-label, order-dependent) |
| **Outbound** | Board-gated SMTP send (structural — agents have no send tool). Draft → Board review → confirm dialog → send → permanent issue comment as send record |
| **Agents** | 4 agents (CEO, Intake Triage, Comms Drafter, Ops Analyst) — all idle (staged rollout, Board ruling R4) |
| **Skills** | 3 company skills: `email-triage-sop`, `outbound-drafting-sop`, `escalation-and-approval-rules` |
| **Routines** | `morning-ops-brief`, `weekly-comms-review` — created but deferred to promotion gate |
| **Budget** | $50/mo company; per-agent budgets set ($8-$20/mo) |
| **Governance** | Board-approved hires; Board-only sends; `requireBoardApprovalForNewAgents: true` |
| **Evidence** | Every intake/send writes activity_log. Thread records in plugin.state. Send records as immutable issue comments. Loop is replayable from activity_log + heartbeat_runs + cost_events. |

### 1.2 What Changed Since the Operational Assessment

The operational assessment (PAPERCLIP-002, 2026-07-29) was accepted as a discovery deliverable with Board amendments applied (T1-C replaced auto-close with recoverable spam-review; T1-G operator recommendation field added; send-gate prohibition codified). **No code has changed since the assessment.** The plan below is the first implementation cycle.

### 1.3 Discovery Findings — Optimization Targets

#### Duplicated Logic (4 instances)

| # | Location | Description | Fix |
|---|---|---|---|
| D1 | `worker.ts:309-325` | `parseReplyDraft()` manually parses `To:`/`Subject:` from markdown; a general-purpose key-value header parser would serve any draft-preview slot | Extract to shared draft parser utility in a future refactor; not blocking |
| D2 | `normalize.ts:67-89` | `classify()` duplicates the Intake Triage agent's work — the agent reassigns the authoritative class on every issue. The heuristic hint is pre-labeling only. | Keep as-is; the duplication is intentional (fast pre-label vs. authoritative agent classification) |
| D3 | `imap.ts:32-41` | `imapClient()` factory is called independently by `fetchUnseen`, `markReplied`, `markSeen`, `validateImap` — each opens a new connection | Acceptable for V1 (each operation is short-lived); connection reuse is a Tier 3 optimization |
| D4 | `worker.ts:106-137` | `buildProfiles()` merges base + `extraProfilesJson` with manual field-by-field spread; fragile to config schema changes | Acceptable for V1 (single profile); profile config refactor is Tier 3 |

#### Unnecessary Complexity (3 instances)

| # | Location | Description | Fix |
|---|---|---|---|
| U1 | `worker.ts:152-167` | `resolveActiveCompanies()` iterates ALL companies on every poll (every 5 minutes), fetches config for each, checks `config.username`. For a single-company deployment this is wasteful. | Low-volume (<20 msg/poll): acceptable. Profile count cache or config-change notification is Tier 3. |
| U2 | `worker.ts:182-186` + DB index | Dual dedup layer: SHA-1 hash in `plugin.state` + unique constraint on `(companyId, originKind, originId)`. Both are correct individually; together they are defense-in-depth. | Keep both. The SHA-1 pre-check avoids a DB round-trip; the DB index catches cursor-corruption edge cases. |
| U3 | `worker.ts:238-245` | `runPollForCompany` fetches full `MailboxStatus` object, mutates it, rewrites it — even for disabled configs. | Minor. The state write is small and idempotent. Tier 3 consideration. |

#### UX Improvements (5 instances)

| # | Location | Description | Severity |
|---|---|---|---|
| UX1 | `ui/index.tsx:145-192` | `EmailMetricsWidget` shows raw counts (ingested/sent/polls) but no actionable insight: what needs review, what's awaiting send, what's blocked | **High** — fixed by T1-D |
| UX2 | `ui/index.tsx:108-139` | Board send requires opening each issue individually → Email tab → confirm. No batch send for common templates | **Medium** — deferred to Tier 3 (batch-send needs per-message audit) |
| UX3 | `ui/index.tsx:44-51` | All styles use raw CSS with hardcoded hex values (`#c0392b`, `#1e8449`, `rgba(127,127,127,0.35)`) — violates the design-token-only rule in `AGENTS.md` and `DESIGN.md` | **Low** — fixed by T2-E |
| UX4 | `normalize.ts:164-186` | Issue description is generic — no per-category workflow instructions, no operator recommendation, no sender history context | **High** — fixed by T1-F, T1-G, T2-A |
| UX5 | `ui/index.tsx:65` | "No inbound email linked" message is generic. No "Email-sourced issues are created by..." context for the Board | **Low** — informational only; acceptable |

#### Automation Opportunities (4 instances)

| # | Location | Description | Impact |
|---|---|---|---|
| A1 | `normalize.ts` | `classify()` returns a single string. Adding `confidence` scoring enables the worker to route high-confidence spam to review state vs. low-confidence unknown to Triage. | **High** — T1-B enables T1-C, T1-G, and future routing |
| A2 | `worker.ts:175-231` | `ingestMessage()` creates every issue identically. Per-category workflow templates and routing would reduce agent re-parsing. | **Medium** — T2-A, T2-D |
| A3 | `worker.ts` | No sender history check. Repeat contacts create independent issues with no context. | **Medium** — T1-E |
| A4 | Routine system | `morning-ops-brief` and `weekly-comms-review` exist but are inactive. Activation provides automated oversight without plugin changes. | **Medium** — T2-C |

#### Governance Improvements (3 instances)

| # | Location | Description | Impact |
|---|---|---|---|
| G1 | `worker.ts` | No spam-review state. `spam_irrelevant` hints produce `todo:low` issues that enter the Triage queue. | **High** — T1-C |
| G2 | `normalize.ts:164-186` | `issueDescriptionFor()` provides no operator triage recommendation. The Board must read the full email body for every issue. | **High** — T1-G |
| G3 | Platform | The send-gate is structural (no agent send tool), which is correct. But there is no per-message sending-audit consolidation — send records are individual issue comments. | **Low** — acceptable for current volume; queryable via activity_log |

---

## 2. Implementation Roadmap

The roadmap addresses the 7 Tier 1 and 5 Tier 2 items from the operational assessment, reordered by dependency and impact.

### 2.1 Phase 0: Reality Foundation (pre-implementation)

**Duration:** 30 minutes
**Code changes:** Zero

| Step | Action | Purpose |
|---|---|---|
| P0.1 | Verify current EMA issue state (EMA-1..32+) in the running instance | Confirm clean issue queue before changes |
| P0.2 | Verify plugin health (`GET /api/plugins/qsl.email/health`) | Baseline before changes |
| P0.3 | Confirm credential secret binding validity | Avoid poll-failure masking during testing |
| P0.4 | Verify existing test suite passes: `pnpm --filter @qsl/plugin-email test` | 338 lines, 28 test cases — current baseline |

**Exit gate:** Plugin healthy; tests pass; credentials valid.

### 2.2 Phase 1: Classifier Foundation (T1-A, T1-B, T1-G)

**Duration:** 2.5 hours
**Files:** `normalize.ts` (+35-50 lines), `normalize.spec.ts` (+45-70 lines)

These three improvements are co-located in `normalize.ts` and share no runtime dependencies. They can be developed and committed together.

#### T1-A: Heuristic Classifier Refinement

Expand `classify()` with additional keyword patterns and fix known ordering edge cases:

| Addition | Keywords | Result |
|---|---|---|
| `vendor` detection | "vendor" + "supply" in body | `partnership_affiliate` (separate from generic "partner") |
| Claim-correction disambiguation | "claim" + ("wrong" \|\| "correct") in body | `correction` (overrides `listing_claim` when both present) |
| Intelligence signup disambiguation | "signup" + "intelligence" | `intelligence_request` (not `newsletter_signup`) |
| Support widening | "bug" \|\| "broken" in subject or body | `support_request` (wider net) |
| Spam false-positive guard | "unsubscribe" in footer only (not subject), no other spam signals | Reclassify to `unknown` (avoid `spam_irrelevant` for legitimate marketing footers) |

**Risk:** Very low. Existing 13-category tests pass unchanged. Add 5-8 new test cases for new patterns.

#### T1-B: Confidence Scoring

Add `confidence: "high" | "medium" | "low"` field to `NormalizedMessage` based on signal count:

| Confidence | Condition |
|---|---|
| `"high"` | 3+ keyword signals match + recognized sender domain |
| `"medium"` | 1-2 keyword signals match |
| `"low"` | Catch-all `unknown` or single weak keyword match |

Add confidence to `issueDescriptionFor()` output. Include it in the issue description as a metadata field:

```
- **Class hint:** `store_submission` (connector heuristic — assign the authoritative class per email-triage-sop)
- **Confidence:** `medium` (2 keyword signals matched)
```

**Risk:** Very low. Additive optional field. No schema change. Existing tests unaffected.

#### T1-G: Operator Recommendation Field

Add `operatorRecommendation` to the issue description based on `classHint`, `confidence`, and venture:

| Recommendation | Condition |
|---|---|
| `review-immediately` | `priority: high` OR `classHint: intelligence_request, listing_claim` |
| `review-soon` | `priority: medium`, confidence `high` or `medium`, known venture |
| `review-when-available` | `priority: medium`, confidence `low`, unknown venture |
| `needs-spam-review` | `classHint: spam_irrelevant` (any confidence) |
| `no-action-required` | `newsletter_signup`, `store_alert_signup` (informational only) |
| `needs-reply` | Any category where inbound expects a response |
| `unknown-needs-triage` | `classHint: unknown`, `confidence: low` |

Rendered as a prominent callout at the top of the issue description:

```
> **Operator recommendation:** review-soon — medium priority, medium confidence, known sender, likely store submission.
```

**Risk:** Very low. Additive text. Heuristic only — the Board always overrides. No schema change.

**Phase 1 exit gate:** 13 existing tests pass + 10-15 new tests. All three improvements verified in normalized output.

### 2.3 Phase 2: Spam-Review Workflow (T1-C)

**Duration:** 1 hour
**Files:** `worker.ts` (+15-20 lines), `normalize.spec.ts` (+5-10 lines for spam-review verification)
**Depends on:** Phase 1 (T1-B confidence field)

When `classHint === "spam_irrelevant"` AND `confidence === "high"`, create the intake issue with `status: "in_review"` instead of `status: "todo"`. The issue description includes a `needs-spam-review` operator recommendation (Phase 1 already provides this via T1-G).

Changes in `ingestMessage()`:

```typescript
// After creating the issue, if spam:
if (msg.classHint === "spam_irrelevant" && msg.confidence === "high") {
  await ctx.issues.update(issue.id, {
    status: "in_review",
    description: issueDescriptionFor(msg) + "\n\n**Spam-review state:** High-confidence spam hint. Board must confirm disposition. Reclassify to `todo` if this is legitimate mail."
  });
}
```

**Recoverable design** (Board amendment to original auto-close proposal):
- Spam issues enter `in_review`, NOT `done`
- The Board sees them in the operator queue
- Operator can (a) confirm spam → `done`, (b) reclassify → `todo` for Triage, or (c) defer — leave in `in_review`
- Every disposition preserves the audit trail

**Risk:** Very low. `in_review` is a normal Paperclip issue status. The Triage agent is not woken for `in_review` issues (they have no `todo` assignment). No agent interaction is triggered until the Board reclassifies.

**Phase 2 exit gate:** Spam classified with `confidence: "high"` → issue created in `in_review` with spam-review description. Non-spam or low-confidence spam → `todo` as before. Tests for both paths.

### 2.4 Phase 3: Operator Dashboard Enhancement (T1-D)

**Duration:** 1 hour
**Files:** `ui/index.tsx` (+40-60 lines)
**Depends on:** None (read-only UI change, data already available through plugin data bridge)

Enhance `EmailMetricsWidget` with actionable data:

```
Email intake
  Last poll: 7/30/2026, 10:05:00 AM (next in 3 min)
  Needs review: 3 issues (2 unreviewed, 1 spam)
  Awaiting send: 1 draft(s) ready
  Ingested: 42 message(s)  |  Replies sent: 12  |  Polls run: 156

Primary   ok — 2 new / 3 found / 1 dup
```

New data points:
1. **"Needs review" count** — issues in `todo`/`in_review` in the Intake project (fetched via separate data provider or computed from existing plugin state)
2. **"Awaiting send" count** — issues with `reply-draft` documents that have not been sent
3. **"Next poll" countdown** — time until next scheduled poll (compute from `lastPollAt` + 5 min)

Implementation approach:
- Add a new data provider `"intake-queue"` that queries issues in the Intake project by status
- Or extend `"mailbox-status"` to include queue counts (simpler, fewer round trips)
- The "next poll" is computed client-side from `lastPollAt`

**Risk:** Low. Read-only additive UI. No new API calls — data already available through plugin data providers. The `intake-queue` data provider reads existing issue data through `ctx.issues` context (already authorized via `issues.read` capability).

**Phase 3 exit gate:** Dashboard widget renders with needs-review count, awaiting-send count, and next-poll countdown. Verified in live UI.

### 2.5 Phase 4: Sender History Check (T1-E)

**Duration:** 1.5 hours
**Files:** `worker.ts` (+25-35 lines)
**Depends on:** None (independent, but Phase 1 classifier improvements enhance the context)

Before creating a new intake issue, search plugin state for previous thread records matching `fromAddress`. Include sender history in the issue description:

```
**Previous contact from this sender:**
- EMA-12 (2026-07-15, listing_claim)
- EMA-8 (2026-07-10, store_submission)
```

Implementation approach:
- Maintain a `sender-index` state namespace mapping `fromAddress` → array of `{ issueId, date, classHint }`
- Update the index after each successful intake
- Include up to 5 most recent contacts in the issue description
- Fall back to scanning thread records if the index is missing (one-time catch-up)

**Risk:** Medium. Cross-issue state lookup adds latency to `ingestMessage()` (mitigated: limit to 5 recent entries; plugin.state read is fast). The sender index is additive — if it's missing, the function still succeeds without history.

**Phase 4 exit gate:** New issues from previously-contacted senders include contact history in the description. First-contact senders show "No previous contact." Verified in issue body and tests.

### 2.6 Phase 5: Structured Extraction (T1-F)

**Duration:** 2 hours
**Files:** `normalize.ts` (+50-70 lines), `normalize.spec.ts` (+50-70 lines)
**Depends on:** Phase 1 (T1-A refined classifier ensures correct `classHint` before extraction)

Add `extractFields()` function that parses structured data from email body based on `classHint`:

For `store_submission`:
| Field | Pattern |
|---|---|
| `store_name` | `store name[:\s]+(.+)` |
| `address` | `address[:\s]+(.+)` |
| `city` | `city[:\s]+(.+)` |
| `state` | `state[:\s]+(.+)` |
| `zip` | `zip[:\s]+(.+)` |
| `hours` | `hours[:\s]+(.+)` |
| `description` | `description[:\s]+(.+)` |

For `listing_claim`:
| Field | Pattern |
|---|---|
| `store_name` | `store name[:\s]+(.+)` |
| `claimer_name` | `name[:\s]+(.+)` |
| `claimer_email` | Email pattern after "email" |
| `role` | `role[:\s]+(.+)` |
| `evidence` | `evidence[:\s]+(.+)` (free text) |

Extracted fields are appended to the issue description as a structured markdown table:

```
### Extracted fields (best-effort, validate in triage)

| Field | Value |
|---|---|
| Store name | Fred's Bargain Barn |
| Address | 123 Main St |
| City | Springfield |
| State | IL |
| Zip | 62701 |
```

**Risk:** Low. Best-effort extraction — raw body is always preserved. The Triage agent validates extracted fields. No schema change. Additive description content.

**Phase 5 exit gate:** `store_submission` and `listing_claim` messages produce extracted field tables in the issue description. Non-matching patterns produce empty tables with "(no fields extracted)" note. 8-10 test cases.

---

### 2.7 Phase 6: Per-Category Workflow Templates (T2-A)

**Duration:** 3 hours
**Files:** `normalize.ts` (+100-130 lines for template map), `normalize.spec.ts` (+20-30 lines)
**Depends on:** Phase 1 (T1-A refined classifier ensures correct template selection)

Add a `WORKFLOW_TEMPLATES` constant mapping each `classHint` to category-specific SOP directives. The template is appended to the issue description:

```typescript
const WORKFLOW_TEMPLATES: Record<MessageClassHint, string> = {
  store_submission: `## Workflow: store_submission
1. Verify store does not already exist in TheBinMap DB
2. Extract: name, address, hours, description, source (use structured extraction above)
3. Create verification task for field team (if applicable)
4. Draft acknowledgement to submitter (template: store-submission-received)
5. Assign to Intake Triage for classification review
6. Board reviews and sends acknowledgement`,

  listing_claim: `## Workflow: listing_claim
1. Verify claimer identity against store records
2. Validate role claim (owner, employee, manager)
3. Check for conflicting claims on the same store
4. Draft claim acknowledgment (template: listing-claim-received)
5. Assign to Intake Triage for claim verification
6. Board reviews and sends acknowledgment`,

  // ... 11 more category templates
};
```

**Risk:** Low. Additive text. Templates are human-authored and Board-reviewed before deployment. Does not change issue routing — every issue still enters the Intake project and is assigned to Intake Triage.

**Phase 6 exit gate:** All 13 categories produce workflow directive sections in the issue description. Templates are consistent with existing SOPs (`email-triage-sop`, `outbound-drafting-sop`). Tests verify each category produces its template.

### 2.8 Phase 7: Reply Template Library (T2-B)

**Duration:** 2 hours
**Files:** New template files (company skills or issue documents), `ui/index.tsx` (+15-20 lines)
**Depends on:** None (uses existing `issue_documents` mechanism)

Store common reply templates as `issue_documents` with key `reply-template:<category>`:

| Template Key | Content |
|---|---|
| `reply-template:store-submission-received` | "Thanks for submitting your store to TheBinMap! We'll review your submission and get back to you within 48 hours..." |
| `reply-template:listing-claim-received` | "Thanks for claiming your listing on TheBinMap! A verification team member will review your claim..." |
| `reply-template:newsletter-welcome` | "Welcome to TheBinMap newsletter! You'll receive updates on new stores, treasure-hunting tips..." |
| `reply-template:correction-received` | "Thanks for helping us keep TheBinMap accurate! We've received your correction and will verify it..." |
| `reply-template:general-inquiry-received` | "Thanks for contacting TheBinMap! We've received your inquiry and will respond within 48 business hours..." |

Implementation approach:
- Templates live as company-level `issue_documents` or as a company skill `reply-templates` with one template per section
- The Comms Drafter reads the template and customizes it (name, date, specific details) instead of drafting from scratch
- The UI issue tab shows available templates if the issue has a matching category and no draft yet
- Templates are Board-authored and Board-maintained

**Risk:** Low. No plugin code changes beyond the UI template selector (which is additive). Templates are text documents that use existing `issue_documents` mechanism. The Comms Drafter's instructions reference the template system.

**Phase 7 exit gate:** 5 reply templates created and accessible. Comms Drafter correctly selects and customizes templates. Board verifies template content.

### 2.9 Phase 8: Routine Activation (T2-C)

**Duration:** 30 minutes
**Files:** Zero code changes
**Depends on:** None (platform feature)

Activate the two deferred routines via the Paperclip API:

1. **`morning-ops-brief`** — weekday cron → creates a daily briefing issue for the CEO summarizing: intake volume (by category), pending reviews, awaiting sends, cost-to-date, agent status
2. **`weekly-comms-review`** — weekly cron → creates a review issue for the Ops Analyst summarizing: weekly intake volume, average time-to-review, send rate, cost per category, classification accuracy (hint vs. authoritative), spam rate

**Risk:** Very low. Paperclip native routine system. Routines already exist in the database; this phase toggles `enabled: true`.

**Phase 8 exit gate:** First `morning-ops-brief` fires on next weekday morning. First `weekly-comms-review` fires on next Monday. Issues created by routines are in the Intake project with correct assignees.

### 2.10 Phase 9: Per-Category Issue Routing (T2-D)

**Duration:** 1.5 hours
**Files:** `worker.ts` (+15-25 lines), `manifest.ts` (+10-15 lines for new config field), `normalize.ts` (+10-15 lines)
**Depends on:** Phase 1 (T1-A refined classifier ensures correct routing)

Add optional `categoryProjectMapping` config field that maps `classHint` → project ID. When configured, intake issues for that category are created in the mapped project instead of the default Intake project. Add `categoryLabelsEnabled` config to auto-apply labels like `category:store-submission`.

Config schema addition:

```json
{
  "categoryProjectMapping": {
    "type": "object",
    "title": "Category → Project Mapping",
    "description": "Optional. Map classification hints to specific projects.",
    "additionalProperties": { "type": "string" }
  },
  "categoryLabelsEnabled": {
    "type": "boolean",
    "title": "Auto-apply Category Labels",
    "default": false
  }
}
```

Default behavior (no mapping configured): all issues → Intake project (unchanged). With mapping: `partnership_affiliate` → Partnerships project; `support_request` → Support project; etc.

**Risk:** Medium. Multi-project routing requires the target projects to exist with correct agent assignments. If a target project ID is invalid, the issue falls back to the Intake project with a warning. Config is optional and defaults to current behavior.

**Phase 9 exit gate:** With mapping configured, `store_submission` → Intake project (default), `partnership_affiliate` → Partnerships project. With mapping absent, all issues → Intake project. Labels auto-applied when enabled.

### 2.11 Phase 10: UI Token Standardization (T2-E)

**Duration:** 1 hour
**Files:** `ui/index.tsx` (style object replacement)
**Depends on:** None (pure style change)

Replace raw CSS inline styles with Paperclip design tokens (CSS custom properties from `ui/src/index.css`). The plugin SDK injects into the host page's CSS context, so host design tokens are available.

Current violations → token replacements:

| Current (raw) | Replacement (token) |
|---|---|
| `color: "#c0392b"` (error text) | `var(--color-error)` or `var(--color-red-600)` |
| `color: "#1e8449"` (success text, send button bg) | `var(--color-success)` or `var(--color-green-600)` |
| `background: "#1e8449"` (send button) | `var(--color-success-bg)` |
| `border: "1px solid rgba(127,127,127,0.35)"` (cards) | `var(--border-color)` or `var(--color-border)` |
| `opacity: 0.75` (label dimming) | `var(--text-dim)` |
| `fontWeight: 600` (labels) | `var(--font-weight-semibold)` |
| `borderRadius: 8` (cards) | `var(--radius-md)` |
| `borderRadius: 6` (buttons, draft preview) | `var(--radius-sm)` |
| `fontSize: 12` (fine print) | `var(--text-xs)` |
| `fontSize: 13` (body) | `var(--text-sm)` |
| `fontFamily: "monospace"` (Message-ID) | `var(--font-mono)` |
| `padding: "6px 14px"` (buttons) | `var(--spacing-1-5)` / `var(--spacing-3-5)` |

**Risk:** Very low. Pure style change. No behavioral change. Verify in the running UI that all elements render identically with token substitution. Run `pnpm check:token-gates` (if applicable to plugin UI) or manual visual verification.

**Phase 10 exit gate:** Email tab and dashboard widget render identically to before, but use CSS custom properties instead of raw hex values.

---

## 3. Dependency Graph

```
Phase 0 (Reality Foundation)
    │
    ▼
Phase 1 (Classifier Foundation: T1-A, T1-B, T1-G)
    │
    ├──► Phase 2 (Spam-Review: T1-C) ─── depends on T1-B confidence
    │
    ├──► Phase 5 (Structured Extraction: T1-F) ─── depends on T1-A refined classifier
    │
    ├──► Phase 6 (Workflow Templates: T2-A) ─── depends on T1-A refined classifier
    │
    └──► Phase 9 (Category Routing: T2-D) ─── depends on T1-A refined classifier
```

Independent phases (can be developed in parallel with Phase 1+):

```
Phase 3 (Dashboard: T1-D) ─── independent (read-only UI)
Phase 4 (Sender History: T1-E) ─── independent
Phase 7 (Reply Templates: T2-B) ─── independent
Phase 8 (Routine Activation: T2-C) ─── independent
Phase 10 (UI Tokens: T2-E) ─── independent
```

### 3.1 Parallel Development Opportunities

With the dependency analysis above, the following phases can be developed concurrently:

- **Wave A** (sequential): Phase 1 → Phase 2, Phase 5, Phase 6, Phase 9
- **Wave B** (parallel with Wave A): Phase 3, Phase 4, Phase 7, Phase 8, Phase 10

Total wall clock: ~5.5 hours (Wave A chain) vs. 2.5 hours each if developed in parallel.

---

## 4. Estimated Implementation Order

| Order | Phase | Item | Effort | Dependencies | Risk |
|---|---|---|---|---|---|
| 1 | P0 | Reality Foundation | 30m | None | Very low |
| 2 | P1 | T1-A: Classifier refinement | 1h | None | Very low |
| 3 | P1 | T1-B: Confidence scoring | 30m | None (co-located in P1) | Very low |
| 4 | P1 | T1-G: Operator recommendation | 45m | T1-A, T1-B (uses both) | Very low |
| 5 | P2 | T1-C: Spam-review state | 1h | T1-B (confidence) | Very low |
| 6 | P3 | T1-D: Dashboard enhancement | 1h | None | Low |
| 7 | P4 | T1-E: Sender history | 1.5h | None | Medium |
| 8 | P5 | T1-F: Structured extraction | 2h | T1-A (refined classifier) | Low |
| 9 | P6 | T2-A: Workflow templates | 3h | T1-A (refined classifier) | Low |
| 10 | P7 | T2-B: Reply templates | 2h | None | Low |
| 11 | P8 | T2-C: Routine activation | 30m | None | Very low |
| 12 | P9 | T2-D: Category routing | 1.5h | T1-A, T6 (templates) | Medium |
| 13 | P10 | T2-E: UI token standardization | 1h | None | Very low |

**Total Tier 1 (P0-P5):** ~7.25 hours
**Total Tier 2 (P6-P10):** ~8 hours
**Grand total:** ~15.25 hours

---

## 5. Risk Analysis

### 5.1 Implementation Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Classification changes break existing 13-category tests | Low | Medium | Phase 1 includes test additions BEFORE code changes. All 13 existing tests verified before accepting any Phase. |
| R2 | Confidence scoring produces wrong hints for ambiguous email | Medium | Low | Confidence is a pre-label only. The Intake Triage agent assigns the authoritative class. Low-confidence hints are surfaced as `unknown-needs-triage`. |
| R3 | Spam-review false positive creates unnecessary `in_review` that blocks Triage | Low | Medium | Issue is `in_review`, not `done`. Operator can reclassify to `todo` in one click. No data is lost. Audit trail preserved. |
| R4 | Sender history query is slow with many issues or missing index | Medium | Low | Limit to 5 most recent contacts. Use dedicated `sender-index` state namespace (flat key-value, O(1) lookup). Fallback: skip history if index missing. |
| R5 | Structured extraction produces incorrect data for non-standard email formats | Medium | Low | Best-effort extraction — raw body always preserved. Triage agent validates. Extracted fields are in a separate "# Extracted fields" section with a "validate in triage" note. |
| R6 | Category routing to non-existent project breaks issue creation | Low | Medium | Config validation at `onValidateConfig` checks project existence. Runtime fallback to Intake project with warning log. Optional config — disabled by default. |
| R7 | UI changes break widget rendering in older Paperclip versions | Low | Low | Plugin SDK API is versioned. The `usePluginData` hook is stable. Additive widget content — empty counts render as "0", not undefined. |
| R8 | Token-based styles conflict with Paperclip's design token resolution | Low | Low | Phase 10 is isolated to plugin UI styles. Host CSS context is shared — tokens resolve to the host's variable definitions. Verify in live UI after each change. |

### 5.2 Operational Risks (post-deployment)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R9 | Poll failure masks email intake during credential rotation | Low | High | Plugin worker logs errors per profile. Dashboard widget shows failed profiles. `morning-ops-brief` routine (Phase 8) surfaces polling gaps. Operator gets visible alert. |
| R10 | Classification drift (heuristic becomes stale as new email patterns emerge) | Medium | Low | Triage agent always assigns authoritative class. The heuristic is a pre-label. Classification accuracy can be monitored via `weekly-comms-review` comparing hints vs. authoritative classes. |
| R11 | Spam volume overwhelms the review queue | Low | Medium | `maxMessagesPerPoll: 20` limits per-poll intake. Spam-review state (Phase 2) surfaces to operator. Board can batch-dispose. Triage agent is not woken for spam. |
| R12 | Budget exhaustion during routine activation | Very low | High | Routines reuse existing agents with existing budget caps. Per-agent budgets ($5-$20/mo) are already set. Routine-created issues are charged to `mission:email-ops`. |

### 5.3 Strategic Risks

| # | Risk | Mitigation |
|---|---|---|
| R13 | Email Company becomes a one-off, not a reference implementation | The reusable capability inventory (operational assessment §7) is the prevention. Every improvement is guided by "does this make the plugin more reusable for future Mission Cells?" |
| R14 | TheBinMap-specific logic leaks into generic plugin | Plugin is venture-agnostic by design. Venture routing is domain-based (`ventureOf()`). Classification is configurable (no hardcoded TheBinMap categories in code — only in workflow templates and reply templates, which are config artifacts, not code). |
| R15 | Phase complexity prevents any single phase from shipping | Each Phase has independent exit gates. Phases can ship incrementally. No phase blocks another's deployment (except the dependency chain in §3). |

---

## 6. Testing Strategy

### 6.1 Unit Tests (Vitest)

All changes to `normalize.ts` and `worker.ts` logic are covered by tests in `normalize.spec.ts` and (new) `worker.spec.ts`.

#### Phase 1 test cases (T1-A, T1-B, T1-G)

| # | Test | Covers |
|---|---|---|
| T1.1 | `vendor + supply` in body → `partnership_affiliate` | T1-A new keyword |
| T1.2 | `claim + wrong` in body → `correction` (not `listing_claim`) | T1-A disambiguation |
| T1.3 | `signup + intelligence` in subject → `intelligence_request` | T1-A disambiguation |
| T1.4 | `bug` in subject → `support_request` | T1-A widened support |
| T1.5 | `unsubscribe` in footer only, no other spam signals → `unknown` | T1-A spam false-positive guard |
| T1.6 | Confidence `high` — 3+ signals + recognized domain | T1-B |
| T1.7 | Confidence `medium` — 2 signals | T1-B |
| T1.8 | Confidence `low` — `unknown` classHint | T1-B |
| T1.9 | `review-immediately` recommendation — `intelligence_request`, `high` confidence | T1-G |
| T1.10 | `review-soon` recommendation — `store_submission`, `medium` confidence | T1-G |
| T1.11 | `needs-spam-review` recommendation — `spam_irrelevant`, any confidence | T1-G |
| T1.12 | `no-action-required` recommendation — `newsletter_signup` | T1-G |
| T1.13 | `unknown-needs-triage` recommendation — `unknown`, `low` confidence | T1-G |

#### Phase 2 test cases (T1-C)

| # | Test | Covers |
|---|---|---|
| T2.1 | `spam_irrelevant` + `confidence: "high"` → issue created with `status: "in_review"` | Spam-review path |
| T2.2 | `spam_irrelevant` + `confidence: "low"` → issue created with `status: "todo"` | Non-spam path |
| T2.3 | Non-spam classHint + any confidence → issue created with `status: "todo"` | Normal intake unchanged |

#### Phase 4 test cases (T1-E)

| # | Test | Covers |
|---|---|---|
| T4.1 | Known sender with 1 previous contact → history in description | Sender history |
| T4.2 | Known sender with 5+ contacts → truncated to 5 most recent | Sender history limit |
| T4.3 | First-contact sender → "No previous contact" note in description | New sender |

#### Phase 5 test cases (T1-F)

| # | Test | Covers |
|---|---|---|
| T5.1 | `store_submission` body with all 7 fields → all extracted | Store extraction — complete |
| T5.2 | `store_submission` body with only name + address → partial extraction | Store extraction — partial |
| T5.3 | `listing_claim` body with all fields → all extracted | Claim extraction — complete |
| T5.4 | `listing_claim` body with only name → partial extraction | Claim extraction — partial |
| T5.5 | Non-standard field format (e.g., "Store Name — Value") → extraction fails gracefully | Extraction robustness |
| T5.6 | No matching fields → "(no fields extracted)" note | Empty extraction |
| T5.7 | Non-store, non-claim classHint → no extraction section | Skip extraction |

#### Phase 6 test cases (T2-A)

| # | Test | Covers |
|---|---|---|
| T6.1 | `store_submission` → workflow section with 6 steps | Template for store_submission |
| T6.2 | `listing_claim` → workflow section with 6 steps | Template for listing_claim |
| T6.3 | All 13 classHints produce a workflow section | Template coverage |
| T6.4 | Template text does not include "send" instructions in categories where Board sends | Send-gate preservation |

### 6.2 Integration Tests (Manual Verification)

| # | Test | Method |
|---|---|---|
| I1 | Send a real email to the Gmail operational inbox → verify it creates an issue with all new fields | Manual: poll-now via dashboard widget → open created issue → verify description |
| I2 | Verify spam-review flow: send known-spam email → verify issue is `in_review`, not `todo` | Manual: same as I1, with spam-flagged content |
| I3 | Verify sender history: send 2 emails from same address → verify 2nd issue shows contact history | Manual: two sequential emails from same test address |
| I4 | Verify dashboard widget shows correct counts after intake | Manual: inspect widget after I1-I3 |
| I5 | Verify routine activation: manually trigger `morning-ops-brief` → verify issue created with summary data | Manual: routine trigger via API |
| I6 | Full governed loop: intake → Triage classify → Drafter draft → Board review → Board send → archive | Manual: end-to-end with real email |

### 6.3 Design Token Verification

After Phase 10, verify:
1. No raw hex colors in `ui/index.tsx` (search for `#` followed by 3/6 hex digits)
2. No raw pixel values (search for bare numbers in CSS objects that look like `12`, `13`, `6`, `8`, `10`, `14`)
3. No raw `rgba()` calls in style objects
4. Visual regression: screenshot before/after and diff

### 6.4 Regression Tests (Existing Suite)

All 28 existing test cases in `normalize.spec.ts` must pass unchanged:
- 13 classification tests (one per classHint)
- 4 venture routing tests
- 4 priorityFor tests
- 4 issueTitleFor tests
- 4 issueDescriptionFor tests
- 2 send-gate tests
- Other normalization tests

Run before and after each Phase:
```sh
pnpm --filter @qsl/plugin-email test
```

### 6.5 Pre-Deployment Checklist

```sh
# 1. Verify tests pass
pnpm --filter @qsl/plugin-email test

# 2. Typecheck
pnpm --filter @qsl/plugin-email typecheck

# 3. Build
pnpm --filter @qsl/plugin-email build

# 4. Verify plugin health in running instance
curl http://localhost:3100/api/plugins/qsl.email/health

# 5. Manual poll (verify no errors)
# Use the dashboard "Poll now" button

# 6. Verify activity_log entries
curl http://localhost:3100/api/activity?limit=5
```

---

## 7. What Does NOT Change

Per Board directive (operational assessment §10.3), these invariants are preserved across all phases:

1. **Send gate is non-negotiable.** Agents draft `reply-draft` documents. Only the Board sends via the `send-reply` UI action. No agent send tool is registered. No auto-send capability exists.
2. **No new database tables or migrations.** All changes are additive to existing plugin files. No core Paperclip modifications.
3. **No agent model changes.** Model configuration remains in `adapter_config` and issue overrides only. No model IDs appear in skill text, instructions, or code.
4. **No budget or governance changes.** Budget policy, approval gates, and company structure are unchanged.
5. **No new plugin dependencies.** `imapflow` and `nodemailer` are the only external dependencies.
6. **Plugin remains venture-agnostic.** The classification, routing, and template systems are configurable. TheBinMap-specific category names appear only in workflow templates and reply templates (config artifacts), not in code.
7. **Config-driven, not code-driven.** The profile-based connector architecture means future mailboxes are new profile rows — zero code changes.
8. **Platform-native storage only.** No custom database tables. All state uses `issues`, `issue_comments`, `issue_documents`, `activity_log`, `plugins`, and `plugin.state`.

---

## 8. Success Criteria

The implementation is successful when:

1. All 28 existing tests pass + all new tests (35-45 new test cases across 6 phases)
2. Typecheck and build pass: `pnpm --filter @qsl/plugin-email typecheck && pnpm --filter @qsl/plugin-email build`
3. A real email sent to the Gmail operational inbox is ingested with: refined `classHint`, `confidence` score, `operatorRecommendation`, structured extraction (if `store_submission` or `listing_claim`), and category-specific workflow template
4. High-confidence spam enters `in_review`, not `todo`
5. Dashboard widget shows actionable counts (needs review, awaiting send, next poll)
6. Repeat senders show contact history in the issue description
7. Routines fire on schedule and create briefing/review issues
8. UI renders identically using design tokens instead of raw CSS
9. Send-gate remains structurally enforced (no agent send tool, no auto-send, no draft-as-send, no bypass)
10. All changes are contained within `packages/plugins/plugin-email/` — zero core modifications

---

## 9. Deferred Backlog (not in scope)

| # | Item | Tier | Rationale |
|---|---|---|---|
| D1 | Classification model (LLM-powered) | T3-A | Heuristic classifier is sufficient for V1 intake volume (<50 messages/day). LLM classification adds latency and cost without proportional benefit at current scale. |
| D2 | Web3Forms direct webhook intake | T3-B | Gmail polling works. Web3Forms webhook bypasses Gmail (removes audit trail in sent folder). Requires webhook endpoint + secret validation. |
| D3 | Attachment ingestion (MIME parsing) | T3-C | Most inbound is text. Attachment handling requires `bodyParts` beyond text and integration with Paperclip's asset storage. |
| D4 | Auto-acknowledgement engine | T3-D | Board-rejected for V1. Auto-reply is a governance risk. Requires per-category Board opt-in with "auto-send enabled" indicator and per-message audit — deferred until the Board explicitly requests it. |
| D5 | Sender reputation system | T3-E | Premature at current volume (<50 messages/day). Requires scoring model, decay function, and integration with classification feedback loop. |
| D6 | Batch send for common templates | N/A | Security concern: batch-send removes per-message Board confirmation. Deferred until volume justifies it. |
| D7 | Connection reuse across poll cycles | N/A | IMAP client per-operation is fine for 5-minute poll intervals. Connection pooling is premature optimization. |
| D8 | `resolveActiveCompanies()` optimization | N/A | Single-company deployment. Profile count cache or config-change notification is not justified for current scale. |

---

## 10. Board Decision

### Request

Implement **all 12 phases** (P0-P10) covering **Tier 1** (T1-A through T1-G) and **Tier 2** (T2-A through T2-E) improvements.

### Decision

**Approve / Approve with changes / Defer**

The Board's decision determines whether the full roadmap, selected phases, or an alternative scope proceeds.

---

*Plan complete. Stopping for Board approval as directed by STOP CONDITION.*