import type {
  CompactIssue,
  IssueThreadInteraction,
} from "../types/issue.js";
import type { Approval } from "../types/approval.js";
import type {
  MissionAttentionEntry,
  AttentionItemKind,
  MissionAttention,
  MissionDescendant,
} from "../types/mission.js";

export interface ClassifyAttentionInput {
  rootIssue: CompactIssue;
  descendants: MissionDescendant[];
  pendingQuestions: IssueThreadInteraction[];
  pendingApprovals: Approval[];
}

export function classifyMissionAttention(
  input: ClassifyAttentionInput,
): MissionAttention {
  const { rootIssue, descendants, pendingQuestions, pendingApprovals } = input;

  const questionsWaiting = pendingQuestions
    .filter((q) => q.status === "pending")
    .map((q) => {
      const issue = findDescendantIssue(descendants, q.issueId);
      return toAttentionItem({
        kind: "question",
        title: q.title ?? "Question awaiting answer",
        description: q.summary ?? null,
        sourceId: q.id,
        sourceType: "interaction",
        priority: "high" as const,
        ageMs: ageMs(q.createdAt),
        route: issue ? `/issues/${issue.id}` : null,
      });
    });

  const approvalsPending = pendingApprovals
    .filter((a) => a.status === "pending")
    .map((a) => {
      return toAttentionItem({
        kind: "approval",
        title: `Approval required: ${a.type.replace(/_/g, " ")}`,
        description: null,
        sourceId: a.id,
        sourceType: "approval",
        priority: "high" as const,
        ageMs: ageMs(a.createdAt),
        route: `/approvals/${a.id}`,
      });
    });

  const blocked: MissionAttentionEntry[] = [];
  for (const d of descendants) {
    if (d.issue.status !== "blocked") continue;
    if (d.blockedBy.length === 0) continue;

    const blockers = d.blockedBy
      .map((r) => findDescendantIssue(descendants, r.relatedIssueId))
      .filter((i): i is CompactIssue => i != null);

    if (blockers.length === 0) continue;

    const blockerDescs = blockers.map((b) => `Blocked by: ${b.title}`).join(", ");
    blocked.push(
      toAttentionItem({
        kind: "blocker",
        title: d.issue.title,
        description: blockerDescs,
        sourceId: d.issue.id,
        sourceType: "issue",
        priority: blockers.some((b) => b.priority === "critical") ? "high" : "medium",
        ageMs: ageMs(d.issue.updatedAt ?? d.issue.createdAt),
        route: `/issues/${d.issue.id}`,
      }),
    );
  }

  const actionRequired: MissionAttentionEntry[] = [];

  if (!rootIssue.description || rootIssue.description.trim().length === 0) {
    actionRequired.push(
      toAttentionItem({
        kind: "action_required",
        title: "Mission has no description",
        description: "Define the mission objective so agents understand the intent.",
        sourceId: rootIssue.id,
        sourceType: "issue",
        priority: "high",
        ageMs: ageMs(rootIssue.createdAt),
        route: `/issues/${rootIssue.id}`,
      }),
    );
  }

  const verificationFailures: MissionAttentionEntry[] = [];
  for (const d of descendants) {
    if (d.issue.status === "done") {
      const hasEvidence = d.issue.identifier != null;
      if (!hasEvidence) {
        verificationFailures.push(
          toAttentionItem({
            kind: "verification_failure",
            title: `${d.issue.title} completed without evidence`,
            description: "No artifacts or work products attached to this completed task.",
            sourceId: d.issue.id,
            sourceType: "issue",
            priority: "medium",
            ageMs: ageMs(d.issue.completedAt ?? d.issue.updatedAt ?? d.issue.createdAt),
            route: `/issues/${d.issue.id}`,
          }),
        );
      }
    }
  }

  const informational: MissionAttentionEntry[] = [];
  for (const d of descendants) {
    if (d.issue.status === "in_progress" && !d.issue.assigneeAgentId) {
      informational.push(
        toAttentionItem({
          kind: "info",
          title: `${d.issue.title} has no assignee`,
          description: "In-progress task without an assigned agent.",
          sourceId: d.issue.id,
          sourceType: "issue",
          priority: "low",
          ageMs: ageMs(d.issue.startedAt ?? d.issue.createdAt),
          route: `/issues/${d.issue.id}`,
        }),
      );
    }
  }

  return {
    actionRequired,
    questionsWaiting,
    approvalsPending,
    blocked,
    verificationFailures,
    informational,
  };
}

function findDescendantIssue(
  descendants: MissionDescendant[],
  issueId: string,
): CompactIssue | null {
  for (const d of descendants) {
    if (d.issue.id === issueId) return d.issue;
  }
  return null;
}

function ageMs(ts: Date | string | null | undefined): number {
  if (!ts) return 0;
  return Math.max(0, Date.now() - new Date(ts).getTime());
}

function toAttentionItem(fields: {
  kind: AttentionItemKind;
  title: string;
  description: string | null;
  sourceId: string;
  sourceType: string;
  priority: "high" | "medium" | "low";
  ageMs: number;
  route: string | null;
}): MissionAttentionEntry {
  return { ...fields };
}
