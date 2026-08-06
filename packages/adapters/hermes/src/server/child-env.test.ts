/**
 * Tests for the Hermes child-process environment builder.
 *
 * Verifies that:
 * - DATABASE_URL is not inherited.
 * - Unrelated provider keys are not inherited.
 * - SMTP, IMAP, AWS, and arbitrary secret-shaped variables are not inherited.
 * - Only minimal safe runtime variables (PATH, LANG, LC_*, TERM) are inherited.
 * - SSH_AUTH_SOCK, NODE_OPTIONS, GIT_*, HOME, USER, SHELL are NOT inherited.
 * - Blocked keys are OMITTED from the env (not set to "") — replace mode.
 * - Explicit isolation variables are set and protected.
 * - Protected isolation variables cannot be accidentally replaced by configEnv.
 * - Paperclip API credentials are absent by default.
 * - Paperclip API credentials appear only through an explicit governed opt-in.
 * - Secret-shaped configEnv values are rejected unless in resolvedSecretKeys.
 * - Git author identity keys (GIT_AUTHOR_NAME, etc.) are allowed via config.
 * - redactedChildEnv redacts sensitive values for logging.
 */

import { describe, expect, it } from "vitest";
import { buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";
import { buildHermesChildEnv, redactedChildEnv } from "./child-env.js";

function makeParentEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/paperclip",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    USER: "paperclip",
    SHELL: "/bin/bash",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    NODE_OPTIONS: "--max-old-space-size=4096",
    GIT_ASKPASS: "/usr/bin/git-askpass",
    GIT_TERMINAL_PROMPT: "1",
    TMPDIR: "/tmp",
    ...overrides,
  };
}

function makePaperclipEnv() {
  return buildPaperclipEnv({ id: "agent-test-1", companyId: "company-test-1" });
}

// ------------------------------------------------------------------
// Secret blocking
// ------------------------------------------------------------------

describe("secret blocking", () => {
  it("blocks DATABASE_URL", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ DATABASE_URL: "postgresql://user:pass@host/db" }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.DATABASE_URL).toBeUndefined();
    expect(result.blockedKeys).toContain("DATABASE_URL");
  });

  it("blocks POSTGRES_* vars", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ POSTGRES_HOST: "db.example.com", POSTGRES_PASSWORD: "secret" }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.POSTGRES_HOST).toBeUndefined();
    expect(result.env.POSTGRES_PASSWORD).toBeUndefined();
  });

  it("blocks AWS_* vars", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({
        AWS_ACCESS_KEY_ID: "AKIAXXXXXXXX",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_REGION: "us-east-1",
      }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(result.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.env.AWS_REGION).toBeUndefined();
  });

  it("blocks SMTP/IMAP credential vars", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({
        SMTP_HOST: "smtp.example.com",
        IMAP_HOST: "imap.example.com",
        MAIL_USER: "mailer",
      }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.SMTP_HOST).toBeUndefined();
    expect(result.env.IMAP_HOST).toBeUndefined();
    expect(result.env.MAIL_USER).toBeUndefined();
  });

  it("blocks API_KEY and TOKEN shaped vars", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({
        SOME_API_KEY: "sk-abc123",
        PROVIDER_TOKEN: "tok_deadbeef",
        MY_SECRET_KEY: "hidden-value",
      }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.SOME_API_KEY).toBeUndefined();
    expect(result.env.PROVIDER_TOKEN).toBeUndefined();
    expect(result.env.MY_SECRET_KEY).toBeUndefined();
  });

  it("blocks OPENAI and ANTHROPIC provider keys", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({
        OPENAI_API_KEY: "sk-openai-key",
        ANTHROPIC_API_KEY: "sk-ant-anthropic-key",
      }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.OPENAI_API_KEY).toBeUndefined();
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("blocks cloud credential vars", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({
        AZURE_VAULT_URL: "https://vault.azure.com",
        GCP_PROJECT: "my-project",
        CLOUDFLARE_API_TOKEN: "cf-token",
        S3_BUCKET: "my-bucket",
      }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.AZURE_VAULT_URL).toBeUndefined();
    expect(result.env.GCP_PROJECT).toBeUndefined();
    expect(result.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(result.env.S3_BUCKET).toBeUndefined();
  });

  it("blocks GITHUB_TOKEN and NPM_TOKEN", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({
        GITHUB_TOKEN: "ghp_token_value",
        NPM_TOKEN: "npm_secret_token",
      }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.GITHUB_TOKEN).toBeUndefined();
    expect(result.env.NPM_TOKEN).toBeUndefined();
  });
});

