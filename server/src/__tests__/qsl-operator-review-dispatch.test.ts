import { describe, expect, it } from "vitest";
import { resolveOperatorReviewDispatch } from "../services/operator-review-dispatch.js";

function pendingReviewState(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    currentStageId: "review-stage-1",
    currentStageIndex: 1,
    currentStageType: "review",
    currentParticipant: {
      type: "agent",
      agentId: "sentinel-agent",
      userId: null,
    },
    returnAssignee: {
      type: "agent",
      agentId: "director-agent",
      userId: null,
    },
    reviewRequest: null,
    completedStageIds: ["implementation-stage"],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
    ...overrides,
  };
}

describe("QSL explicit operator review dispatch", () => {
  it("restores a blocked pending review to in_review and targets its reviewer", () => {
    const result = resolveOperatorReviewDispatch({
      issueId: "issue-1",
      issueStatus: "blocked",
      executionState: pendingReviewState(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.nextIssueStatus).toBe("in_review");
    expect(result.plan.reviewerAgentId).toBe("sentinel-agent");
    expect(result.plan.executionStage).toMatchObject({
      wakeRole: "reviewer",
      stageId: "review-stage-1",
      stageType: "review",
      allowedActions: ["approve", "request_changes"],
    });
  });

  it("is idempotent within one review decision cycle", () => {
    const first = resolveOperatorReviewDispatch({
      issueId: "issue-1",
      issueStatus: "in_review",
      executionState: pendingReviewState(),
    });
    const second = resolveOperatorReviewDispatch({
      issueId: "issue-1",
      issueStatus: "in_review",
      executionState: pendingReviewState(),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.plan.idempotencyKey).toBe(second.plan.idempotencyKey);
  });

  it("creates a new idempotency key for a new review decision cycle", () => {
    const initial = resolveOperatorReviewDispatch({
      issueId: "issue-1",
      issueStatus: "in_review",
      executionState: pendingReviewState(),
    });
    const later = resolveOperatorReviewDispatch({
      issueId: "issue-1",
      issueStatus: "in_review",
      executionState: pendingReviewState({ lastDecisionId: "decision-2" }),
    });

    expect(initial.ok).toBe(true);
    expect(later.ok).toBe(true);
    if (!initial.ok || !later.ok) return;
    expect(initial.plan.idempotencyKey).not.toBe(later.plan.idempotencyKey);
  });

  it("fails closed when the current stage is not review", () => {
    const result = resolveOperatorReviewDispatch({
      issueId: "issue-1",
      issueStatus: "blocked",
      executionState: pendingReviewState({ currentStageType: "approval" }),
    });

    expect(result).toEqual({
      ok: false,
      reason: "Current execution stage is approval, not review",
    });
  });

  it("fails closed without an agent reviewer", () => {
    const result = resolveOperatorReviewDispatch({
      issueId: "issue-1",
      issueStatus: "blocked",
      executionState: pendingReviewState({
        currentParticipant: { type: "user", userId: "board-user", agentId: null },
      }),
    });

    expect(result).toEqual({
      ok: false,
      reason: "Pending review stage has no agent reviewer participant",
    });
  });

  it("fails closed for terminal issues", () => {
    const result = resolveOperatorReviewDispatch({
      issueId: "issue-1",
      issueStatus: "done",
      executionState: pendingReviewState(),
    });

    expect(result).toEqual({ ok: false, reason: "Issue is terminal (done)" });
  });
});
