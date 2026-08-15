import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issues,
  operatorMissions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { operatorMissionService } from "../services/operator-mission.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres operator mission tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("operator mission service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  let svc!: ReturnType<typeof operatorMissionService>;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-operator-mission-",
    );
    db = createDb(tempDb.connectionString);
    svc = operatorMissionService(db);

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      status: "active",
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(operatorMissions);
    await db.delete(issues);
  });

  afterAll(async () => {
    await db.delete(operatorMissions);
    await db.delete(issues);
    await db.delete(companies);
    await tempDb?.cleanup();
  });

  it("creates a mission with explicit mission_id binding", async () => {
    const missionId = `test-mission-${randomUUID().slice(0, 8)}`;
    const record = await svc.create({
      companyId,
      missionId,
      provider: "openrouter",
      model: "openrouter/deepseek/deepseek-chat",
    });

    expect(record).not.toBeNull();
    expect(record!.missionId).toBe(missionId);
    expect(record!.companyId).toBe(companyId);
    expect(record!.status).toBe("submitted");
    expect(record!.authorityScope).toBe("autonomous");
    expect(record!.provider).toBe("openrouter");
    expect(record!.model).toBe("openrouter/deepseek/deepseek-chat");
  });

  it("finds an existing mission_id within the same company", async () => {
    const missionId = `test-mission-${randomUUID().slice(0, 8)}`;
    await svc.create({ companyId, missionId });

    const duplicate = await svc.getByMissionId(companyId, missionId);
    expect(duplicate).not.toBeNull();
    expect(duplicate!.missionId).toBe(missionId);
  });

  it("binds to an existing issue when issueId is provided", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Operator mission test issue",
    });
    const missionId = `test-mission-${randomUUID().slice(0, 8)}`;

    const record = await svc.create({
      companyId,
      missionId,
      issueId,
    });

    expect(record!.issueId).toBe(issueId);
  });

  it("can create a mission without an issue (standalone)", async () => {
    const missionId = `test-mission-${randomUUID().slice(0, 8)}`;
    const record = await svc.create({
      companyId,
      missionId,
    });

    expect(record!.issueId).toBeNull();
  });

  it("transitions through mission statuses", async () => {
    const missionId = `test-mission-${randomUUID().slice(0, 8)}`;
    const record = await svc.create({ companyId, missionId });

    const preflighting = await svc.updateStatus(record!.id, "preflighting");
    expect(preflighting!.status).toBe("preflighting");

    const preflightPassed = await svc.updateStatus(
      record!.id,
      "preflight_passed",
      { initial_head: "abc123" },
    );
    expect(preflightPassed!.status).toBe("preflight_passed");
    expect(preflightPassed!.evidence).toEqual({ initial_head: "abc123" });

    const implemented = await svc.updateStatus(record!.id, "implemented");
    expect(implemented!.status).toBe("implemented");

    const verified = await svc.updateStatus(record!.id, "verification_passed", {
      tests: "passed",
    });
    expect(verified!.status).toBe("verification_passed");

    const reviewPassed = await svc.updateStatus(record!.id, "review_passed");
    expect(reviewPassed!.status).toBe("review_passed");

    const completed = await svc.updateStatus(record!.id, "completed");
    expect(completed!.status).toBe("completed");
  });

  it("generates a valid receipt from a completed mission", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Operator mission receipt issue",
    });
    const missionId = `test-mission-${randomUUID().slice(0, 8)}`;
    const record = await svc.create({
      companyId,
      missionId,
      issueId,
      provider: "openrouter",
      model: "openrouter/deepseek/deepseek-chat",
      credentialRefType: "secret_ref",
      initialHead: "abc123def456",
    });

    await svc.updateFields(record!.id, {
      finalHead: "def789abc123",
      changedFiles: ["server/src/services/operator-mission.ts"],
      reviewVerdict: "PASS",
      stagingPid: "12345",
      productionPidBefore: "9999",
      productionPidAfter: "9999",
      productionUntouched: "true",
      terminalStatus: "completed",
      evidence: { tests: "passed", typecheck: "passed", build: "passed" },
    });

    const updated = await svc.getById(record!.id);
    const receipt = svc.toReceipt(updated!);

    expect(receipt.mission_id).toBe(missionId);
    expect(receipt.issue_id).toBe(record!.issueId);
    expect(receipt.authorized_scope).toBe("autonomous");
    expect(receipt.provider).toBe("openrouter");
    expect(receipt.model).toBe("openrouter/deepseek/deepseek-chat");
    expect(receipt.credential_reference_type).toBe("secret_ref");
    expect(receipt.final_head).toBe("def789abc123");
    expect(receipt.changed_files).toEqual([
      "server/src/services/operator-mission.ts",
    ]);
    expect(receipt.review_verdict).toBe("PASS");
    expect(receipt.staging_pid).toBe("12345");
    expect(receipt.production_untouched).toBe("true");
    expect(receipt.terminal_status).toBe("completed");
    expect(receipt.run_ids).toEqual([]);
  });

  it("lists missions by company", async () => {
    const id1 = `test-mission-${randomUUID().slice(0, 8)}`;
    const id2 = `test-mission-${randomUUID().slice(0, 8)}`;

    await svc.create({ companyId, missionId: id1 });
    await svc.create({ companyId, missionId: id2 });

    const list = await svc.listByCompany(companyId, 10);
    expect(list.length).toBeGreaterThanOrEqual(2);

    const missionIds = list.map((m) => m.missionId);
    expect(missionIds).toContain(id1);
    expect(missionIds).toContain(id2);
  });

  it("allows updating evidence alongside status transition", async () => {
    const missionId = `test-mission-${randomUUID().slice(0, 8)}`;
    const record = await svc.create({ companyId, missionId });

    const updated = await svc.updateStatus(record!.id, "completed", {
      tests: "passed",
      review_verdict: "PASS",
      staging_pid: "12345",
    });

    expect(updated!.status).toBe("completed");
    expect(updated!.evidence).toEqual({
      tests: "passed",
      review_verdict: "PASS",
      staging_pid: "12345",
    });
  });
});