// ------------------------------------------------------------------
// Dangerous variables NOT inherited
// ------------------------------------------------------------------

describe("dangerous variables blocked", () => {
  it("does NOT inherit SSH_AUTH_SOCK", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ SSH_AUTH_SOCK: "/tmp/evil-agent.sock" }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(result.blockedKeys).toContain("SSH_AUTH_SOCK");
  });

  it("does NOT inherit NODE_OPTIONS", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ NODE_OPTIONS: "--require /evil/inject.js" }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.NODE_OPTIONS).toBeUndefined();
    expect(result.blockedKeys).toContain("NODE_OPTIONS");
  });

  it("does NOT inherit GIT_ASKPASS", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ GIT_ASKPASS: "/evil/git-credential-helper" }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.GIT_ASKPASS).toBeUndefined();
    expect(result.blockedKeys).toContain("GIT_ASKPASS");
  });

  it("does NOT inherit GIT_SSH_COMMAND", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ GIT_SSH_COMMAND: "ssh -o ProxyCommand=/evil/proxy" }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.GIT_SSH_COMMAND).toBeUndefined();
    expect(result.blockedKeys).toContain("GIT_SSH_COMMAND");
  });

  it("does NOT inherit GIT_CONFIG_COUNT or GIT_CONFIG_KEY_*", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.sshCommand",
        GIT_CONFIG_VALUE_0: "evil",
      }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(result.env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(result.env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it("does NOT inherit HOME from parent (set from isolation)", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ HOME: "/home/evil" }),
      paperclipEnv: makePaperclipEnv(),
    });
    // HOME is blocked from inheritance, but falls back to default in step 7
    expect(result.env.HOME).toBe("/home/hermes-agent");
  });

  it("does NOT inherit USER or SHELL", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ USER: "eviluser", SHELL: "/bin/evilsh" }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.USER).toBeUndefined();
    expect(result.env.SHELL).toBeUndefined();
  });
});

// ------------------------------------------------------------------
// Minimal safe defaults preserved
// ------------------------------------------------------------------

describe("minimal safe defaults preserved", () => {
  it("preserves PATH", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ PATH: "/custom/path" }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.PATH).toBe("/custom/path");
  });

  it("preserves LANG and LC_* vars", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ LANG: "en_US.UTF-8", LC_ALL: "C.UTF-8", LC_CTYPE: "UTF-8" }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.LANG).toBe("en_US.UTF-8");
    expect(result.env.LC_ALL).toBe("C.UTF-8");
    expect(result.env.LC_CTYPE).toBe("UTF-8");
  });

  it("preserves TERM", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ TERM: "xterm-256color" }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.TERM).toBe("xterm-256color");
  });

  it("does NOT inherit TMPDIR (not in safe inherited list)", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ TMPDIR: "/my/tmp" }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.TMPDIR).toBeUndefined();
  });
});

// ------------------------------------------------------------------
// Paperclip runtime vars
// ------------------------------------------------------------------

describe("paperclip runtime vars", () => {
  it("forwards PAPERCLIP_AGENT_ID and PAPERCLIP_COMPANY_ID", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: buildPaperclipEnv({ id: "a-42", companyId: "c-99" }),
    });
    expect(result.env.PAPERCLIP_AGENT_ID).toBe("a-42");
    expect(result.env.PAPERCLIP_COMPANY_ID).toBe("c-99");
  });

  it("forwards PAPERCLIP_API_URL from buildPaperclipEnv", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.PAPERCLIP_API_URL).toBeTruthy();
  });

  it("forwards task-scoped vars when present", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
      taskEnv: {
        runId: "run-1",
        taskId: "issue-1",
        wakeReason: "comment",
        commentId: "c-1",
        wakePayloadJson: '{"reason":"test"}',
      },
    });
    expect(result.env.PAPERCLIP_RUN_ID).toBe("run-1");
    expect(result.env.PAPERCLIP_TASK_ID).toBe("issue-1");
    expect(result.env.PAPERCLIP_WAKE_REASON).toBe("comment");
    expect(result.env.PAPERCLIP_WAKE_COMMENT_ID).toBe("c-1");
    expect(result.env.PAPERCLIP_WAKE_PAYLOAD_JSON).toBe('{"reason":"test"}');
  });
});

