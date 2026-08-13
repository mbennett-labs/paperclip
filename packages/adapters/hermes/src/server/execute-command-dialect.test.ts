/**
 * Command-dialect tests for the Hermes adapter.
 *
 * Pins the argv contract for both the Hermes CLI dialect (historical `chat -q`)
 * and the OpenClaw 2026.2.17 dialect (`agent --local --session-id --message
 * --json`). No process is spawned and no provider is contacted.
 */

import { describe, expect, test } from "vitest";

import {
  buildHermesCommandArgs,
  parseCommandOutput,
  resolveHermesCommandDialect,
} from "./execute.js";

const baseInput = {
  dialect: "hermes" as const,
  prompt: "Write 3 to hermes-poc.txt",
  runId: "run-abc-123",
  model: "openrouter/deepseek/deepseek-chat",
  resolvedProvider: "openrouter",
  timeoutSec: 1800,
  useQuiet: true,
  toolsets: undefined,
  maxTurns: 50,
  worktreeMode: false,
  checkpoints: false,
  verbose: false,
  dangerousYolo: false,
  persistSession: true,
  prevSessionId: undefined,
  extraArgs: undefined,
};

describe("resolveHermesCommandDialect", () => {
  test("defaults to hermes when commandDialect is unset", () => {
    expect(resolveHermesCommandDialect({})).toBe("hermes");
  });

  test("resolves openclaw when commandDialect is 'openclaw'", () => {
    expect(resolveHermesCommandDialect({ commandDialect: "openclaw" })).toBe("openclaw");
  });

  test("treats any other value as hermes (fail-closed to known syntax)", () => {
    expect(resolveHermesCommandDialect({ commandDialect: "hermes" })).toBe("hermes");
    expect(resolveHermesCommandDialect({ commandDialect: "unknown" })).toBe("hermes");
  });
});

describe("buildHermesCommandArgs — Hermes dialect", () => {
  test("emits the historical chat -q argv", () => {
    const args = buildHermesCommandArgs({ ...baseInput, dialect: "hermes" });
    expect(args[0]).toBe("chat");
    expect(args[1]).toBe("-q");
    expect(args[2]).toBe(baseInput.prompt);
    expect(args).toContain("-Q");
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("openrouter/deepseek/deepseek-chat");
    expect(args).toContain("--provider");
    expect(args[args.indexOf("--provider") + 1]).toBe("openrouter");
    expect(args).toContain("--source");
    expect(args).toContain("tool");
  });

  test("the prompt is a single argv element", () => {
    const prompt = "line one\nline two\n--not-a-flag";
    const args = buildHermesCommandArgs({ ...baseInput, dialect: "hermes", prompt });
    expect(args.filter((a) => a === prompt)).toHaveLength(1);
  });
});

describe("buildHermesCommandArgs — OpenClaw dialect", () => {
  test("emits agent --local --session-id --message --json --timeout", () => {
    const args = buildHermesCommandArgs({ ...baseInput, dialect: "openclaw" });
    expect(args[0]).toBe("agent");
    expect(args).toContain("--local");
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("run-abc-123");
    expect(args).toContain("--message");
    expect(args[args.indexOf("--message") + 1]).toBe(baseInput.prompt);
    expect(args).toContain("--json");
    expect(args).toContain("--timeout");
    expect(args[args.indexOf("--timeout") + 1]).toBe("1800");
  });

  test("never emits chat or -q", () => {
    const args = buildHermesCommandArgs({ ...baseInput, dialect: "openclaw" });
    expect(args).not.toContain("chat");
    expect(args).not.toContain("-q");
    expect(args).not.toContain("-Q");
  });

  test("does not emit -m/--provider (model/provider come from governed env)", () => {
    const args = buildHermesCommandArgs({ ...baseInput, dialect: "openclaw" });
    expect(args).not.toContain("-m");
    expect(args).not.toContain("--provider");
    expect(args).not.toContain("--source");
  });

  test("the prompt is passed as a single --message argument", () => {
    const prompt = "multi\nline\nprompt";
    const args = buildHermesCommandArgs({ ...baseInput, dialect: "openclaw", prompt });
    expect(args.filter((a) => a === prompt)).toHaveLength(1);
    expect(args[args.indexOf("--message") + 1]).toBe(prompt);
  });
});

describe("parseCommandOutput", () => {
  test("openclaw dialect extracts assistant text from JSON payloads", () => {
    const stdout = JSON.stringify({
      payloads: [{ text: "done: wrote 3" }, { text: "final answer" }],
      meta: { agentMeta: { sessionId: "run-abc-123", provider: "openrouter", model: "deepseek/deepseek-chat" } },
    });
    const parsed = parseCommandOutput(stdout, "", "openclaw");
    expect(parsed.sessionId).toBe("run-abc-123");
    expect(parsed.response).toBe("done: wrote 3\nfinal answer");
  });

  test("openclaw dialect tolerates an empty payloads array", () => {
    const stdout = JSON.stringify({
      payloads: [],
      meta: { agentMeta: { sessionId: "run-abc-123", provider: "openrouter", model: "deepseek/deepseek-chat" } },
    });
    const parsed = parseCommandOutput(stdout, "", "openclaw");
    expect(parsed.sessionId).toBe("run-abc-123");
    expect(parsed.response).toBeUndefined();
  });

  test("hermes dialect still parses quiet-mode session_id output", () => {
    const stdout = "hello world\n\nsession_id: sess-1\n";
    const parsed = parseCommandOutput(stdout, "", "hermes");
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.response).toContain("hello world");
  });
});
