import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveContainedHermesCwdAccess } from "./execute.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

async function roots() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qsl-hermes-cwd-"));
  cleanup.push(root);
  const allowed = path.join(root, "allowed");
  const child = path.join(allowed, "mission");
  const outside = path.join(root, "outside");
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  return { allowed, child, outside };
}

describe("Hermes contained cwd access", () => {
  it("defaults to read-only", async () => {
    const { child } = await roots();
    await expect(resolveContainedHermesCwdAccess({}, child)).resolves.toBe("ro");
  });

  it("allows rw only inside the explicit realpath root", async () => {
    const { allowed, child } = await roots();
    await expect(resolveContainedHermesCwdAccess({
      "containment.cwdAccess": "rw",
      "containment.cwdWriteRoot": allowed,
    }, child)).resolves.toBe("rw");
  });

  it("rejects rw without a bounded root", async () => {
    const { child } = await roots();
    await expect(resolveContainedHermesCwdAccess({ "containment.cwdAccess": "rw" }, child))
      .rejects.toThrow("requires an absolute containment.cwdWriteRoot");
  });

  it("rejects cwd outside the configured write root", async () => {
    const { allowed, outside } = await roots();
    await expect(resolveContainedHermesCwdAccess({
      "containment.cwdAccess": "rw",
      "containment.cwdWriteRoot": allowed,
    }, outside)).rejects.toThrow("escapes containment.cwdWriteRoot");
  });

  it("rejects filesystem root as the writable boundary", async () => {
    const { child } = await roots();
    await expect(resolveContainedHermesCwdAccess({
      "containment.cwdAccess": "rw",
      "containment.cwdWriteRoot": path.parse(child).root,
    }, child)).rejects.toThrow("may not be the filesystem root");
  });
});
