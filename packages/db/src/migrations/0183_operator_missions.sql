CREATE TABLE IF NOT EXISTS "operator_missions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "mission_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'submitted',
  "authority_scope" text NOT NULL DEFAULT 'autonomous',
  "provider" text,
  "model" text,
  "credential_ref_type" text,
  "initial_head" text,
  "final_head" text,
  "changed_files" jsonb,
  "review_verdict" text,
  "staging_pid" text,
  "production_pid_before" text,
  "production_pid_after" text,
  "production_untouched" text,
  "retries" text DEFAULT '0',
  "escalations" text DEFAULT '0',
  "cost_usage" jsonb,
  "terminal_status" text,
  "evidence" jsonb,
  "implement_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL,
  "review_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL,
  "created_by_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operator_missions_company_mission_id_idx"
  ON "operator_missions" USING btree ("company_id","mission_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operator_missions_company_status_idx"
  ON "operator_missions" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operator_missions_company_issue_id_idx"
  ON "operator_missions" USING btree ("company_id","issue_id");