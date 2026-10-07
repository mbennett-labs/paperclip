import { describe, expect, it } from "vitest";
import { extractMimeText } from "../src/mail/mime.js";

describe("extractMimeText", () => {
  it("extracts plain text from multipart/alternative without MIME boundaries", async () => {
    const boundary = "=_Part_1123294_1863167491.1788460498141";

    const raw = [
      "From: Mike <mikebennett637@gmail.com>",
      "To: agents@quantumshieldlabs.dev",
      "Subject: QSL-PAPERCLIP-MIME-TEST",
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      "Controlled staging intake test.",
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      "<html><body><p>Controlled staging intake test.</p></body></html>",
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const body = await extractMimeText(Buffer.from(raw, "utf8"));

    expect(body).toBe("Controlled staging intake test.");
    expect(body).not.toContain(boundary);
    expect(body).not.toContain("Content-Type:");
    expect(body).not.toContain("<html>");
  });

  it("produces readable text for HTML-only mail", async () => {
    const raw = [
      "From: sender@example.com",
      "To: agents@quantumshieldlabs.dev",
      "Subject: HTML only",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "",
      "<html><body><p>Hello <strong>QSL</strong>.</p><p>Second line.</p></body></html>",
      "",
    ].join("\r\n");

    const body = await extractMimeText(Buffer.from(raw, "utf8"));

    expect(body).toContain("Hello QSL.");
    expect(body).toContain("Second line.");
    expect(body).not.toContain("<html>");
  });
});
