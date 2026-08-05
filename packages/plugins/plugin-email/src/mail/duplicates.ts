export type MatchStrength = "none" | "possible" | "strong";

export interface DuplicateCandidate {
  storeId: string;
  storeName: string;
  matchStrength: MatchStrength;
  matchReasons: string[];
  matchedFields: Record<string, string>;
}

export interface StoreRecord {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  phone: string;
  website: string;
  facebookUrl: string;
  otherSocialUrl: string;
}

export interface StoreProvider {
  lookup(field: string, value: string): Promise<StoreRecord[]>;
  listAll(): Promise<StoreRecord[]>;
}

export interface DuplicateQuery {
  storeName: string;
  address: string;
  city: string;
  state: string;
  phone: string;
  website: string;
  facebookUrl: string;
  otherSocialUrl: string;
}

function normalizedName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedAddress(addr: string): string {
  return addr
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b(street|st|road|rd|avenue|ave|drive|dr|lane|ln|boulevard|blvd|highway|hwy|parkway|pkwy|court|ct|place|pl|way|circle|cir|trail|trl)\b/gi, "")
    .trim();
}

function normalizedCity(city: string): string {
  return city.toLowerCase().replace(/[^a-z\s]/g, "").trim();
}

function normalizedPhone(phone: string): string {
  return phone.replace(/[^\d]/g, "").slice(-10);
}

function normalizedWebsiteDomain(url: string): string {
  try {
    const hostname = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
    return hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
  }
}

function normalizedSocial(url: string): string {
  const lower = url.toLowerCase().trim();
  try {
    const hostname = new URL(lower.startsWith("http") ? lower : `https://${lower}`).hostname;
    return hostname.replace(/^www\./, "");
  } catch {
    return lower.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
  }
}

function getStoreField(record: StoreRecord, field: string): string {
  const r = record as unknown as Record<string, string>;
  return r[field] ?? "";
}

export class DuplicateMatcher {
  constructor(private provider: StoreProvider) {}

  async findDuplicates(query: DuplicateQuery): Promise<DuplicateCandidate[]> {
    const candidates: DuplicateCandidate[] = [];

    const hasAnyField = query.storeName || query.address || query.city || query.state || query.website || query.phone || query.facebookUrl || query.otherSocialUrl;
    if (!hasAnyField) {
      return [];
    }

    let candidateRecords: StoreRecord[];
    try {
      candidateRecords = await this.provider.listAll();
    } catch {
      return [];
    }

    for (const record of candidateRecords) {
      const reasons: string[] = [];
      const matchedFields: Record<string, string> = {};
      let score = 0;

      if (query.storeName && record.name) {
        const qn = normalizedName(query.storeName);
        const rn = normalizedName(record.name);
        if (qn === rn) {
          reasons.push("normalized name match");
          matchedFields.name = record.name;
          score += 3;
        } else if (qn.includes(rn) || rn.includes(qn)) {
          reasons.push("partial name match");
          matchedFields.name = record.name;
          score += 2;
        }
      }

      if (query.address && record.address) {
        const na = normalizedAddress(query.address);
        const ra = normalizedAddress(record.address);
        if (na && ra && na === ra) {
          reasons.push("exact address match");
          matchedFields.address = record.address;
          score += 3;
        }
      }

      if (query.city && record.city && normalizedCity(query.city) === normalizedCity(record.city)) {
        reasons.push("city match");
        matchedFields.city = record.city;
        score += 1;
      }

      if (query.state && record.state && query.state.toUpperCase() === record.state.toUpperCase()) {
        reasons.push("state match");
        matchedFields.state = record.state;
        score += 1;
      }

      if (query.phone && record.phone && normalizedPhone(query.phone) && normalizedPhone(record.phone)) {
        if (normalizedPhone(query.phone) === normalizedPhone(record.phone)) {
          reasons.push("phone match");
          matchedFields.phone = record.phone;
          score += 2;
        }
      }

      if (query.website && record.website && normalizedWebsiteDomain(query.website) === normalizedWebsiteDomain(record.website)) {
        reasons.push("website domain match");
        matchedFields.website = record.website;
        score += 2;
      }

      if (query.facebookUrl && record.facebookUrl && normalizedSocial(query.facebookUrl) === normalizedSocial(record.facebookUrl)) {
        reasons.push("facebook URL match");
        matchedFields.facebookUrl = record.facebookUrl;
        score += 2;
      }

      if (reasons.length > 0) {
        candidates.push({
          storeId: record.id,
          storeName: record.name,
          matchStrength: score >= 4 ? "strong" : score >= 2 ? "possible" : "none",
          matchReasons: reasons,
          matchedFields,
        });
      }
    }

    candidates.sort((a, b) => {
      const strengthOrder: Record<MatchStrength, number> = { strong: 3, possible: 2, none: 1 };
      return strengthOrder[b.matchStrength] - strengthOrder[a.matchStrength];
    });

    return candidates.filter((c) => c.matchStrength !== "none");
  }
}

