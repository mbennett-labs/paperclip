import { readFile, writeFile, access } from 'node:fs/promises';

const schemaPath = 'packages/db/src/schema/operator_missions.ts';
const migrationPath = 'packages/db/src/migrations/0184_operator_mission_company_mission_unique.sql';
const journalPath = 'packages/db/src/migrations/meta/_journal.json';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (await exists(migrationPath)) {
  throw new Error(`${migrationPath} already exists; refusing to overwrite`);
}

let schema = await readFile(schemaPath, 'utf8');

const importNeedle = '  index,\n';
if (!schema.includes(importNeedle)) {
  throw new Error('Expected index import not found in operator_missions schema');
}
schema = schema.replace(importNeedle, '  index,\n  uniqueIndex,\n');

const oldIndex = `    companyMissionIdIdx: index("operator_missions_company_mission_id_idx").on(\n      table.companyId,\n      table.missionId,\n    ),`;
const newIndex = `    companyMissionIdUq: uniqueIndex("operator_missions_company_mission_id_uq").on(\n      table.companyId,\n      table.missionId,\n    ),`;

if (!schema.includes(oldIndex)) {
  throw new Error('Expected non-unique operator mission index block not found');
}
schema = schema.replace(oldIndex, newIndex);

if (schema.includes('companyMissionIdIdx: index("operator_missions_company_mission_id_idx")')) {
  throw new Error('Non-unique operator mission index remained after replacement');
}

await writeFile(schemaPath, schema);

const migration = `-- QSL staging precondition proved 0 duplicate (company_id, mission_id) pairs on 2026-08-16.\n-- Create enforcement first, then remove the redundant non-unique index in the same migration transaction.\nCREATE UNIQUE INDEX IF NOT EXISTS "operator_missions_company_mission_id_uq"\n  ON "operator_missions" USING btree ("company_id","mission_id");\n--> statement-breakpoint\nDROP INDEX IF EXISTS "operator_missions_company_mission_id_idx";\n`;
await writeFile(migrationPath, migration);

const journal = JSON.parse(await readFile(journalPath, 'utf8'));
if (!Array.isArray(journal.entries)) {
  throw new Error('Migration journal entries missing');
}
const last = journal.entries.at(-1);
if (last?.idx !== 183 || last?.tag !== '0183_operator_missions') {
  throw new Error(`Unexpected journal tail: ${JSON.stringify(last)}`);
}
if (journal.entries.some((entry) => entry?.tag === '0184_operator_mission_company_mission_unique')) {
  throw new Error('0184 journal entry already exists');
}

journal.entries.push({
  idx: 184,
  version: '7',
  when: Date.now(),
  tag: '0184_operator_mission_company_mission_unique',
  breakpoints: true,
});

await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

console.log('Prepared 0184 operator mission uniqueness migration and schema metadata.');
