import { describe, expect, it } from "vitest";
import { deriveOperatorMissionProjection } from "../services/operator-mission-reconcile.js";

const IMPLEMENT_RUN = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "succeeded",
  agentId: "22222222-2222-4222-8222-222222222222",
  error: null,
  errorCode: null,
};

const REVIEW_RUN = {
  id: "33333333-3333-4333-8333-333333333333",
  status: "running",
  agentId: "44444444-4444-4444-8444-444444444444",
  error: null,
  errorCode: null,
};

function project(overrides: Record<string, unknown> = {}) {
  return deriveOperatorMissionProjection({
    missionStatus: "implementing",
    missionTerminalStatus: null,
    issue: {
      status: "in_progress",
      executionState: null,
      executionWorkspaceId: null,
    },
    implementRun: IMPLEMENT_RUN,
    reviewRun: null,
    ...overrides,
  } as Parameters<typeof deriveOperatorMissionProjection>[0]);
}

describe("QSL operator mission native reconciliation", () => {
  it("projects ordinary assigned work as implementing", () => {
    const result = project();
    expect(result.status).toBe("implementing");
    expect(result.evidence.nativeLifecycle).toMatchObject({
      issueStatus: "in_progress",
      implementationRun: { id: IMPLEMENT_RUN.id, status: "succeeded" },
    });
  });

  it("projects a native pending review stage as reviewing and records the real reviewer run", () => {
    const result = project({
      issue: {
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageId: "security-review",
          currentStageType: "review",
        },
        executionWorkspaceId: "55555555-5555-4555-8555-555555555555",
      },
      reviewRun: REVIEW_RUN,
    });

    expect(result.status).toBe("reviewing");
    expect(result.reviewRunId).toBe(REVIEW_RUN.id);
    expect(result.evidence.nativeLifecycle).toMatchObject({
      executionStatus: "pending",
      executionStageId: "security-review",
      executionStageType: "review",
      reviewRun: { id: REVIEW_RUN.id, agentId: REVIEW_RUN.agentId },
    });
  });

  it("returns to implementing when native review requests changes", () => {
    const result = project({
      issue: {
        status: "in_progress",
        executionState: {
          status: "changes_requested",
          currentStageId: "security-review",
          currentStageType: "review",
          lastDecisionOutcome: "changes_requested",
        },
        executionWorkspaceId: null,
      },
      reviewRun: { ...REVIEW_RUN, status: "succeeded" },
    });

    expect(result.status).toBe("implementing");
    expect(result.reviewVerdict).toBe("changes_requested");
  });

  it("completes from authoritative native issue/execution completion", () => {
    const result = project({
      issue: {
        status: "done",
        executionState: {
          status: "completed",
          currentStageId: null,
          currentStageType: null,
          lastDecisionOutcome: "approved",
        },
        executionWorkspaceId: null,
      },
      reviewRun: { ...REVIEW_RUN, status: "succeeded" },
    });

    expect(result.status).toBe("completed");
    expect(result.terminalStatus).toBe("completed");
    expect(result.reviewVerdict).toBe("approved");
  });

  it("fails closed when the authoritative issue is cancelled", () => {
    const result = project({
      issue: {
        status: "cancelled",
        executionState: null,
        executionWorkspaceId: null,
      },
    });

    expect(result.status).toBe("failed");
    expect(result.terminalStatus).toBe("issue_cancelled");
  });

  it("surfaces a blocked issue as an escalation without inventing a terminal outcome", () => {
    const result = project({
      issue: {
        status: "blocked",
        executionState: null,
        executionWorkspaceId: null,
      },
    });

    expect(result.status).toBe("escalated");
    expect(result.terminalStatus).toBeUndefined();
  });

  it("never resurrects an already bounded fail-closed mission", () => {
    const result = project({
      missionStatus: "failed",
      missionTerminalStatus: "dispatch_failed",
      issue: {
        status: "in_progress",
        executionState: null,
        executionWorkspaceId: null,
      },
    });

    expect(result.status).toBe("failed");
    expect(result.terminalStatus).toBeUndefined();
  });
});
