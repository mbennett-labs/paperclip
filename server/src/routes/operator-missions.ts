import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { operatorMissionService } from "../services/operator-mission.js";
import { mergeMissionEvidence } from "../services/operator-mission-evidence.js";
import { resolveOperatorReviewDispatch } from "../services/operator-review-dispatch.js";
import { heartbeatService, issueService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound, conflict } from "../errors.js";
import type { OperatorMissionStatus } from "@paperclipai/shared";
import { spawn } from "node:child_process";
import path from "node:path";

export function operatorMissionRoutes(db: Db) {
  const router = Router();
  const svc = operatorMissionService(db);
  const issueSvc = issueService(db);
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

        await heartbeat.wakeup(plan.reviewerAgentId, {
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
        missionId: string;
        authorityScope?: string;
        provider?: string | null;
        model?: string | null;
        credentialRefType?: string | null;
        message?: string;
      };

      if (!missionId) {
        res.status(400).json({ error: "missionId is required" });
        return;
      }

      const existing = await svc.getByMissionId(companyId, missionId);
      if (existing) {
        throw conflict("Mission already exists");
      }

      const record = await svc.create({
        companyId,
        issueId: issueId ?? null,
        missionId,
        authorityScope,
        provider,
        model,
        credentialRefType,
      });

      const runnerScript = path.resolve(
        process.cwd(),
        "scripts/operator-loop/run-mission.sh",
      );
      const runnerArgs = [
        "--mission-id", missionId,
        "--repo-dir", process.cwd(),
        "--company-id", companyId,
        "--api-base", "http://localhost:3101/api",
        "--provider", provider ?? "openrouter",
        "--model", model ?? "openrouter/deepseek/deepseek-chat",
      ];
      if (issueId) {
        runnerArgs.push("--issue-id", issueId);
      }
      if (message) {
        runnerArgs.push("--message", message);
      }

      if (!record) {
        res.status(500).json({ error: "Failed to create mission record" });
        return;
      }
      await svc.updateStatus(record.id, "running");

      spawn("bash", [runnerScript, ...runnerArgs], {
        detached: true,
        stdio: "ignore",
        cwd: process.cwd(),
        env: {
          ...process.env,
          PAPERCLIP_OPERATOR_RECORD_EXISTS: "true",
        },
      }).unref();

      res.status(201).json(record);
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

      res.json(record);
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
      res.json(records);
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

      const receipt = svc.toReceipt(record);
      res.json(receipt);
    },
  );

  return router;
}
