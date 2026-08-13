import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const operatorMissions = pgTable(
  "operator_missions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    issueId: uuid("issue_id")
      .references(() => issues.id, { onDelete: "set null" }),
    missionId: text("mission_id").notNull(),
    status: text("status").notNull().default("submitted"),
    authorityScope: text("authority_scope").notNull().default("autonomous"),
    provider: text("provider"),
    model: text("model"),
    credentialRefType: text("credential_ref_type"),
    initialHead: text("initial_head"),
    finalHead: text("final_head"),
    changedFiles: jsonb("changed_files").$type<string[]>(),
    reviewVerdict: text("review_verdict"),
    stagingPid: text("staging_pid"),
    productionPidBefore: text("production_pid_before"),
    productionPidAfter: text("production_pid_after"),
    productionUntouched: text("production_untouched"),
    retries: text("retries").default("0"),
    escalations: text("escalations").default("0"),
    costUsage: jsonb("cost_usage").$type<Record<string, unknown>>(),
    terminalStatus: text("terminal_status"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    implementRunId: uuid("implement_run_id")
      .references(() => heartbeatRuns.id, { onDelete: "set null" }),
    reviewRunId: uuid("review_run_id")
      .references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdByRunId: uuid("created_by_run_id")
      .references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyMissionIdIdx: index("operator_missions_company_mission_id_idx").on(
      table.companyId,
      table.missionId,
    ),
    companyStatusIdx: index("operator_missions_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    companyIssueIdIdx: index("operator_missions_company_issue_id_idx").on(
      table.companyId,
      table.issueId,
    ),
  }),
);