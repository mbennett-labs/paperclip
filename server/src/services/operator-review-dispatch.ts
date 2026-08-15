import type { IssueExecutionState } from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

export type OperatorReviewDispatchPlan = {
  reviewerAgentId: string;
  nextIssueStatus: "in_review";
  idempotencyKey: string;
  executionStage: {
    wakeRole: "reviewer";
    stageId: string | null;
    stageType: "review";
    currentParticipant: IssueExecutionState["currentParticipant"];
    returnAssignee: IssueExecutionState["returnAssignee"];
    reviewRequest: IssueExecutionState["reviewRequest"];
    lastDecisionOutcome: IssueExecutionState["lastDecisionOutcome"];
    allowedActions: ["approve", "request_changes"];
  };
};

export type OperatorReviewDispatchResolution =
  | { ok: true; plan: OperatorReviewDispatchPlan }
  | { ok: false; reason: string };

export function resolveOperatorReviewDispatch(input: {
  issueId: string;
  issueStatus: string;
  executionState: unknown;
}): OperatorReviewDispatchResolution {
  if (input.issueStatus === "done" || input.issueStatus === "cancelled") {
    return { ok: false, reason: `Issue is terminal (${input.issueStatus})` };
  }

  const state = parseIssueExecutionState(input.executionState);
  if (!state || state.status !== "pending") {
    return { ok: false, reason: "Issue has no pending execution stage" };
  }
  if (state.currentStageType !== "review") {
    return { ok: false, reason: `Current execution stage is ${state.currentStageType ?? "none"}, not review` };
  }
  if (state.currentParticipant?.type !== "agent" || !state.currentParticipant.agentId) {
    return { ok: false, reason: "Pending review stage has no agent reviewer participant" };
  }

  const reviewerAgentId = state.currentParticipant.agentId;
  const stageId = state.currentStageId ?? "no-stage";
  const decisionCycle = state.lastDecisionId ?? "initial";

  return {
    ok: true,
    plan: {
      reviewerAgentId,
      nextIssueStatus: "in_review",
      idempotencyKey: `operator-review:${input.issueId}:${stageId}:${reviewerAgentId}:${decisionCycle}`,
      executionStage: {
        wakeRole: "reviewer",
        stageId: state.currentStageId,
        stageType: "review",
        currentParticipant: state.currentParticipant,
        returnAssignee: state.returnAssignee,
        reviewRequest: state.reviewRequest ?? null,
        lastDecisionOutcome: state.lastDecisionOutcome,
        allowedActions: ["approve", "request_changes"],
      },
    },
  };
}
