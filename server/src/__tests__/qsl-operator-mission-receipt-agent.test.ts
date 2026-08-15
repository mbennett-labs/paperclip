import { describe, expect, it } from "vitest";
import { operatorMissionAgentId } from "../services/operator-mission.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("QSL operator mission receipt agent identity", () => {
  it("prefers the reconciled native implementation run agent", () => {
    expect(
      operatorMissionAgentId({
        dispatch: { agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        nativeLifecycle: {
          implementationRun: { agentId: AGENT_ID, status: "running" },
        },
      }),
    ).toBe(AGENT_ID);
  });

  it("uses native dispatch evidence before lifecycle reconciliation", () => {
    expect(
      operatorMissionAgentId({
        dispatch: { agentId: AGENT_ID, status: "queued" },
      }),
    ).toBe(AGENT_ID);
  });

  it("fails closed to null when no trustworthy agent identity is recorded", () => {
    expect(operatorMissionAgentId({ dispatch: { status: "failed" } })).toBeNull();
    expect(operatorMissionAgentId(null)).toBeNull();
  });
});
