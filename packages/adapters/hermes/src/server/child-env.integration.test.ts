/**
 * Integration tests: full runChildProcess → spawn path with envMode: "replace".
 *
 * Spawns a real node child process that inspects specific environment
 * variables and reports their presence, absence, or one-way digest.
 * This proves the env replacement mechanism without printing secret
 * values in test output.
 * Does NOT start Hermes or call any provider.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess, buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";
import { buildHermesChildEnv } from "./child-env.js";

function makeParentEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/home/paperclip",
    LANG: "en_US.UTF-8",
    USER: "paperclip",
    SHELL: "/bin/bash",
    SSH_AUTH_SOCK: "/tmp/fake-ssh-agent.sock",
    NODE_OPTIONS: "--max-old-space-size=8192",
    GIT_ASKPASS: "/usr/bin/git-askpass",
    GIT_SSH_COMMAND: "ssh -o ProxyCommand=/fake/proxy",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.sshCommand",
    GIT_CONFIG_VALUE_0: "evil-command",
    DATABASE_URL: "postgresql://user:pass@localhost/db",
    OPENAI_API_KEY: "sk-fake-openai-key",
    ANTHROPIC_API_KEY: "sk-ant-fake-key",
    AWS_ACCESS_KEY_ID: "AKIAFAKE",
    AWS_SECRET_ACCESS_KEY: "fake-secret",
    SMTP_HOST: "smtp.example.com",
    SOME_API_KEY: "sk-some-key",
    ANOTHER_TOKEN: "tok-deadbeef",
    ...overrides,
  };
}

interface KeyPresenceResult {
  present: string[];
  absent: string[];
  digests: Record<string, string>;
}

/**
 * Spawns a child process that inspects specific env keys.
 * For each key, the child reports PRESENT, ABSENT, or DIGEST:<sha256>.
 * The env values are NEVER printed; only hashes confirm delivery.
 */
