import type {
  CompactIssue,
  IssueThreadInteraction,
} from "../types/issue.js";
import type { MissionDescendant, MissionState } from "../types/mission.js";

export interface DeriveMissionStateInput {
  rootIssue: CompactIssue;
  descendants: MissionDescendant[];
  pendingQuestions: IssueThreadInteraction[];
  hasPendingApprovals: boolean;
}

export function deriveMissionState(input: DeriveMissionStateInput): MissionState {
  const { rootIssue, descendants, pendingQuestions, hasPendingApprovals } = input;

  if (rootIssue.status === "cancelled") {
    return "failed";
  }

  const allIssues = [rootIssue, ...descendants.map((d) => d.issue)];
  const descendantIssues = descendants.map((d) => d.issue);
  const nonCancelled = descendantIssues.filter((i) => i.status !== "cancelled");
  const allDoneOrCancelled = descendantIssues.every(
    (i) => i.status === "done" || i.status === "cancelled",
  );

  if (rootIssue.status === "done" && allDoneOrCancelled && nonCancelled.length > 0) {
    return "completed";
  }

  const hasUnansweredQuestions = pendingQuestions.some(
    (q) => q.status === "pending",
  );

  if (hasUnansweredQuestions || hasPendingApprovals) {
    return "waiting_for_human";
  }

  const hasBlocked = allIssues.some(
    (i) => i.status === "blocked",
  );

  if (hasBlocked) {
    return "blocked";
  }

  const hasInReview = allIssues.some(
    (i) => i.status === "in_review",
  );

  if (hasInReview) {
    return "verifying";
  }

  const hasInProgress = allIssues.some(
    (i) => i.status === "in_progress",
  );

  if (hasInProgress) {
    return "running";
  }

  return "planned";
}
