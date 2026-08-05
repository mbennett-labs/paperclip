/**
 * Bounded LLM intake analysis contract.
 *
 * This contract defines the input and output shapes for the governed
 * intake analysis pipeline. Deterministic facts run before any LLM
 * interpretation. The output is validated against the schema and
 * fails closed to `needs_classification`.
 *
 * No live model calls occur here. This is the schema + validation layer
 * only — the actual LLM invocation is gated by Human Board approval.
 */

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

export const ANALYSIS_CONTRACT_VERSION = "v1.0";

// ---------------------------------------------------------------------------
// Input: bounded intake work unit
// ---------------------------------------------------------------------------

export interface IntakeAnalysisInput {
  payload: Record<string, string>;
  source: {
    sourceType: string;
    sourceForm: string;
    sourcePage: string;
    confidence: number;
    evidence: string[];
  };
  classHint: string;
  ventureContext: string;
  priorClassifications?: Array<{ class: string; confidence: number }>;
  knownEntities?: Array<{ name: string; type: string }>;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface AnalyzedField {
  key: string;
  value: string;
  confidence: number;
}

export interface MissingInfo {
  key: string;
  description: string;
}

export interface DuplicateHint {
  reason: string;
  confidence: number;
  targetField?: string;
  targetValue?: string;
}

export interface ResponseDraft {
  to: string;
  subject: string;
  body: string;
}

export type AuthenticityPrediction = "likely_genuine" | "likely_spam" | "likely_test" | "uncertain";

export type AnalysisPriority = "low" | "medium" | "high" | "critical";

export interface IntakeAnalysisOutput {
  category: string;
  subcategory?: string;
  authenticityPrediction: AuthenticityPrediction;
  confidence: number;
  priority: AnalysisPriority;
  priorityReason: string;
  extractedFields: AnalyzedField[];
  missingInformation: MissingInfo[];
  relatedHints: DuplicateHint[];
  recommendedQueue: string;
  recommendedNextAction: string;
  responseRequired: boolean;
  responseDraft?: ResponseDraft;
  humanApprovalRequired: boolean;
  summary: string;
}

// ---------------------------------------------------------------------------
// Schema validation (manual, no zod dependency)
// ---------------------------------------------------------------------------

const VALID_AUTHENTICITY = ["likely_genuine", "likely_spam", "likely_test", "uncertain"];
const VALID_PRIORITIES = ["low", "medium", "high", "critical"];

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && !isNaN(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

export function validateAnalysisOutput(raw: unknown): {
  ok: boolean;
  analysis?: IntakeAnalysisOutput;
  errors?: string[];
} {
  const errors: string[] = [];

  if (!isObject(raw)) {
    errors.push("expected object");
    return { ok: false, errors };
  }

  const r = raw as Record<string, unknown>;

  if (!isString(r.category)) errors.push("category: must be string");
  if (r.subcategory !== undefined && !isString(r.subcategory)) errors.push("subcategory: must be string if present");
  if (!isString(r.authenticityPrediction) || !VALID_AUTHENTICITY.includes(r.authenticityPrediction)) {
    errors.push(`authenticityPrediction: must be one of ${VALID_AUTHENTICITY.join(", ")}`);
  }
  if (!isNumber(r.confidence) || r.confidence < 0 || r.confidence > 1) {
    errors.push("confidence: must be number between 0 and 1");
  }
  if (!isString(r.priority) || !VALID_PRIORITIES.includes(r.priority)) {
    errors.push(`priority: must be one of ${VALID_PRIORITIES.join(", ")}`);
  }
  if (!isString(r.priorityReason)) errors.push("priorityReason: must be string");
  if (!isArray(r.extractedFields)) {
    errors.push("extractedFields: must be array");
  } else {
    for (let i = 0; i < r.extractedFields.length; i++) {
      const f = r.extractedFields[i];
      if (!isObject(f)) { errors.push(`extractedFields[${i}]: must be object`); continue; }
      const ef = f as Record<string, unknown>;
      if (!isString(ef.key)) errors.push(`extractedFields[${i}].key: must be string`);
      if (!isString(ef.value)) errors.push(`extractedFields[${i}].value: must be string`);
      if (!isNumber(ef.confidence) || ef.confidence < 0 || ef.confidence > 1) {
        errors.push(`extractedFields[${i}].confidence: must be number between 0 and 1`);
      }
    }
  }
  if (!isArray(r.missingInformation)) {
    errors.push("missingInformation: must be array");
  } else {
    for (let i = 0; i < r.missingInformation.length; i++) {
      const m = r.missingInformation[i];
      if (!isObject(m)) { errors.push(`missingInformation[${i}]: must be object`); continue; }
      const mi = m as Record<string, unknown>;
      if (!isString(mi.key)) errors.push(`missingInformation[${i}].key: must be string`);
      if (!isString(mi.description)) errors.push(`missingInformation[${i}].description: must be string`);
    }
  }
  if (!isArray(r.relatedHints)) {
    errors.push("relatedHints: must be array");
  } else {
    for (let i = 0; i < r.relatedHints.length; i++) {
      const h = r.relatedHints[i];
      if (!isObject(h)) { errors.push(`relatedHints[${i}]: must be object`); continue; }
      const rh = h as Record<string, unknown>;
      if (!isString(rh.reason)) errors.push(`relatedHints[${i}].reason: must be string`);
      if (!isNumber(rh.confidence) || rh.confidence < 0 || rh.confidence > 1) {
        errors.push(`relatedHints[${i}].confidence: must be number between 0 and 1`);
      }
      if (rh.targetField !== undefined && !isString(rh.targetField)) {
        errors.push(`relatedHints[${i}].targetField: must be string if present`);
      }
      if (rh.targetValue !== undefined && !isString(rh.targetValue)) {
        errors.push(`relatedHints[${i}].targetValue: must be string if present`);
      }
    }
  }
  if (!isString(r.recommendedQueue)) errors.push("recommendedQueue: must be string");
  if (!isString(r.recommendedNextAction)) errors.push("recommendedNextAction: must be string");
  if (!isBoolean(r.responseRequired)) errors.push("responseRequired: must be boolean");
  if (!isBoolean(r.humanApprovalRequired)) errors.push("humanApprovalRequired: must be boolean");
  if (!isString(r.summary)) errors.push("summary: must be string");

  if (r.responseDraft !== undefined) {
    if (!isObject(r.responseDraft)) {
      errors.push("responseDraft: must be object if present");
    } else {
      const rd = r.responseDraft as Record<string, unknown>;
      if (!isString(rd.to)) errors.push("responseDraft.to: must be string");
      if (!isString(rd.subject)) errors.push("responseDraft.subject: must be string");
      if (!isString(rd.body)) errors.push("responseDraft.body: must be string");
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, analysis: r as unknown as IntakeAnalysisOutput };
}

// ---------------------------------------------------------------------------
// Fallback analysis (fail closed)
// ---------------------------------------------------------------------------

export function needsClassificationFallback(): IntakeAnalysisOutput {
  return {
    category: "needs_classification",
    authenticityPrediction: "uncertain",
    confidence: 0,
    priority: "medium",
    priorityReason: "Model output failed validation; human review required",
    extractedFields: [],
    missingInformation: [
      { key: "all", description: "Analysis failed — full human review required" },
    ],
    relatedHints: [],
    recommendedQueue: "unreviewed",
    recommendedNextAction: "human_classification",
    responseRequired: false,
    humanApprovalRequired: true,
    summary: "Analysis failed closed. Deterministic facts are available for review.",
  };
}

// ---------------------------------------------------------------------------
// Analysis record (stored in plugin_state)
// ---------------------------------------------------------------------------

export interface AnalysisRecord {
  contractVersion: string;
  modelProvider: string;
  modelId: string;
  analysis: IntakeAnalysisOutput;
  inputFingerprint: string;
  analyzedAt: string;
  sourceKind: "live_model" | "fixture" | "deterministic_only";
}

export function createAnalysisRecord(
  provider: string,
  modelId: string,
  analysis: IntakeAnalysisOutput,
  inputFingerprint: string,
  sourceKind: "live_model" | "fixture" | "deterministic_only" = "deterministic_only",
): AnalysisRecord {
  return {
    contractVersion: ANALYSIS_CONTRACT_VERSION,
    modelProvider: provider,
    modelId,
    analysis,
    inputFingerprint,
    analyzedAt: new Date().toISOString(),
    sourceKind,
  };
}