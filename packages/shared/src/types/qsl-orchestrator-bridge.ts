// QSL Orchestrator Bridge V1 — request/response schema for ChatGPT control-plane access.
//
// Issue #36: scoped ChatGPT orchestration bridge over the private Paperclip API.
// Transport: GitHub issue comments → self-hosted runner → localhost Paperclip API → sanitized result.

export const ORCHESTRATOR_BRIDGE_OPERATIONS = [
  // Read-only / routine
  "status",
  "list-missions",
  "get-mission",
  "list-tasks",
  "get-task",
  "list-approvals",
  "list-mail-triage",
  "get-mail-thread-summary",
  // Bounded writes
  "create-task",
  "update-task",
  "assign-task",
  "create-approval-request",
  "create-outbound-draft",
  "record-mission-evidence",
  // Human-gated execution only
  "execute-approved-send",
  "publish-approved-asset",
  "accept-approved-commercial-commitment",
] as const;

export type OrchestratorBridgeOperation = (typeof ORCHESTRATOR_BRIDGE_OPERATIONS)[number];

export const ORCHESTRATOR_BRIDGE_RESULT_CLASSES = [
  "PASS",
  "BLOCKED",
  "FAIL",
  "UNKNOWN",
] as const;

export type OrchestratorBridgeResultClass = (typeof ORCHESTRATOR_BRIDGE_RESULT_CLASSES)[number];

export interface OrchestratorBridgeRequest {
  request_id: string;
  operation: OrchestratorBridgeOperation;
  environment: "staging";
  target_ids?: string[];
  payload?: Record<string, unknown>;
  authority_approval_id?: string;
  expected_terminal_state?: string;
}

export interface OrchestratorBridgeResult {
  request_id: string;
  operation: OrchestratorBridgeOperation;
  result_class: OrchestratorBridgeResultClass;
  affected_ids?: string[];
  evidence_summary?: string;
  approval_required?: boolean;
  approval_id?: string;
  sanitized_error?: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export const READ_ONLY_OPERATIONS: readonly OrchestratorBridgeOperation[] = [
  "status",
  "list-missions",
  "get-mission",
  "list-tasks",
  "get-task",
  "list-approvals",
  "list-mail-triage",
  "get-mail-thread-summary",
];

export const BOUNDED_WRITE_OPERATIONS: readonly OrchestratorBridgeOperation[] = [
  "create-task",
  "update-task",
  "assign-task",
  "create-approval-request",
  "create-outbound-draft",
  "record-mission-evidence",
];

export const HUMAN_GATED_OPERATIONS: readonly OrchestratorBridgeOperation[] = [
  "execute-approved-send",
  "publish-approved-asset",
  "accept-approved-commercial-commitment",
];

export const PROHIBITED_OPERATION_PATTERNS: readonly string[] = [
  "shell",
  "exec",
  "sql",
  "credential",
  "secret",
  "deploy",
  "restart",
  "production",
  "destructive",
  "migrate",
  "drop",
];

export function isProhibitedOperation(operation: string): boolean {
  const lower = operation.toLowerCase();
  return PROHIBITED_OPERATION_PATTERNS.some((p) => lower.includes(p));
}