import fs from "node:fs";

const path = "doc/plans/2026-08-06-email-intake-source-of-truth.md";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(oldText, newText) {
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`Expected doc anchor not found: ${oldText.slice(0, 120)}`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error(`Doc anchor is not unique: ${oldText.slice(0, 120)}`);
  source = source.slice(0, first) + newText + source.slice(first + oldText.length);
}

replaceOnce(
`Current v1 limitation: additional profiles share the company-level credential resolved by the worker. This is safe for aliases or endpoints in one credential group. **Independent mailbox credentials are not yet a completed capability** and require a later per-profile credential binding contract before unrelated accounts are added.`,
`The preferred configuration is now a structured \`mailboxProfiles\` array. Each mailbox has a stable company-local key, real mailbox address, and operational status: \`active\`, \`standby\`, or \`reserved\`. An active structured mailbox must have its **own governed secret binding** before it can poll or send; standby and reserved mailboxes can be modeled without credentials until they are deliberately activated.

The legacy top-level \`username\` / \`credentialSecretRef\` / \`extraProfilesJson\` path remains backward-compatible for the existing Gmail bootstrap and same-credential aliases. It is a compatibility path, not the target architecture for unrelated inboxes.`
);

replaceOnce(
`### Sorting is authoritative before UI presentation`,
`### WordPress identity is not mailbox ownership

For WordPress properties such as TherapistIndex, keep these concepts separate:

**WordPress login identity ≠ WordPress notification recipient ≠ Email Operations mailbox ownership**

A WordPress administrative username may belong to a QSL identity while site notifications route to a TherapistIndex mailbox. Email Operations therefore routes from actual inbound evidence, receiving mailbox profile, source/site context, and deterministic event patterns — never from the WordPress login username alone.

### Sorting is authoritative before UI presentation`
);

replaceOnce(
`### UI scalability seam

The Email Operations page is company-scoped now and can display the configured mailbox profile set. Per-message mailbox identity is already preserved in the issue Email record through \`profileKey\`.

Queue-level mailbox filtering is intentionally deferred until \`profileKey\` is promoted into the \`intake-queue\` data contract. This avoids client-side N+1 message lookups and keeps future large queues compatible with server-side filtering/pagination.`,
`### Mailbox identity is first-class in the queue

The Email Operations page remains company-scoped, while \`profileKey\` is now promoted from immutable issue email evidence into the \`intake-queue\` contract. The queue also exposes the configured mailbox address, sender, recipient, message subject, and message date.

Mailbox filtering happens in the data-provider path before records reach the UI. This avoids client-side N+1 message lookups and gives future pagination/indexing work a stable company + mailbox boundary.`
);

replaceOnce(
`11. **Company-scoped Email Operations console** — the queue surfaces attention, draft, notification, review, evidence-quality, portfolio-brand, and suppression views from persisted intake state.`,
`11. **Company-scoped Email Operations console** — the queue surfaces attention, draft, notification, review, evidence-quality, portfolio-brand, and suppression views from persisted intake state.
12. **First-class mailbox queue identity** — \`profileKey\`, configured mailbox address, sender/recipient metadata, and mailbox-scoped filtering are part of the queue contract.
13. **Governed multi-mailbox profiles** — companies can model active, standby, and reserved mailboxes; active structured mailboxes resolve their own nested Paperclip secret binding.
14. **Exact-mailbox outbound safety** — a reply may use only the mailbox profile recorded on the original message. Missing, standby, or reserved profiles fail closed instead of falling back to another mailbox.`
);

