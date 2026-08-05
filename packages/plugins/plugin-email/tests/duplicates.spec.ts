import { describe, expect, it } from "vitest";
import {
  DuplicateMatcher,
  FixtureStoreProvider,
  type DuplicateQuery,
  type StoreRecord,
} from "../src/mail/duplicates.js";

function makeStores(): StoreRecord[] {
  return [
    {
      id: "store-1",
      name: "Bargain Bin Bonanza",
      address: "123 Main St",
      city: "Nashville",
      state: "TN",
      postalCode: "37201",
      phone: "615-555-0100",
      website: "https://bargainbinbonanza.com",
      facebookUrl: "https://facebook.com/bargainbinbonanza",
      otherSocialUrl: "",
    },
    {
      id: "store-2",
      name: "City Discounts",
      address: "456 Oak Ave",
      city: "Memphis",
      state: "TN",
      postalCode: "38101",
      phone: "901-555-0200",
      website: "https://citydiscounts.com",
      facebookUrl: "",
      otherSocialUrl: "",
    },
    {
      id: "store-3",
      name: "Liquidation World",
      address: "789 Pine Blvd",
      city: "Knoxville",
      state: "TN",
      postalCode: "37901",
      phone: "865-555-0300",
      website: "https://liquidationworld.com",
      facebookUrl: "",
      otherSocialUrl: "",
    },
  ];
}

