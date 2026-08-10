import { describe, it, expect } from "vitest";
import { classifyMissionAttention } from "./classify-attention.js";
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
    description: "Test description",
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

describe("classifyMissionAttention", () => {
  it("flags missing description as action required", () => {
    const root = makeIssue({ description: null });
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [],
      pendingApprovals: [],
    });
    expect(result.actionRequired.length).toBe(1);
    expect(result.actionRequired[0].kind).toBe("action_required");
    expect(result.actionRequired[0].title).toBe("Mission has no description");
  });

  it("flags empty description as action required", () => {
    const root = makeIssue({ description: "" });
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [],
      pendingApprovals: [],
    });
    expect(result.actionRequired.length).toBe(1);
  });

  it("does not flag a mission with description", () => {
    const root = makeIssue({ description: "A good description" });
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [],
      pendingApprovals: [],
    });
    expect(result.actionRequired.length).toBe(0);
  });

  it("produces questions waiting from pending interactions", () => {
    const root = makeIssue({ id: "root" });
    const pendingQuestion = {
      id: "q1",
      companyId: "company-1",
      issueId: "root",
      kind: "ask_user_questions" as const,
      title: "What approach should we use?",
      summary: "Need your guidance",
      status: "pending" as const,
      continuationPolicy: "wake_assignee" as const,
      payload: { version: 1, questions: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [makeDescendant(root)],
      pendingQuestions: [pendingQuestion as any],
      pendingApprovals: [],
    });
    expect(result.questionsWaiting.length).toBe(1);
    expect(result.questionsWaiting[0].kind).toBe("question");
    expect(result.questionsWaiting[0].title).toBe("What approach should we use?");
  });

  it("does not flag answered questions", () => {
    const root = makeIssue({ id: "root" });
    const answeredQuestion = {
      id: "q1",
      companyId: "company-1",
      issueId: "root",
      kind: "ask_user_questions" as const,
      status: "answered" as const,
      continuationPolicy: "wake_assignee" as const,
      payload: { version: 1, questions: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [answeredQuestion as any],
      pendingApprovals: [],
    });
    expect(result.questionsWaiting.length).toBe(0);
  });

  it("produces approvals pending", () => {
    const root = makeIssue({ id: "root" });
    const pendingApproval = {
      id: "a1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending" as const,
      payload: {},
      requestedByAgentId: null,
      requestedByUserId: null,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [],
      pendingApprovals: [pendingApproval as any],
    });
    expect(result.approvalsPending.length).toBe(1);
    expect(result.approvalsPending[0].kind).toBe("approval");
  });

  it("produces blocked attention for blocked descendants", () => {
    const root = makeIssue({ id: "root" });
    const blocker = makeIssue({ id: "blocker-1", title: "Dependency task" });
    const blocked = makeIssue({ id: "blocked-1", status: "blocked", title: "Blocked task" });
    const desc: MissionDescendant = {
      issue: blocked,
      blockedBy: [{
        id: "r1",
        companyId: "company-1",
        issueId: "blocked-1",
        relatedIssueId: "blocker-1",
        type: "blocks",
        relatedIssue: { id: "blocker-1", title: "Dependency task", identifier: null },
      } as any],
    };
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [makeDescendant(root), desc, makeDescendant(blocker)],
      pendingQuestions: [],
      pendingApprovals: [],
    });
    expect(result.blocked.length).toBe(1);
    expect(result.blocked[0].kind).toBe("blocker");
    expect(result.blocked[0].title).toBe("Blocked task");
  });

  it("unverified completed work is not presented as verified success", () => {
    const root = makeIssue({ id: "root" });
    const done = makeIssue({
      id: "done-1",
      status: "done",
      completedAt: new Date(),
    });
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [makeDescendant(done)],
      pendingQuestions: [],
      pendingApprovals: [],
    });
    expect(result.verificationFailures.length).toBe(0);
    expect(result.informational.length).toBe(1);
    expect(result.informational[0].kind).toBe("info");
    expect(result.informational[0].priority).toBe("low");
  });

  it("done tasks with identifiers are still unverified—identifier is not evidence", () => {
    const root = makeIssue({ id: "root" });
    const done = makeIssue({
      id: "done-1",
      status: "done",
      identifier: "DONE-1",
      completedAt: new Date(),
    });
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [makeDescendant(done)],
      pendingQuestions: [],
      pendingApprovals: [],
    });
    expect(result.verificationFailures.length).toBe(0);
    expect(result.informational.some(
      (i) => i.description?.includes("Verification evidence is not yet inspected"),
    )).toBe(true);
  });

  it("completed prose without verification evidence does not prove completion", () => {
    const root = makeIssue({ id: "root" });
    const done = makeIssue({
      id: "done-1",
      status: "done",
      title: "All work finished",
      completedAt: new Date(),
    });
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [makeDescendant(done)],
      pendingQuestions: [],
      pendingApprovals: [],
    });
    expect(result.verificationFailures).toEqual([]);
    expect(result.informational.length).toBeGreaterThanOrEqual(1);
  });

  it("produces informational for in-progress tasks without assignee", () => {
    const root = makeIssue({ id: "root" });
    const orphan = makeIssue({
      id: "orphan",
      status: "in_progress",
      assigneeAgentId: null,
    });
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [makeDescendant(orphan)],
      pendingQuestions: [],
      pendingApprovals: [],
    });
    expect(result.informational.length).toBe(1);
    expect(result.informational[0].kind).toBe("info");
  });

  it("does not produce informational for assigned in-progress tasks", () => {
    const root = makeIssue({ id: "root" });
    const assigned = makeIssue({
      id: "assigned",
      status: "in_progress",
      assigneeAgentId: "agent-1",
    });
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [makeDescendant(assigned)],
      pendingQuestions: [],
      pendingApprovals: [],
    });
    expect(result.informational.length).toBe(0);
  });

  it("returns empty attention for a clean planned mission", () => {
    const root = makeIssue({ description: "Good description" });
    const result = classifyMissionAttention({
      rootIssue: root,
      descendants: [],
      pendingQuestions: [],
      pendingApprovals: [],
    });
    expect(result.actionRequired.length).toBe(0);
    expect(result.questionsWaiting.length).toBe(0);
    expect(result.approvalsPending.length).toBe(0);
    expect(result.blocked.length).toBe(0);
    expect(result.verificationFailures.length).toBe(0);
    expect(result.informational.length).toBe(0);
  });
});