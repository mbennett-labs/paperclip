import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Operator Authority Policy", () => {
  const policyPath = path.resolve(
    __dirname,
    "../../../packages/shared/src/operator/authority-policy.json",
  );

  function loadPolicy() {
    const raw = fs.readFileSync(policyPath, "utf8");
    return JSON.parse(raw);
  }

  it("policy file is valid JSON and version 1", () => {
    const policy = loadPolicy();
    expect(policy.version).toBe(1);
    expect(policy.description).toBeTypeOf("string");
    expect(policy.description.length).toBeGreaterThan(0);
  });

  it("defines the three enforcement buckets and explicit audit markers", () => {
    const policy = loadPolicy();
    expect(policy.preauthorized).toBeInstanceOf(Array);
    expect(policy.human_approval_required).toBeInstanceOf(Array);
    expect(policy.prohibited).toBeInstanceOf(Array);

    const auditedAutonomous = policy.preauthorized.filter(
      (action: { audit?: boolean }) => action.audit === true,
    );
    expect(auditedAutonomous.length).toBeGreaterThan(0);
  });

  it("each action has required fields", () => {
    const policy = loadPolicy();
    for (const category of [
      "preauthorized",
      "human_approval_required",
      "prohibited",
    ]) {
      for (const action of policy[category]) {
        expect(action.action).toBeTypeOf("string");
        expect(action.action.length).toBeGreaterThan(0);
        expect(action.class).toBeTypeOf("string");
        expect(action.description).toBeTypeOf("string");
        expect(action.examples).toBeInstanceOf(Array);
        expect(action.examples.length).toBeGreaterThan(0);
      }
    }
  });

  it("no action appears in multiple enforcement buckets", () => {
    const policy = loadPolicy();
    const allActions = new Map<string, string>();
    const categories = [
      "preauthorized",
      "human_approval_required",
      "prohibited",
    ] as const;

    for (const cat of categories) {
      for (const action of policy[cat]) {
        if (allActions.has(action.action)) {
          throw new Error(
            `Action "${action.action}" appears in both "${allActions.get(action.action)}" and "${cat}"`,
          );
        }
        allActions.set(action.action, cat);
      }
    }
  });

  it("prohibited actions match expected invariant categories", () => {
    const policy = loadPolicy();
    const prohibitedActions = policy.prohibited.map((a: { action: string }) => a.action);

    expect(prohibitedActions).toContain("governance:bypass");
    expect(prohibitedActions).toContain("credentials:expose_raw");
    expect(prohibitedActions).toContain("containment:disable");
    expect(prohibitedActions).toContain("provider:silent_substitution");
    expect(prohibitedActions).toContain("production:fallback_from_staging");
    expect(prohibitedActions).toContain("mission:scope_expansion");
  });

  it("human-gated actions include production, secrets, and security boundaries", () => {
    const policy = loadPolicy();
    const gatedActions = policy.human_approval_required.map(
      (a: { action: string }) => a.action,
    );

    expect(gatedActions).toContain("production:any_modification");
    expect(gatedActions).toContain("secrets:create_change_expose");
    expect(gatedActions).toContain("security:change_boundaries");
    expect(gatedActions).toContain("external:publish_message");
    expect(gatedActions).toContain("financial:transaction");
  });

  it("autonomous actions include safe engineering operations", () => {
    const policy = loadPolicy();
    const autonomousActions = policy.preauthorized.map(
      (a: { action: string }) => a.action,
    );

    expect(autonomousActions).toContain("repo:read_source");
    expect(autonomousActions).toContain("repo:grep_search");
    expect(autonomousActions).toContain("git:status_log_diff");
    expect(autonomousActions).toContain("git:create_branch");
    expect(autonomousActions).toContain("repo:edit_files");
    expect(autonomousActions).toContain("test:run_unit_integration");
    expect(autonomousActions).toContain("build:typecheck");
    expect(autonomousActions).toContain("git:commit");
    expect(autonomousActions).toContain("staging:inspect_logs");
    expect(autonomousActions).toContain("staging:restart");
    expect(autonomousActions).toContain("staging:health_check");
    expect(autonomousActions).toContain("evidence:collect");
    expect(autonomousActions).toContain("workspace:cleanup_temp");
  });

  it("audited autonomous actions are explicitly marked", () => {
    const policy = loadPolicy();
    const audited = policy.preauthorized
      .filter((a: { audit?: boolean }) => a.audit === true)
      .map((a: { action: string }) => a.action);

    expect(audited).toContain("repo:read_source");
    expect(audited).toContain("test:run_unit_integration");
    expect(audited).toContain("build:typecheck");
    expect(audited).toContain("git:commit");
    expect(audited).toContain("staging:restart");
    expect(audited).toContain("evidence:collect");
  });

  it("git:push requires human approval", () => {
    const policy = loadPolicy();
    const gatedActions = policy.human_approval_required.map(
      (a: { action: string }) => a.action,
    );
    expect(gatedActions).toContain("git:push");
  });
});