async function spawnCheckKeys(
  env: Record<string, string>,
  keysToCheck: string[],
  digestKeys: string[] = [],
): Promise<KeyPresenceResult> {
  const checkScript = `
const inspect = ${JSON.stringify(keysToCheck)};
const digest = ${JSON.stringify(digestKeys)};
const result = { present: [], absent: [] };
for (const k of inspect) {
  if (k in process.env) result.present.push(k);
  else result.absent.push(k);
}
const digests = {};
const { createHash } = require("crypto");
for (const k of digest) {
  if (k in process.env) {
    digests[k] = createHash("sha256").update(process.env[k]).digest("hex");
  }
}
result.digests = digests;
console.log(JSON.stringify(result));
`.trim();

  const result = await runChildProcess("test-check-keys", process.execPath, ["-e", checkScript], {
    cwd: "/tmp",
    env,
    timeoutSec: 10,
    graceSec: 2,
    envMode: "replace",
    onLog: async () => undefined,
  });

  const stdout = (result.stdout ?? "").trim();
  if (!stdout) throw new Error("Child process produced no stdout");
  const jsonStart = stdout.indexOf("{");
  const jsonEnd = stdout.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`No JSON found in child stdout: ${stdout.slice(0, 500)}`);
  }
  return JSON.parse(stdout.slice(jsonStart, jsonEnd + 1)) as KeyPresenceResult;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("runChildProcess envMode replace integration", () => {
  it("child receives only explicitly constructed env keys", async () => {
    const built = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: buildPaperclipEnv({ id: "agent-int", companyId: "company-int" }),
      isolation: { HOME: "/isolated/home", TMPDIR: "/isolated/tmp" },
    });

    const result = await spawnCheckKeys(built.env, [
      "PAPERCLIP_AGENT_ID",
      "PAPERCLIP_COMPANY_ID",
      "SSH_AUTH_SOCK",
      "NODE_OPTIONS",
      "GIT_ASKPASS",
      "GIT_SSH_COMMAND",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "SMTP_HOST",
      "SOME_API_KEY",
      "ANOTHER_TOKEN",
      "USER",
      "SHELL",
    ]);

    expect(result.present).toContain("PAPERCLIP_AGENT_ID");
    expect(result.present).toContain("PAPERCLIP_COMPANY_ID");

    // Dangerous variables must NOT reach the child
    for (const dangerous of [
      "SSH_AUTH_SOCK", "NODE_OPTIONS", "GIT_ASKPASS", "GIT_SSH_COMMAND",
      "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
      "DATABASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
      "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SMTP_HOST",
      "SOME_API_KEY", "ANOTHER_TOKEN", "USER", "SHELL",
    ]) {
      expect(result.absent, `Dangerous var ${dangerous} leaked`).toContain(dangerous);
    }
  });

  it("child receives safe inherited keys", async () => {
    const built = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: buildPaperclipEnv({ id: "agent-safe", companyId: "company-safe" }),
    });

    const result = await spawnCheckKeys(built.env, ["PATH", "LANG", "PAPERCLIP_AGENT_ID", "PAPERCLIP_COMPANY_ID"]);

    expect(result.present).toContain("PATH");
    expect(result.present).toContain("LANG");
    expect(result.present).toContain("PAPERCLIP_AGENT_ID");
    expect(result.present).toContain("PAPERCLIP_COMPANY_ID");
  });

  it("child env does not contain random parent vars", async () => {
    const parentEnv = makeParentEnv({ RANDOM_PARENT_VAR: "should-not-leak" });
    const built = buildHermesChildEnv({
      parentEnv,
      paperclipEnv: buildPaperclipEnv({ id: "agent-no-leak", companyId: "company-no-leak" }),
    });

    const result = await spawnCheckKeys(built.env, ["RANDOM_PARENT_VAR", "USER"]);
    expect(result.absent).toContain("RANDOM_PARENT_VAR");
    expect(result.absent).toContain("USER");
  });

  it("child receives isolation vars and protects them", async () => {
    const built = buildHermesChildEnv({
      parentEnv: makeParentEnv({ HOME: "/evil/home" }),
      paperclipEnv: buildPaperclipEnv({ id: "agent-iso", companyId: "company-iso" }),
      isolation: {
        HOME: "/safe/isolated/home",
        HERMES_HOME: "/safe/hermes",
        HERMES_WRITE_SAFE_ROOT: "/safe/root",
        HERMES_REDACT_SECRETS: "1",
      },
    });

    const result = await spawnCheckKeys(built.env, ["HOME", "HERMES_HOME", "HERMES_WRITE_SAFE_ROOT", "HERMES_REDACT_SECRETS"]);
    expect(result.present).toContain("HOME");
    expect(result.present).toContain("HERMES_HOME");
    expect(result.present).toContain("HERMES_WRITE_SAFE_ROOT");
    expect(result.present).toContain("HERMES_REDACT_SECRETS");
  });

  it("child does NOT receive PAPERCLIP_API_KEY by default", async () => {
    const built = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: buildPaperclipEnv({ id: "agent-no-key", companyId: "company-no-key" }),
    });

    const result = await spawnCheckKeys(built.env, ["PAPERCLIP_API_KEY"]);
    expect(result.absent).toContain("PAPERCLIP_API_KEY");
  });

  it("child receives PAPERCLIP_API_KEY only when opted in (verified via digest)", async () => {
    const authToken = "test-auth-token-for-verification";
    const built = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: buildPaperclipEnv({ id: "agent-key", companyId: "company-key" }),
      authToken,
    });

    // Verify delivery using one-way digest — the token value never appears in child stdout.
    const result = await spawnCheckKeys(built.env, ["PAPERCLIP_API_KEY"], ["PAPERCLIP_API_KEY"]);
    expect(result.present).toContain("PAPERCLIP_API_KEY");
    expect(result.digests.PAPERCLIP_API_KEY).toBe(digest(authToken));
  });

  it("child receives governed secret but not plaintext secrets (digest-verified)", async () => {
    const governedKey = "openrouter-governed-credential-xyz";
    const built = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: buildPaperclipEnv({ id: "agent-secret", companyId: "company-secret" }),
      configEnv: {
        OPENROUTER_API_KEY: governedKey,
        EVIL_PLAINTEXT_TOKEN: "should-be-rejected",
      },
      resolvedSecretKeys: ["OPENROUTER_API_KEY"],
    });

    const result = await spawnCheckKeys(
      built.env,
      ["OPENROUTER_API_KEY", "EVIL_PLAINTEXT_TOKEN"],
      ["OPENROUTER_API_KEY"],
    );

    // Governed secret delivered — verified via digest (value never in child stdout).
    expect(result.present).toContain("OPENROUTER_API_KEY");
    expect(result.digests.OPENROUTER_API_KEY).toBe(digest(governedKey));

    // Plaintext secret rejected.
    expect(result.absent).toContain("EVIL_PLAINTEXT_TOKEN");
    expect(built.rejectedConfigSecrets).toContain("EVIL_PLAINTEXT_TOKEN");
    expect(built.resolvedSecretKeysUsed).toContain("OPENROUTER_API_KEY");
  });

  it("child env does not leak secret-shaped configEnv without resolvedSecretKeys", async () => {
    const built = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: buildPaperclipEnv({ id: "agent-reject", companyId: "company-reject" }),
      configEnv: {
        AWS_SECRET_ACCESS_KEY: "plaintext-fake-key",
        DATABASE_URL: "postgresql://hacked",
        MY_TOKEN: "tok-plain",
      },
    });

    const result = await spawnCheckKeys(built.env, ["AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "MY_TOKEN"]);
    expect(result.absent).toContain("AWS_SECRET_ACCESS_KEY");
    expect(result.absent).toContain("DATABASE_URL");
    expect(result.absent).toContain("MY_TOKEN");
    expect(built.rejectedConfigSecrets).toContain("AWS_SECRET_ACCESS_KEY");
    expect(built.rejectedConfigSecrets).toContain("DATABASE_URL");
    expect(built.rejectedConfigSecrets).toContain("MY_TOKEN");
  });

  it("end-to-end: governed OPENROUTER_API_KEY reaches child, plaintext secret rejected, no leak", async () => {
    // Simulates the full server→adapter→child path:
    // 1. Server resolves secret_ref binding → plaintext value + __resolvedEnvKeys
    // 2. Adapter's execute() passes these to buildHermesChildEnv
    // 3. buildHermesChildEnv allows governed key, rejects plaintext secret key
    // 4. runChildProcess with envMode:replace delivers only the governed key

    const governedOpenRouterKey = "sk-or-v1-governed-secret-path";
    const built = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: buildPaperclipEnv({ id: "agent-e2e", companyId: "company-e2e" }),
      configEnv: {
        // This is what resolveAdapterConfigForRuntime would produce after
        // resolving a secret_ref binding for OPENROUTER_API_KEY.
        OPENROUTER_API_KEY: governedOpenRouterKey,
        // Attacker introduces a different provider key via plaintext config.
        // This matches the blocked pattern /^OPENAI|ANTHROPIC|.../ so it
        // must be rejected without __resolvedEnvKeys coverage.
        OPENAI_API_KEY: "sk-forged-plaintext",
        // Attacker also tries a token-shaped key name.
        EVIL_AUTH_TOKEN: "tok-injected",
      },
      // This is what the heartbeat now plants via runtimeConfig.__resolvedEnvKeys.
      resolvedSecretKeys: ["OPENROUTER_API_KEY"],
    });

    // Deliver OPENROUTER_API_KEY — but verify via digest so the value
    // never appears in child stdout.
    const result = await spawnCheckKeys(
      built.env,
      ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "EVIL_AUTH_TOKEN"],
      ["OPENROUTER_API_KEY"],
    );

    expect(result.present).toContain("OPENROUTER_API_KEY");
    expect(result.digests.OPENROUTER_API_KEY).toBe(digest(governedOpenRouterKey));
    expect(result.absent).toContain("OPENAI_API_KEY");
    expect(result.absent).toContain("EVIL_AUTH_TOKEN");
    expect(built.resolvedSecretKeysUsed).toContain("OPENROUTER_API_KEY");
    expect(built.rejectedConfigSecrets).toContain("OPENAI_API_KEY");
    expect(built.rejectedConfigSecrets).toContain("EVIL_AUTH_TOKEN");
  });
});

describe("envMode inherit backward compatibility", () => {
  it("inherit mode still merges sanitized process.env", async () => {
    const result = await runChildProcess("test-inherit", process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], {
      cwd: "/tmp",
      env: { MY_OVERRIDE: "override-value" },
      timeoutSec: 10,
      graceSec: 2,
      envMode: "inherit",
      onLog: async () => undefined,
    });

    const stdout = result.stdout ?? "";
    const childEnv = JSON.parse(stdout.trim()) as Record<string, string>;
    expect(childEnv.PATH).toBeTruthy();
    expect(childEnv.MY_OVERRIDE).toBe("override-value");
  });

  it("default (no envMode) uses inherit behavior", async () => {
    const result = await runChildProcess("test-default", process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], {
      cwd: "/tmp",
      env: { DEFAULT_TEST_VAR: "default-works" },
      timeoutSec: 10,
      graceSec: 2,
      onLog: async () => undefined,
    });

    const stdout = result.stdout ?? "";
    const childEnv = JSON.parse(stdout.trim()) as Record<string, string>;
    expect(childEnv.DEFAULT_TEST_VAR).toBe("default-works");
    expect(childEnv.PATH).toBeTruthy();
  });
});