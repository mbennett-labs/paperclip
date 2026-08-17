import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routePath = fileURLToPath(
  new URL("../routes/operator-missions.ts", import.meta.url),
);

describe("QSL native Mission Control boundary", () => {
  it("does not delegate server orchestration back to the shell runner", () => {
    const source = readFileSync(routePath, "utf8");

    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("run-mission.sh");
    expect(source).not.toContain('spawn("bash"');
    expect(source).toContain("heartbeat.wakeup");
    expect(source).toContain("reconcileOperatorMission");
  });

  it("fails closed when the native reviewer wake is skipped or deferred", () => {
    const source = readFileSync(routePath, "utf8");

    expect(source).toContain("const reviewRun = await heartbeat.wakeup");
    expect(source).toContain("if (!reviewRun)");
    expect(source).toContain("operator_review_dispatch_not_queued");
    expect(source).toContain("reviewRunId = reviewRun.id");
  });

  it("withholds implementation dispatch for human-required authority", () => {
    const source = readFileSync(routePath, "utf8");
    const gateIndex = source.indexOf(
      'if (normalizedAuthorityScope === "human_required")',
    );
    const implementationWakeIndex = source.indexOf(
      "const run = await heartbeat.wakeup(plan.agentId",
    );

    expect(source).toContain(
      'error: "authorityScope must be autonomous or human_required"',
    );
    expect(source).toContain('dispatch: "withheld"');
    expect(source).toContain('terminalStatus: "human_approval_required"');
    expect(source).toContain('"operator_mission.authority_escalated"');
    expect(gateIndex).toBeGreaterThan(-1);
    expect(implementationWakeIndex).toBeGreaterThan(gateIndex);
  });
});
