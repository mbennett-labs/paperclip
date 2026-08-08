import { eq, and, inArray, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issues,
  issueRelations,
  issueThreadInteractions,
  approvals as approvalsTable,
  issueApprovals,
  activityLog as activityLogTable,
  costEvents,
  agents,
} from "@paperclipai/db";
import { notFound } from "../errors.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { deriveMissionState, classifyMissionAttention } from "@paperclipai/shared";
import type {
  ActivityEvent,
  Approval,
  CompactIssue,
  IssueThreadInteraction,
} from "@paperclipai/shared";
import type {
  MissionActiveWork,
  MissionApprovalItem,
  MissionBlocker,
  MissionBudget,
  MissionDescendant,
  MissionProgress,
  MissionQuestion,
  MissionVerification,
  MissionView,
} from "@paperclipai/shared";

const RECENT_ACTIVITY_LIMIT = 20;
const RECENT_COMPLETED_LIMIT = 10;

type DbIssueRow = {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
  status: string;
  workMode: string | null;
  priority: string;
  assigneeAgentId: string | null;
  identifier: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type DbRelationRow = {
  id: string;
  companyId: string;
  issueId: string;
  relatedIssueId: string;
  type: string;
};

function toCompactIssue(companyId: string, r: DbIssueRow): CompactIssue {
  return {
    id: r.id,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: r.parentId,
    title: r.title,
    description: r.description,
    status: r.status as CompactIssue["status"],
    workMode: (r.workMode ?? "standard") as CompactIssue["workMode"],
    priority: r.priority as CompactIssue["priority"],
    assigneeAgentId: r.assigneeAgentId,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: r.identifier,
    originKind: undefined,
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    executionWorkspaceId: null,
    startedAt: r.startedAt ? new Date(r.startedAt) : null,
    completedAt: r.completedAt ? new Date(r.completedAt) : null,
    cancelledAt: null,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
    activeRecoveryAction: null,
    successfulRunHandoff: null,
  };
}

function compactIssueFields() {
  return {
    id: issues.id,
    parentId: issues.parentId,
    title: issues.title,
    description: issues.description,
    status: issues.status,
    workMode: issues.workMode,
    priority: issues.priority,
    assigneeAgentId: issues.assigneeAgentId,
    identifier: issues.identifier,
    startedAt: issues.startedAt,
    completedAt: issues.completedAt,
    createdAt: issues.createdAt,
    updatedAt: issues.updatedAt,
  };
}

export function missionService(db: Db) {
  return {
    getMission: async (companyId: string, issueId: string): Promise<MissionView> => {
      const rootIssue = await db
        .select(compactIssueFields())
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId), visibleIssueCondition()))
        .then((rows) => rows[0] ?? null);

      if (!rootIssue) throw notFound("Mission issue not found");

      const allCompanyIssues = await db
        .select(compactIssueFields())
        .from(issues)
        .where(and(eq(issues.companyId, companyId), visibleIssueCondition()));

      const descendantIds = new Set<string>([issueId]);
      function collectDescendants(parentId: string) {
        for (const row of allCompanyIssues) {
          if (row.parentId === parentId && !descendantIds.has(row.id)) {
            descendantIds.add(row.id);
            collectDescendants(row.id);
          }
        }
      }
      collectDescendants(issueId);

      const allIds = [...descendantIds];
      const descendantList = allCompanyIssues
        .filter((r) => descendantIds.has(r.id))
        .map((r) => toCompactIssue(companyId, r as unknown as DbIssueRow));

      const rootCompact = descendantList.find((i) => i.id === issueId)!;
      const descendantsOnly = descendantList.filter((i) => i.id !== issueId);

      const relationRows = await db
        .select()
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            inArray(issueRelations.issueId, allIds),
          ),
        );

      const interactionRows = await db
        .select()
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, companyId),
            inArray(issueThreadInteractions.issueId, allIds),
          ),
        )
        .orderBy(desc(issueThreadInteractions.createdAt));

      const questions = interactionRows.filter((r) => r.kind === "ask_user_questions");

      const approvalLinks = await db
        .select()
        .from(issueApprovals)
        .where(
          and(
            eq(issueApprovals.companyId, companyId),
            inArray(issueApprovals.issueId, allIds),
          ),
        );

      const approvalIds = [...new Set(approvalLinks.map((a) => a.approvalId))];
      const approvalRows = approvalIds.length > 0
        ? await db
            .select()
            .from(approvalsTable)
            .where(
              and(
                eq(approvalsTable.companyId, companyId),
                inArray(approvalsTable.id, approvalIds),
                eq(approvalsTable.status, "pending"),
              ),
            )
        : [];

      const activityRows = await db
        .select()
        .from(activityLogTable)
        .where(eq(activityLogTable.companyId, companyId))
        .orderBy(desc(activityLogTable.createdAt))
        .limit(RECENT_ACTIVITY_LIMIT);

      const assigneeAgentIds = [...new Set(descendantList.map((i) => i.assigneeAgentId).filter(Boolean))] as string[];
      const agentRows = assigneeAgentIds.length > 0
        ? await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(and(eq(agents.companyId, companyId), inArray(agents.id, assigneeAgentIds)))
        : [];
      const agentNameMap = new Map(agentRows.map((a) => [a.id, a.name]));

      const spendRows = await db
        .select({ costCents: costEvents.costCents })
        .from(costEvents)
        .where(eq(costEvents.companyId, companyId));
      const totalSpentCents = spendRows.reduce((sum, r) => sum + r.costCents, 0);

      const budget: MissionBudget | null = {
        spentCents: totalSpentCents,
        budgetCents: null,
        hasHardLimit: false,
        available: true,
        label: totalSpentCents > 0
          ? `$${(totalSpentCents / 100).toFixed(2)} spent`
          : "No cost data available",
      };

      const now = Date.now();
      const progress: MissionProgress = {
        totalTasks: descendantsOnly.length,
        completedTasks: descendantsOnly.filter((i) => i.status === "done").length,
        inProgressTasks: descendantsOnly.filter((i) => i.status === "in_progress").length,
        blockedTasks: descendantsOnly.filter((i) => i.status === "blocked").length,
        inReviewTasks: descendantsOnly.filter((i) => i.status === "in_review").length,
      };

      const activeWork: MissionActiveWork[] = descendantsOnly
        .filter((i) => i.status === "in_progress")
        .slice(0, 10)
        .map((i) => ({
          issue: i,
          assigneeName: i.assigneeAgentId ? (agentNameMap.get(i.assigneeAgentId) ?? null) : null,
          lastActivityAt: i.startedAt?.toISOString() ?? i.createdAt.toISOString(),
        }));

      const recentlyCompleted = descendantsOnly
        .filter((i) => i.status === "done" && i.completedAt)
        .sort((a, b) => {
          const aTime = a.completedAt ? a.completedAt.getTime() : 0;
          const bTime = b.completedAt ? b.completedAt.getTime() : 0;
          return bTime - aTime;
        })
        .slice(0, RECENT_COMPLETED_LIMIT);

      const blockers: MissionBlocker[] = [];
      for (const d of descendantList) {
        if (d.status !== "blocked") continue;
        const rels = relationRows.filter((r) => r.issueId === d.id && r.type === "blocks");
        if (rels.length === 0) continue;
        const blockedBy = rels
          .map((r) => descendantList.find((di) => di.id === r.relatedIssueId))
          .filter((i): i is CompactIssue => i != null);
        if (blockedBy.length === 0) continue;
        blockers.push({ issue: d, blockedBy });
      }

      const unansweredQuestions: MissionQuestion[] = questions
        .filter((q) => q.status === "pending")
        .map((q) => ({
          interaction: q as unknown as IssueThreadInteraction,
          issue: descendantList.find((i) => i.id === q.issueId) ?? rootCompact,
          issueIdentifier: descendantList.find((i) => i.id === q.issueId)?.identifier ?? null,
          ageMs: Math.max(0, now - new Date(q.createdAt as unknown as string).getTime()),
        }));

      const pendingApprovalItems: MissionApprovalItem[] = approvalRows.map((a) => {
        const linked = approvalLinks
          .filter((l) => l.approvalId === a.id)
          .map((l) => descendantList.find((i) => i.id === l.issueId))
          .filter((i): i is CompactIssue => i != null);
        return { approval: a as unknown as Approval, issues: linked };
      });

      const verification = deriveVerification(descendantsOnly);

      const descendants: MissionDescendant[] = descendantList.map((i) => ({
        issue: i,
        blockedBy: relationRows
          .filter((r) => r.issueId === i.id && r.type === "blocks")
          .map((r) => ({
            id: r.id,
            companyId: r.companyId,
            issueId: r.issueId,
            relatedIssueId: r.relatedIssueId,
            type: "blocks" as const,
            relatedIssue: { id: r.relatedIssueId, title: "", identifier: null },
          })) as unknown as MissionDescendant["blockedBy"],
      }));

      const state = deriveMissionState({
        rootIssue: rootCompact,
        descendants,
        pendingQuestions: questions as unknown as IssueThreadInteraction[],
        hasPendingApprovals: approvalRows.length > 0,
      });

      const humanAttention = classifyMissionAttention({
        rootIssue: rootCompact,
        descendants,
        pendingQuestions: questions as unknown as IssueThreadInteraction[],
        pendingApprovals: approvalRows as unknown as Approval[],
      });

      const phase = derivePhase(state, progress, humanAttention);

      return {
        missionId: issueId,
        companyId,
        objective: rootIssue.title,
        description: rootIssue.description,
        state,
        phase,
        progress,
        activeWork,
        recentlyCompleted,
        blockers,
        unansweredQuestions,
        pendingApprovals: pendingApprovalItems,
        budget,
        verification,
        recentActivity: activityRows as unknown as ActivityEvent[],
        humanAttention,
      };
    },
  };
}

