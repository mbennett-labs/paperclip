import { describe, expect, it } from "vitest";
import { decideDraft } from "../src/mail/drafts.js";
import type { IntakeSortCategory } from "../src/mail/sorter.js";

describe("portfolio-neutral default draft candidates", () => {
  const categories: IntakeSortCategory[] = [
    "store_submission",
    "incomplete",
    "general_email",
    "reply_continuation",
  ];

  it.each(categories)("does not hard-code a portfolio company for %s", (category) => {
    const decision = decideDraft(category, {
      fromAddress: "person@example.com",
      from: "Person <person@example.com>",
      subject: "Operational message",
    });

    expect(decision.shouldDraft).toBe(true);
    expect(decision.candidate).not.toBeNull();
    expect(decision.candidate!.body).not.toContain("TheBinMap Team");
    expect(decision.candidate!.body).not.toContain("TherapistIndex");
    expect(decision.candidate!.body).not.toContain("QuantumShield Labs");
    expect(decision.candidate!.body).toContain("Operations Team");
  });
});
