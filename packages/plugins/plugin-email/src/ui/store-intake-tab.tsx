import { useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
} from "@paperclipai/plugin-sdk/ui";

type DuplicateCandidate = {
  storeId: string;
  storeName: string;
  matchStrength: string;
  matchReasons: string[];
  matchedFields: Record<string, string>;
};

type ReviewRecord = {
  reviewIndex: number;
  verdict: string;
  reviewer: string;
  reviewedAt: string;
  notes: string;
  correctedClassification?: string;
  duplicateLink?: { referenceId: string; reason: string };
  approvedNextAction?: string;
  operationalOutcome?: string;
};

type AnalysisRecord = {
  contractVersion: string;
  modelProvider: string;
  modelId: string;
  analysis: {
    category: string;
    subcategory?: string;
    authenticityPrediction: string;
    confidence: number;
    priority: string;
    priorityReason: string;
    extractedFields: Array<{ key: string; value: string; confidence: number }>;
    missingInformation: Array<{ key: string; description: string }>;
    relatedHints: unknown[];
    recommendedQueue: string;
    recommendedNextAction: string;
    responseRequired: boolean;
    humanApprovalRequired: boolean;
    summary: string;
  };
  inputFingerprint: string;
  analyzedAt: string;
  sourceKind: string;
};

type IntakeMetadataType = {
  intakeTransport: string;
  recordCompleteness: string;
  evidenceSources: Array<{
    transport: string;
    referenceId: string;
    receivedAt: string;
    providerSubmissionId?: string;
    emailMessageId?: string;
    payloadHash: string;
    fieldCount: number;
    fieldsPresent: string[];
  }>;
  providerSubmissionId: string | null;
  emailMessageId: string | null;
  correlationFingerprint: string;
  missingFields: string[];
  conflictingFields: Array<{
    field: string;
    values: Array<{ value: string; source: string; precedence: number }>;
  }>;
  lastEnrichedAt: string | null;
};

type StoreIntakeData = {
  evidence: {
    sourceDetection: {
      sourceType: string;
      sourceForm: string;
      sourcePage: string;
      confidence: number;
      evidence: string[];
    };
    storeIntake: {
      originalValues: Record<string, string>;
      normalizedValues: Record<string, string>;
      confidenceByField: Record<string, number>;
      missingFields: string[];
      category: string;
      priority: string;
      status: string;
    } | null;
    messageId: string;
    fromAddress: string;
    subject: string;
    date: string;
    evidenceId: string;
    ingestedAt: string;
  } | null;
  duplicates: DuplicateCandidate[];
  analyses: AnalysisRecord[];
  reviews: ReviewRecord[];
  latestAnalysis: {
    category: string;
    authenticityPrediction: string;
    confidence: number;
    priority: string;
    priorityReason: string;
    summary: string;
  } | null;
  latestReview: ReviewRecord | null;
  latestVerdict: string | null;
  latestOutcome: string | null;
  intakeMetadata: IntakeMetadataType | null;
} | null;

const VERDICT_LABELS: Record<string, string> = {
  genuine_external: "Genuine external",
  internal_test: "Internal test",
  family_test: "Family test",
  spam: "Spam",
  duplicate: "Duplicate",
  unsure: "Unsure",
};

const OUTCOME_LABELS: Record<string, string> = {
  needs_verification: "Needs verification",
  accepted: "Accepted",
  rejected: "Rejected",
  closed: "Closed",
};

const TRANSPORT_LABELS: Record<string, string> = {
  provider_webhook: "Webhook",
  provider_api: "Provider API",
  wordpress_event: "WordPress",
  email_notification: "Email Notification",
  inferred_email: "Inferred Email",
};

const COMPLETENESS_LABELS: Record<string, string> = {
  complete: "Complete",
  partial: "Partial",
  needs_source_verification: "Needs Source Verification",
};

function completenessColor(c: string): string {
  if (c === "complete") return "#27ae60";
  if (c === "partial") return "#e67e22";
  return "#e74c3c";
}

function transportColor(t: string): string {
  if (t === "provider_webhook" || t === "provider_api") return "#2980b9";
  if (t === "wordpress_event") return "#8e44ad";
  if (t === "email_notification") return "#7f8c8d";
  return "#bdc3c7";
}

