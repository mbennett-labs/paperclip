import { describe, expect, it } from "vitest";
import { resolveOperatorReviewDispatch } from "../services/operator-review-dispatch.js";

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVIEW_STAGE_ID = "11111111-1111-4111-8111-111111111111";
const IMPLEMENTATION_STAGE_ID = "12121212-1212-4121-8121-121212121212";
const SENTINEL_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const DIRECTOR_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_DECISION_ID = "44444444-4444-4444-8444-444444444444";
const BOARD_USER_ID = "55555555-5555-4555-8555-555555555555";

function pendingReviewState(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    currentStageId: REVIEW_STAGE_ID,
    currentStageIndex: 1,
    currentStageType: "review",
    currentParticipant: {
      type: "agent",
      agentId: SENTINEL_AGENT_ID,
      userId: null,
    },
    returnAssignee: {
      type: "agent",
      agentId: DIRECTOR_AGENT_ID,
      userId: null,
    },
    reviewRequest: null,
    completedStageIds: [IMPLEMENTATION_STAGE_ID],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
    ...overrides,
  };
}

describe("QSL explicit operator review dispatch", () => {
  it("restores a blocked pending review to in_review and targets its reviewer", () => {
    const result = resolveOperatorReviewDispatch({
      issueId: ISSUE_ID,
      issueStatus: "blocked",
      executionState: pendingReviewState(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.nextIssueStatus).toBe("in_review");
    expect(result.plan.reviewerAgentId).toBe(SENTINEL_AGENT_ID);
    expect(result.plan.executionStage).toMatchObject({
      wakeRole: "reviewer",
      stageId: REVIEW_STAGE_ID,
      stageType: "review",
      allowedActions: ["approve", "request_changes"],
    });
  });

  it("is idempotent within one review decision cycle", () => {
    const first = resolveOperatorReviewDispatch({
      issueId: ISSUE_ID,
      issueStatus: "in_review",
      executionState: pendingReviewState(),
    });
    const second = resolveOperatorReviewDispatch({
      issueId: ISSUE_ID,
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
      issueId: ISSUE_ID,
      issueStatus: "in_review",
      executionState: pendingReviewState(),
    });
    const later = resolveOperatorReviewDispatch({
      issueId: ISSUE_ID,
      issueStatus: "in_review",
      executionState: pendingReviewState({ lastDecisionId: SECOND_DECISION_ID }),
    });

    expect(initial.ok).toBe(true);
    expect(later.ok).toBe(true);
    if (!initial.ok || !later.ok) return;
    expect(initial.plan.idempotencyKey).not.toBe(later.plan.idempotencyKey);
  });

  it("fails closed when the current stage is not review", () => {
    const result = resolveOperatorReviewDispatch({
      issueId: ISSUE_ID,
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
      issueId: ISSUE_ID,
      issueStatus: "blocked",
      executionState: pendingReviewState({
        currentParticipant: { type: "user", userId: BOARD_USER_ID, agentId: null },
      }),
    });

    expect(result).toEqual({
      ok: false,
      reason: "Pending review stage has no agent reviewer participant",
    });
  });

  it("fails closed for terminal issues", () => {
    const result = resolveOperatorReviewDispatch({
      issueId: ISSUE_ID,
      issueStatus: "done",
      executionState: pendingReviewState(),
    });

    expect(result).toEqual({ ok: false, reason: "Issue is terminal (done)" });
  });
});
