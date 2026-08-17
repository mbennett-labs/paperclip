-- QSL staging precondition proved 0 duplicate (company_id, mission_id) pairs on 2026-08-16.
-- Create enforcement first, then remove the redundant non-unique index in the same migration transaction.
CREATE UNIQUE INDEX IF NOT EXISTS "operator_missions_company_mission_id_uq"
  ON "operator_missions" USING btree ("company_id","mission_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "operator_missions_company_mission_id_idx";
