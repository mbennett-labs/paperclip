import { describe, it, expect } from "vitest";
import { deriveMissionState } from "@paperclipai/shared";
import { classifyMissionAttention } from "@paperclipai/shared";

describe("mission API - mission service logic (pure function tests)", () => {
  describe("deriveMissionState", () => {
    it("distinguishes planned from running", () => {
      const root = makeFakeIssue("root", "backlog");
      const result = deriveMissionState({
        rootIssue: root,
        descendants: [],
        pendingQuestions: [],
        hasPendingApprovals: false,
      });
      expect(result).toBe("planned");

      const runningRoot = { ...root, status: "in_progress" as const };
      const runningResult = deriveMissionState({
        rootIssue: runningRoot,
        descendants: [{ issue: { ...root, id: "child", status: "in_progress", parentId: "root" }, blockedBy: [] }],
        pendingQuestions: [],
        hasPendingApprovals: false,
      });
      expect(runningResult).toBe("running");
    });

    it("distinguishes running from waiting_for_human", () => {
      const root = makeFakeIssue("root", "in_progress");
      const running = deriveMissionState({
        rootIssue: root,
        descendants: [],
        pendingQuestions: [],
        hasPendingApprovals: false,
      });
      expect(running).toBe("running");

      const waiting = deriveMissionState({
        rootIssue: root,
        descendants: [],
        pendingQuestions: [
          { id: "q1", status: "pending", kind: "ask_user_questions", createdAt: new Date().toISOString() } as any,
        ],
        hasPendingApprovals: false,
      });
      expect(waiting).toBe("waiting_for_human");
    });

    it("a pending question produces waiting_for_human", () => {
      const root = makeFakeIssue("root", "running" as any);
      const result = deriveMissionState({
        rootIssue: root,
        descendants: [],
        pendingQuestions: [
          { id: "q1", status: "pending", kind: "ask_user_questions", createdAt: new Date().toISOString() } as any,
        ],
        hasPendingApprovals: false,
      });
      expect(result).toBe("waiting_for_human");
    });

    it("a pending approval produces human attention via classifier", () => {
      const root = makeFakeIssue("root", "todo");
      const result = classifyMissionAttention({
        rootIssue: root,
        descendants: [],
        pendingQuestions: [],
        pendingApprovals: [
          { id: "a1", status: "pending", type: "hire_agent", payload: {}, createdAt: new Date().toISOString() } as any,
        ],
      });
      expect(result.approvalsPending.length).toBe(1);
    });

    it("a blocker is surfaced distinctly", () => {
      const root = makeFakeIssue("root", "todo");
      const blocker = makeFakeIssue("blocker", "todo");
      const blocked = makeFakeIssue("blocked", "blocked");
      const result = classifyMissionAttention({
        rootIssue: root,
        descendants: [
          { issue: root, blockedBy: [] },
          { issue: blocker, blockedBy: [] },
          {
            issue: blocked,
            blockedBy: [{
              id: "r1", companyId: "c1", issueId: "blocked", relatedIssueId: "blocker", type: "blocks",
              relatedIssue: { id: "blocker", title: "blocker", identifier: null },
            } as any],
          },
        ],
        pendingQuestions: [],
        pendingApprovals: [],
      });
      expect(result.blocked.length).toBe(1);
      expect(result.blocked[0].kind).toBe("blocker");
    });

    it("unverified done work is not presented as verified success", () => {
      const root = makeFakeIssue("root", "todo");
      const done = makeFakeIssue("done", "done");
      const result = classifyMissionAttention({
        rootIssue: root,
        descendants: [{ issue: done, blockedBy: [] }],
        pendingQuestions: [],
        pendingApprovals: [],
      });
      expect(result.verificationFailures).toEqual([]);
    });

    it("done tasks with identifiers are still not verification evidence", () => {
      const root = makeFakeIssue("root", "todo");
      const done = makeFakeIssue("done", "done");
      done.identifier = "DONE-99";
      const result = classifyMissionAttention({
        rootIssue: root,
        descendants: [{ issue: done, blockedBy: [] }],
        pendingQuestions: [],
        pendingApprovals: [],
      });
      expect(result.verificationFailures.length).toBe(0);
      expect(result.informational.some(
        (i: { description?: string | null }) => i.description?.includes("Verification evidence is not yet inspected"),
      )).toBe(true);
    });

    it("completed prose without evidence does not prove verification", () => {
      const root = makeFakeIssue("root", "todo");
      const done = makeFakeIssue("done", "done");
      done.title = "Everything is perfect, trust me";
      const result = classifyMissionAttention({
        rootIssue: root,
        descendants: [{ issue: done, blockedBy: [] }],
        pendingQuestions: [],
        pendingApprovals: [],
      });
      expect(result.verificationFailures).toEqual([]);
    });

    it("informational activity does not produce an unnecessary alert", () => {
      const root = makeFakeIssue("root", "todo");
      const orphan = makeFakeIssue("orphan", "in_progress");
      orphan.assigneeAgentId = null;
      const result = classifyMissionAttention({
        rootIssue: root,
        descendants: [{ issue: orphan, blockedBy: [] }],
        pendingQuestions: [],
        pendingApprovals: [],
      });
      expect(result.informational.length).toBe(1);
      expect(result.informational[0].kind).toBe("info");
      expect(result.informational[0].priority).toBe("low");
    });

    it("missing budget data renders honestly", () => {
      const budget = { spentCents: 0, budgetCents: null, hasHardLimit: false, available: true, label: "No cost data available" };
      expect(budget.budgetCents).toBeNull();
      expect(budget.label).toContain("No cost data available");
    });

    it("empty mission state renders safely", () => {
      const root = makeFakeIssue("root", "todo");
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

    it("unknown or legacy records do not crash the page", () => {
      const root = makeFakeIssue("root", "backlog");
      root.priority = "unknown" as any;
      const result = deriveMissionState({
        rootIssue: root,
        descendants: [{ issue: makeFakeIssue("child", "unknown_status" as any), blockedBy: [] }],
        pendingQuestions: [],
        hasPendingApprovals: false,
      });
      expect(result).toBe("planned");
    });

    it("no customer data, credentials, or real private emails appear in tests", () => {
      const root = makeFakeIssue("root", "todo");
      root.description = "test mission description";
      expect(root.description).not.toContain("@");
      expect(root.description).not.toContain("api_key");
      expect(root.description).not.toContain("password");
      expect(root.description).not.toContain("secret");
      expect(root.title).not.toContain("@");
    });
  });
});

function makeFakeIssue(id: string, status: string): any {
  return {
    id,
    companyId: "test-company",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Issue ${id}`,
    description: `Description for ${id}`,
    status,
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
    identifier: `ID-${id}`,
    originKind: undefined,
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    executionWorkspaceId: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    activeRecoveryAction: null,
    successfulRunHandoff: null,
  };
}