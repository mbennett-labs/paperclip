/**
 * Working-directory / sandbox-workspace contract tests for the Hermes adapter.
 *
 * These tests pin the invariant that a relative "." can never reach
 * local-process-sandbox and that the contained workspace is derived per-run
 * (not from a stale persistent poc-NNN directory in the agent config).
 *
 * No Hermes process is started. No provider is called. No credentials appear.
 */

import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  resolveHermesSandboxWorkspaceDir,
  resolveHermesWorkingDirectory,
} from "./execute.js";

describe("resolveHermesWorkingDirectory", () => {
  test("uses context.paperclipWorkspace.cwd when present", () => {
    const cwd = resolveHermesWorkingDirectory(
      {},
      { paperclipWorkspace: { cwd: "/workspaces/agent-1", source: "project" } },
    );
    expect(cwd).toBe("/workspaces/agent-1");
  });

  test("falls back to config.cwd when no workspace context is supplied", () => {
    const cwd = resolveHermesWorkingDirectory({ cwd: "/opt/explicit-cwd" }, {});
    expect(cwd).toBe("/opt/explicit-cwd");
  });

  test("falls back to process.cwd() — absolute, never a relative '.'", () => {
    const cwd = resolveHermesWorkingDirectory({}, {});
    expect(path.isAbsolute(cwd)).toBe(true);
    expect(cwd).not.toBe(".");
    expect(cwd).toBe(process.cwd());
  });

  test("never returns a relative path for any input", () => {
    expect(path.isAbsolute(resolveHermesWorkingDirectory({}, {}))).toBe(true);
    expect(
      path.isAbsolute(resolveHermesWorkingDirectory({}, { paperclipWorkspace: { cwd: "/a" } })),
    ).toBe(true);
    expect(
      path.isAbsolute(resolveHermesWorkingDirectory({ cwd: "/b" }, {})),
    ).toBe(true);
  });

  test("config.cwd wins over the fallback agent_home workspace", () => {
    const cwd = resolveHermesWorkingDirectory(
      { cwd: "/opt/configured" },
      { paperclipWorkspace: { cwd: "/workspaces/agent-home", source: "agent_home" } },
    );
    expect(cwd).toBe("/opt/configured");
  });

  test("agent_home workspace is used when no config.cwd override exists", () => {
    const cwd = resolveHermesWorkingDirectory(
      {},
      { paperclipWorkspace: { cwd: "/workspaces/agent-home", source: "agent_home" } },
    );
    expect(cwd).toBe("/workspaces/agent-home");
  });

  test("a stale containment.workspaceDir in config does not affect the working directory", () => {
    const cwd = resolveHermesWorkingDirectory(
      { "containment.workspaceDir": "/tmp/paperclip-hermes-sandbox-poc-001" },
      { paperclipWorkspace: { cwd: "/workspaces/agent-1" } },
    );
    expect(cwd).toBe("/workspaces/agent-1");
    expect(cwd).not.toContain("poc-001");
  });
});

describe("resolveHermesSandboxWorkspaceDir", () => {
  test("derives a per-run workspace from the run ID when unset", () => {
    const dir = resolveHermesSandboxWorkspaceDir({}, "run-abc-123");
    expect(dir).toBe(path.join(os.tmpdir(), "paperclip-hermes-sandbox-run-abc-123"));
    expect(path.isAbsolute(dir)).toBe(true);
  });

  test("a new run does not reuse a stale persistent poc workspace", () => {
    const first = resolveHermesSandboxWorkspaceDir({}, "run-001");
    const second = resolveHermesSandboxWorkspaceDir({}, "run-002");
    expect(first).not.toBe(second);
    expect(first).toContain("run-001");
    expect(second).toContain("run-002");
  });

  test("explicit containment.workspaceDir override still wins when configured", () => {
    const dir = resolveHermesSandboxWorkspaceDir(
      { "containment.workspaceDir": "/tmp/paperclip-hermes-sandbox-poc-003" },
      "run-xyz",
    );
    expect(dir).toBe("/tmp/paperclip-hermes-sandbox-poc-003");
  });
});
