import { describe, expect, it } from "vitest";
import { resolveOperatorMissionDispatch } from "../services/operator-mission-dispatch.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ISSUE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WORKSPACE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "todo",
    assigneeAgentId: AGENT_ID,
    executionWorkspaceId: null,
    ...overrides,
  } as {
    id: string;
    companyId: string;
    status: string;
    assigneeAgentId: string | null;
    executionWorkspaceId: string | null;
  };
}

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKSPACE_ID,
    companyId: COMPANY_ID,
    sourceIssueId: ISSUE_ID,
    status: "idle",
    closedAt: null,
    ...overrides,
  } as {
    id: string;
    companyId: string;
    sourceIssueId: string | null;
    status: string;
    closedAt: string | null;
  };
}

describe("QSL native operator mission dispatch", () => {
  it("targets the issue assignee and lets heartbeat realize a missing workspace", () => {
    const result = resolveOperatorMissionDispatch({
      companyId: COMPANY_ID,
      missionId: "mission-001",
      issue: issue(),
      message: "Implement the bounded mission.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({
      issueId: ISSUE_ID,
      missionId: "mission-001",
      agentId: AGENT_ID,
      workspaceId: null,
      idempotencyKey: `operator-mission:${COMPANY_ID}:mission-001:implement`,
    });
    expect(result.plan.payload).toMatchObject({
      issueId: ISSUE_ID,
      missionId: "mission-001",
      mutation: "operator_mission_dispatch",
      message: "Implement the bounded mission.",
    });
  });

  it("preserves a valid persisted execution workspace in wake context", () => {
    const result = resolveOperatorMissionDispatch({
      companyId: COMPANY_ID,
      missionId: "mission-002",
      issue: issue({ executionWorkspaceId: WORKSPACE_ID }),
      workspace: workspace(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.workspaceId).toBe(WORKSPACE_ID);
    expect(result.plan.contextSnapshot.executionWorkspaceId).toBe(WORKSPACE_ID);
  });

  it("fails closed without an assigned implementation agent", () => {
    const result = resolveOperatorMissionDispatch({
      companyId: COMPANY_ID,
      missionId: "mission-003",
      issue: issue({ assigneeAgentId: null }),
    });

    expect(result).toEqual({
      ok: false,
      reason: "Issue has no assigned implementation agent",
    });
  });

  it("fails closed when the issue points at a missing workspace", () => {
    const result = resolveOperatorMissionDispatch({
      companyId: COMPANY_ID,
      missionId: "mission-004",
      issue: issue({ executionWorkspaceId: WORKSPACE_ID }),
      workspace: null,
    });

    expect(result).toEqual({
      ok: false,
      reason: "Issue references a missing execution workspace",
    });
  });

  it("fails closed for a cross-issue persisted workspace", () => {
    const result = resolveOperatorMissionDispatch({
      companyId: COMPANY_ID,
      missionId: "mission-005",
      issue: issue({ executionWorkspaceId: WORKSPACE_ID }),
      workspace: workspace({ sourceIssueId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }),
    });

    expect(result).toEqual({
      ok: false,
      reason: "Execution workspace belongs to another issue",
    });
  });

  it("fails closed for a closed workspace", () => {
    const result = resolveOperatorMissionDispatch({
      companyId: COMPANY_ID,
      missionId: "mission-006",
      issue: issue({ executionWorkspaceId: WORKSPACE_ID }),
      workspace: workspace({ status: "archived", closedAt: "2026-08-15T00:00:00.000Z" }),
    });

    expect(result).toEqual({
      ok: false,
      reason: "Execution workspace is closed or archived",
    });
  });

  it("fails closed for terminal issues", () => {
    const result = resolveOperatorMissionDispatch({
      companyId: COMPANY_ID,
      missionId: "mission-007",
      issue: issue({ status: "done" }),
    });

    expect(result).toEqual({ ok: false, reason: "Issue is terminal (done)" });
  });
});
