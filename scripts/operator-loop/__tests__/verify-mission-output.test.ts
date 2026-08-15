import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

describe("Operator Loop verification diagnostics", () => {
  it("surfaces failed-stage diagnostics and reports stage evidence independently", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qsl-verify-"));
    const repoDir = path.join(root, "repo");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const fakePnpm = `#!/usr/bin/env bash\nset -euo pipefail\ncase "$*" in\n  "test:run") echo "TEST_DIAGNOSTIC_SENTINEL" >&2; exit 1 ;;\n  "-r typecheck") echo "typecheck ok"; exit 0 ;;\n  "build") echo "build ok"; exit 0 ;;\n  *) echo "unexpected pnpm args: $*" >&2; exit 2 ;;\nesac\n`;
    const fakeGit = `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$*" == "diff --check" ]]; then\n  exit 0\nfi\nexit 0\n`;

    const pnpmPath = path.join(binDir, "pnpm");
    const gitPath = path.join(binDir, "git");
    fs.writeFileSync(pnpmPath, fakePnpm, { mode: 0o755 });
    fs.writeFileSync(gitPath, fakeGit, { mode: 0o755 });

    const scriptPath = path.resolve(__dirname, "../verify-mission.sh");
    const result = spawnSync(
      "bash",
      [scriptPath, "--mission-id", "verifier-diagnostics-test", "--repo-dir", repoDir],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          VERIFY_DIAGNOSTIC_LINES: "25",
        },
      },
    );

    expect(result.status).toBe(1);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("TEST_DIAGNOSTIC_SENTINEL");
    expect(combined).toContain("--- tests diagnostics (last 25 lines) ---");
    expect(combined).toContain("FAIL: Tests failed");
    expect(combined).toContain("PASS: Typecheck passed");
    expect(combined).toContain("PASS: Build passed");

    const evidenceMatch = result.stdout.match(
      /=== Verification Evidence \(JSON\) ===\n(\{[\s\S]*?\n\})/,
    );
    expect(evidenceMatch).not.toBeNull();
    const evidence = JSON.parse(evidenceMatch![1]);
    expect(evidence).toMatchObject({
      mission_id: "verifier-diagnostics-test",
      tests: "failed",
      typecheck: "passed",
      build: "passed",
      diff_check: "clean",
      diagnostic_tail_lines: 25,
    });

    fs.rmSync(root, { recursive: true, force: true });
  });
});