replaceOnce(
`5. **Per-profile credentials are not implemented** — current additional profiles share one company credential.
6. **Queue-level mailbox filtering is not implemented** — \`profileKey\` remains on the issue Email record until the queue contract is extended.
7. **Venture-specific outbound templates are not implemented** — default draft candidates are deliberately portfolio-neutral.
8. **TherapistIndex registration/office-event subtypes are not yet modeled** — exact deterministic rules should be added only after representative real messages are captured. Do not infer those formats from unrelated mail.`,
`5. **Direct company mailbox connections are not yet configured in runtime** — the architecture supports independent mailbox credentials, but no new Hostinger/QSL/TherapistIndex mailbox secret or live connection is introduced by this source change.
6. **Venture-specific outbound templates are not implemented** — default draft candidates are deliberately portfolio-neutral.
7. **TherapistIndex registration/office-event subtypes are not yet modeled** — exact deterministic rules should be added only after a representative real office/listing-registration message is captured. Do not infer that format from unrelated WordPress mail.
8. **Scheduled polling and outbound remain separately governed** — modeling or activating mailbox profiles in configuration must not silently grant recurring polling or external-send authority.`
);

replaceOnce(
`- \`packages/plugins/plugin-email/tests/system-notification-draft.spec.ts\` — regression coverage proving system notifications cannot produce draft candidates or reply-draft documents`,
`- \`packages/plugins/plugin-email/tests/system-notification-draft.spec.ts\` — regression coverage proving system notifications cannot produce draft candidates or reply-draft documents
- \`packages/plugins/plugin-email/src/mail/mailbox-profiles.ts\` — first-class mailbox profile model with active/standby/reserved states, structured-vs-legacy compatibility, and exact secret-binding paths
- \`packages/plugins/plugin-email/tests/mailbox-profiles.spec.ts\` — regression coverage for independent mailbox secrets, fail-closed activation, reserved/standby modeling, duplicate keys, and legacy Gmail compatibility`
);

replaceOnce(
`- \`packages/plugins/plugin-email/src/worker.ts\` — ingestMessage stores intake metadata in plugin_state with reconciliation store persistence; data providers expose metadata and persisted sorting to UI`,
`- \`packages/plugins/plugin-email/src/worker.ts\` — ingestMessage stores intake metadata in plugin_state; queue providers expose first-class mailbox identity/filtering; polling and sending resolve the exact active mailbox profile and its exact credential binding`
);

replaceOnce(
`- \`packages/plugins/plugin-email/src/ui/store-intake-page.tsx\` — upgraded from store-focused review table to company-scoped Email Operations console driven by persisted sort/action state, including a Notifications view`,
`- \`packages/plugins/plugin-email/src/ui/store-intake-page.tsx\` — company-scoped Email Operations console driven by persisted sort/action state, including mailbox identity, mailbox filtering, status-aware profile display, and operational views`
);

replaceOnce(
`- \`packages/plugins/plugin-email/src/manifest.ts\` — Email Operations naming and explicit multi-mailbox credential boundary`,
`- \`packages/plugins/plugin-email/src/manifest.ts\` — structured Mailbox Profiles settings with native nested Paperclip Secret pickers plus clearly labeled legacy compatibility fields`
);

const gatesStart = source.indexOf("## Next Operational Gates\n");
if (gatesStart < 0) throw new Error("Next Operational Gates heading not found.");
source = source.slice(0, gatesStart) + `## Next Operational Gates

1. **Review and merge the governed multi-mailbox profile PR after final validation.**
2. **Deploy to staging only under a separate approval** and confirm the existing Gmail bootstrap remains unchanged before any mailbox config migration.
3. **Model the real portfolio mailbox inventory** with active/standby/reserved states; modeling alone must not enable polling or sending.
4. **Bind credentials only through Paperclip Secrets** for the small first-wave set of direct mailboxes. Passwords/app passwords must never be pasted into chat, source, or JSON.
5. **Connect and manually validate one direct TheBinMap mailbox first** with scheduled polling still disabled and outbound still locked.
6. **Expand bounded direct intake to QSL and TherapistIndex only after the first direct mailbox proves the credential/profile boundary in staging.**
7. **Capture one representative TherapistIndex office/listing-registration message**, then add the exact deterministic UsersWP/GeoDirectory subtype and routing rule.
8. **Keep scheduled polling and outbound sending disabled until separately approved by the Board.**
`;

fs.writeFileSync(path, source);
console.log("Email Operations source-of-truth updated for governed multi-mailbox profiles.");
