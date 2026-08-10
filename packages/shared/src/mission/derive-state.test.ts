import { describe, it, expect } from "vitest";
import { deriveMissionState } from "./derive-state.js";
import type { CompactIssue } from "../types/issue.js";
import type { MissionDescendant } from "../types/mission.js";

function makeIssue(overrides: Partial<CompactIssue> = {}): CompactIssue {
  const now = new Date();
  return {
    id: overrides.id ?? "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Test Issue",
    description: null,
    status: "backlog",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    originKind: undefined,
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    executionWorkspaceId: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    activeRecoveryAction: null,
    successfulRunHandoff: null,
    ...overrides,
  };
}

function makeDescendant(issue: CompactIssue): MissionDescendant {
  return { issue, blockedBy: [] };
}

describe("deriveMissionState", () => {
  it("returns planned for a root issue in backlog with no descendants", () => {
    const root = makeIssue({ status: "backlog" });
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [],
      hasPendingApprovals: false,
    });
    expect(result).toBe("planned");
  });

  it("returns planned even with cancelled descendants if root is todo", () => {
    const root = makeIssue({ status: "todo", id: "root" });
    const child = makeDescendant(makeIssue({ id: "child", status: "cancelled", parentId: "root" }));
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [child],
      pendingQuestions: [],
      hasPendingApprovals: false,
    });
    expect(result).toBe("planned");
  });

  it("returns running when a descendant is in_progress", () => {
    const root = makeIssue({ id: "root", status: "in_progress" });
    const child = makeDescendant(makeIssue({ id: "child", status: "in_progress", parentId: "root" }));
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [child],
      pendingQuestions: [],
      hasPendingApprovals: false,
    });
    expect(result).toBe("running");
  });

  it("returns running when the root itself is in_progress", () => {
    const root = makeIssue({ status: "in_progress" });
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [],
      hasPendingApprovals: false,
    });
    expect(result).toBe("running");
  });

  it("returns waiting_for_human when there is a pending question", () => {
    const root = makeIssue({ status: "in_progress" });
    const pendingQuestion = {
      id: "q1",
      companyId: "company-1",
      issueId: "root",
      kind: "ask_user_questions" as const,
      status: "pending" as const,
      continuationPolicy: "wake_assignee" as const,
      payload: { version: 1, questions: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [pendingQuestion as any],
      hasPendingApprovals: false,
    });
    expect(result).toBe("waiting_for_human");
  });

  it("returns waiting_for_human when there is a pending approval", () => {
    const root = makeIssue({ status: "in_progress" });
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [],
      hasPendingApprovals: true,
    });
    expect(result).toBe("waiting_for_human");
  });

  it("returns waiting_for_human over running when both questions and running tasks exist", () => {
    const root = makeIssue({ id: "root", status: "in_progress" });
    const pendingQuestion = {
      id: "q1",
      companyId: "company-1",
      issueId: "root",
      kind: "ask_user_questions" as const,
      status: "pending" as const,
      continuationPolicy: "wake_assignee" as const,
      payload: { version: 1, questions: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [pendingQuestion as any],
      hasPendingApprovals: false,
    });
    expect(result).toBe("waiting_for_human");
  });

  it("returns blocked when a descendant is blocked and no questions/approvals", () => {
    const root = makeIssue({ id: "root", status: "todo" });
    const child = makeDescendant(makeIssue({ id: "child", status: "blocked", parentId: "root" }));
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [child],
      pendingQuestions: [],
      hasPendingApprovals: false,
    });
    expect(result).toBe("blocked");
  });

  it("returns verifying when a descendant is in_review", () => {
    const root = makeIssue({ id: "root", status: "todo" });
    const child = makeDescendant(makeIssue({ id: "child", status: "in_review", parentId: "root" }));
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [child],
      pendingQuestions: [],
      hasPendingApprovals: false,
    });
    expect(result).toBe("verifying");
  });

  it("returns completed when root is done and all descendants are done", () => {
    const root = makeIssue({ id: "root", status: "done" });
    const child1 = makeDescendant(makeIssue({ id: "child1", status: "done", parentId: "root" }));
    const child2 = makeDescendant(makeIssue({ id: "child2", status: "done", parentId: "root" }));
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [child1, child2],
      pendingQuestions: [],
      hasPendingApprovals: false,
    });
    expect(result).toBe("completed");
  });

  it("returns completed when all non-cancelled descendants are done", () => {
    const root = makeIssue({ id: "root", status: "done" });
    const child1 = makeDescendant(makeIssue({ id: "child1", status: "done", parentId: "root" }));
    const child2 = makeDescendant(makeIssue({ id: "child2", status: "cancelled", parentId: "root" }));
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [child1, child2],
      pendingQuestions: [],
      hasPendingApprovals: false,
    });
    expect(result).toBe("completed");
  });

  it("returns failed when root is cancelled", () => {
    const root = makeIssue({ status: "cancelled" });
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [],
      hasPendingApprovals: false,
    });
    expect(result).toBe("failed");
  });

  it("returns planned with only cancelled descendants", () => {
    const root = makeIssue({ id: "root", status: "todo" });
    const child = makeDescendant(makeIssue({ id: "child", status: "cancelled", parentId: "root" }));
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [child],
      pendingQuestions: [],
      hasPendingApprovals: false,
    });
    expect(result).toBe("planned");
  });

  it("returns planned when status is todo with no children", () => {
    const root = makeIssue({ status: "todo" });
    const result = deriveMissionState({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [],
      hasPendingApprovals: false,
    });
    expect(result).toBe("planned");
  });
});