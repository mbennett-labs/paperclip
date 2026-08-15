import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, operatorMissions } from "@paperclipai/db";
import type { OperatorMissionStatus } from "@paperclipai/shared";
import { mergeMissionEvidence } from "./operator-mission-evidence.js";
import {
  toOperatorMissionRecord,
  type OperatorMissionRecord,
} from "./operator-mission.js";

const REVIEW_WAKE_REASONS = new Set([
  "execution_review_requested",
  "execution_review_participant_recovery",
]);

type NativeRunSnapshot = {
  id: string;
  status: string;
  agentId: string;
  error: string | null;
  errorCode: string | null;
};

type NativeIssueSnapshot = {
  status: string;
  executionState: Record<string, unknown> | null;
  executionWorkspaceId: string | null;
};

export type OperatorMissionProjection = {
  status: OperatorMissionStatus;
  terminalStatus?: string | null;
  reviewRunId?: string | null;
  reviewVerdict?: string | null;
  evidence: Record<string, unknown>;
};

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function runEvidence(run: NativeRunSnapshot | null) {
  if (!run) return null;
  return {
    id: run.id,
    agentId: run.agentId,
    status: run.status,
    error: run.error,
    errorCode: run.errorCode,
  };
}

/**
 * Project the operator-mission view from Paperclip's authoritative native issue
 * and heartbeat state. This never manufactures an implementation/review stage;
 * it only mirrors the state the normal issue execution policy already owns.
 */
export function deriveOperatorMissionProjection(input: {
  missionStatus: OperatorMissionStatus;
  missionTerminalStatus: string | null;
  issue: NativeIssueSnapshot;
  implementRun: NativeRunSnapshot | null;
  reviewRun: NativeRunSnapshot | null;
}): OperatorMissionProjection {
  const executionState = input.issue.executionState ?? {};
  const executionStatus = stringField(executionState.status);
  const stageId = stringField(executionState.currentStageId);
  const stageType = stringField(executionState.currentStageType);
  const lastDecisionOutcome = stringField(executionState.lastDecisionOutcome);

  let status = input.missionStatus;
  let terminalStatus: string | null | undefined;
  let reviewVerdict: string | null | undefined;

  // A bounded terminal outcome is sticky. A read/reconcile must never resurrect
  // a mission that already failed closed (for example dispatch_failed).
  if (!input.missionTerminalStatus) {
    if (input.issue.status === "cancelled") {
      status = "failed";
      terminalStatus = "issue_cancelled";
    } else if (input.issue.status === "done" || executionStatus === "completed") {
      status = "completed";
      terminalStatus = "completed";
      if (lastDecisionOutcome) reviewVerdict = lastDecisionOutcome;
    } else if (executionStatus === "changes_requested") {
      status = "implementing";
      reviewVerdict = lastDecisionOutcome ?? "changes_requested";
    } else if (
      executionStatus === "pending" &&
      (stageType === "review" || stageType === "approval")
    ) {
      status = "reviewing";
    } else if (input.issue.status === "in_review") {
      status = "reviewing";
    } else if (input.issue.status === "blocked") {
      status = "escalated";
    } else {
      status = "implementing";
    }
  }

  return {
    status,
    ...(terminalStatus !== undefined ? { terminalStatus } : {}),
    ...(input.reviewRun ? { reviewRunId: input.reviewRun.id } : {}),
    ...(reviewVerdict !== undefined ? { reviewVerdict } : {}),
    evidence: {
      nativeLifecycle: {
        issueStatus: input.issue.status,
        executionStatus,
        executionStageId: stageId,
        executionStageType: stageType,
        executionWorkspaceId: input.issue.executionWorkspaceId,
        implementationRun: runEvidence(input.implementRun),
        reviewRun: runEvidence(input.reviewRun),
      },
    },
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export async function reconcileOperatorMission(
  db: Db,
  record: OperatorMissionRecord,
): Promise<OperatorMissionRecord> {
  if (!record.issueId) return record;

  const issue = await db
    .select({
      companyId: issues.companyId,
      status: issues.status,
      executionState: issues.executionState,
      executionWorkspaceId: issues.executionWorkspaceId,
    })
    .from(issues)
    .where(eq(issues.id, record.issueId))
    .then((rows) => rows[0] ?? null);

  // The FK is set-null on issue deletion. If a concurrent deletion races this
  // read, preserve the durable mission record rather than inventing a state.
  if (!issue || issue.companyId !== record.companyId) return record;

  const implementRun = record.implementRunId
    ? await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          agentId: heartbeatRuns.agentId,
          error: heartbeatRuns.error,
          errorCode: heartbeatRuns.errorCode,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, record.implementRunId))
        .then((rows) => rows[0] ?? null)
    : null;

  // Correlate the reviewer from the native wake context. This deliberately
  // includes Paperclip's reviewer-recovery wake, so receipts follow the run
  // that actually owns the pending review after a failed reviewer heartbeat.
  const reviewRun = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      agentId: heartbeatRuns.agentId,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
      wakeReason: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeReason'`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, record.companyId),
        gte(heartbeatRuns.createdAt, record.createdAt),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${record.issueId}`,
        sql`${heartbeatRuns.contextSnapshot} ->> 'wakeReason' in ('execution_review_requested', 'execution_review_participant_recovery')`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (reviewRun && !REVIEW_WAKE_REASONS.has(reviewRun.wakeReason ?? "")) {
    return record;
  }

  const projection = deriveOperatorMissionProjection({
    missionStatus: record.status,
    missionTerminalStatus: record.terminalStatus,
    issue: {
      status: issue.status,
      executionState: (issue.executionState as Record<string, unknown> | null) ?? null,
      executionWorkspaceId: issue.executionWorkspaceId ?? null,
    },
    implementRun,
    reviewRun,
  });
  const mergedEvidence = mergeMissionEvidence(record.evidence, projection.evidence);

  const nextTerminalStatus =
    projection.terminalStatus !== undefined
      ? projection.terminalStatus
      : record.terminalStatus;
  const nextReviewRunId =
    projection.reviewRunId !== undefined ? projection.reviewRunId : record.reviewRunId;
  const nextReviewVerdict =
    projection.reviewVerdict !== undefined ? projection.reviewVerdict : record.reviewVerdict;

  const changed =
    projection.status !== record.status ||
    nextTerminalStatus !== record.terminalStatus ||
    nextReviewRunId !== record.reviewRunId ||
    nextReviewVerdict !== record.reviewVerdict ||
    stableJson(mergedEvidence) !== stableJson(record.evidence);

  if (!changed) return record;

  const row = await db
    .update(operatorMissions)
    .set({
      status: projection.status,
      terminalStatus: nextTerminalStatus,
      reviewRunId: nextReviewRunId,
      reviewVerdict: nextReviewVerdict,
      evidence: mergedEvidence,
      updatedAt: new Date(),
    })
    .where(eq(operatorMissions.id, record.id))
    .returning()
    .then((rows) => rows[0] ?? null);

  return row ? toOperatorMissionRecord(row) : record;
}
