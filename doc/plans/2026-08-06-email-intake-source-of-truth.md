# Email Intake Source-of-Truth Architecture Report

Date: 2026-08-06  
Operationalization update: 2026-08-16

## Summary

The unified intake design supports multiple evidence transports (email notification, provider webhook, provider API, WordPress event, inferred email) without creating duplicate business records. Email notifications are treated as provisional evidence, not authoritative records.

The 2026-08-16 operating direction expands this from a TheBinMap-focused intake workflow into **Email Operations**: a reusable, company-scoped capability intended to manage inbound communications across the QSL portfolio while preserving evidence, authority boundaries, and human attention.

## 2026-08-16 Email Operations Operating Model

The canonical hierarchy is:

**Company → Mailbox Profile → Message / Intake Record → Deterministic Sort → Action State → Review / Evidence**

### Company is the isolation boundary

Each Paperclip company receives its own plugin configuration, intake issues, state, cursor history, review records, and outbound authority settings. The same Email Operations implementation should serve TheBinMap, TherapistIndex, QSL, and future portfolio companies without adding venture-specific worker logic.

### Mailbox profiles are transport endpoints, not business identity

A company may operate one or more mailbox profiles. Profile keys identify the transport endpoint that received a message; portfolio/venture identity is determined independently from company context and source evidence.

Current v1 limitation: additional profiles share the company-level credential resolved by the worker. This is safe for aliases or endpoints in one credential group. **Independent mailbox credentials are not yet a completed capability** and require a later per-profile credential binding contract before unrelated accounts are added.

### Sorting is authoritative before UI presentation

The UI must consume the persisted `intake-sort-result` contract rather than recreate classification from subjects or source strings. The deterministic sorter currently separates records into:

- `store_submission`
- `general_email`
- `reply_continuation`
- `spam_irrelevant`
- `duplicate`
- `incomplete`
- `unknown`

The console may build operational views such as Needs Attention, Draft Work, Needs Review, Submissions, Correspondence, Data Quality, Suppressed, and Reviewed, but those views are projections over the persisted sort result rather than a second classifier.

### Human attention is the scarce resource

The Email Operations page should answer, in order:

1. What actually needs attention?
2. What can be safely suppressed or ignored?
3. What has a draft candidate ready for review?
4. What still lacks a human verdict?
5. What evidence is incomplete, conflicting, or provisional?

Routine provider marketing and deterministic duplicates should not compete visually with customer, registration, operational, security, or commercial messages.

### Outbound authority remains separate

Draft creation and message sending remain different actions. A draft candidate is evidence/work product, not authority to communicate externally.

Default draft candidates must be **portfolio-neutral**. Venture-specific voice, signatures, legal language, and automatic-response policies belong in an explicitly selected company/template policy. No company name may be silently hard-coded into a shared default draft generator.

Automated sending remains outside this operationalization step.

### UI scalability seam

The Email Operations page is company-scoped now and can display the configured mailbox profile set. Per-message mailbox identity is already preserved in the issue Email record through `profileKey`.

Queue-level mailbox filtering is intentionally deferred until `profileKey` is promoted into the `intake-queue` data contract. This avoids client-side N+1 message lookups and keeps future large queues compatible with server-side filtering/pagination.

## What Works Now from Email Notifications

1. **Deterministic form-source detection** — email subjects and body patterns are matched with confidence scores.
2. **Field extraction** — store name, address, city, state, postal code, phone, website, social URLs, restock days, pricing schedule, and submitter info are extracted from the email body.
3. **Heuristic classification** — 13 message categories (store_submission, listing_claim, contact_general, etc.).
4. **Provisional intake record creation** — each email notification creates an intake record marked as `email_notification` transport with `partial` or `needs_source_verification` completeness.
5. **Duplicate matching against known store database** — ingested submissions are compared against the configured store export.
6. **Append-only human review with verdicts and operational outcomes**.
7. **Deduplicated intake notifications** for high-priority store submissions.
8. **Deterministic final sorting** — intake records persist a seven-category sort result and reply-action status.
9. **Safe draft candidates** — eligible records can produce draft candidates without sending or granting outbound authority.
10. **Company-scoped Email Operations console** — the queue surfaces attention, draft, review, evidence-quality, portfolio-brand, and suppression views from the persisted intake state.

## What Remains Provisional

1. **All email-notification records are provisional** — field values extracted from email bodies have confidence scores (typically 0.5–0.7) and are labeled as "unconfirmed" in the UI.
2. **Missing fields are tracked** — when the email body doesn't contain certain form fields, they're listed in `missingFields`.
3. **No automatic external action** — partial records remain in the review queue for human follow-up.
4. **Conflicting values are preserved** — when two evidence sources disagree on a field value, both are retained with their source transport.
5. **Per-profile credentials are not implemented** — current additional profiles share one company credential.
6. **Queue-level mailbox filtering is not implemented** — `profileKey` remains on the issue Email record until the queue contract is extended.
7. **Venture-specific outbound templates are not implemented** — default draft candidates are deliberately portfolio-neutral.

## What Requires Provider Webhook/API or WordPress Integration

| Capability | Current State | Required Integration |
|---|---|---|
| Complete structured form data | Provisional (email only) | Web3Forms/Formspree webhook, WordPress REST API, or GeoDirectory event hook |
| Verified field values | Confidence-scored from email | Provider API with structured JSON payload |
| Atomic creation (no missing fields) | Supported in contract | Provider webhook with full payload |
| Real-time intake | Polling only (IMAP) | Webhook push endpoint |
| Evidence enrichment | Supported in contract | Provider API returning structured records |

