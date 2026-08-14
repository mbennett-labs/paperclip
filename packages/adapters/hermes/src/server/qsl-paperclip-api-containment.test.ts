import { describe, expect, it } from "vitest";
import { resolveContainedPaperclipApiAllowlistTarget } from "./execute.js";

describe("Hermes contained Paperclip API target", () => {
  it("allows the exact loopback staging target", () => {
    expect(resolveContainedPaperclipApiAllowlistTarget("http://127.0.0.1:3101/api"))
      .toBe("127.0.0.1:3101");
  });

  it("allows localhost loopback", () => {
    expect(resolveContainedPaperclipApiAllowlistTarget("http://localhost:3101/api"))
      .toBe("localhost:3101");
  });

  it("rejects non-loopback and HTTPS targets", () => {
    expect(() => resolveContainedPaperclipApiAllowlistTarget("https://paperclip.example.com/api"))
      .toThrow("loopback HTTP staging endpoints");
    expect(() => resolveContainedPaperclipApiAllowlistTarget("http://10.0.0.5:3101/api"))
      .toThrow("loopback HTTP staging endpoints");
  });
});
