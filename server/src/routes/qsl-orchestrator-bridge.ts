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
  orchestratorBridgeRequestSchema,
  type OrchestratorBridgeOperation,
} from "@paperclipai/shared";

const MAX_TARGET_IDS = 50;
const MAX_PAYLOAD_KEYS = 20;
const MAX_PAYLOAD_VALUE_LENGTH = 10_000;
const MAX_EVIDENCE_TEXT_LENGTH = 50_000;

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

    const parsed = orchestratorBridgeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => i.path.join(".") + " " + i.message).join("; ").slice(0, 500);
      res.status(400).json({
        error: "Invalid bridge request",
        result_class: "BLOCKED",
        sanitized_error: "Request validation failed: " + issues,
      });
      return;
    }

    const { operation, target_ids, payload, authority_approval_id, environment, request_id } =
      parsed.data;

    if (environment !== "staging") {
      res.status(403).json({
        error: "Only staging environment is allowed",
        result_class: "BLOCKED",
        sanitized_error: `Environment must be "staging", got "${environment}"`,
      });
      return;
    }

    if (isProhibitedOperation(operation)) {
      res.status(403).json({
        error: "Prohibited operation class",
        result_class: "BLOCKED",
        request_id,
        sanitized_error: `Operation "${operation}" matches a prohibited pattern`,
      });
      return;
    }

    if (!(ALL_BRIDGE_OPERATIONS as readonly string[]).includes(operation)) {
      res.status(400).json({
        error: "Unknown operation",
        result_class: "BLOCKED",
        request_id,
        sanitized_error: `Unknown operation: ${operation}`,
      });
      return;
    }

    // Bounded-write operations are NOT live-capable until durable server-side
    // idempotency/receipts exist. Fail closed unless the operator has explicitly
    // enabled the provisional path (proof-of-life only). This prevents duplicate
    // mutation when execution succeeds but the runner fails before persisting
    // its client-side ledger.
    if (
      (BOUNDED_WRITE_OPERATIONS as readonly string[]).includes(operation) &&
      process.env.PAPERCLIP_BRIDGE_ENABLE_BOUNDED_WRITES !== "true"
    ) {
      res.status(403).json({
        error: "Bounded-write operations are not live-capable",
        result_class: "BLOCKED",
        request_id,
        sanitized_error:
          "server_side_idempotency_not_implemented: bounded-write bridge operations are disabled until durable server-side request receipts exist",
      });
      return;
    }

    if (target_ids && target_ids.length > MAX_TARGET_IDS) {
      res.status(400).json({
        error: "Too many target_ids",
        result_class: "BLOCKED",
        sanitized_error: `target_ids limit is ${MAX_TARGET_IDS}, got ${target_ids.length}`,
      });
      return;
    }

    if (payload) {
      const keys = Object.keys(payload);
      if (keys.length > MAX_PAYLOAD_KEYS) {
        res.status(400).json({
          error: "Too many payload keys",
          result_class: "BLOCKED",
          sanitized_error: `Payload key limit is ${MAX_PAYLOAD_KEYS}, got ${keys.length}`,
        });
        return;
      }
      for (const key of keys) {
        const val = payload[key];
        if (typeof val === "string" && val.length > MAX_PAYLOAD_VALUE_LENGTH) {
          res.status(400).json({
            error: "Payload value too long",
            result_class: "BLOCKED",
            sanitized_error: `Payload key "${key}" exceeds max length ${MAX_PAYLOAD_VALUE_LENGTH}`,
          });
          return;
        }
      }
    }

    if (authority_approval_id && authority_approval_id.length > 128) {
      res.status(400).json({
        error: "authority_approval_id too long",
        result_class: "BLOCKED",
        sanitized_error: "authority_approval_id exceeds max length",
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
        payload: (payload as Record<string, unknown>) ?? {},
        authorityApprovalId: authority_approval_id ?? undefined,
        actor,
        issueSvc,
        approvalSvc,
        operatorMissionSvc,
        missionSvc,
      });

      res.json({ ...result, request_id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        result_class: "FAIL",
        request_id,
        sanitized_error: sanitizeErrorMessage(message),
      });
    }
  });

  return router;
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/(eyJ|sk-|api_key|password|secret|token|credential)[\w\-]{20,}/gi, "[REDACTED]")
    .replace(/-----BEGIN[\s\S]*?-----END[\s\S]*?-----/gi, "[REDACTED]")
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

  switch (operation) {
    // ── Read-only operations ──────────────────────────────────────
    case "status": {
      const issues = await ctx.issueSvc.list(companyId, { limit: 5 });
      return {
        result_class: "PASS" as const,
        evidence_summary: `Status resolved. Recent issues: ${issues.length}.`,
        data: {
          company_id: companyId,
          recent_issue_count: issues.length,
          recent_issue_ids: issues.map((i) => i.id),
        },
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
          missions: issues.slice(0, 50).map((i) => ({
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
      return {
        result_class: "PASS" as const,
        evidence_summary: `Resolved mission: ${issue.title}`,
        data: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          priority: issue.priority,
          description: issue.description?.slice(0, 500),
          assignee_agent_id: issue.assigneeAgentId,
          parent_id: issue.parentId,
          project_id: issue.projectId,
          mission_view: missionView ? {
            state: missionView.state,
            total_tasks: missionView.progress?.totalTasks,
            completed_tasks: missionView.progress?.completedTasks,
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
          tasks: issues.slice(0, 50).map((i) => ({
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
        originKind: "plugin:qsl.email:intake",
        limit: 50,
      });
      return {
        result_class: "PASS" as const,
        evidence_summary: `Found ${issues.length} email intake issues.`,
        data: {
          intake_items: issues.slice(0, 50).map((i) => ({
            id: i.id,
            identifier: i.identifier,
            title: i.title,
            status: i.status,
            priority: i.priority,
            origin_kind: i.originKind,
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

      const comments = await ctx.issueSvc.listComments(issueId, { limit: 10 }).catch(() => []);
      return {
        result_class: "PASS" as const,
        evidence_summary: `Resolved mail thread summary for: ${issue.title}`,
        data: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          origin_kind: issue.originKind,
          description_summary: issue.description?.slice(0, 500),
          comment_count: comments.length,
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
        title: String(payload.title).slice(0, 500),
        description: typeof payload.description === "string" ? String(payload.description).slice(0, 10000) : undefined,
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
      if (typeof payload.title === "string") updates.title = String(payload.title).slice(0, 500);
      if (typeof payload.description === "string") updates.description = String(payload.description).slice(0, 10000);
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
        title: `[DRAFT] ${String(payload.title).slice(0, 500)}`,
        description: typeof payload.description === "string"
          ? String(payload.description).slice(0, 10000)
          : undefined,
        status: "backlog",
        priority: "medium",
        workMode: "ask",
        originKind: "plugin:qsl.email:intake",
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
        evidence_summary: `Created outbound draft: ${draft.title} (intake pipeline)`,
        data: {
          id: draft.id,
          identifier: draft.identifier,
          title: draft.title,
          origin_kind: draft.originKind,
          note: "Draft created in email intake pipeline. Human Board review required before any send.",
        },
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

      const truncatedEvidence = evidenceText.slice(0, MAX_EVIDENCE_TEXT_LENGTH);

      const bodyText = `[Orchestrator Bridge Evidence]\n\n${truncatedEvidence}`;

      const comment = await ctx.issueSvc.addComment(issueId, bodyText, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
      });

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
          commentId: comment.id,
          evidenceLength: truncatedEvidence.length,
        },
      });

      return {
        result_class: "PASS" as const,
        affected_ids: [issueId, comment.id],
        evidence_summary: `Recorded evidence for ${issue.title} (${truncatedEvidence.length} chars, comment: ${comment.id})`,
        data: { issue_id: issueId, comment_id: comment.id, evidence_length: truncatedEvidence.length },
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

      return {
        result_class: "BLOCKED" as const,
        sanitized_error: `Operation "${operation}" is human-gated. Approval ${ctx.authorityApprovalId} is valid (status: approved) but the execution adapter is not implemented in V1. Deferred to future work.`,
        approval_required: false,
        data: {
          operation,
          approval_id: ctx.authorityApprovalId,
          approval_status: approval.status,
          reason: "execution_adapter_not_implemented",
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