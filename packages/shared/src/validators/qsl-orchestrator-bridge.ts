import { z } from "zod";
import { ORCHESTRATOR_BRIDGE_OPERATIONS } from "../types/qsl-orchestrator-bridge.js";

export const orchestratorBridgeRequestSchema = z.object({
  request_id: z.string().min(1).max(128),
  operation: z.enum(ORCHESTRATOR_BRIDGE_OPERATIONS),
  environment: z.literal("staging"),
  target_ids: z.array(z.string()).max(50).optional(),
  payload: z.record(z.unknown()).optional(),
  authority_approval_id: z.string().max(128).optional(),
  expected_terminal_state: z.string().max(128).optional(),
});

export type OrchestratorBridgeRequest = z.infer<typeof orchestratorBridgeRequestSchema>;