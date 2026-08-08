import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { missionService } from "../services/mission.js";
import { assertCompanyAccess } from "./authz.js";

export function missionRoutes(db: Db) {
  const router = Router();
  const svc = missionService(db);

  router.get("/companies/:companyId/mission/:issueId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    const mission = await svc.getMission(companyId, issueId);
    res.json(mission);
  });

  return router;
}