export class FixtureStoreProvider implements StoreProvider {
  private stores: StoreRecord[];

  constructor(stores: StoreRecord[] = []) {
    this.stores = stores;
  }

  async lookup(field: string, value: string): Promise<StoreRecord[]> {
    return this.stores.filter((s) => {
      const normalized = getStoreField(s, field).toLowerCase();
      return normalized.includes(value.toLowerCase());
    });
  }

  async listAll(): Promise<StoreRecord[]> {
    return this.stores;
  }
}

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function isStoreRecord(raw: unknown): raw is StoreRecord {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.name === "string";
}

export class JsonStoreProvider implements StoreProvider {
  private stores: StoreRecord[] | null = null;
  private providerAvailable: boolean;
  private providerError: string | null = null;

  constructor(private filePath: string) {
    this.providerAvailable = false;
    this.initialize();
  }

  private initialize(): void {
    try {
      const resolved = resolve(this.filePath);
      if (!existsSync(resolved)) {
        this.providerError = "Store export file not found: " + this.filePath;
        return;
      }
      const raw = readFileSync(resolved, "utf-8");
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed) ? parsed : (parsed.stores ?? parsed.data ?? []);
      if (!Array.isArray(records)) {
        this.providerError = "Store export file does not contain an array: " + this.filePath;
        return;
      }
      this.stores = records.filter(isStoreRecord).map((r) => ({
        id: r.id,
        name: r.name,
        address: r.address || "",
        city: r.city || "",
        state: r.state || "",
        postalCode: r.postalCode || "",
        phone: r.phone || "",
        website: r.website || "",
        facebookUrl: r.facebookUrl || "",
        otherSocialUrl: r.otherSocialUrl || "",
      }));
      this.providerAvailable = true;
    } catch (err) {
      this.providerError = err instanceof Error ? err.message : String(err);
    }
  }

  isAvailable(): boolean {
    return this.providerAvailable;
  }

  getError(): string | null {
    return this.providerError;
  }

  async lookup(field: string, value: string): Promise<StoreRecord[]> {
    if (!this.stores) return [];
    const normalized = value.toLowerCase();
    return this.stores.filter((s) => {
      const v = getStoreField(s, field).toLowerCase();
      return v.includes(normalized);
    });
  }

  async listAll(): Promise<StoreRecord[]> {
    return this.stores ?? [];
  }
}

export function createConfigurableDuplicateMatcher(config?: { stores?: StoreRecord[]; storeExportPath?: string }): { matcher: DuplicateMatcher; provider: StoreProvider } {
  if (config?.storeExportPath) {
    const jsonProvider = new JsonStoreProvider(config.storeExportPath);
    return { matcher: new DuplicateMatcher(jsonProvider), provider: jsonProvider };
  }
  const stores = config?.stores ?? [];
  const fixtureProvider = new FixtureStoreProvider(stores);
  return { matcher: new DuplicateMatcher(fixtureProvider), provider: fixtureProvider };
}