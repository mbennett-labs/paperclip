#!/usr/bin/env tsx
/**
 * Board Intelligence Export Generator
 *
 * Usage:
 *   npx tsx server/scripts/generate-board-export.ts [--output <dir>]
 *
 * Requires DATABASE_URL to be set (or the server's embedded Postgres to be running).
 * Defaults output to ./board_exports/
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@paperclipai/db";
import { generateBoardExport } from "../src/services/board-export.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function main() {
  const args = process.argv.slice(2);
  let outputDir = path.join(ROOT, "board_exports");

  const outputIdx = args.indexOf("--output");
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    outputDir = path.resolve(args[outputIdx + 1]);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set.");
    console.error("Either set DATABASE_URL or ensure the embedded Postgres is running.");
    process.exit(1);
  }

  console.log(`Connecting to database...`);
  const db = createDb(databaseUrl);

  console.log(`Generating board export...`);
  const { bundle, files } = await generateBoardExport(db);

  await mkdir(outputDir, { recursive: true });

  for (const [filename, content] of Object.entries(files)) {
    const filePath = path.join(outputDir, filename);
    await writeFile(filePath, content, "utf-8");
    console.log(`  wrote ${filename}`);
  }

  // Write the full bundle as a single JSON
  const bundlePath = path.join(outputDir, "board_export_bundle.json");
  await writeFile(bundlePath, JSON.stringify(bundle, null, 2), "utf-8");
  console.log(`  wrote board_export_bundle.json`);

  console.log(`\nBoard export complete: ${outputDir}`);
  console.log(`Generated at: ${bundle.generated_at}`);
  console.log(`Companies: ${bundle.companies.length}`);
  console.log(`Agents: ${bundle.agents.length}`);
  console.log(`Issues: ${bundle.issues.length}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Board export failed:", err);
  process.exit(1);
});