// ------------------------------------------------------------------
// PAPERCLIP_API_KEY isolation
// ------------------------------------------------------------------

describe("paperclip API key isolation", () => {
  it("does NOT forward PAPERCLIP_API_KEY by default", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.PAPERCLIP_API_KEY).toBeUndefined();
  });

  it("forwards PAPERCLIP_API_KEY when authToken is provided (opt-in path)", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
      authToken: "agent-auth-token-xyz",
    });
    expect(result.env.PAPERCLIP_API_KEY).toBe("agent-auth-token-xyz");
  });
});

// ------------------------------------------------------------------
// Isolation variables
// ------------------------------------------------------------------

describe("isolation variables", () => {
  it("sets HOME from isolation", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ HOME: "/home/wrong" }),
      paperclipEnv: makePaperclipEnv(),
      isolation: { HOME: "/isolated/home" },
    });
    expect(result.env.HOME).toBe("/isolated/home");
  });

  it("sets HERMES_HOME from isolation", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
      isolation: { HERMES_HOME: "/isolated/hermes-home" },
    });
    expect(result.env.HERMES_HOME).toBe("/isolated/hermes-home");
  });

  it("sets HERMES_WRITE_SAFE_ROOT from isolation", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
      isolation: { HERMES_WRITE_SAFE_ROOT: "/safe/root" },
    });
    expect(result.env.HERMES_WRITE_SAFE_ROOT).toBe("/safe/root");
  });

  it("sets HERMES_REDACT_SECRETS from isolation", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
      isolation: { HERMES_REDACT_SECRETS: "1" },
    });
    expect(result.env.HERMES_REDACT_SECRETS).toBe("1");
  });

  it("protects isolation vars from configEnv override", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
      configEnv: {
        HOME: "/evil/home",
        HERMES_HOME: "/evil/hermes",
        HERMES_WRITE_SAFE_ROOT: "/evil/root",
      },
      isolation: {
        HOME: "/safe/home",
        HERMES_HOME: "/safe/hermes",
        HERMES_WRITE_SAFE_ROOT: "/safe/root",
      },
    });
    expect(result.env.HOME).toBe("/safe/home");
    expect(result.env.HERMES_HOME).toBe("/safe/hermes");
    expect(result.env.HERMES_WRITE_SAFE_ROOT).toBe("/safe/root");
  });

  it("falls back to default HOME when neither parent nor isolation provides it", () => {
    const result = buildHermesChildEnv({
      parentEnv: { PATH: "/bin" },
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.HOME).toBe("/home/hermes-agent");
  });
});

// ------------------------------------------------------------------
// Config env — operator-supplied
// ------------------------------------------------------------------

describe("config env", () => {
  it("allows operator-specified env to be added", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
      configEnv: { CUSTOM_VAR: "custom-value", ANOTHER: "value-2" },
    });
    expect(result.env.CUSTOM_VAR).toBe("custom-value");
    expect(result.env.ANOTHER).toBe("value-2");
  });

  it("operator env adds to (does not replace) safe inherited env", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ PATH: "/inherited/path", LANG: "en_US.UTF-8" }),
      paperclipEnv: makePaperclipEnv(),
      configEnv: { MY_ENV: "my-value" },
    });
    expect(result.env.PATH).toBe("/inherited/path");
    expect(result.env.LANG).toBe("en_US.UTF-8");
    expect(result.env.MY_ENV).toBe("my-value");
  });

  it("rejects secret-shaped configEnv values when no resolvedSecretKeys", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
      configEnv: { OPENAI_API_KEY: "sk-evil-plaintext", SOME_TOKEN: "tok123" },
    });
    expect(result.env.OPENAI_API_KEY).toBeUndefined();
    expect(result.env.SOME_TOKEN).toBeUndefined();
    expect(result.rejectedConfigSecrets).toContain("OPENAI_API_KEY");
    expect(result.rejectedConfigSecrets).toContain("SOME_TOKEN");
  });

  it("allows secret-shaped configEnv values when present in resolvedSecretKeys", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
      configEnv: { OPENROUTER_API_KEY: "sk-governed-key" },
      resolvedSecretKeys: ["OPENROUTER_API_KEY"],
    });
    expect(result.env.OPENROUTER_API_KEY).toBe("sk-governed-key");
    expect(result.rejectedConfigSecrets).toHaveLength(0);
    expect(result.resolvedSecretKeysUsed).toContain("OPENROUTER_API_KEY");
  });

  it("rejects a mix: allows governed, rejects plaintext", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
      configEnv: {
        OPENROUTER_API_KEY: "governed-key",
        EVIL_TOKEN: "plaintext-leak",
      },
      resolvedSecretKeys: ["OPENROUTER_API_KEY"],
    });
    expect(result.env.OPENROUTER_API_KEY).toBe("governed-key");
    expect(result.env.EVIL_TOKEN).toBeUndefined();
    expect(result.rejectedConfigSecrets).toContain("EVIL_TOKEN");
  });

  it("allows git author identity keys through configEnv", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv(),
      paperclipEnv: makePaperclipEnv(),
      configEnv: {
        GIT_AUTHOR_NAME: "Agent",
        GIT_AUTHOR_EMAIL: "agent@paperclip.dev",
        GIT_COMMITTER_NAME: "Agent",
        GIT_COMMITTER_EMAIL: "agent@paperclip.dev",
      },
    });
    expect(result.env.GIT_AUTHOR_NAME).toBe("Agent");
    expect(result.env.GIT_AUTHOR_EMAIL).toBe("agent@paperclip.dev");
    expect(result.env.GIT_COMMITTER_NAME).toBe("Agent");
    expect(result.env.GIT_COMMITTER_EMAIL).toBe("agent@paperclip.dev");
  });
});