const box = (gap: number, pad: number) => ({ display: "grid", gap, padding: pad, fontSize: 13 } as const);
const row = () => ({ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" } as const);
const labelStyle = () => ({ fontWeight: 600, minWidth: 110, opacity: 0.75 } as const);
const cardStyle = () => ({ border: "1px solid rgba(127,127,127,0.35)", borderRadius: 8, padding: 10, display: "grid", gap: 6 } as const);
const btn = () => ({ padding: "6px 14px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.5)", cursor: "pointer", fontWeight: 600 } as const);
const errStyle = { color: "#c0392b", fontSize: 12 };
const okStyle = { color: "#1e8449", fontSize: 12 };
const tag = (color: string) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: color, color: "#fff" } as const);

export function StoreIntakeTab({ context }: PluginDetailTabProps) {
  const issueId = context.entityId;
  const { data, loading, error, refresh } = usePluginData<StoreIntakeData>("store-intake", { issueId });
  const performReview = usePluginAction("perform-review");
  const [verdictChoice, setVerdictChoice] = useState<string>("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [outcomeChoice, setOutcomeChoice] = useState<string>("");
  const [duplicateRef, setDuplicateRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewSuccess, setReviewSuccess] = useState(false);

  if (loading) return <div style={box(10, 12)}>Loading store intake record...</div>;
  if (error) return <div style={box(10, 12)}><span style={errStyle}>Error: {error.message}</span></div>;
  if (!data?.evidence) {
    return <div style={box(10, 12)}><span style={{ opacity: 0.7 }}>No store intake record linked to this issue.</span></div>;
  }

  const { evidence, duplicates, analyses, reviews, latestAnalysis, latestReview, intakeMetadata } = data;
  const intake = evidence.storeIntake;

  async function handleReview() {
    if (!verdictChoice) return;
    setBusy(true);
    setReviewError(null);
    setReviewSuccess(false);
    try {
      const reviewParams: Record<string, unknown> = {
        issueId,
        verdict: verdictChoice,
        notes: reviewNotes,
      };
      if (outcomeChoice) reviewParams.operationalOutcome = outcomeChoice;
      if (verdictChoice === "duplicate" && duplicateRef) {
        reviewParams.duplicateLink = { referenceId: duplicateRef, reason: reviewNotes || "Linked by reviewer" };
      }
      await performReview(reviewParams);
      setReviewSuccess(true);
      refresh();
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : "Review failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={box(12, 14)}>
      {latestReview && (
        <div style={cardStyle()}>
          <div style={{ fontWeight: 700, display: "flex", gap: 8, alignItems: "center" }}>
            Current verdict
            <span style={tag(latestReview.verdict === "genuine_external" ? "#27ae60" : latestReview.verdict === "spam" ? "#e74c3c" : "#7f8c8d")}>
              {VERDICT_LABELS[latestReview.verdict] || latestReview.verdict}
            </span>
          </div>
          <div style={row()}><span style={labelStyle()}>Reviewer</span><span>{latestReview.reviewer}</span></div>
          <div style={row()}><span style={labelStyle()}>Reviewed</span><span>{new Date(latestReview.reviewedAt).toLocaleString()}</span></div>
          {latestReview.operationalOutcome && (
            <div style={row()}><span style={labelStyle()}>Outcome</span><span>{OUTCOME_LABELS[latestReview.operationalOutcome] || latestReview.operationalOutcome}</span></div>
          )}
          {latestReview.notes && (
            <div style={row()}><span style={labelStyle()}>Notes</span><span>{latestReview.notes}</span></div>
          )}
        </div>
      )}

      {intakeMetadata && (
        <div style={cardStyle()}>
          <div style={{ fontWeight: 700 }}>Source Data Quality</div>
          <div style={row()}>
            <span style={labelStyle()}>Completeness</span>
            <span style={{
              display: "inline-block",
              padding: "2px 8px",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              color: completenessColor(intakeMetadata.recordCompleteness),
              background: completenessColor(intakeMetadata.recordCompleteness) + "22",
            }}>
              {COMPLETENESS_LABELS[intakeMetadata.recordCompleteness] || intakeMetadata.recordCompleteness}
            </span>
          </div>
          <div style={row()}>
            <span style={labelStyle()}>Transport</span>
            <span style={{
              display: "inline-block",
              padding: "2px 8px",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              color: transportColor(intakeMetadata.intakeTransport),
              background: transportColor(intakeMetadata.intakeTransport) + "22",
            }}>
              {TRANSPORT_LABELS[intakeMetadata.intakeTransport] || intakeMetadata.intakeTransport}
            </span>
          </div>
          {intakeMetadata.providerSubmissionId && (
            <div style={row()}>
              <span style={labelStyle()}>Submission ID</span>
              <span style={{ fontFamily: "monospace", fontSize: 12 }}>{intakeMetadata.providerSubmissionId}</span>
            </div>
          )}
          {intakeMetadata.emailMessageId && (
            <div style={row()}>
              <span style={labelStyle()}>Message ID</span>
              <span style={{ fontFamily: "monospace", fontSize: 12, opacity: 0.8 }}>{intakeMetadata.emailMessageId.slice(0, 24)}...</span>
            </div>
          )}
          {intakeMetadata.lastEnrichedAt && (
            <div style={row()}>
              <span style={labelStyle()}>Last enriched</span>
              <span>{new Date(intakeMetadata.lastEnrichedAt).toLocaleString()}</span>
            </div>
          )}
          {intakeMetadata.evidenceSources.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Evidence sources ({intakeMetadata.evidenceSources.length})</div>
              {intakeMetadata.evidenceSources.map((src, i) => (
                <div key={i} style={{ fontSize: 11, opacity: 0.8, padding: "2px 0" }}>
                  <span style={{
                    display: "inline-block",
                    padding: "1px 6px",
                    borderRadius: 3,
                    fontWeight: 600,
                    color: transportColor(src.transport),
                    background: transportColor(src.transport) + "22",
                  }}>
                    {TRANSPORT_LABELS[src.transport] || src.transport}
                  </span>
                  {" "}{src.fieldCount} fields · {new Date(src.receivedAt).toLocaleDateString()}
                </div>
              ))}
            </div>
          )}
          {intakeMetadata.missingFields.length > 0 && (
            <div style={row()}>
              <span style={labelStyle()}>Missing fields</span>
              <span style={{ opacity: 0.75, fontSize: 12 }}>{intakeMetadata.missingFields.join(", ")}</span>
            </div>
          )}
        </div>
      )}

      {intakeMetadata && intakeMetadata.conflictingFields.length > 0 && (
        <div style={cardStyle()}>
          <div style={{ fontWeight: 700, color: "#e74c3c" }}>Conflicting field values</div>
          {intakeMetadata.conflictingFields.map((conflict, i) => (
            <div key={i} style={{ padding: "4px 0", borderBottom: i < intakeMetadata.conflictingFields.length - 1 ? "1px solid rgba(127,127,127,0.2)" : "none" }}>
              <div style={{ fontWeight: 600, fontSize: 12 }}>{conflict.field}</div>
              <div style={{ fontSize: 11, opacity: 0.8 }}>
                {conflict.values.map((v, j) => (
                  <span key={j} style={{
                    display: "inline-block",
                    marginRight: 8,
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: v.precedence <= 2 ? "rgba(39,174,96,0.1)" : "rgba(127,127,127,0.08)",
                  }}>
                    "{v.value}" <span style={{ opacity: 0.6 }}>({TRANSPORT_LABELS[v.source] || v.source})</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {intake && (
        <div style={cardStyle()}>
          <div style={{ fontWeight: 700 }}>Store information</div>
          {["storeName", "address", "city", "state", "postalCode", "phone", "website", "facebookUrl", "otherSocialUrl", "restockDays", "pricingSchedule"].map((field) => {
            const orig = intake.originalValues[field];
            const norm = intake.normalizedValues[field];
            if (!orig) return null;
            const isInferred = intakeMetadata?.intakeTransport === "inferred_email" || intakeMetadata?.intakeTransport === "email_notification";
            return (
              <div key={field} style={row()}>
                <span style={labelStyle()}>{field}</span>
                <span>{norm || orig}</span>
                {intake.confidenceByField[field] && (
                  <span style={{ fontSize: 11, opacity: 0.6 }}>({Math.round(intake.confidenceByField[field] * 100)}%)</span>
                )}
                {isInferred && (
                  <span style={{ fontSize: 10, color: "#e67e22", fontWeight: 600 }}>unconfirmed</span>
                )}
              </div>
            );
          })}
          {intake.missingFields.length > 0 && (
            <div style={row()}>
              <span style={labelStyle()}>Missing</span>
              <span style={{ opacity: 0.7 }}>{intake.missingFields.join(", ")}</span>
            </div>
          )}
        </div>
      )}

      <div style={cardStyle()}>
        <div style={{ fontWeight: 700 }}>Source</div>
        <div style={row()}><span style={labelStyle()}>Form</span><span>{evidence.sourceDetection.sourceForm}</span></div>
        <div style={row()}><span style={labelStyle()}>Type</span><span>{evidence.sourceDetection.sourceType}</span></div>
        <div style={row()}><span style={labelStyle()}>Page</span><span>{evidence.sourceDetection.sourcePage}</span></div>
        <div style={row()}><span style={labelStyle()}>Received</span><span>{new Date(evidence.date).toLocaleString()}</span></div>
        <div style={row()}><span style={labelStyle()}>Evidence ID</span><span style={{ fontFamily: "monospace", fontSize: 12 }}>{evidence.evidenceId.slice(0, 16)}</span></div>
      </div>

      {latestAnalysis && (
        <div style={cardStyle()}>
          <div style={{ fontWeight: 700 }}>Analysis</div>
          <div style={row()}><span style={labelStyle()}>Category</span><span>{latestAnalysis.category}</span></div>
          <div style={row()}><span style={labelStyle()}>Authenticity</span><span>{latestAnalysis.authenticityPrediction}</span></div>
          <div style={row()}><span style={labelStyle()}>Confidence</span><span>{Math.round(latestAnalysis.confidence * 100)}%</span></div>
          <div style={row()}><span style={labelStyle()}>Priority</span><span>{latestAnalysis.priority}</span></div>
          <div style={row()}><span style={labelStyle()}>Reason</span><span>{latestAnalysis.priorityReason}</span></div>
          {latestAnalysis.summary && <div style={{ opacity: 0.8, fontSize: 12 }}>{latestAnalysis.summary}</div>}
        </div>
      )}

      {duplicates.length > 0 && (
        <div style={cardStyle()}>
          <div style={{ fontWeight: 700 }}>Duplicate candidates</div>
          {duplicates.map((d, i) => (
            <div key={i} style={{ padding: "4px 0", borderBottom: i < duplicates.length - 1 ? "1px solid rgba(127,127,127,0.2)" : "none" }}>
              <div style={{ fontWeight: 600 }}>{d.storeName} <span style={tag(d.matchStrength === "strong" ? "#e67e22" : "#7f8c8d")}>{d.matchStrength}</span></div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{d.matchReasons.join(", ")}</div>
            </div>
          ))}
        </div>
      )}

      {reviews.length > 1 && (
        <div style={cardStyle()}>
          <div style={{ fontWeight: 700 }}>Review history ({reviews.length} reviews)</div>
          {reviews.slice().reverse().map((r, i) => (
            <div key={i} style={{ fontSize: 12, opacity: 0.75 }}>
              #{r.reviewIndex}: {VERDICT_LABELS[r.verdict] || r.verdict} by {r.reviewer} on {new Date(r.reviewedAt).toLocaleString()}
              {r.notes ? ` — ${r.notes}` : ""}
            </div>
          ))}
        </div>
      )}

      <div style={cardStyle()}>
        <div style={{ fontWeight: 700 }}>Submit review</div>
        <div style={row()}>
          <span style={labelStyle()}>Verdict</span>
          <select value={verdictChoice} onChange={(e) => setVerdictChoice(e.target.value)} style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid rgba(127,127,127,0.5)" }}>
            <option value="">Select...</option>
            {Object.entries(VERDICT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        {verdictChoice === "genuine_external" && (
          <div style={row()}>
            <span style={labelStyle()}>Outcome</span>
            <select value={outcomeChoice} onChange={(e) => setOutcomeChoice(e.target.value)} style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid rgba(127,127,127,0.5)" }}>
              <option value="">Select...</option>
              {Object.entries(OUTCOME_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
        )}
        {verdictChoice === "duplicate" && (
          <div style={row()}>
            <span style={labelStyle()}>Ref ID</span>
            <input type="text" value={duplicateRef} onChange={(e) => setDuplicateRef(e.target.value)} placeholder="Store ID or record reference" style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid rgba(127,127,127,0.5)", width: 200 }} />
          </div>
        )}
        <div style={row()}>
          <span style={labelStyle()}>Notes</span>
          <input type="text" value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} placeholder="Optional review notes" style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid rgba(127,127,127,0.5)", flex: 1 }} />
        </div>
        <div>
          <button style={{ ...btn(), opacity: verdictChoice ? 1 : 0.5, background: verdictChoice ? "#2980b9" : "#bdc3c7", color: "#fff", borderColor: "transparent" }} disabled={!verdictChoice || busy} onClick={() => void handleReview()}>
            {busy ? "Saving..." : "Save verdict"}
          </button>
        </div>
        {reviewSuccess && <div style={okStyle}>Verdict saved.</div>}
        {reviewError && <div style={errStyle}>{reviewError}</div>}
      </div>
    </div>
  );
}