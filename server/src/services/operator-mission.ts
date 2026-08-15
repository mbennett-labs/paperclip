import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { operatorMissions } from "@paperclipai/db";
import type { MissionReceipt, OperatorMissionStatus } from "@paperclipai/shared";

type OperatorMissionRow = typeof operatorMissions.$inferSelect;

export interface OperatorMissionRecord {
  id: string;
  companyId: string;
  issueId: string | null;
  missionId: string;
  status: OperatorMissionStatus;
  authorityScope: string;
  provider: string | null;
  model: string | null;
  credentialRefType: string | null;
  initialHead: string | null;
  finalHead: string | null;
  changedFiles: string[] | null;
  reviewVerdict: string | null;
  stagingPid: string | null;
  productionPidBefore: string | null;
  productionPidAfter: string | null;
  productionUntouched: string | null;
  retries: string;
  escalations: string;
  costUsage: Record<string, unknown> | null;
  terminalStatus: string | null;
  evidence: Record<string, unknown> | null;
  implementRunId: string | null;
  reviewRunId: string | null;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: OperatorMissionRow): OperatorMissionRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId ?? null,
    missionId: row.missionId,
    status: row.status as OperatorMissionStatus,
    authorityScope: row.authorityScope,
    provider: row.provider ?? null,
    model: row.model ?? null,
    credentialRefType: row.credentialRefType ?? null,
    initialHead: row.initialHead ?? null,
    finalHead: row.finalHead ?? null,
    changedFiles: (row.changedFiles as string[] | null) ?? null,
    reviewVerdict: row.reviewVerdict ?? null,
    stagingPid: row.stagingPid ?? null,
    productionPidBefore: row.productionPidBefore ?? null,
    productionPidAfter: row.productionPidAfter ?? null,
    productionUntouched: row.productionUntouched ?? null,
    retries: row.retries ?? "0",
    escalations: row.escalations ?? "0",
    costUsage: (row.costUsage as Record<string, unknown> | null) ?? null,
    terminalStatus: row.terminalStatus ?? null,
    evidence: (row.evidence as Record<string, unknown> | null) ?? null,
    implementRunId: row.implementRunId ?? null,
    reviewRunId: row.reviewRunId ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function operatorMissionService(db: Db) {
  return {
    create: async (input: {
      companyId: string;
      issueId?: string | null;
      missionId: string;
      authorityScope?: string;
      provider?: string | null;
      model?: string | null;
      credentialRefType?: string | null;
      initialHead?: string | null;
      createdByRunId?: string | null;
    }) => {
      const row = await db
        .insert(operatorMissions)
        .values({
          companyId: input.companyId,
          issueId: input.issueId ?? null,
          missionId: input.missionId,
          status: "submitted",
          authorityScope: input.authorityScope ?? "autonomous",
          provider: input.provider ?? null,
          model: input.model ?? null,
          credentialRefType: input.credentialRefType ?? null,
          initialHead: input.initialHead ?? null,
          createdByRunId: input.createdByRunId ?? null,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toRecord(row) : null;
    },

    getByMissionId: async (companyId: string, missionId: string) => {
      const row = await db
        .select()
        .from(operatorMissions)
        .where(
          and(
            eq(operatorMissions.companyId, companyId),
            eq(operatorMissions.missionId, missionId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return row ? toRecord(row) : null;
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(operatorMissions)
        .where(eq(operatorMissions.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toRecord(row) : null;
    },

    listByCompany: async (companyId: string, limit = 20) => {
      const rows = await db
        .select()
        .from(operatorMissions)
        .where(eq(operatorMissions.companyId, companyId))
        .orderBy(desc(operatorMissions.createdAt))
        .limit(limit);
      return rows.map(toRecord);
    },

    updateStatus: async (
      id: string,
      status: OperatorMissionStatus,
      evidence?: Record<string, unknown>,
    ) => {
      const updates: Record<string, unknown> = {
        status,
        updatedAt: new Date(),
      };
      if (evidence !== undefined) {
        updates.evidence = evidence;
      }
      const row = await db
        .update(operatorMissions)
        .set(updates)
        .where(eq(operatorMissions.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toRecord(row) : null;
    },

    updateFields: async (
      id: string,
      fields: Partial<{
        initialHead: string | null;
        finalHead: string | null;
        changedFiles: string[] | null;
        reviewVerdict: string | null;
        stagingPid: string | null;
        productionPidBefore: string | null;
        productionPidAfter: string | null;
        productionUntouched: string | null;
        retries: string;
        escalations: string;
        costUsage: Record<string, unknown> | null;
        terminalStatus: string | null;
        evidence: Record<string, unknown> | null;
        implementRunId: string | null;
        reviewRunId: string | null;
      }>,
    ) => {
      const row = await db
        .update(operatorMissions)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(operatorMissions.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toRecord(row) : null;
    },

    toReceipt: (record: OperatorMissionRecord): MissionReceipt => ({
      mission_id: record.missionId,
      issue_id: record.issueId,
      agent_id: null,
      run_ids: [record.implementRunId, record.reviewRunId].filter(
        (id): id is string => id !== null,
      ),
      authorized_scope: record.authorityScope,
      provider: record.provider,
      model: record.model,
      credential_reference_type: record.credentialRefType,
      start_time: record.createdAt.toISOString(),
      end_time: record.updatedAt.toISOString(),
      initial_head: record.initialHead,
      final_head: record.finalHead,
      changed_files: record.changedFiles ?? [],
      tests: record.evidence
        ? (record.evidence.tests as string | undefined) ?? null
        : null,
      review_verdict: record.reviewVerdict,
      staging_deployment: record.status === "deploy_succeeded" ? "deployed" : null,
      staging_pid: record.stagingPid,
      production_pid_before: record.productionPidBefore,
      production_pid_after: record.productionPidAfter,
      production_untouched: record.productionUntouched,
      retries: record.retries,
      escalations: record.escalations,
      cost_usage: record.costUsage,
      terminal_status: record.terminalStatus ?? record.status,
    }),
  };
}

export { toRecord as toOperatorMissionRecord };