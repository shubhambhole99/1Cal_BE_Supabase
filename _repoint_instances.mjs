// Re-point OLD v3 instances from the "All Feasibilities" monolith to their
// calculation's per-scheme re-template. Resolution is by MI name (template_mi_key),
// so this is a metadata-only change: set template_id, leave version_id NULL, and
// every saved value follows by name. Only instances with a clean calculation→
// per-scheme mapping are touched (the 61); the 64 without a calculation_id are left.
//
//   node _repoint_instances.mjs           # dry run (+ writes a rollback backup)
//   node _repoint_instances.mjs --apply   # execute
//   node _repoint_instances.mjs --rollback# restore from the backup file

import { config } from "dotenv";
config({ override: true });
import { getSql } from "./v3/db/index.js";
import { writeFileSync, readFileSync, existsSync } from "fs";

const SCHEMA = process.env.DB_SCHEMA ?? "prod";
const T = (t) => `"${SCHEMA}"."${t}"`;
const MONO = "278ae332cfe0af1b00c6a598";
const APPLY = process.argv.includes("--apply");
const ROLLBACK = process.argv.includes("--rollback");
const BACKUP = "C:/Users/Shubham(Code)/Desktop/Reservation Calculator/_instance_repoint_backup.json";

const sql = getSql();
try {
  if (ROLLBACK) {
    if (!existsSync(BACKUP)) throw new Error("no backup file to roll back from");
    const bak = JSON.parse(readFileSync(BACKUP, "utf8"));
    let n = 0;
    for (const b of bak) {
      const res = await sql.unsafe(
        `UPDATE ${T("v3_instances")} SET template_id = $1, version_id = $2, updated_at = now() WHERE id = $3`,
        [b.old_template_id, b.version_id ?? null, b.id],
      );
      n += res.count ?? 0;
    }
    console.log(`ROLLBACK: restored ${n}/${bak.length} instances to their old template_id`);
    process.exit(0);
  }

  // The auto-mappable set: monolith instances whose calc points at a real per-scheme template.
  const rows = await sql.unsafe(
    `SELECT i.id, i.name, i.template_id AS old_template_id, i.version_id, i.calculation_id,
            c.name AS calc_name, c.retemplate_id AS target_template_id
       FROM ${T("v3_instances")} i
       JOIN ${T("v3_calculations")} c ON c.id = i.calculation_id
      WHERE i.template_id = $1
        AND i.calculation_id IS NOT NULL
        AND c.retemplate_id IS NOT NULL
        AND c.retemplate_id <> $1
      ORDER BY c.name, i.name`,
    [MONO],
  );

  console.log(`Calc-mapped monolith instances: ${rows.length}  ·  mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);
  const byCalc = new Map();
  for (const r of rows) {
    if (!byCalc.has(r.calc_name)) byCalc.set(r.calc_name, { n: 0, target: r.target_template_id });
    byCalc.get(r.calc_name).n++;
  }
  console.log("Per calculation → target per-scheme template:");
  for (const [name, { n, target }] of byCalc) console.log(`  ${String(n).padStart(3)}  ${name.padEnd(32)} → ${target}`);

  // Rollback backup (old template_id + version_id per instance).
  writeFileSync(BACKUP, JSON.stringify(
    rows.map((r) => ({ id: r.id, name: r.name, old_template_id: r.old_template_id, version_id: r.version_id, calculation_id: r.calculation_id, target_template_id: r.target_template_id })),
    null, 2));
  console.log(`\nBackup written → ${BACKUP} (${rows.length} rows)`);

  if (APPLY) {
    const ids = rows.map((r) => r.id);
    const targets = rows.map((r) => r.target_template_id);
    const res = await sql.unsafe(
      `UPDATE ${T("v3_instances")} AS i
          SET template_id = t.target, updated_at = now()
         FROM unnest($1::text[], $2::text[]) AS t(id, target)
        WHERE i.id = t.id AND i.template_id = $3`,
      [ids, targets, MONO],
    );
    console.log(`\nAPPLIED: updated ${res.count} instances`);
    const [{ remaining }] = await sql.unsafe(
      `SELECT COUNT(*)::int AS remaining
         FROM ${T("v3_instances")} i JOIN ${T("v3_calculations")} c ON c.id = i.calculation_id
        WHERE i.template_id = $1 AND c.retemplate_id <> $1`,
      [MONO],
    );
    console.log(`Verify: calc-mapped instances still on monolith = ${remaining} (expect 0)`);
  } else {
    console.log(`\n(dry run — pass --apply to write; --rollback to undo)`);
  }
} finally {
  await sql.end();
}
