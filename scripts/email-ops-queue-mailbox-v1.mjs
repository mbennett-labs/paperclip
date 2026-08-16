import fs from "node:fs";

function replaceOnce(path, oldText, newText) {
  const source = fs.readFileSync(path, "utf8");
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`Expected patch anchor not found in ${path}: ${oldText.slice(0, 120)}`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error(`Patch anchor is not unique in ${path}`);
  fs.writeFileSync(path, source.slice(0, first) + newText + source.slice(first + oldText.length));
}

const workerPath = "packages/plugins/plugin-email/src/worker.ts";
const worker = fs.readFileSync(workerPath, "utf8");
const queueStart = worker.indexOf('    // -- Intake queue data provider (D1: review queue) --');
const queueEnd = worker.indexOf('    // -- Perform human review action (D3: unique key per review; D4: trusted actor) --');
if (queueStart < 0 || queueEnd < 0 || queueEnd <= queueStart) {
  throw new Error("Could not locate intake queue provider boundaries.");
}

const queueBlock = String.raw`    // -- Intake queue data provider (D1: review queue) --
    ctx.data.register("intake-queue", async (params) => {
      const companyId = params?.companyId as string;
      if (!companyId) return [];
      const requestedProfileKey = typeof params?.profileKey === "string" && params.profileKey.trim()
        ? params.profileKey.trim()
        : null;
      try {
        const config = (await ctx.config.get(companyId).catch(() => null)) as EmailPluginConfig | null;
        const mailboxUsernameByKey = new Map<string, string>();
        if (config) {
          try {
            for (const profile of buildProfiles(config)) {
              mailboxUsernameByKey.set(profile.key, profile.username);
            }
          } catch {
            // Keep historical queue evidence readable even if current mailbox config is incomplete.
          }
        }

        const issues = await ctx.issues.list({
          companyId,
          originKindPrefix: ORIGIN_KIND_INTAKE,
          limit: 200,
        });
        const items: Array<Record<string, unknown>> = [];
        for (const issue of issues) {
          try {
            const evidence = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-evidence" });
            const evidenceRecord = evidence && typeof evidence === "object"
              ? evidence as Record<string, unknown>
              : null;
            const profileKey = typeof evidenceRecord?.profileKey === "string" ? evidenceRecord.profileKey : null;
            if (requestedProfileKey && profileKey !== requestedProfileKey) continue;

            const reviewKeys = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-review-keys" });
            const reviewKeyList: string[] = Array.isArray(reviewKeys) ? reviewKeys : [];
            let latestVerdict: string | null = null;
            let latestOutcome: string | null = null;
            if (reviewKeyList.length > 0) {
              const lastKey = reviewKeyList[reviewKeyList.length - 1];
              const lastReview = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: lastKey });
              if (lastReview) {
                const r = lastReview as ReviewRecord;
                latestVerdict = r.verdict;
                latestOutcome = r.operationalOutcome ?? null;
              }
            }
            const duplicates = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-duplicates" });
            const dupList = Array.isArray(duplicates) ? duplicates : [];
            const intakeMetadata = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-metadata" });
            const sortData = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-sort-result" }) as IntakeSortResult | undefined;
            const draftData = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-draft-candidate" }) as Record<string, unknown> | undefined;
            items.push({
              issueId: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              status: issue.status,
              priority: issue.priority,
              createdAt: issue.createdAt,
              profileKey,
              mailboxUsername: profileKey ? mailboxUsernameByKey.get(profileKey) ?? null : null,
              fromAddress: typeof evidenceRecord?.fromAddress === "string" ? evidenceRecord.fromAddress : null,
              to: typeof evidenceRecord?.to === "string" ? evidenceRecord.to : null,
              messageSubject: typeof evidenceRecord?.subject === "string" ? evidenceRecord.subject : issue.title,
              messageDate: typeof evidenceRecord?.date === "string" ? evidenceRecord.date : issue.createdAt,
              storeName: resolveQueueStoreName(evidenceRecord),
              sourceForm: evidenceRecord?.sourceDetection
                ? (evidenceRecord.sourceDetection as Record<string, string>)?.sourceForm ?? null
                : null,
              sourceType: evidenceRecord?.sourceDetection
                ? (evidenceRecord.sourceDetection as Record<string, string>)?.sourceType ?? null
                : null,
              latestVerdict,
              latestOutcome,
              duplicateCount: dupList.length,
              duplicateStrength: dupList.length > 0 ? (dupList.some((d: Record<string, unknown>) => d.matchStrength === "strong") ? "strong" : "possible") : null,
              hasEvidence: evidence != null,
              intakeTransport: intakeMetadata ? (intakeMetadata as IntakeMetadata).intakeTransport : "inferred_email",
              recordCompleteness: intakeMetadata ? (intakeMetadata as IntakeMetadata).recordCompleteness : "needs_source_verification",
              missingFields: intakeMetadata ? (intakeMetadata as IntakeMetadata).missingFields : [],
              conflictingFields: intakeMetadata ? (intakeMetadata as IntakeMetadata).conflictingFields : [],
              sortCategory: sortData?.category ?? null,
              sortLabel: sortData ? CATEGORY_LABELS[sortData.category] : null,
              replyActionStatus: sortData?.replyActionStatus ?? null,
              draftCandidateKind: draftData?.candidate ? (draftData.candidate as DraftCandidate).kind : null,
            });
          } catch { /* skip problematic issues */ }
        }
        return items;
      } catch {
        return [];
      }
    });

`;
fs.writeFileSync(workerPath, worker.slice(0, queueStart) + queueBlock + worker.slice(queueEnd));

