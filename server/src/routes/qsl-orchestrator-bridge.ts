import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  issueService,
  approvalService,
  logActivity,
} from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { missionService } from "../services/mission.js";
import { operatorMissionService } from "../services/operator-mission.js";
import {
  READ_ONLY_OPERATIONS,
  BOUNDED_WRITE_OPERATIONS,
  HUMAN_GATED_OPERATIONS,
  isProhibitedOperation,
  type OrchestratorBridgeOperation,
} from "@paperclipai/shared";

export function qslOrchestratorBridgeRoutes(db: Db) {
  const router = Router();
  const issueSvc = issueService(db);
  const approvalSvc = approvalService(db);
  const operatorMissionSvc = operatorMissionService(db);
  const missionSvc = missionService(db);

  const ALL_BRIDGE_OPERATIONS: OrchestratorBridgeOperation[] = [
    ...READ_ONLY_OPERATIONS,
    ...BOUNDED_WRITE_OPERATIONS,
    ...HUMAN_GATED_OPERATIONS,
  ];

  router.post("/companies/:companyId/bridge", async (req: any, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { operation, target_ids, payload, authority_approval_id } = req.body;

    if (!operation || typeof operation !== "string") {
      res.status(400).json({ error: "operation is required" });
      return;
    }

    if (isProhibitedOperation(operation)) {
      res.status(403).json({
        error: "Prohibited operation class",
        result_class: "BLOCKED",
      });
      return;
    }

    if (!(ALL_BRIDGE_OPERATIONS as readonly string[]).includes(operation)) {
      res.status(400).json({
        error: `Unknown operation: ${operation}`,
        allowed: ALL_BRIDGE_OPERATIONS,
      });
      return;
    }

    const actor = getActorInfo(req);

    try {
      const result = await executeBridgeOperation({
        db,
        companyId,
        operation: operation as OrchestratorBridgeOperation,
        targetIds: target_ids ?? [],
        payload: payload ?? {},
        authorityApprovalId: authority_approval_id,
        actor,
        issueSvc,
        approvalSvc,
        operatorMissionSvc,
        missionSvc,
      });

      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: "Bridge operation failed",
        result_class: "FAIL",
        sanitized_error: sanitizeErrorMessage(message),
      });
    }
  });

  return router;
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/(eyJ|sk-|api_key|password|secret|token)[\w-]{20,}/gi, "[REDACTED]")
    .slice(0, 500);
}

interface BridgeOpContext {
  db: Db;
  companyId: string;
  operation: OrchestratorBridgeOperation;
  targetIds: string[];
  payload: Record<string, unknown>;
  authorityApprovalId?: string;
  actor: ReturnType<typeof getActorInfo>;
  issueSvc: ReturnType<typeof issueService>;
  approvalSvc: ReturnType<typeof approvalService>;
  operatorMissionSvc: ReturnType<typeof operatorMissionService>;
  missionSvc: ReturnType<typeof missionService>;
}

