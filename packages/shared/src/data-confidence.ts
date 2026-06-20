/**
 * Data Confidence Classification Layer
 *
 * Defines confidence states for all data produced by governance agents.
 * Governance agents must NOT invent metrics — missing data should produce
 * blocked/unverified state instead of fabricated distributions.
 *
 * Co-Authored-By: Paperclip <noreply@paperclip.ing>
 */

/**
 * Confidence states for institutional data.
 *
 * - verified:    Data backed by direct evidence from authoritative source.
 * - partial:     Some fields evidence-backed, others inferred or incomplete.
 * - inferred:    Data derived from heuristics or indirect signals, not confirmed.
 * - synthetic:   Data generated for modeling/testing, NOT from real-world source.
 * - blocked:     Data source unavailable — cannot determine real value.
 * - unverified:  Data present but not yet validated against authoritative source.
 */
export type DataConfidence =
  | "verified"
  | "partial"
  | "inferred"
  | "synthetic"
  | "blocked"
  | "unverified";

export const ALL_CONFIDENCE_STATES: readonly DataConfidence[] = [
  "verified",
  "partial",
  "inferred",
  "synthetic",
  "blocked",
  "unverified",
];

/**
 * Confidence envelope wrapping any data payload.
 * Governance agents attach this to all produced metrics and reports.
 */
export interface ConfidenceEnvelope<T = unknown> {
  /** The data payload */
  data: T;
  /** Confidence classification */
  confidence: DataConfidence;
  /** Human-readable reason for this confidence level */
  reason: string;
  /** Source reference (URL, file path, API endpoint, etc.) */
  evidenceRef: string | null;
  /** ISO timestamp of when confidence was assessed */
  assessedAt: string;
  /** ID of the agent or user that assessed confidence */
  assessedBy: string | null;
}

/**
 * Validate that a string is a valid DataConfidence value.
 */
export function isValidConfidence(value: unknown): value is DataConfidence {
  return typeof value === "string" && ALL_CONFIDENCE_STATES.includes(value as DataConfidence);
}

/**
 * Create a confidence envelope for verified data.
 */
export function verified<T>(data: T, opts: { reason?: string; evidenceRef?: string; assessedBy?: string } = {}): ConfidenceEnvelope<T> {
  return {
    data,
    confidence: "verified",
    reason: opts.reason ?? "Data confirmed from authoritative source",
    evidenceRef: opts.evidenceRef ?? null,
    assessedAt: new Date().toISOString(),
    assessedBy: opts.assessedBy ?? null,
  };
}

/**
 * Create a confidence envelope for inferred data.
 */
export function inferred<T>(data: T, reason: string, opts: { evidenceRef?: string; assessedBy?: string } = {}): ConfidenceEnvelope<T> {
  return {
    data,
    confidence: "inferred",
    reason,
    evidenceRef: opts.evidenceRef ?? null,
    assessedAt: new Date().toISOString(),
    assessedBy: opts.assessedBy ?? null,
  };
}

/**
 * Create a blocked confidence envelope when data source is unavailable.
 */
export function blocked<T>(fallback: T, reason: string, opts: { assessedBy?: string } = {}): ConfidenceEnvelope<T> {
  return {
    data: fallback,
    confidence: "blocked",
    reason,
    evidenceRef: null,
    assessedAt: new Date().toISOString(),
    assessedBy: opts.assessedBy ?? null,
  };
}

/**
 * Rules for governance agents regarding data confidence.
 *
 * These are enforced at the service layer and documented in board exports.
 */
export const GOVERNANCE_CONFIDENCE_RULES = {
  /** TrustScore recommendations require verified evidence */
  trustScoreRequiresVerified: true,
  /** Operational reports must distinguish evidence-backed vs inferred */
  reportsDistinguishConfidence: true,
  /** Missing datasets produce blocked/unverified instead of fabricated data */
  missingDataProducesBlocked: true,
  /** Governance agents must NOT invent metrics */
  noFabricatedMetrics: true,
} as const;

/**
 * UI display metadata for each confidence level.
 */
export const CONFIDENCE_DISPLAY: Record<DataConfidence, {
  label: string;
  color: string;
  description: string;
}> = {
  verified: {
    label: "Verified",
    color: "green",
    description: "Confirmed from authoritative source",
  },
  partial: {
    label: "Partial",
    color: "amber",
    description: "Some fields evidence-backed, others incomplete",
  },
  inferred: {
    label: "Inferred",
    color: "orange",
    description: "Derived from heuristics, not confirmed",
  },
  synthetic: {
    label: "Synthetic",
    color: "purple",
    description: "Generated for modeling/testing purposes",
  },
  blocked: {
    label: "Blocked",
    color: "red",
    description: "Data source unavailable",
  },
  unverified: {
    label: "Unverified",
    color: "gray",
    description: "Not yet validated against authoritative source",
  },
};
