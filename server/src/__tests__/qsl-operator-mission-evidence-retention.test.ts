import { describe, expect, it } from "vitest";
import { mergeMissionEvidence } from "../services/operator-mission-evidence.js";

describe("QSL operator mission evidence retention", () => {
  it("preserves prior stage evidence while adding later verification receipts", () => {
    const existing = {
      preflight: {
        initial_head: "abc123",
        production_pid_before: "796",
      },
      run_ids: ["run-implement-1"],
      tests: "pending",
    };

    const incoming = {
      verification_receipts: [
        {
          schema: "qsl.verification_receipt.v1",
          artifact_id: "verification-QSL-1-001",
          stages: {
            tests: { status: "failed" },
            typecheck: { status: "passed" },
            build: { status: "passed" },
          },
        },
      ],
      run_ids: ["run-verify-1"],
      tests: "failed",
    };

    const merged = mergeMissionEvidence(existing, incoming);

    expect(merged).toMatchObject({
      preflight: {
        initial_head: "abc123",
        production_pid_before: "796",
      },
      tests: "failed",
    });
    expect(merged?.run_ids).toEqual(["run-implement-1", "run-verify-1"]);
    expect(merged?.verification_receipts).toHaveLength(1);
  });

  it("merges nested evidence and appends object history without rewriting prior entries", () => {
    const first = mergeMissionEvidence(null, {
      safety: { production: "unchanged" },
      verification_receipts: [{ artifact_id: "r1" }],
    });
    const second = mergeMissionEvidence(first, {
      safety: { staging: "healthy" },
      verification_receipts: [{ artifact_id: "r2" }],
    });

    expect(second).toEqual({
      safety: {
        production: "unchanged",
        staging: "healthy",
      },
      verification_receipts: [{ artifact_id: "r1" }, { artifact_id: "r2" }],
    });
  });
});