const uiPath = "packages/plugins/plugin-email/src/ui/store-intake-page.tsx";
replaceOnce(uiPath,
`  draftCandidateKind: string | null;
};`,
`  draftCandidateKind: string | null;
  profileKey: string | null;
  mailboxUsername: string | null;
  fromAddress: string | null;
  to: string | null;
  messageSubject: string | null;
  messageDate: string | null;
};`);

replaceOnce(uiPath,
`export function StoreIntakePage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const { data, loading, error, refresh } = usePluginData<QueueItem[]>("intake-queue", { companyId });
  const { data: configData } = usePluginData<EmailPluginConfigView | null>("plugin-config", { companyId });
  const { resolveHref } = useHostNavigation();
  const [activeFilter, setActiveFilter] = useState<WorkflowFilter>("attention");
  const [brandFilter, setBrandFilter] = useState<BrandFilter>("all");
  const [search, setSearch] = useState("");`,
`export function StoreIntakePage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const [activeFilter, setActiveFilter] = useState<WorkflowFilter>("attention");
  const [brandFilter, setBrandFilter] = useState<BrandFilter>("all");
  const [mailboxFilter, setMailboxFilter] = useState("all");
  const [search, setSearch] = useState("");
  const { data, loading, error, refresh } = usePluginData<QueueItem[]>("intake-queue", {
    companyId,
    ...(mailboxFilter !== "all" ? { profileKey: mailboxFilter } : {}),
  });
  const { data: configData } = usePluginData<EmailPluginConfigView | null>("plugin-config", { companyId });
  const { resolveHref } = useHostNavigation();`);

replaceOnce(uiPath,
`          item.sortCategory,
          item.latestVerdict,
        ]`,
`          item.sortCategory,
          item.latestVerdict,
          item.profileKey,
          item.mailboxUsername,
          item.fromAddress,
          item.to,
        ]`);

replaceOnce(uiPath,
`        <select value={brandFilter} onChange={(event) => setBrandFilter(event.target.value as BrandFilter)} style={selectStyle}>
          {BRAND_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>{option.label}</option>
          ))}
        </select>
      </div>`,
`        <select value={brandFilter} onChange={(event) => setBrandFilter(event.target.value as BrandFilter)} style={selectStyle}>
          {BRAND_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>{option.label}</option>
          ))}
        </select>
        <select value={mailboxFilter} onChange={(event) => setMailboxFilter(event.target.value)} style={selectStyle}>
          <option value="all">All mailboxes</option>
          {mailboxProfiles.map((profile) => (
            <option key={profile.key} value={profile.key}>{profile.username}</option>
          ))}
        </select>
      </div>`);

replaceOnce(uiPath,
`          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 980 }}>`,
`          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 1120 }}>`);

replaceOnce(uiPath,
`                <th style={thStyle}>Portfolio</th>
                <th style={thStyle}>Sorted as</th>`,
`                <th style={thStyle}>Portfolio</th>
                <th style={thStyle}>Mailbox</th>
                <th style={thStyle}>Sorted as</th>`);

replaceOnce(uiPath,
`                    <td style={tdStyle}>
                      <span style={{ fontSize: 11, fontWeight: 600, opacity: brand === "unknown" ? 0.5 : 1 }}>
                        {BRAND_LABELS[brand]}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ ...badgeStyle, ...categoryStyle(item.sortCategory) }}>
                        {item.sortLabel || item.sortCategory?.replace(/_/g, " ") || item.sourceType?.replace(/_/g, " ") || "Unsorted"}
                      </span>
                    </td>`,
`                    <td style={tdStyle}>
                      <span style={{ fontSize: 11, fontWeight: 600, opacity: brand === "unknown" ? 0.5 : 1 }}>
                        {BRAND_LABELS[brand]}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <div style={{ fontSize: 11, fontWeight: 600 }} title={item.mailboxUsername || item.profileKey || undefined}>
                        {item.mailboxUsername || item.profileKey || "Unknown"}
                      </div>
                      {item.profileKey && item.mailboxUsername ? (
                        <div style={{ marginTop: 2, fontSize: 10, opacity: 0.5 }}>{item.profileKey}</div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      <span style={{ ...badgeStyle, ...categoryStyle(item.sortCategory) }}>
                        {item.sortLabel || item.sortCategory?.replace(/_/g, " ") || item.sourceType?.replace(/_/g, " ") || "Unsorted"}
                      </span>
                    </td>`);

replaceOnce(uiPath,
`                      <div style={{ marginTop: 2, fontSize: 10, opacity: 0.55 }}>
                        {item.sourceForm || item.sourceType || "unknown source"}
                      </div>`,
`                      <div style={{ marginTop: 2, fontSize: 10, opacity: 0.55 }}>
                        {item.fromAddress ? "from " + item.fromAddress : item.sourceForm || item.sourceType || "unknown source"}
                      </div>`);

replaceOnce(uiPath,
`        Showing {filtered.length} of {items.length} intake records. Company isolation is enforced by the page context. Mailbox profile identity is preserved on each issue’s Email record; queue-level mailbox filtering will be added when that identity is promoted into the queue contract.`,
`        Showing {filtered.length} of {items.length} intake records for the selected mailbox scope. Company isolation is enforced by the page context; mailbox identity and filtering are first-class queue fields.`);

console.log("Mailbox identity/filtering patch applied.");
