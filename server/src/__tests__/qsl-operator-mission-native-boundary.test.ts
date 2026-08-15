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
});
