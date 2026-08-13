export const OPERATOR_MISSION_STATUSES = [
  "submitted",
  "preflighting",
  "preflight_passed",
  "preflight_failed",
  "implementing",
  "implemented",
  "verifying",
  "verification_passed",
  "verification_failed",
  "reviewing",
  "review_passed",
  "review_failed",
  "review_escalated",
  "deploying",
  "deploy_succeeded",
  "deploy_failed",
  "isolating_production",
  "production_proof_success",
  "production_proof_failed",
  "finalizing",
  "completed",
  "completed_with_escalations",
  "failed",
  "escalated",
] as const;

export type OperatorMissionStatus = (typeof OPERATOR_MISSION_STATUSES)[number];

export const OPERATOR_AUTHORITY_SCOPES = [
  "autonomous",
  "human_required",
] as const;

export type OperatorAuthorityScope =
  (typeof OPERATOR_AUTHORITY_SCOPES)[number];

export interface MissionReceipt {
  mission_id: string;
  issue_id: string | null;
  agent_id: string | null;
  run_ids: string[];
  authorized_scope: string;
  provider: string | null;
  model: string | null;
  credential_reference_type: string | null;
  start_time: string;
  end_time: string;
  initial_head: string | null;
  final_head: string | null;
  changed_files: string[];
  tests: string | null;
  review_verdict: string | null;
  staging_deployment: string | null;
  staging_pid: string | null;
  production_pid_before: string | null;
  production_pid_after: string | null;
  production_untouched: string | null;
  retries: string;
  escalations: string;
  cost_usage: Record<string, unknown> | null;
  terminal_status: string;
}

export type OperatorActionClass =
  | "autonomous"
  | "audit"
  | "human_required"
  | "prohibited";

export interface OperatorActionRule {
  action: string;
  class: OperatorActionClass;
  description: string;
  examples: string[];
  audit?: boolean;
}

export interface OperatorAuthorityPolicy {
  version: 1;
  description: string;
  preauthorized: OperatorActionRule[];
  human_approval_required: OperatorActionRule[];
  prohibited: OperatorActionRule[];
}