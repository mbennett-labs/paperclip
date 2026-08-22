import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runnerPath = fileURLToPath(
  new URL("../../../scripts/qsl-chatgpt-orchestrator-bridge/run-bridge-operation.sh", import.meta.url),
);

describe("QSL Orchestrator Bridge — runner script invariants", () => {
  it("exists", () => {
    expect(existsSync(runnerPath)).toBe(true);
  });

  const source = readFileSync(runnerPath, "utf8");

  it("defines post_result before any usage", () => {
    const defIndex = source.indexOf("post_result()");
    const firstCallIndex = source.indexOf("post_result \"");
    expect(defIndex).toBeGreaterThan(-1);
    expect(firstCallIndex).toBeGreaterThan(defIndex);
  });

  it("uses correct API base path (/api/qsl-orchestrator-bridge...)", () => {
    expect(source).toContain("/api/qsl-orchestrator-bridge/companies/");
    expect(source).toContain("/bridge");
  });

  it("only pipes request/response through jq, never echos raw to stdout", () => {
    const sourceNoComments = source.replace(/#.*/g, "");
    const echoLines = sourceNoComments.split("\n").filter(
      (l) => l.trim().startsWith("echo ") && !l.includes(">&2") && !l.includes("comment_body")
    );
    for (const line of echoLines) {
      if (line.includes("$REQUEST_JSON") || line.includes("$RESPONSE_BODY")) {
        expect(line).toMatch(/\|/);
      }
    }
  });

  it("does not interpolate untrusted comment body directly into shell commands", () => {
    // The runner reads a pre-parsed JSON file, not raw comment text into shell
    expect(source).toContain("--request-json");
    expect(source).toContain("jq -r");
  });

  it("validates environment is staging", () => {
    expect(source).toContain("Only staging environment is allowed");
    expect(source).toContain("ENVIRONMENT");
  });

  it("checks prohibited patterns in operation name", () => {
    expect(source).toContain("PROHIBITED_PATTERNS");
    expect(source).toContain("grep -qi");
  });

  it("sanitizes comment body before posting to GitHub", () => {
    expect(source).toContain("[REDACTED]");
    expect(source).toContain("sed -E");
  });

  it("fails closed when API call fails", () => {
    expect(source).toContain("Paperclip API call failed");
    expect(source).toContain("post_result \"FAIL\"");
  });

  it("fails closed on missing required arguments", () => {
    expect(source).toContain("--request-json is required");
    expect(source).toContain("--company-id or PAPERCLIP_COMPANY_ID is required");
  });

  it("validates JSON before dispatching", () => {
    expect(source).toContain("jq -r");
    expect(source).toContain(".operation");
  });

  it("handles HTTP error codes with appropriate result classes", () => {
    expect(source).toContain("HTTP_CODE");
    expect(source).toContain("RESULT_CLASS=\"FAIL\"");
    expect(source).toContain("RESULT_CLASS=\"BLOCKED\"");
  });

  it("strips out API key patterns from posted comments", () => {
    expect(source).toContain("sk-[a-zA-Z0-9]");
    expect(source).toContain("[REDACTED]");
  });
});