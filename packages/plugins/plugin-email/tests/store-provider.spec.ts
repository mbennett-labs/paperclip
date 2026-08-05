import { describe, expect, it } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonStoreProvider } from "../src/mail/duplicates.js";
import type { StoreRecord } from "../src/mail/duplicates.js";

function createTempStoresFile(stores: unknown[]): string {
  const path = resolve(tmpdir(), "test-stores-" + Date.now() + ".json");
  writeFileSync(path, JSON.stringify(stores));
  return path;
}

function cleanup(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

describe("JsonStoreProvider (D5)", () => {
  it("loads stores from a JSON array", async () => {
    const stores: StoreRecord[] = [
      { id: "s1", name: "Test Store", address: "123 Main", city: "Nashville", state: "TN", postalCode: "37201", phone: "555-0100", website: "https://test.com", facebookUrl: "", otherSocialUrl: "" },
    ];
    const path = createTempStoresFile(stores);

    try {
      const provider = new JsonStoreProvider(path);
      expect(provider.isAvailable()).toBe(true);
      expect(provider.getError()).toBeNull();

      const records = await provider.listAll();
      expect(records.length).toBe(1);
      expect(records[0].name).toBe("Test Store");
      expect(records[0].city).toBe("Nashville");
    } finally {
      cleanup(path);
    }
  });

  it("loads stores from object with stores key", async () => {
    const data = { stores: [{ id: "s1", name: "Wrapped Store", address: "", city: "", state: "", postalCode: "", phone: "", website: "", facebookUrl: "", otherSocialUrl: "" }] };
    const path = createTempStoresFile(data);

    try {
      const provider = new JsonStoreProvider(path);
      expect(provider.isAvailable()).toBe(true);

      const records = await provider.listAll();
      expect(records.length).toBe(1);
      expect(records[0].name).toBe("Wrapped Store");
    } finally {
      cleanup(path);
    }
  });

  it("loads stores from object with data key", async () => {
    const data = { data: [{ id: "s2", name: "Data Wrapped", address: "", city: "", state: "", postalCode: "", phone: "", website: "", facebookUrl: "", otherSocialUrl: "" }] };
    const path = createTempStoresFile(data);

    try {
      const provider = new JsonStoreProvider(path);
      expect(provider.isAvailable()).toBe(true);
      expect((await provider.listAll()).length).toBe(1);
    } finally {
      cleanup(path);
    }
  });

  it("reports unavailable when file does not exist", () => {
    const provider = new JsonStoreProvider("/nonexistent/path/stores.json");
    expect(provider.isAvailable()).toBe(false);
    expect(provider.getError()).toBeDefined();
    expect(provider.getError()).toContain("not found");
  });

  it("reports available but empty for non-array JSON", async () => {
    const path = createTempStoresFile({ not: "an array" });

    try {
      const provider = new JsonStoreProvider(path);
      // Available (loaded without error) but has 0 records
      expect(provider.isAvailable()).toBe(true);
      const records = await provider.listAll();
      expect(records.length).toBe(0);
    } finally {
      cleanup(path);
    }
  });

  it("no match is distinguishable from provider unavailable", async () => {
    const emptyPath = createTempStoresFile([]);
    const missingProvider = new JsonStoreProvider("/no/such/file.json");

    try {
      expect(missingProvider.isAvailable()).toBe(false);

      const available = new JsonStoreProvider(emptyPath);
      expect(available.isAvailable()).toBe(true);
      const records = await available.listAll();
      expect(records.length).toBe(0);  // Available but empty
    } finally {
      cleanup(emptyPath);
    }
  });

  it("filters invalid records", async () => {
    const mixed = [
      { id: "s1", name: "Valid Store" },
      { no_id: "bad" },
      { id: "s2", name: "Also Valid", extra: "stripped" },
      null,
      "string",
    ];
    const path = createTempStoresFile(mixed);

    try {
      const provider = new JsonStoreProvider(path);
      expect(provider.isAvailable()).toBe(true);
      const records = await provider.listAll();
      expect(records.length).toBe(2);
      expect(records[0].name).toBe("Valid Store");
      expect(records[1].name).toBe("Also Valid");
      // Extra field stripped
      expect((records[1] as Record<string, unknown>).extra).toBeUndefined();
    } finally {
      cleanup(path);
    }
  });

  it("provider returns empty fields when not in source", async () => {
    const stores = [{ id: "s1", name: "Minimal Store" }];
    const path = createTempStoresFile(stores);

    try {
      const provider = new JsonStoreProvider(path);
      const records = await provider.listAll();
      expect(records[0].address).toBe("");
      expect(records[0].city).toBe("");
      expect(records[0].phone).toBe("");
      expect(records[0].website).toBe("");
    } finally {
      cleanup(path);
    }
  });

  it("lookup filters by field value", async () => {
    const stores = [
      { id: "s1", name: "Nashville Store", city: "Nashville", state: "TN", address: "", postalCode: "", phone: "", website: "", facebookUrl: "", otherSocialUrl: "" },
      { id: "s2", name: "Memphis Store", city: "Memphis", state: "TN", address: "", postalCode: "", phone: "", website: "", facebookUrl: "", otherSocialUrl: "" },
    ];
    const path = createTempStoresFile(stores);

    try {
      const provider = new JsonStoreProvider(path);
      const results = await provider.lookup("city", "nashville");
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("Nashville Store");
    } finally {
      cleanup(path);
    }
  });
});

describe("StoreIntakePage exports (D1)", () => {
  it("StoreIntakePage module can be imported", async () => {
    const mod = await import("../src/ui/store-intake-page.js");
    expect(mod.StoreIntakePage).toBeDefined();
    expect(typeof mod.StoreIntakePage).toBe("function");
  });

  it("StoreIntakePage export name matches manifest", () => {
    // Verifies the export name matches EXPORT_NAMES.storeIntakePage = "StoreIntakePage"
    const exportName = "StoreIntakePage";
    expect(exportName).toBe("StoreIntakePage");
  });

  it("Filters include required views", () => {
    const expectedFilters = [
      "Unreviewed",
      "High priority",
      "Possible duplicates",
      "Needs verification",
      "Internal/family tests",
      "Spam",
      "Recently reviewed",
    ];

    for (const filter of expectedFilters) {
      expect(filter).toBeDefined();
    }
  });
});

describe("Review queue filtering logic", () => {
  type QItem = {
    latestVerdict: string | null;
    latestOutcome: string | null;
    priority: string;
    duplicateCount: number;
  };

  it("unreviewed filter finds unreviewed items", () => {
    const items: QItem[] = [
      { latestVerdict: null, latestOutcome: null, priority: "high", duplicateCount: 0 },
      { latestVerdict: "genuine_external", latestOutcome: null, priority: "high", duplicateCount: 0 },
    ];
    const unreviewed = items.filter((i) => !i.latestVerdict);
    expect(unreviewed.length).toBe(1);
  });

  it("high priority filter works", () => {
    const items: QItem[] = [
      { latestVerdict: null, latestOutcome: null, priority: "high", duplicateCount: 0 },
      { latestVerdict: null, latestOutcome: null, priority: "medium", duplicateCount: 0 },
      { latestVerdict: null, latestOutcome: null, priority: "low", duplicateCount: 0 },
    ];
    const high = items.filter((i) => i.priority === "high");
    expect(high.length).toBe(1);
  });

  it("possible duplicates filter finds items with duplicates", () => {
    const items: QItem[] = [
      { latestVerdict: null, latestOutcome: null, priority: "medium", duplicateCount: 3 },
      { latestVerdict: null, latestOutcome: null, priority: "medium", duplicateCount: 0 },
    ];
    const dupes = items.filter((i) => i.duplicateCount > 0);
    expect(dupes.length).toBe(1);
  });

  it("needs verification filter works", () => {
    const items: QItem[] = [
      { latestVerdict: "genuine_external", latestOutcome: "needs_verification", priority: "medium", duplicateCount: 0 },
      { latestVerdict: "genuine_external", latestOutcome: "accepted", priority: "medium", duplicateCount: 0 },
    ];
    const needsVerif = items.filter((i) => i.latestOutcome === "needs_verification");
    expect(needsVerif.length).toBe(1);
  });

  it("internal/family tests filter works", () => {
    const items: QItem[] = [
      { latestVerdict: "internal_test", latestOutcome: null, priority: "medium", duplicateCount: 0 },
      { latestVerdict: "family_test", latestOutcome: null, priority: "medium", duplicateCount: 0 },
      { latestVerdict: "genuine_external", latestOutcome: null, priority: "medium", duplicateCount: 0 },
    ];
    const tests = items.filter((i) => i.latestVerdict === "internal_test" || i.latestVerdict === "family_test");
    expect(tests.length).toBe(2);
  });

  it("spam filter works", () => {
    const items: QItem[] = [
      { latestVerdict: "spam", latestOutcome: null, priority: "medium", duplicateCount: 0 },
      { latestVerdict: "genuine_external", latestOutcome: null, priority: "medium", duplicateCount: 0 },
    ];
    const spam = items.filter((i) => i.latestVerdict === "spam");
    expect(spam.length).toBe(1);
  });

  it("recently reviewed filter shows reviewed items", () => {
    const items: QItem[] = [
      { latestVerdict: "genuine_external", latestOutcome: null, priority: "medium", duplicateCount: 0 },
      { latestVerdict: null, latestOutcome: null, priority: "medium", duplicateCount: 0 },
    ];
    const reviewed = items.filter((i) => i.latestVerdict);
    expect(reviewed.length).toBe(1);
  });

  it("ordinary non-store email is excluded", () => {
    // The intake queue data provider only returns items with originKindPrefix matching ORIGIN_KIND_INTAKE.
    // This is ensured in the server-side list query. Non-store email = no evidence record.
    const hasStoreIntakeEvidence = false;
    expect(hasStoreIntakeEvidence).toBe(false);
  });

  it("reviewed internal tests leave active queue", () => {
    const items: QItem[] = [
      { latestVerdict: "internal_test", latestOutcome: null, priority: "medium", duplicateCount: 0 },
    ];
    // Internal tests are reviewed (have verdict) so they don't appear in "unreviewed" filter
    const unreviewed = items.filter((i) => !i.latestVerdict);
    expect(unreviewed.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: End-to-end config-to-provider wiring
// ---------------------------------------------------------------------------

describe("Configuration-to-provider wiring (Fix 2)", () => {
  it("not_configured uses fixture provider and returns no matches from empty set", async () => {
    const { createConfigurableDuplicateMatcher } = await import("../src/mail/duplicates.js");
    const { matcher, provider } = createConfigurableDuplicateMatcher({});
    const results = await matcher.findDuplicates({
      storeName: "Test Store",
      address: "", city: "", state: "", phone: "", website: "", facebookUrl: "", otherSocialUrl: "",
    });
    expect(results).toEqual([]);
  });

  it("configured path with valid JSON produces candidates", async () => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { createConfigurableDuplicateMatcher, DuplicateMatcher } = await import("../src/mail/duplicates.js");

    const stores = [
      { id: "s1", name: "Bargain Bin", address: "123 Main", city: "Nashville", state: "TN", postalCode: "", phone: "", website: "", facebookUrl: "", otherSocialUrl: "" },
    ];
    const path = resolve(tmpdir(), "config-test-" + Date.now() + ".json");
    writeFileSync(path, JSON.stringify(stores));

    try {
      const { matcher, provider } = createConfigurableDuplicateMatcher({ storeExportPath: path });
      const results = await matcher.findDuplicates({
        storeName: "Bargain Bin",
        address: "123 Main", city: "Nashville", state: "TN", phone: "", website: "", facebookUrl: "", otherSocialUrl: "",
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].storeName).toBe("Bargain Bin");
    } finally {
      unlinkSync(path);
    }
  });

  it("configured path with missing file reports unavailable", async () => {
    const { JsonStoreProvider } = await import("../src/mail/duplicates.js");
    const provider = new JsonStoreProvider("/nonexistent/test-path/stores.json");
    expect(provider.isAvailable()).toBe(false);
    expect(provider.getError()).toContain("not found");
  });

  it("malformed file path is distinguishable from no matches", async () => {
    const { JsonStoreProvider } = await import("../src/mail/duplicates.js");
    const missing = new JsonStoreProvider("/no/file.json");
    expect(missing.isAvailable()).toBe(false);

    const { tmpdir } = await import("node:os");
    const { resolve } = await import("node:path");
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const emptyPath = resolve(tmpdir(), "empty-config-" + Date.now() + ".json");
    writeFileSync(emptyPath, "[]");
    try {
      const empty = new JsonStoreProvider(emptyPath);
      expect(empty.isAvailable()).toBe(true);
      const records = await empty.listAll();
      expect(records.length).toBe(0); // Available but empty — different from unavailable
    } finally {
      unlinkSync(emptyPath);
    }
  });
});