async function executeBridgeOperation(ctx: BridgeOpContext) {
  const { companyId, operation, targetIds, payload, actor } = ctx;
  const evidence: string[] = [];

  switch (operation) {
    // ── Read-only operations ──────────────────────────────────────
    case "status": {
      const companies = targetIds.length > 0 ? targetIds : [companyId];
      const issues = await Promise.all(
        companies.map((cid) =>
          ctx.issueSvc
            .list(cid, { limit: 5 })
            .catch(() => [])
        )
      );
      return {
        result_class: "PASS" as const,
        evidence_summary: `Status resolved for ${companies.length} company scope(s).`,
        data: { companies, recent_issue_count: issues.flat().length },
      };
    }

    case "list-missions": {
      const issues = await ctx.issueSvc.list(companyId, {
        status: "in_progress",
        limit: 50,
      });
      return {
        result_class: "PASS" as const,
        evidence_summary: `Listed ${issues.length} in_progress issues.`,
        data: {
          missions: issues.map((i) => ({
            id: i.id,
            title: i.title,
            status: i.status,
            priority: i.priority,
            assignee_agent_id: i.assigneeAgentId,
          })),
        },
      };
    }

    case "get-mission": {
      const issueId = targetIds[0];
      if (!issueId) {
        return { result_class: "BLOCKED" as const, sanitized_error: "target_ids[0] required" };
      }
      const issue = await ctx.issueSvc.getById(issueId);
      if (!issue || issue.companyId !== companyId) {
        return { result_class: "BLOCKED" as const, sanitized_error: "Mission not found in company scope" };
      }
      const missionView = await ctx.missionSvc.getMission(companyId, issueId).catch(() => null);
      evidence.push(`get-mission: ${issue.title}`);
      return {
        result_class: "PASS" as const,
        evidence_summary: evidence.join("; "),
        data: {
          id: issue.id,
          title: issue.title,
          status: issue.status,
          priority: issue.priority,
          description: issue.description?.slice(0, 500),
          assignee_agent_id: issue.assigneeAgentId,
          parent_id: issue.parentId,
          mission_view: missionView ? {
            progress: missionView.progress,
            blockers: missionView.blockers?.length ?? 0,
          } : null,
        },
      };
    }

    case "list-tasks": {
      const statusFilter = typeof payload.status === "string" ? payload.status : undefined;
      const issues = await ctx.issueSvc.list(companyId, {
        status: statusFilter,
        limit: 50,
      });
      return {
        result_class: "PASS" as const,
        evidence_summary: `Listed ${issues.length} tasks.`,
        data: {
          tasks: issues.map((i) => ({
            id: i.id,
            identifier: i.identifier,
            title: i.title,
            status: i.status,
            priority: i.priority,
            assignee_agent_id: i.assigneeAgentId,
          })),
        },
      };
    }

    case "get-task": {
      const issueId = targetIds[0];
      if (!issueId) {
        return { result_class: "BLOCKED" as const, sanitized_error: "target_ids[0] required" };
      }
      const issue = await ctx.issueSvc.getById(issueId);
      if (!issue || issue.companyId !== companyId) {
        return { result_class: "BLOCKED" as const, sanitized_error: "Task not found in company scope" };
      }
      return {
        result_class: "PASS" as const,
        evidence_summary: `Resolved task: ${issue.title}`,
        data: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description?.slice(0, 1000),
          status: issue.status,
          priority: issue.priority,
          assignee_agent_id: issue.assigneeAgentId,
          parent_id: issue.parentId,
          project_id: issue.projectId,
          work_mode: issue.workMode,
        },
      };
    }

    case "list-approvals": {
      const status = typeof payload.status === "string" ? payload.status : undefined;
      const approvals = await ctx.approvalSvc.list(companyId, status);
      return {
        result_class: "PASS" as const,
        evidence_summary: `Listed ${approvals.length} approvals.`,
        data: {
          approvals: approvals.map((a) => ({
            id: a.id,
            type: a.type,
            status: a.status,
            requested_by_agent_id: a.requestedByAgentId,
          })),
        },
      };
    }

    case "list-mail-triage": {
      const issues = await ctx.issueSvc.list(companyId, {
        status: "backlog",
        limit: 50,
      });
      const triageCandidates = issues.filter((i) =>
        i.title.toLowerCase().includes("mail") ||
        i.title.toLowerCase().includes("inbox") ||
        i.title.toLowerCase().includes("email")
      );
      return {
        result_class: "PASS" as const,
        evidence_summary: `Found ${triageCandidates.length} mail-triage candidates among ${issues.length} backlog items.`,
        data: {
          candidates: triageCandidates.map((i) => ({
            id: i.id,
            title: i.title,
            status: i.status,
            identifier: i.identifier,
          })),
        },
      };
    }

    case "get-mail-thread-summary": {
      const issueId = targetIds[0];
      if (!issueId) {
        return { result_class: "BLOCKED" as const, sanitized_error: "target_ids[0] required" };
      }
      const issue = await ctx.issueSvc.getById(issueId);
      if (!issue || issue.companyId !== companyId) {
        return { result_class: "BLOCKED" as const, sanitized_error: "Mail thread not found in company scope" };
      }
      return {
        result_class: "PASS" as const,
        evidence_summary: `Resolved mail thread summary for: ${issue.title}`,
        data: {
          id: issue.id,
          title: issue.title,
          description_summary: issue.description?.slice(0, 500),
          status: issue.status,
          created_at: issue.createdAt,
        },
      };
    }

    // ── Bounded write operations ──────────────────────────────────
    case "create-task": {
      if (typeof payload.title !== "string" || !payload.title.trim()) {
        return { result_class: "BLOCKED" as const, sanitized_error: "payload.title is required" };
      }
      const created = await ctx.issueSvc.create(companyId, {
        title: String(payload.title),
        description: typeof payload.description === "string" ? String(payload.description) : undefined,
        status: "todo",
        priority: typeof payload.priority === "string" ? String(payload.priority) : "medium",
        parentId: typeof payload.parent_id === "string" ? String(payload.parent_id) : undefined,
        projectId: typeof payload.project_id === "string" ? String(payload.project_id) : undefined,
      });

      await logActivity(ctx.db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "issue.created",
        entityType: "issue",
        entityId: created.id,
        details: { source: "qsl_orchestrator_bridge", title: created.title },
      });

      return {
        result_class: "PASS" as const,
        affected_ids: [created.id],
        evidence_summary: `Created task: ${created.title}`,
        data: { id: created.id, identifier: created.identifier, title: created.title },
      };
    }

    case "update-task": {
      const issueId = targetIds[0];
      if (!issueId) {
        return { result_class: "BLOCKED" as const, sanitized_error: "target_ids[0] required" };
      }
      const existing = await ctx.issueSvc.getById(issueId);
      if (!existing || existing.companyId !== companyId) {
        return { result_class: "BLOCKED" as const, sanitized_error: "Task not found in company scope" };
      }
      const updates: Record<string, unknown> = {};
      if (typeof payload.title === "string") updates.title = payload.title;
      if (typeof payload.description === "string") updates.description = payload.description;
      if (typeof payload.status === "string") updates.status = payload.status;
      if (typeof payload.priority === "string") updates.priority = payload.priority;
      if (Object.keys(updates).length === 0) {
        return { result_class: "BLOCKED" as const, sanitized_error: "No valid update fields in payload" };
      }
      const updated = await ctx.issueSvc.update(issueId, {
        ...updates,
        actorAgentId: actor.agentId ?? null,
        actorUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      return {
        result_class: "PASS" as const,
        affected_ids: [issueId],
        evidence_summary: `Updated task: ${updated?.title ?? issueId}`,
        data: { id: issueId, updated_fields: Object.keys(updates) },
      };
    }

    case "assign-task": {
      const issueId = targetIds[0];
      const agentId = typeof payload.assignee_agent_id === "string" ? payload.assignee_agent_id : undefined;
      if (!issueId || !agentId) {
        return {
          result_class: "BLOCKED" as const,
          sanitized_error: "target_ids[0] and payload.assignee_agent_id required",
        };
      }
      const existing = await ctx.issueSvc.getById(issueId);
      if (!existing || existing.companyId !== companyId) {
        return { result_class: "BLOCKED" as const, sanitized_error: "Task not found in company scope" };
      }
      const updated = await ctx.issueSvc.update(issueId, {
        assigneeAgentId: agentId,
        actorAgentId: actor.agentId ?? null,
        actorUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      return {
        result_class: "PASS" as const,
        affected_ids: [issueId],
        evidence_summary: `Assigned task ${issueId} to agent ${agentId}`,
        data: { id: issueId, assignee_agent_id: agentId },
      };
    }

    case "create-approval-request": {
      if (typeof payload.type !== "string" || !payload.type) {
        return { result_class: "BLOCKED" as const, sanitized_error: "payload.type is required" };
      }
      const approvalPayload =
        typeof payload.payload === "object" && payload.payload !== null
          ? (payload.payload as Record<string, unknown>)
          : {};
      const approval = await ctx.approvalSvc.create(companyId, {
        type: String(payload.type),
        payload: approvalPayload,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        status: "pending",
      });

      await logActivity(ctx.db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { source: "qsl_orchestrator_bridge", type: approval.type },
      });

      return {
        result_class: "PASS" as const,
        affected_ids: [approval.id],
        approval_required: true,
        approval_id: approval.id,
        evidence_summary: `Created approval request: ${approval.type}`,
        data: { id: approval.id, type: approval.type, status: approval.status },
      };
    }

    case "create-outbound-draft": {
      if (typeof payload.title !== "string" || !payload.title.trim()) {
        return { result_class: "BLOCKED" as const, sanitized_error: "payload.title is required" };
      }
      const draft = await ctx.issueSvc.create(companyId, {
        title: `[DRAFT] ${String(payload.title)}`,
        description: typeof payload.description === "string" ? String(payload.description) : undefined,
        status: "backlog",
        priority: "medium",
        workMode: "ask",
      });

      await logActivity(ctx.db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "issue.created",
        entityType: "issue",
        entityId: draft.id,
        details: { source: "qsl_orchestrator_bridge", kind: "outbound_draft" },
      });

      return {
        result_class: "PASS" as const,
        affected_ids: [draft.id],
        evidence_summary: `Created outbound draft: ${draft.title}`,
        data: { id: draft.id, identifier: draft.identifier, title: draft.title },
      };
    }

    case "record-mission-evidence": {
      const issueId = targetIds[0];
      const evidenceText = typeof payload.evidence === "string" ? payload.evidence : "";
      if (!issueId || !evidenceText) {
        return {
          result_class: "BLOCKED" as const,
          sanitized_error: "target_ids[0] and payload.evidence required",
        };
      }
      const issue = await ctx.issueSvc.getById(issueId);
      if (!issue || issue.companyId !== companyId) {
        return { result_class: "BLOCKED" as const, sanitized_error: "Issue not found in company scope" };
      }

      await logActivity(ctx.db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "mission.evidence_recorded",
        entityType: "issue",
        entityId: issueId,
        details: {
          source: "qsl_orchestrator_bridge",
          evidenceLength: evidenceText.length,
          issueTitle: issue.title,
        },
      });

      return {
        result_class: "PASS" as const,
        affected_ids: [issueId],
        evidence_summary: `Recorded evidence for ${issue.title} (${evidenceText.length} chars)`,
        data: { id: issueId, evidence_length: evidenceText.length },
      };
    }

    // ── Human-gated operations ────────────────────────────────────
    case "execute-approved-send":
    case "publish-approved-asset":
    case "accept-approved-commercial-commitment": {
      if (!ctx.authorityApprovalId) {
        return {
          result_class: "BLOCKED" as const,
          sanitized_error: "Human-gated operation requires authority_approval_id",
          approval_required: true,
        };
      }
      const approval = await ctx.approvalSvc.getById(ctx.authorityApprovalId);
      if (!approval || approval.companyId !== companyId) {
        return {
          result_class: "BLOCKED" as const,
          sanitized_error: "Approval not found in company scope",
        };
      }
      if (approval.status !== "approved") {
        return {
          result_class: "BLOCKED" as const,
          sanitized_error: `Approval is in state "${approval.status}", must be "approved"`,
          approval_required: true,
        };
      }

      await logActivity(ctx.db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: `mission.${operation}`,
        entityType: "approval",
        entityId: ctx.authorityApprovalId,
        details: {
          source: "qsl_orchestrator_bridge",
          operation,
          approvalType: approval.type,
        },
      });

      return {
        result_class: "PASS" as const,
        affected_ids: [ctx.authorityApprovalId],
        evidence_summary: `Executed human-gated operation: ${operation} (approval: ${ctx.authorityApprovalId})`,
        data: {
          operation,
          approval_id: ctx.authorityApprovalId,
          approval_status: approval.status,
        },
      };
    }

    default:
      return {
        result_class: "UNKNOWN" as const,
        sanitized_error: `Unhandled operation: ${operation}`,
      };
  }
}