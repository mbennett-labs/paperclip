import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_BRIDGE_OPERATIONS,
  READ_ONLY_OPERATIONS,
  BOUNDED_WRITE_OPERATIONS,
  HUMAN_GATED_OPERATIONS,
  isProhibitedOperation,
  type OrchestratorBridgeOperation,
} from "@paperclipai/shared";

const routePath = fileURLToPath(
  new URL("../routes/qsl-orchestrator-bridge.ts", import.meta.url),
);

const sharedTypesPath = fileURLToPath(
  new URL("../../../packages/shared/src/types/qsl-orchestrator-bridge.ts", import.meta.url),
);

describe("QSL Orchestrator Bridge — shared types", () => {
  it("exports all expected operation categories", () => {
    expect(READ_ONLY_OPERATIONS.length).toBeGreaterThanOrEqual(8);
    expect(BOUNDED_WRITE_OPERATIONS.length).toBeGreaterThanOrEqual(6);
    expect(HUMAN_GATED_OPERATIONS.length).toBeGreaterThanOrEqual(3);

    const allOps = ORCHESTRATOR_BRIDGE_OPERATIONS as readonly string[];
    for (const op of READ_ONLY_OPERATIONS) {
      expect(allOps).toContain(op);
    }
    for (const op of BOUNDED_WRITE_OPERATIONS) {
      expect(allOps).toContain(op);
    }
    for (const op of HUMAN_GATED_OPERATIONS) {
      expect(allOps).toContain(op);
    }
  });

  it("rejects prohibited operation patterns", () => {
    expect(isProhibitedOperation("exec-shell")).toBe(true);
    expect(isProhibitedOperation("run-sql")).toBe(true);
    expect(isProhibitedOperation("read-credential")).toBe(true);
    expect(isProhibitedOperation("deploy-production")).toBe(true);
    expect(isProhibitedOperation("restart-service")).toBe(true);
    expect(isProhibitedOperation("production-deploy")).toBe(true);
    expect(isProhibitedOperation("destructive-drop")).toBe(true);
    expect(isProhibitedOperation("migrate-db")).toBe(true);
  });

  it("allows valid bridge operations", () => {
    expect(isProhibitedOperation("status")).toBe(false);
    expect(isProhibitedOperation("list-missions")).toBe(false);
    expect(isProhibitedOperation("create-task")).toBe(false);
    expect(isProhibitedOperation("list-approvals")).toBe(false);
  });
});

describe("QSL Orchestrator Bridge — route invariants", () => {
  it("does not use shell orchestration", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain('exec(');
    expect(source).not.toContain('spawn(');
  });

  it("does not export environment secrets", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).not.toMatch(/process\.env\.(OPENAI|ANTHROPIC|API_KEY)/);
  });

  it("enforces company boundary on all operations", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain("assertCompanyAccess(req, companyId)");
    expect(source).toContain("issue.companyId !== companyId");
    expect(source).toContain("company scope");
  });

  it("sanitizes error messages before returning", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain("sanitizeErrorMessage");
    expect(source).toContain("[REDACTED]");
  });

  it("blocks prohibited operation classes", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain("isProhibitedOperation(operation)");
    expect(source).toContain("Prohibited operation class");
  });

  it("validates operation against allowlist", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain("ALL_BRIDGE_OPERATIONS");
    expect(source).toContain("Unknown operation");
  });

  it("requires company scope for all mutations", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain("assertCompanyAccess(req, companyId)");
  });
});

describe("QSL Orchestrator Bridge — operation categories", () => {
  it("has all required read-only operations", () => {
    const ro = READ_ONLY_OPERATIONS as readonly string[];
    expect(ro).toContain("status");
    expect(ro).toContain("list-missions");
    expect(ro).toContain("get-mission");
    expect(ro).toContain("list-tasks");
    expect(ro).toContain("get-task");
    expect(ro).toContain("list-approvals");
    expect(ro).toContain("list-mail-triage");
    expect(ro).toContain("get-mail-thread-summary");
  });

  it("has all required bounded write operations", () => {
    const bw = BOUNDED_WRITE_OPERATIONS as readonly string[];
    expect(bw).toContain("create-task");
    expect(bw).toContain("update-task");
    expect(bw).toContain("assign-task");
    expect(bw).toContain("create-approval-request");
    expect(bw).toContain("create-outbound-draft");
    expect(bw).toContain("record-mission-evidence");
  });

  it("has all required human-gated operations", () => {
    const hg = HUMAN_GATED_OPERATIONS as readonly string[];
    expect(hg).toContain("execute-approved-send");
    expect(hg).toContain("publish-approved-asset");
    expect(hg).toContain("accept-approved-commercial-commitment");
  });
});

describe("QSL Orchestrator Bridge — human-gated operations", () => {
  it("blocks human-gated operations without approval id", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain("requires authority_approval_id");
    expect(source).toContain("ctx.authorityApprovalId");
  });

  it("validates approval status before execution", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain("approval.status !== \"approved\"");
    expect(source).toContain("must be \"approved\"");
  });

  it("logs activity for human-gated operations", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain("mission.${operation}");
    expect(source).toContain("logActivity");
  });
});

describe("QSL Orchestrator Bridge — response schema", () => {
  it("produces PASS results with evidence", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain('"PASS"');
    expect(source).toContain("evidence_summary");
  });

  it("produces BLOCKED results for denied operations", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain('"BLOCKED"');
  });

  it("produces FAIL results for errors", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain('"FAIL"');
  });

  it("produces UNKNOWN results for unhandled operations", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain('"UNKNOWN"');
  });
});