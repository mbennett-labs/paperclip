# Email Intake Source-of-Truth Architecture Report

Date: 2026-08-06

## Summary

The unified intake design now supports multiple evidence transports (email notification, provider webhook, provider API, WordPress event, inferred email) without creating duplicate business records. Email notifications are treated as provisional evidence, not authoritative records.

## What Works Now from Email Notifications

1. **Deterministic form-source detection** — email subjects and body patterns are matched with confidence scores.
2. **Field extraction** — store name, address, city, state, postal code, phone, website, social URLs, restock days, pricing schedule, and submitter info are extracted from the email body.
3. **Heuristic classification** — 13 message categories (store_submission, listing_claim, contact_general, etc.).
4. **Provisional intake record creation** — each email notification creates an intake record marked as `email_notification` transport with `partial` or `needs_source_verification` completeness.
5. **Duplicate matching against known store database** — ingested submissions are compared against the configured store export.
6. **Append-only human review with verdicts and operational outcomes**.
7. **Deduplicated intake notifications** for high-priority store submissions.

## What Remains Provisional

1. **All email-notification records are provisional** — field values extracted from email bodies have confidence scores (typically 0.5–0.7) and are labeled as "unconfirmed" in the UI.
2. **Missing fields are tracked** — when the email body doesn't contain certain form fields, they're listed in `missingFields`.
3. **No automatic external action** — partial records remain in the review queue for human follow-up.
4. **Conflicting values are preserved** — when two evidence sources disagree on a field value, both are retained with their source transport.

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

## What Has Been Implemented

### New Files
- `packages/plugins/plugin-email/src/mail/intake-metadata.ts` — IntakeTransport, RecordCompleteness, EvidenceSource, IntakeMetadata types with merge, conflict detection, and completeness computation
- `packages/plugins/plugin-email/src/mail/reconciliation.ts` — ReconciliationStore, correlateIncomingEvidence, reconcileRecord, canonical payload fingerprinting
- `packages/plugins/plugin-email/tests/intake-metadata.spec.ts` — 38 synthetic tests covering all 10 required scenarios

### Modified Files
- `packages/plugins/plugin-email/src/mail/normalize.ts` — StoreIntakeRecord now includes `intakeMetadata`; extractStoreIntake computes and populates it
- `packages/plugins/plugin-email/src/worker.ts` — ingestMessage stores intake metadata in plugin_state with reconciliation store persistence; data providers expose metadata to UI
- `packages/plugins/plugin-email/src/ui/store-intake-page.tsx` — Added Source Data status column, Transport column, filters for Partial and Needs Source Check
- `packages/plugins/plugin-email/src/ui/store-intake-tab.tsx` — Added Source Data Quality card with completeness, transport, evidence sources, missing fields, conflicting values

### Future Enrichment Contract

When a structured provider payload arrives (webhook, API, WordPress event), the contract supports:
1. Adding a new EvidenceSource with `provider_webhook`, `provider_api`, or `wordpress_event` transport.
2. Setting `providerSubmissionId` from the provider's ID.
3. `ReconciliationStore` correlation by submission ID will match the existing provisional record.
4. `reconcileRecord` will enrich field values with stronger evidence and update the completeness status.
5. Conflicting values are tracked in `conflictingFields`.
6. No duplicate business record is created.