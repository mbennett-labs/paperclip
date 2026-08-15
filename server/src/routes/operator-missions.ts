import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { operatorMissionService } from "../services/operator-mission.js";
import { mergeMissionEvidence } from "../services/operator-mission-evidence.js";
import { assertCompanyAccess } from "./authz.js";
import { notFound, conflict } from "../errors.js";
import type { OperatorMissionStatus } from "@paperclipai/shared";
import { spawn } from "node:child_process";
import path from "node:path";

export function operatorMissionRoutes(db: Db) {
  const router = Router();
  const svc = operatorMissionService(db);

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