// ------------------------------------------------------------------
// Edge cases
// ------------------------------------------------------------------

describe("edge cases", () => {
  it("empty parent env produces minimal result", () => {
    const result = buildHermesChildEnv({
      parentEnv: {},
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.PAPERCLIP_AGENT_ID).toBeTruthy();
    expect(result.env.DATABASE_URL).toBeUndefined();
    expect(result.env.HOME).toBe("/home/hermes-agent");
  });

  it("undefined values in parentEnv are skipped", () => {
    const result = buildHermesChildEnv({
      parentEnv: { PATH: "/bin", DATABASE_URL: undefined } as NodeJS.ProcessEnv,
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.env.PATH).toBe("/bin");
    expect(result.env.DATABASE_URL).toBeUndefined();
  });

  it("blockedKeys includes every blocked variable", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({
        DATABASE_URL: "x",
        AWS_ACCESS_KEY_ID: "x",
        SMTP_HOST: "x",
        GITHUB_TOKEN: "x",
      }),
      paperclipEnv: makePaperclipEnv(),
    });
    expect(result.blockedKeys).toContain("DATABASE_URL");
    expect(result.blockedKeys).toContain("AWS_ACCESS_KEY_ID");
    expect(result.blockedKeys).toContain("SMTP_HOST");
    expect(result.blockedKeys).toContain("GITHUB_TOKEN");
  });

  it("unknown non-secret keys from parent are not included in result (replace mode)", () => {
    const result = buildHermesChildEnv({
      parentEnv: makeParentEnv({ RANDOM_APP_VAR: "some-value", FOO_BAR: "baz" }),
      paperclipEnv: makePaperclipEnv(),
    });
    // In replace mode, unknown keys are OMITTED entirely.
    // runChildProcess with envMode:"replace" does NOT merge process.env.
    expect(result.env.RANDOM_APP_VAR).toBeUndefined();
    expect(result.env.FOO_BAR).toBeUndefined();
  });
});

// ------------------------------------------------------------------
// Log safety
// ------------------------------------------------------------------

describe("log safety", () => {
  it("redactedChildEnv hides API keys", () => {
    const result = redactedChildEnv({ PATH: "/bin", PAPERCLIP_API_KEY: "secret-token", SOME_VAR: "safe" });
    expect(result.PAPERCLIP_API_KEY).toBe("***REDACTED***");
    expect(result.PATH).toBe("/bin");
    expect(result.SOME_VAR).toBe("safe");
  });

  it("redactedChildEnv hides token-shaped vars", () => {
    const result = redactedChildEnv({ OPENROUTER_API_KEY: "sk-key", AUTH_TOKEN: "tok" });
    expect(result.OPENROUTER_API_KEY).toBe("***REDACTED***");
    expect(result.AUTH_TOKEN).toBe("***REDACTED***");
  });
});