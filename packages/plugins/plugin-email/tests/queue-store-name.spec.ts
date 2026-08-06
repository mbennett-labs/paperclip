import { describe, expect, it } from "vitest";
import { resolveQueueStoreName } from "../src/worker.js";

function the4Evidence() {
  return {
    evidenceId: "ev-2faac983e2091d3656de29cb4d8d77584ab6d7dd",
    storeIntake: {
      recordType: "store_intake",
      sourceType: "store_submission",
      sourceForm: "thebinmap_submit",
      originalValues: {
        storeName: "The Flying Hog - Springdale",
        address: "1410 S Thompson St",
        city: "Springdale",
        state: "Arkansas",
        submitterEmail: "submitter@example.com",
        restockDays: "Schedule  : Bin prices are Friday $6, Saturday $5, Sunday $2 Monday $1",
      },
      normalizedValues: {
        storeName: "The Flying Hog - Springdale",
        address: "1410 S Thompson St",
        city: "Springdale",
        state: "Arkansas",
        submitterEmail: "submitter@example.com",
        restockDays: "Schedule  : Bin prices are Friday $6, Saturday $5, Sunday $2 Monday $1",
        storeType: "bin-store",
      },
    },
    sourceDetection: {
      sourceType: "store_submission",
      sourceForm: "thebinmap_submit",
    },
  } as unknown as Record<string, unknown>;
}

describe("resolveQueueStoreName", () => {
  it("returns the store name from THE-4-shaped evidence", () => {
    expect(resolveQueueStoreName(the4Evidence())).toBe("The Flying Hog - Springdale");
  });

  it("returns null when evidence is null", () => {
    expect(resolveQueueStoreName(null)).toBeNull();
  });

  it("returns null when storeIntake is null", () => {
    const ev = {
      storeIntake: null,
      sourceDetection: { sourceType: "unknown", sourceForm: "unknown" },
    } as unknown as Record<string, unknown>;
    expect(resolveQueueStoreName(ev)).toBeNull();
  });

  it("returns null when evidence has no storeIntake property", () => {
    const ev = {
      sourceDetection: { sourceType: "unknown", sourceForm: "unknown" },
    } as unknown as Record<string, unknown>;
    expect(resolveQueueStoreName(ev)).toBeNull();
  });

  it("returns null when storeIntake has no originalValues or normalizedValues with storeName", () => {
    const ev = {
      storeIntake: { originalValues: {}, normalizedValues: {} },
    } as unknown as Record<string, unknown>;
    expect(resolveQueueStoreName(ev)).toBeNull();
  });

  it("prefers normalizedValues.storeName over originalValues.storeName", () => {
    const ev = {
      storeIntake: {
        originalValues: { storeName: "Raw Name" },
        normalizedValues: { storeName: "Clean Name" },
      },
    } as unknown as Record<string, unknown>;
    expect(resolveQueueStoreName(ev)).toBe("Clean Name");
  });

  it("falls back to originalValues.storeName when normalizedValues lacks storeName", () => {
    const ev = {
      storeIntake: {
        originalValues: { storeName: "Fallback Name" },
        normalizedValues: { city: "Somewhere" },
      },
    } as unknown as Record<string, unknown>;
    expect(resolveQueueStoreName(ev)).toBe("Fallback Name");
  });

  it("does not mutate unrelated queue fields", () => {
    const sourceDetection = { sourceType: "store_submission", sourceForm: "thebinmap_submit" };
    const ev = the4Evidence();
    expect((ev.sourceDetection as Record<string, string>).sourceType).toBe("store_submission");
    expect((ev.sourceDetection as Record<string, string>).sourceForm).toBe("thebinmap_submit");
  });
});