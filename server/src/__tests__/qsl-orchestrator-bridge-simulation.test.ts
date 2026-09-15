import { describe, expect, it } from "vitest";
import { orchestratorBridgeRequestSchema } from "@paperclipai/shared";

describe("QSL Orchestrator Bridge — schema-level simulation", () => {
  function simulateBridgeCall(request: Record<string, unknown>) {
    const parsed = orchestratorBridgeRequestSchema.safeParse(request);
    if (!parsed.success) {
      return {
        result_class: "BLOCKED",
        sanitized_error: "Validation failed: " + parsed.error.issues[0]?.message,
      };
    }

    const { operation, environment } = parsed.data;

    if (environment !== "staging") {
      return { result_class: "BLOCKED", sanitized_error: "Only staging allowed" };
    }

    return {
      result_class: "PASS",
      evidence_summary: `Simulated ${operation} operation.`,
      data: { operation, environment },
    };
  }

  it("PASS: valid status read through bridge", () => {
    const result = simulateBridgeCall({
      request_id: "e2e-status-001",
      operation: "status",
      environment: "staging",
    });
    expect(result.result_class).toBe("PASS");
  });

  it("PASS: valid list-tasks read through bridge", () => {
    const result = simulateBridgeCall({
      request_id: "e2e-list-tasks-001",
      operation: "list-tasks",
      environment: "staging",
      payload: { status: "in_progress" },
    });
    expect(result.result_class).toBe("PASS");
  });

  it("BLOCKED: production environment rejected", () => {
    const result = simulateBridgeCall({
      request_id: "e2e-prod",
      operation: "status",
      environment: "production",
    });
    expect(result.result_class).toBe("BLOCKED");
    expect(result.sanitized_error).toContain("staging");
  });

  it("BLOCKED: invalid operation rejected by validator", () => {
    const result = simulateBridgeCall({
      request_id: "e2e-invalid",
      operation: "rm -rf /",
      environment: "staging",
    });
    expect(result.result_class).toBe("BLOCKED");
  });

  it("PASS at schema level: human-gated op schema-accepted (server blocks)", () => {
    const result = simulateBridgeCall({
      request_id: "e2e-send",
      operation: "execute-approved-send",
      environment: "staging",
    });
    // Schema accepts it; the server route blocks it without authority_approval_id
    expect(result.result_class).toBe("PASS");
  });

  it("BLOCKED: empty request_id rejected", () => {
    const result = simulateBridgeCall({
      request_id: "",
      operation: "status",
      environment: "staging",
    });
    expect(result.result_class).toBe("BLOCKED");
  });

  it("BLOCKED: missing operation rejected", () => {
    const result = simulateBridgeCall({
      request_id: "e2e-missing",
      environment: "staging",
    });
    expect(result.result_class).toBe("BLOCKED");
  });

  it("PASS: bounded write create-task validated", () => {
    const result = simulateBridgeCall({
      request_id: "e2e-create-task-001",
      operation: "create-task",
      environment: "staging",
      payload: { title: "Audit Gumroad revenue channel" },
      target_ids: [],
    });
    expect(result.result_class).toBe("PASS");
  });

  it("PASS: approval request validated", () => {
    const result = simulateBridgeCall({
      request_id: "e2e-approval-001",
      operation: "create-approval-request",
      environment: "staging",
      authority_approval_id: "approval-uuid-here",
      payload: { type: "request_board_approval" },
    });
    expect(result.result_class).toBe("PASS");
  });

  it("roundtrip: request serialized/deserialized correctly", () => {
    const original = {
      request_id: "e2e-roundtrip-001",
      operation: "status" as const,
      environment: "staging" as const,
      target_ids: ["task-1", "task-2"],
      payload: { key: "value" },
    };
    const json = JSON.stringify(original);
    const parsed = JSON.parse(json);
    const validated = orchestratorBridgeRequestSchema.parse(parsed);
    expect(validated.operation).toBe("status");
    expect(validated.environment).toBe("staging");
    expect(validated.target_ids).toEqual(["task-1", "task-2"]);
  });
});