describe("DuplicateMatcher", () => {
  describe("strong exact candidate", () => {
    it("matches exact name + city + state", async () => {
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(makeStores()));
      const query: DuplicateQuery = {
        storeName: "Bargain Bin Bonanza",
        address: "123 Main Street",
        city: "Nashville",
        state: "TN",
        phone: "615-555-0100",
        website: "https://bargainbinbonanza.com",
        facebookUrl: "https://facebook.com/bargainbinbonanza",
        otherSocialUrl: "",
      };
      const results = await matcher.findDuplicates(query);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const top = results[0];
      expect(top.matchStrength).toBe("strong");
      expect(top.storeId).toBe("store-1");
      expect(top.matchReasons).toContain("normalized name match");
      expect(top.matchReasons).toContain("phone match");
    });

    it("scores strong on name + website + city", async () => {
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(makeStores()));
      const query: DuplicateQuery = {
        storeName: "Bargain Bin Bonanza",
        address: "",
        city: "Nashville",
        state: "TN",
        phone: "",
        website: "https://bargainbinbonanza.com",
        facebookUrl: "",
        otherSocialUrl: "",
      };
      const results = await matcher.findDuplicates(query);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].matchStrength).toBe("strong");
    });
  });

  describe("possible candidate", () => {
    it("matches by city + state only", async () => {
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(makeStores()));
      const query: DuplicateQuery = {
        storeName: "",
        address: "",
        city: "Nashville",
        state: "TN",
        phone: "",
        website: "",
        facebookUrl: "",
        otherSocialUrl: "",
      };
      const results = await matcher.findDuplicates(query);
      const nashvilleResults = results.filter((r) => r.storeId === "store-1");
      expect(nashvilleResults.length).toBeGreaterThanOrEqual(1);
      expect(nashvilleResults[0].matchStrength).toBe("possible");
    });

    it("matches by partial name similarity", async () => {
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(makeStores()));
      const query: DuplicateQuery = {
        storeName: "Bargain Bin",
        address: "",
        city: "",
        state: "",
        phone: "",
        website: "",
        facebookUrl: "",
        otherSocialUrl: "",
      };
      const results = await matcher.findDuplicates(query);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].matchStrength).toBe("possible");
      expect(results[0].matchReasons).toContain("partial name match");
    });

    it("matches by website domain only", async () => {
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(makeStores()));
      const query: DuplicateQuery = {
        storeName: "",
        address: "",
        city: "",
        state: "",
        phone: "",
        website: "bargainbinbonanza.com",
        facebookUrl: "",
        otherSocialUrl: "",
      };
      const results = await matcher.findDuplicates(query);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].matchStrength).toBe("possible");
    });
  });

  describe("no candidate", () => {
    it("returns empty for empty query", async () => {
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(makeStores()));
      const query: DuplicateQuery = {
        storeName: "",
        address: "",
        city: "",
        state: "",
        phone: "",
        website: "",
        facebookUrl: "",
        otherSocialUrl: "",
      };
      const results = await matcher.findDuplicates(query);
      expect(results).toEqual([]);
    });

    it("returns empty for no matching records", async () => {
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(makeStores()));
      const query: DuplicateQuery = {
        storeName: "Completely Different Store",
        address: "999 Unknown Rd",
        city: "Nowhere",
        state: "ZZ",
        phone: "000-000-0000",
        website: "https://nowhere.com",
        facebookUrl: "",
        otherSocialUrl: "",
      };
      const results = await matcher.findDuplicates(query);
      expect(results).toEqual([]);
    });

    it("handles provider error gracefully", async () => {
      const brokenProvider = new FixtureStoreProvider(makeStores());
      const originalListAll = brokenProvider.listAll.bind(brokenProvider);
      brokenProvider.listAll = async () => {
        throw new Error("DB connection failed");
      };
      const matcher = new DuplicateMatcher(brokenProvider);
      const results = await matcher.findDuplicates({
        storeName: "Test",
        address: "",
        city: "",
        state: "",
        phone: "",
        website: "",
        facebookUrl: "",
        otherSocialUrl: "",
      });
      expect(results).toEqual([]);
    });

    it("matchStrength is none when score is too low", async () => {
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(makeStores()));
      const query: DuplicateQuery = {
        storeName: "",
        address: "999 Unknown Rd",
        city: "",
        state: "",
        phone: "",
        website: "",
        facebookUrl: "",
        otherSocialUrl: "",
      };
      const results = await matcher.findDuplicates(query);
      expect(results).toEqual([]);
    });
  });

  describe("name normalization", () => {
    it("matches despite punctuation differences", async () => {
      const stores: StoreRecord[] = [
        { id: "s1", name: "Bob's Discount Bin!", address: "", city: "", state: "", postalCode: "", phone: "", website: "", facebookUrl: "", otherSocialUrl: "" },
      ];
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(stores));
      const results = await matcher.findDuplicates({
        storeName: "Bobs Discount Bin",
        address: "", city: "", state: "", phone: "", website: "", facebookUrl: "", otherSocialUrl: "",
      });
      expect(results.length).toBe(1);
      expect(results[0].matchStrength).toBe("possible");
    });

    it("matches despite extra whitespace", async () => {
      const stores: StoreRecord[] = [
        { id: "s1", name: "Super    Store", address: "", city: "", state: "", postalCode: "", phone: "", website: "", facebookUrl: "", otherSocialUrl: "" },
      ];
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(stores));
      const results = await matcher.findDuplicates({
        storeName: "Super Store",
        address: "", city: "", state: "", phone: "", website: "", facebookUrl: "", otherSocialUrl: "",
      });
      expect(results.length).toBe(1);
    });
  });

  describe("address normalization", () => {
    it("matches Street vs St abbreviation", async () => {
      const stores: StoreRecord[] = [
        { id: "s1", name: "Test", address: "123 Main Street", city: "Nashville", state: "TN", postalCode: "", phone: "", website: "", facebookUrl: "", otherSocialUrl: "" },
      ];
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(stores));
      const results = await matcher.findDuplicates({
        storeName: "Test",
        address: "123 Main St",
        city: "Nashville", state: "TN", phone: "", website: "", facebookUrl: "", otherSocialUrl: "",
      });
      expect(results.length).toBe(1);
      expect(results[0].matchReasons).toContain("exact address match");
    });

    it("matches Avenue vs Ave abbreviation", async () => {
      const stores: StoreRecord[] = [
        { id: "s1", name: "Test", address: "456 Oak Avenue", city: "Memphis", state: "TN", postalCode: "", phone: "", website: "", facebookUrl: "", otherSocialUrl: "" },
      ];
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(stores));
      const results = await matcher.findDuplicates({
        storeName: "",
        address: "456 Oak Ave",
        city: "Memphis", state: "TN", phone: "", website: "", facebookUrl: "", otherSocialUrl: "",
      });
      expect(results.length).toBe(1);
    });
  });

  describe("website domain normalization", () => {
    it("matches https:// vs http://", async () => {
      const stores: StoreRecord[] = [
        { id: "s1", name: "Test", address: "", city: "", state: "", postalCode: "", phone: "", website: "http://example.com", facebookUrl: "", otherSocialUrl: "" },
      ];
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(stores));
      const results = await matcher.findDuplicates({
        storeName: "", address: "", city: "", state: "", phone: "",
        website: "https://example.com", facebookUrl: "", otherSocialUrl: "",
      });
      expect(results.length).toBe(1);
    });

    it("matches www prefix differences", async () => {
      const stores: StoreRecord[] = [
        { id: "s1", name: "Test", address: "", city: "", state: "", postalCode: "", phone: "", website: "https://www.example.com", facebookUrl: "", otherSocialUrl: "" },
      ];
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(stores));
      const results = await matcher.findDuplicates({
        storeName: "", address: "", city: "", state: "", phone: "",
        website: "https://example.com", facebookUrl: "", otherSocialUrl: "",
      });
      expect(results.length).toBe(1);
    });
  });

  describe("phone normalization", () => {
    it("matches different phone formats", async () => {
      const stores: StoreRecord[] = [
        { id: "s1", name: "Test", address: "", city: "", state: "", postalCode: "", phone: "(615) 555-0100", website: "", facebookUrl: "", otherSocialUrl: "" },
      ];
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(stores));
      const results = await matcher.findDuplicates({
        storeName: "", address: "", city: "", state: "",
        phone: "6155550100", website: "", facebookUrl: "", otherSocialUrl: "",
      });
      expect(results.length).toBe(1);
    });

    it("matches phone with +1 prefix", async () => {
      const stores: StoreRecord[] = [
        { id: "s1", name: "Test", address: "", city: "", state: "", postalCode: "", phone: "+1 615-555-0100", website: "", facebookUrl: "", otherSocialUrl: "" },
      ];
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(stores));
      const results = await matcher.findDuplicates({
        storeName: "", address: "", city: "", state: "",
        phone: "615-555-0100", website: "", facebookUrl: "", otherSocialUrl: "",
      });
      expect(results.length).toBe(1);
    });
  });

  describe("match reasons preserved", () => {
    it("returns all matching reasons for a candidate", async () => {
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(makeStores()));
      const query: DuplicateQuery = {
        storeName: "Bargain Bin Bonanza",
        address: "123 Main Street",
        city: "Nashville",
        state: "TN",
        phone: "6155550100",
        website: "bargainbinbonanza.com",
        facebookUrl: "facebook.com/bargainbinbonanza",
        otherSocialUrl: "",
      };
      const results = await matcher.findDuplicates(query);
      expect(results.length).toBe(1);
      expect(results[0].matchReasons.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("no automatic merge or rejection", () => {
    it("does not modify provider data", async () => {
      const stores = makeStores();
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(stores));
      await matcher.findDuplicates({
        storeName: "Bargain Bin Bonanza",
        address: "123 Main St", city: "Nashville", state: "TN",
        phone: "", website: "", facebookUrl: "", otherSocialUrl: "",
      });
      expect(stores).toEqual(makeStores());
    });
  });

  describe("social URL matching", () => {
    it("matches facebook URLs", async () => {
      const stores: StoreRecord[] = [
        { id: "s1", name: "Test", address: "", city: "", state: "", postalCode: "", phone: "", website: "", facebookUrl: "https://www.facebook.com/teststore", otherSocialUrl: "" },
      ];
      const matcher = new DuplicateMatcher(new FixtureStoreProvider(stores));
      const results = await matcher.findDuplicates({
        storeName: "", address: "", city: "", state: "", phone: "", website: "",
        facebookUrl: "https://facebook.com/teststore", otherSocialUrl: "",
      });
      expect(results.length).toBe(1);
      expect(results[0].matchReasons).toContain("facebook URL match");
    });
  });
});