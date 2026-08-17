import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { operatorMissionService } from "../services/operator-mission.js";
import { mergeMissionEvidence } from "../services/operator-mission-evidence.js";
import { resolveOperatorMissionDispatch } from "../services/operator-mission-dispatch.js";
import { reconcileOperatorMission } from "../services/operator-mission-reconcile.js";
import { resolveOperatorReviewDispatch } from "../services/operator-review-dispatch.js";
import {
  executionWorkspaceService,
  heartbeatService,
  issueService,
  logActivity,
} from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound, conflict, HttpError } from "../errors.js";
import type { OperatorMissionStatus } from "@paperclipai/shared";

export function operatorMissionRoutes(db: Db) {
  const router = Router();
  const svc = operatorMissionService(db);
  const issueSvc = issueService(db);
  const workspaces = executionWorkspaceService(db);
  const heartbeat = heartbeatService(db);

  // QSL Operator Loop V0.1 explicit review dispatch.
  //
  // The generic Issue Properties "Run review now" control currently changes only
  // issue status. When an execution state is already pending on the same review
  // stage, the generic stage-transition wake path correctly sees no *new* stage
  // transition and therefore emits no reviewer wake. This governed primitive
  // makes the operator intent explicit: restore the issue to in_review and wake
  // exactly the agent participant that already owns the pending review stage.
  //
  // Dispatch is idempotent for one review-decision cycle. A later decision cycle
  // receives a new key so changes-requested -> resubmitted work can be reviewed
  // again without duplicate wakes inside the same cycle.
  router.post(
    "/companies/:companyId/operator-review-dispatch",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const issueId = typeof req.body?.issueId === "string" ? req.body.issueId.trim() : "";
      if (!issueId) {
        res.status(400).json({ error: "issueId is required" });
        return;
      }

      const issue = await issueSvc.getById(issueId);
      if (!issue || issue.companyId !== companyId) {
        throw notFound("Issue not found");
      }

      // Agents may dispatch review only for work they currently own. Board users
      // retain their normal company-scoped authority.
      if (
        req.actor.type === "agent" &&
        (!req.actor.agentId || req.actor.agentId !== issue.assigneeAgentId)
      ) {
        res.status(403).json({ error: "Agent may dispatch review only for its assigned issue" });
        return;
      }

      const resolution = resolveOperatorReviewDispatch({
        issueId: issue.id,
        issueStatus: issue.status,
        executionState: issue.executionState,
      });
      if (!resolution.ok) {
        res.status(422).json({ error: resolution.reason });
        return;
      }

      const { plan } = resolution;
      const actor = getActorInfo(req);
      const previousStatus = issue.status;
      let statusChanged = false;
      let reviewRunId: string | null = null;

      try {
        if (previousStatus !== plan.nextIssueStatus) {
          const updated = await issueSvc.update(issue.id, {
            status: plan.nextIssueStatus,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
          });
          if (!updated) throw notFound("Issue not found");
          statusChanged = true;
        }

        const reviewRun = await heartbeat.wakeup(plan.reviewerAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "execution_review_requested",
          payload: {
            issueId: issue.id,
            mutation: "operator_review_dispatch",
            executionStage: plan.executionStage,
          },
          idempotencyKey: plan.idempotencyKey,
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            wakeReason: "execution_review_requested",
            source: "qsl.operator_review_dispatch",
            executionStage: plan.executionStage,
          },
        });
        if (!reviewRun) {
          throw new HttpError(503, "Native reviewer dispatch was not queued", {
            code: "operator_review_dispatch_not_queued",
            issueId: issue.id,
            reviewerAgentId: plan.reviewerAgentId,
            stageId: plan.executionStage.stageId,
          });
        }
        reviewRunId = reviewRun.id;

        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "issue.execution_review_dispatched",
          entityType: "issue",
          entityId: issue.id,
          details: {
            reviewerAgentId: plan.reviewerAgentId,
            reviewRunId,
            stageId: plan.executionStage.stageId,
            previousStatus,
            nextStatus: plan.nextIssueStatus,
            idempotencyKey: plan.idempotencyKey,
          },
        });
      } catch (err) {
        // Fail closed: if we restored review state but could not dispatch its
        // owner, put the issue back where it was rather than leaving an
        // ownerless in_review state. Re-read first so we do not overwrite a
        // concurrent terminal transition.
        if (statusChanged) {
          const current = await issueSvc.getById(issue.id).catch(() => null);
          if (current?.status === plan.nextIssueStatus) {
            await issueSvc.update(issue.id, {
              status: previousStatus,
              actorAgentId: actor.agentId ?? null,
              actorUserId: actor.actorType === "user" ? actor.actorId : null,
            }).catch(() => null);
          }
        }
        throw err;
      }

      res.status(202).json({
        issueId: issue.id,
        status: plan.nextIssueStatus,
        reviewerAgentId: plan.reviewerAgentId,
        reviewRunId,
        stageId: plan.executionStage.stageId,
        dispatch: "queued",
      });
    },
  );

  router.post(
    "/companies/:companyId/operator-missions",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const {
        issueId,
        missionId,
        authorityScope,
        provider,
        model,
        credentialRefType,
        message,
      } = req.body as {
        issueId?: string | null;
        missionId?: string;
        authorityScope?: string;
        provider?: string | null;
        model?: string | null;
        credentialRefType?: string | null;
        message?: string;
      };

      const normalizedMissionId = typeof missionId === "string" ? missionId.trim() : "";
      const normalizedIssueId = typeof issueId === "string" ? issueId.trim() : "";
      const normalizedAuthorityScope =
        authorityScope == null
          ? "autonomous"
          : typeof authorityScope === "string"
            ? authorityScope.trim()
            : "";
      if (!normalizedMissionId) {
        res.status(400).json({ error: "missionId is required" });
        return;
      }
      if (!normalizedIssueId) {
        res.status(400).json({ error: "issueId is required for native mission dispatch" });
        return;
      }
      if (
        normalizedAuthorityScope !== "autonomous" &&
        normalizedAuthorityScope !== "human_required"
      ) {
        res.status(400).json({
          error: "authorityScope must be autonomous or human_required",
        });
        return;
      }

      const existing = await svc.getByMissionId(companyId, normalizedMissionId);
      if (existing) {
        throw conflict("Mission already exists");
      }

      const issue = await issueSvc.getById(normalizedIssueId);
      if (!issue || issue.companyId !== companyId) {
        throw notFound("Issue not found");
      }

      const persistedWorkspace = issue.executionWorkspaceId
        ? await workspaces.getById(issue.executionWorkspaceId)
        : null;
      const resolution = resolveOperatorMissionDispatch({
        companyId,
        missionId: normalizedMissionId,
        issue,
        workspace: persistedWorkspace,
        message,
      });
      if (!resolution.ok) {
        res.status(422).json({ error: resolution.reason });
        return;
      }

      const actor = getActorInfo(req);
      const { plan } = resolution;
      const record = await svc.create({
        companyId,
        issueId: issue.id,
        missionId: normalizedMissionId,
        authorityScope: normalizedAuthorityScope,
        provider,
        model,
        credentialRefType,
        createdByRunId: actor.runId ?? null,
      });
      if (!record) {
        res.status(500).json({ error: "Failed to create mission record" });
        return;
      }

      // Guardian authority gate: a mission explicitly classified as requiring
      // human authority is durable evidence, not permission to run. Persist the
      // escalation and withhold the implementation heartbeat entirely.
      if (normalizedAuthorityScope === "human_required") {
        const authorityEvidence = mergeMissionEvidence(record.evidence, {
          authorityGate: {
            status: "human_required",
            dispatch: "withheld",
            reason: "human_approval_required",
          },
        });
        await svc.updateFields(record.id, {
          terminalStatus: "human_approval_required",
          escalations: "1",
          evidence: authorityEvidence,
        });
        const gatedRecord = await svc.updateStatus(
          record.id,
          "escalated",
          authorityEvidence ?? undefined,
        );

        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "operator_mission.authority_escalated",
          entityType: "operator_mission",
          entityId: record.id,
          details: {
            missionId: normalizedMissionId,
            issueId: issue.id,
            authorityScope: normalizedAuthorityScope,
            dispatch: "withheld",
            reason: "human_approval_required",
          },
        });

        res.status(202).json(gatedRecord ?? record);
        return;
      }

      try {
        const run = await heartbeat.wakeup(plan.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "operator_mission_requested",
          payload: plan.payload,
          idempotencyKey: plan.idempotencyKey,
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: plan.contextSnapshot,
        });

        if (!run) {
          const failedEvidence = mergeMissionEvidence(record.evidence, {
            dispatch: {
              status: "failed",
              mechanism: "native_heartbeat",
              reason: "heartbeat_wakeup_not_queued",
              agentId: plan.agentId,
              workspaceId: plan.workspaceId,
            },
          });
          await svc.updateFields(record.id, {
            terminalStatus: "dispatch_failed",
            evidence: failedEvidence,
          });
          await svc.updateStatus(record.id, "failed");
          res.status(503).json({
            error: "Native mission dispatch was not queued",
            missionId: normalizedMissionId,
          });
          return;
        }

        const dispatchEvidence = mergeMissionEvidence(record.evidence, {
          dispatch: {
            status: "queued",
            mechanism: "native_heartbeat",
            agentId: plan.agentId,
            runId: run.id,
            workspaceId: plan.workspaceId,
            workspaceRealization: plan.workspaceId ? "persisted" : "heartbeat_owned",
          },
        });
        await svc.updateFields(record.id, {
          implementRunId: run.id,
          evidence: dispatchEvidence,
        });
        const runningRecord = await svc.updateStatus(record.id, "implementing");

        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "operator_mission.native_dispatched",
          entityType: "operator_mission",
          entityId: record.id,
          details: {
            missionId: normalizedMissionId,
            issueId: issue.id,
            implementationAgentId: plan.agentId,
            implementRunId: run.id,
            workspaceId: plan.workspaceId,
            idempotencyKey: plan.idempotencyKey,
          },
        });

        res.status(201).json(runningRecord ?? record);
      } catch (err) {
        const dispatchError = err instanceof Error ? err.message : String(err);
        const failedEvidence = mergeMissionEvidence(record.evidence, {
          dispatch: {
            status: "failed",
            mechanism: "native_heartbeat",
            reason: dispatchError,
            agentId: plan.agentId,
            workspaceId: plan.workspaceId,
          },
        });
        await svc.updateFields(record.id, {
          terminalStatus: "dispatch_failed",
          evidence: failedEvidence,
        }).catch(() => null);
        await svc.updateStatus(record.id, "failed").catch(() => null);
        throw err;
      }
    },
  );

  router.get(
    "/companies/:companyId/operator-missions/:missionId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const missionId = req.params.missionId as string;
      assertCompanyAccess(req, companyId);

      const record = await svc.getByMissionId(companyId, missionId);
      if (!record) {
        throw notFound("Operator mission not found");
      }

      const reconciled = await reconcileOperatorMission(db, record);
      res.json(reconciled);
    },
  );

  router.get(
    "/companies/:companyId/operator-missions",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const limit = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : 20;
      const records = await svc.listByCompany(companyId, Math.min(limit, 100));
      const reconciled = await Promise.all(
        records.map((record) => reconcileOperatorMission(db, record)),
      );
      res.json(reconciled);
    },
  );

  router.patch(
    "/companies/:companyId/operator-missions/:missionId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const missionId = req.params.missionId as string;
      assertCompanyAccess(req, companyId);

      const record = await svc.getByMissionId(companyId, missionId);
      if (!record) {
        throw notFound("Operator mission not found");
      }

      const {
        status,
        evidence,
        initialHead,
        finalHead,
        changedFiles,
        reviewVerdict,
        stagingPid,
        productionPidBefore,
        productionPidAfter,
        productionUntouched,
        retries,
        escalations,
        costUsage,
        terminalStatus,
        implementRunId,
        reviewRunId,
      } = req.body as Record<string, unknown>;

      const incomingEvidence =
        evidence && typeof evidence === "object" && !Array.isArray(evidence)
          ? (evidence as Record<string, unknown>)
          : undefined;
      const mergedEvidence =
        incomingEvidence !== undefined
          ? mergeMissionEvidence(record.evidence, incomingEvidence)
          : undefined;

      const fields: Record<string, unknown> = {};
      if (initialHead !== undefined) fields.initialHead = initialHead;
      if (finalHead !== undefined) fields.finalHead = finalHead;
      if (changedFiles !== undefined) fields.changedFiles = changedFiles;
      if (reviewVerdict !== undefined) fields.reviewVerdict = reviewVerdict;
      if (stagingPid !== undefined) fields.stagingPid = stagingPid;
      if (productionPidBefore !== undefined)
        fields.productionPidBefore = productionPidBefore;
      if (productionPidAfter !== undefined)
        fields.productionPidAfter = productionPidAfter;
      if (productionUntouched !== undefined)
        fields.productionUntouched = productionUntouched;
      if (retries !== undefined) fields.retries = retries;
      if (escalations !== undefined) fields.escalations = escalations;
      if (costUsage !== undefined) fields.costUsage = costUsage;
      if (terminalStatus !== undefined) fields.terminalStatus = terminalStatus;
      if (mergedEvidence !== undefined) fields.evidence = mergedEvidence;
      if (implementRunId !== undefined) fields.implementRunId = implementRunId;
      if (reviewRunId !== undefined) fields.reviewRunId = reviewRunId;

      if (status !== undefined) {
        const updated = await svc.updateStatus(
          record.id,
          status as OperatorMissionStatus,
          mergedEvidence ?? undefined,
        );
        if (updated && Object.keys(fields).length > 0) {
          const merged = await svc.updateFields(record.id, fields);
          res.json(merged ?? record);
        } else {
          res.json(updated ?? record);
        }
      } else {
        const updated = await svc.updateFields(record.id, fields);
        res.json(updated ?? record);
      }
    },
  );

  router.get(
    "/companies/:companyId/operator-missions/:missionId/receipt",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const missionId = req.params.missionId as string;
      assertCompanyAccess(req, companyId);

      const record = await svc.getByMissionId(companyId, missionId);
      if (!record) {
        throw notFound("Operator mission not found");
      }

      const reconciled = await reconcileOperatorMission(db, record);
      const receipt = svc.toReceipt(reconciled);
      res.json(receipt);
    },
  );

  return router;
}