## Provider Capabilities That May Require Paid Plans

| Provider | Free Tier Cap | Paid Plan Requirement |
|---|---|---|
| Web3Forms | 250 submissions/month, no webhooks | Pro plan for webhook delivery, API access for submission export |
| Formspree | 50 submissions/month, webhooks on all plans | Higher tiers for volume |
| WordPress/GeoDirectory | REST API included | Custom plugin or Gravity Forms webhook add-on for structured events |
| Cloudflare Email Routing | Free (email forwarding) | Not a form provider |

## Smallest Later Integration Step for Each Provider

### Web3Forms Webhook
1. Enable webhook in Web3Forms dashboard (Pro plan required).
2. Create a Paperclip webhook handler route at `/api/intake/web3forms`.
3. Validate the webhook signature.
4. Call `ReconciliationStore.add()` with `intakeTransport: "provider_webhook"` and `providerSubmissionId`.
5. Existing email-notification records with matching fingerprints auto-enrich.

### Formspree Webhook
1. Enable webhook in Formspree form settings (available on all plans).
2. Create a Paperclip webhook handler route at `/api/intake/formspree`.
3. Parse structured JSON payload with full form fields.
4. Call `ReconciliationStore.add()` with `intakeTransport: "provider_api"` and `providerSubmissionId`.

### WordPress/GeoDirectory Event
1. Install a WordPress plugin or custom action hook on form submission events.
2. POST structured payload to a Paperclip internal endpoint.
3. Call `ReconciliationStore.add()` with `intakeTransport: "wordpress_event"`.

### Provider Export (Bulk)
1. Add a cron job that fetches provider submission export CSV/JSON.
2. For each submission, check the ReconciliationStore for existing records by submission ID.
3. Enrich existing records or create new ones with `intakeTransport: "provider_api"`.

## How the Design Avoids Lock-In

1. **Transport-agnostic evidence model** — every evidence source is stored independently with its transport type.
2. **Precedence-based merging** — stronger evidence enriches weaker evidence; transport precedence is configurable.
3. **No provider-specific data in the core schema** — intake metadata uses generic fields (providerSubmissionId, emailMessageId) that work across providers.
4. **ReconciliationStore is ephemeral** — it's derived from plugin_state data and can be rebuilt.
5. **Fingerprint-based correlation** — canonical payload fingerprints allow matching across providers without relying on provider-specific IDs.
6. **Company-scoped operation** — portfolio companies reuse the same worker and UI with independent config/state boundaries.
7. **Neutral default drafting** — shared draft generation cannot accidentally impersonate another portfolio company.

## What Has Been Implemented

### New Files
- `packages/plugins/plugin-email/src/mail/intake-metadata.ts` — IntakeTransport, RecordCompleteness, EvidenceSource, IntakeMetadata types with merge, conflict detection, and completeness computation
- `packages/plugins/plugin-email/src/mail/reconciliation.ts` — ReconciliationStore, correlateIncomingEvidence, reconcileRecord, canonical payload fingerprinting
- `packages/plugins/plugin-email/tests/intake-metadata.spec.ts` — 38 synthetic tests covering all 10 required scenarios
- `packages/plugins/plugin-email/tests/draft-brand-neutral.spec.ts` — regression coverage preventing venture names from leaking into shared default drafts

### Modified Files
- `packages/plugins/plugin-email/src/mail/normalize.ts` — StoreIntakeRecord includes `intakeMetadata`; extractStoreIntake computes and populates it
- `packages/plugins/plugin-email/src/worker.ts` — ingestMessage stores intake metadata in plugin_state with reconciliation store persistence; data providers expose metadata and persisted sorting to UI
- `packages/plugins/plugin-email/src/mail/drafts.ts` — shared draft candidates are portfolio-neutral and remain non-sending work products
- `packages/plugins/plugin-email/src/ui/store-intake-page.tsx` — upgraded from store-focused review table to company-scoped Email Operations console driven by persisted sort/action state
- `packages/plugins/plugin-email/src/ui/store-intake-tab.tsx` — Source Data Quality card with completeness, transport, evidence sources, missing fields, conflicting values
- `packages/plugins/plugin-email/src/manifest.ts` — Email Operations naming and explicit multi-mailbox credential boundary

### Future Enrichment Contract

When a structured provider payload arrives (webhook, API, WordPress event), the contract supports:
1. Adding a new EvidenceSource with `provider_webhook`, `provider_api`, or `wordpress_event` transport.
2. Setting `providerSubmissionId` from the provider's ID.
3. `ReconciliationStore` correlation by submission ID will match the existing provisional record.
4. `reconcileRecord` will enrich field values with stronger evidence and update the completeness status.
5. Conflicting values are tracked in `conflictingFields`.
6. No duplicate business record is created.

## Next Operational Gates

1. **Build/typecheck the plugin and UI.**
2. **Review CI and any static-analysis findings.**
3. **Promote `profileKey` into the queue contract before implementing mailbox-level filtering/pagination.**
4. **Design per-profile secret bindings before attaching unrelated mailbox credentials.**
5. **Use real TheBinMap traffic for bounded staging validation.**
6. **Add TherapistIndex as the next company only after representative registration/office-registration messages are captured and deterministic source rules are defined.**
7. **Keep scheduled polling and outbound sending disabled until separately approved.**