function deriveVerification(descendants: CompactIssue[]): MissionVerification {
  const inReviewTasks = descendants.filter((i) => i.status === "in_review");

  if (inReviewTasks.length > 0) {
    return {
      overallStatus: "in_progress",
      note: `${inReviewTasks.length} task(s) in review. Awaiting review disposition.`,
    };
  }

  const doneTasks = descendants.filter((i) => i.status === "done");
  if (doneTasks.length > 0) {
    return {
      overallStatus: "unknown",
      note: `${doneTasks.length} task(s) completed. Inspectable evidence (work products, verified runs) is not yet available for automated verification.`,
    };
  }

  return {
    overallStatus: "unknown",
    note: "No completed or in-review tasks exist yet.",
  };
}

function derivePhase(
  state: string,
  progress: MissionProgress,
  attention: ReturnType<typeof classifyMissionAttention>,
): string {
  if (state === "planned" && progress.totalTasks === 0) return "Planning";
  if (state === "waiting_for_human") {
    if (attention.questionsWaiting.length > 0) return "Awaiting answers";
    return "Awaiting approvals";
  }
  if (state === "blocked") return "Blocked";
  if (state === "verifying") return "Verification";
  if (state === "completed") return "Complete";
  if (state === "failed") return "Failed";
  if (progress.completedTasks > 0 && progress.inProgressTasks > 0) return "Mixed execution";
  if (progress.inProgressTasks > 0) return "Execution";
  return "Initializing";
}