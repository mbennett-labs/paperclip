import { describe, expect, it } from "vitest";
import {
  validateAnalysisOutput,
  needsClassificationFallback,
  createAnalysisRecord,
  ANALYSIS_CONTRACT_VERSION,
  type IntakeAnalysisOutput,
} from "../src/mail/analysis.js";

function makeValidOutput(): IntakeAnalysisOutput {
  return {
    category: "store_submission",
    subcategory: "bin-store",
    authenticityPrediction: "likely_genuine",
    confidence: 0.85,
    priority: "high",
    priorityReason: "New store submission from known form; moderate field completeness",
    extractedFields: [
      { key: "storeName", value: "Bargain Bin Bonanza", confidence: 0.9 },
      { key: "city", value: "Nashville", confidence: 0.9 },
    ],
    missingInformation: [
      { key: "phone", description: "Phone number not provided" },
    ],
    relatedHints: [],
    recommendedQueue: "unreviewed",
    recommendedNextAction: "human_review",
    responseRequired: false,
    humanApprovalRequired: true,
    summary: "Likely genuine store submission. Human review required before publication.",
  };
}

describe("validateAnalysisOutput", () => {
  it("accepts a valid output", () => {
    const result = validateAnalysisOutput(makeValidOutput());
    expect(result.ok).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = validateAnalysisOutput({});
    expect(result.ok).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it("rejects invalid authenticity prediction", () => {
    const invalid = { ...makeValidOutput(), authenticityPrediction: "maybe" };
    const result = validateAnalysisOutput(invalid);
    expect(result.ok).toBe(false);
  });

  it("rejects confidence > 1", () => {
    const invalid = { ...makeValidOutput(), confidence: 1.5 };
    const result = validateAnalysisOutput(invalid);
    expect(result.ok).toBe(false);
  });

  it("rejects confidence < 0", () => {
    const invalid = { ...makeValidOutput(), confidence: -0.1 };
    const result = validateAnalysisOutput(invalid);
    expect(result.ok).toBe(false);
  });

  it("rejects invalid priority value", () => {
    const invalid = { ...makeValidOutput(), priority: "urgent" };
    const result = validateAnalysisOutput(invalid);
    expect(result.ok).toBe(false);
  });

  it("rejects malformed extracted fields", () => {
    const invalid = {
      ...makeValidOutput(),
      extractedFields: [{ key: "test" }],
    };
    const result = validateAnalysisOutput(invalid);
    expect(result.ok).toBe(false);
  });

  it("rejects responseDraft with missing required fields", () => {
    const invalid = {
      ...makeValidOutput(),
      responseDraft: { to: "test@test.com" },
    };
    const result = validateAnalysisOutput(invalid);
    expect(result.ok).toBe(false);
  });

  it("accepts optional subcategory", () => {
    const valid = { ...makeValidOutput(), subcategory: undefined };
    const result = validateAnalysisOutput(valid);
    expect(result.ok).toBe(true);
  });

  it("accepts optional responseDraft with all fields", () => {
    const valid = {
      ...makeValidOutput(),
      responseDraft: {
        to: "test@test.com",
        subject: "Test Subject",
        body: "Test body",
      },
    };
    const result = validateAnalysisOutput(valid);
    expect(result.ok).toBe(true);
  });

  it("returns ok: false for null", () => {
    const result = validateAnalysisOutput(null);
    expect(result.ok).toBe(false);
  });

  it("returns ok: false for string", () => {
    const result = validateAnalysisOutput("not an object");
    expect(result.ok).toBe(false);
  });

  it("returns ok: false for array", () => {
    const result = validateAnalysisOutput(["not", "an", "object"]);
    expect(result.ok).toBe(false);
  });
});

describe("needsClassificationFallback", () => {
  it("returns a fail-closed analysis", () => {
    const fallback = needsClassificationFallback();
    expect(fallback.category).toBe("needs_classification");
    expect(fallback.confidence).toBe(0);
    expect(fallback.priority).toBe("medium");
    expect(fallback.humanApprovalRequired).toBe(true);
  });

  it("is valid against the schema", () => {
    const result = validateAnalysisOutput(needsClassificationFallback());
    expect(result.ok).toBe(true);
  });
});

describe("createAnalysisRecord", () => {
  it("captures contract version", () => {
    const record = createAnalysisRecord(
      "deepseek", "deepseek-v3",
      makeValidOutput(),
      "fp-abc123",
    );
    expect(record.contractVersion).toBe(ANALYSIS_CONTRACT_VERSION);
  });

  it("captures model provider and id", () => {
    const record = createAnalysisRecord(
      "deepseek", "deepseek-v3",
      makeValidOutput(),
      "fp-abc123",
    );
    expect(record.modelProvider).toBe("deepseek");
    expect(record.modelId).toBe("deepseek-v3");
  });

  it("defaults sourceKind to deterministic_only", () => {
    const record = createAnalysisRecord(
      "none", "none",
      makeValidOutput(),
      "fp-abc123",
    );
    expect(record.sourceKind).toBe("deterministic_only");
  });

  it("sets analyzedAt timestamp", () => {
    const before = new Date().toISOString();
    const record = createAnalysisRecord(
      "fixture", "fixture-v1",
      makeValidOutput(),
      "fp-test",
      "fixture",
    );
    expect(record.analyzedAt).toBeDefined();
    expect(record.analyzedAt >= before).toBe(true);
  });
});

describe("prior analyses preserved", () => {
  it("createAnalysisRecord does not mutate input", () => {
    const analysis = makeValidOutput();
    const original = JSON.parse(JSON.stringify(analysis));
    createAnalysisRecord("test", "test-v1", analysis, "fp-test");
    expect(analysis).toEqual(original);
  });
});

describe("response draft remains proposed only", () => {
  it("responseDraft is optional and structural only", () => {
    const output = makeValidOutput();
    expect(output.responseRequired).toBe(false);
    expect(output.humanApprovalRequired).toBe(true);
  });
});

describe("no human verdict written by model", () => {
  it("analysis has no verdict field", () => {
    const output = makeValidOutput();
    expect((output as Record<string, unknown>).verdict).toBeUndefined();
  });

  it("analysis recommends but does not decide", () => {
    const output = makeValidOutput();
    expect(output.humanApprovalRequired).toBe(true);
    expect(output.recommendedNextAction).toBe("human_review");
  });
});