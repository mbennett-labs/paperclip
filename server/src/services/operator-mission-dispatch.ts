const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export type OperatorMissionDispatchIssue = {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  executionWorkspaceId?: string | null;
};

export type OperatorMissionDispatchWorkspace = {
  id: string;
  companyId: string;
  sourceIssueId?: string | null;
  status: string;
  closedAt?: Date | string | null;
};

export type OperatorMissionDispatchPlan = {
  issueId: string;
  missionId: string;
  agentId: string;
  workspaceId: string | null;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
};

export type OperatorMissionDispatchResolution =
  | { ok: true; plan: OperatorMissionDispatchPlan }
  | { ok: false; reason: string };

export function resolveOperatorMissionDispatch(input: {
  companyId: string;
  missionId: string;
  issue: OperatorMissionDispatchIssue | null;
  workspace?: OperatorMissionDispatchWorkspace | null;
  message?: string | null;
}): OperatorMissionDispatchResolution {
  const missionId = input.missionId.trim();
  if (!missionId) return { ok: false, reason: "Mission id is required" };

  const issue = input.issue;
  if (!issue || issue.companyId !== input.companyId) {
    return { ok: false, reason: "Issue not found in mission company" };
  }
  if (TERMINAL_ISSUE_STATUSES.has(issue.status)) {
    return { ok: false, reason: `Issue is terminal (${issue.status})` };
  }
  if (!issue.assigneeAgentId) {
    return { ok: false, reason: "Issue has no assigned implementation agent" };
  }

  const expectedWorkspaceId = issue.executionWorkspaceId ?? null;
  if (expectedWorkspaceId) {
    const workspace = input.workspace;
    if (!workspace || workspace.id !== expectedWorkspaceId) {
      return { ok: false, reason: "Issue references a missing execution workspace" };
    }
    if (workspace.companyId !== input.companyId) {
      return { ok: false, reason: "Execution workspace belongs to another company" };
    }
    if (workspace.sourceIssueId && workspace.sourceIssueId !== issue.id) {
      return { ok: false, reason: "Execution workspace belongs to another issue" };
    }
    if (workspace.status === "archived" || workspace.closedAt) {
      return { ok: false, reason: "Execution workspace is closed or archived" };
    }
  }

  const message = input.message?.trim() || null;
  const payload: Record<string, unknown> = {
    issueId: issue.id,
    missionId,
    mutation: "operator_mission_dispatch",
  };
  if (message) payload.message = message;

  return {
    ok: true,
    plan: {
      issueId: issue.id,
      missionId,
      agentId: issue.assigneeAgentId,
      workspaceId: expectedWorkspaceId,
      idempotencyKey: `operator-mission:${input.companyId}:${missionId}:implement`,
      payload,
      contextSnapshot: {
        issueId: issue.id,
        taskId: issue.id,
        missionId,
        wakeReason: "operator_mission_requested",
        source: "qsl.operator_mission",
        ...(expectedWorkspaceId ? { executionWorkspaceId: expectedWorkspaceId } : {}),
      },
    },
  };
}
