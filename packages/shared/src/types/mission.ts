import type { CompactIssue, IssueRelation, IssueThreadInteraction } from "./issue.js";
import type { Approval } from "./approval.js";
import type { ActivityEvent } from "./activity.js";

export type MissionState =
  | "planned"
  | "running"
  | "waiting_for_human"
  | "blocked"
  | "verifying"
  | "completed"
  | "failed";

export interface MissionProgress {
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  blockedTasks: number;
  inReviewTasks: number;
}

export interface MissionActiveWork {
  issue: CompactIssue;
  assigneeName: string | null;
  lastActivityAt: string | null;
}

export interface MissionBlocker {
  issue: CompactIssue;
  blockedBy: CompactIssue[];
}

export interface MissionQuestion {
  interaction: IssueThreadInteraction;
  issue: CompactIssue;
  issueIdentifier: string | null;
  ageMs: number;
}

export interface MissionApprovalItem {
  approval: Approval;
  issues: CompactIssue[];
}

export interface MissionBudget {
  spentCents: number;
  budgetCents: number | null;
  hasHardLimit: boolean;
  available: boolean;
  label: string;
}

export interface MissionVerification {
  overallStatus: "passed" | "failed" | "in_progress" | "unknown";
  failures: Array<{
    issue: CompactIssue;
    reason: string;
  }>;
}

export type AttentionItemKind =
  | "action_required"
  | "question"
  | "approval"
  | "blocker"
  | "verification_failure"
  | "info";

export interface MissionAttentionEntry {
  kind: AttentionItemKind;
  title: string;
  description: string | null;
  sourceId: string;
  sourceType: string;
  priority: "high" | "medium" | "low";
  ageMs: number;
  route: string | null;
}

export interface MissionAttention {
  actionRequired: MissionAttentionEntry[];
  questionsWaiting: MissionAttentionEntry[];
  approvalsPending: MissionAttentionEntry[];
  blocked: MissionAttentionEntry[];
  verificationFailures: MissionAttentionEntry[];
  informational: MissionAttentionEntry[];
}

export interface MissionView {
  missionId: string;
  companyId: string;
  objective: string;
  description: string | null;

  state: MissionState;
  phase: string;

  progress: MissionProgress;

  activeWork: MissionActiveWork[];
  recentlyCompleted: CompactIssue[];

  blockers: MissionBlocker[];

  unansweredQuestions: MissionQuestion[];

  pendingApprovals: MissionApprovalItem[];

  budget: MissionBudget | null;

  verification: MissionVerification;

  recentActivity: ActivityEvent[];

  humanAttention: MissionAttention;
}

export interface MissionDescendant {
  issue: CompactIssue;
  blockedBy: IssueRelation[];
}
