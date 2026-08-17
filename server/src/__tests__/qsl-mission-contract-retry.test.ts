import { describe, expect, it } from "vitest";
import { effectiveContinuationRetryMaxAttempts } from "../services/recovery/service.js";

describe("QSL mission contract continuation retry cap", () => {
  it("uses the platform limit when no mission contract exists", () => {
    expect(effectiveContinuationRetryMaxAttempts(3, null)).toBe(3);
  });

  it("allows a mission contract to tighten the platform retry limit", () => {
    expect(effectiveContinuationRetryMaxAttempts(3, {
      missionContract: { maxRepairRetries: 1 },
    })).toBe(1);
  });

  it("never lets a mission contract loosen the platform retry limit", () => {
    expect(effectiveContinuationRetryMaxAttempts(1, {
      missionContract: { maxRepairRetries: 9 },
    })).toBe(1);
  });
});
