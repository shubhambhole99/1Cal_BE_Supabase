// One-shot bulk copy of RevenueFlow MI distribution values.
//
// Source: template 61522cba81c7a12e506c6612 (Scheme_30A_RevenueFlow)
//         version 8f2285c241a63bc1a1972387 (has realistic distribution values)
// Target: template cb3e949b633809ecaf39e9b8 (Scheme_30(A)+33(7A)_RevenueFlow)
//         version 69d422a15c015e018d7b39b1 (blank / all zero)
//
// Covers:
//   - Sales Distribution (resi, comm, retail, parking) — ~336 MIs
//   - Custom Price (resi, comm, retail, parking) — ~336 MIs (mostly zeros; copy them anyway)
//   - Collection Slab % — ~144 MIs
//
// Match by (group.key, mi.key). Copies EVERY row, including zeros/blanks
// (Custom Price defaults to 0 = "no override"; we want to preserve that).
//
// Usage:
//   node _copy_revenueflow_values.mjs           # preview counts only
//   node _copy_revenueflow_values.mjs --apply   # actually run the UPDATE
import { getSql } from "./v3/db/index.js";

const SCHEMA = process.env.DB_SCHEMA ?? "prod";
const MI = `"${SCHEMA}"."v3_master_input"`;
const MIG = `"${SCHEMA}"."v3_master_input_group"`;

const SRC_TPL = "61522cba81c7a12e506c6612";
const SRC_VER = "8f2285c241a63bc1a1972387";
const SRC_SEC = "Scheme_30A_RevenueFlow";

const TGT_TPL = "cb3e949b633809ecaf39e9b8";
const TGT_VER = "69d422a15c015e018d7b39b1";
const TGT_SEC = "Scheme_30(A)+33(7A)_RevenueFlow";

const APPLY = process.argv.includes("--apply");

const sql = getSql();

// Match on (group.key, mi.key). Include ALL rows even zeros/blanks
// because Custom Price zeros are meaningful ("no override" default).
const JOIN_SQL = `
  ${MI} src
  JOIN ${MIG} srcg ON srcg.id = src.group_id
                   AND srcg.template_id = $1
                   AND srcg.version_id = $2
                   AND srcg.section = $3
  JOIN ${MIG} tgtg ON tgtg.key = srcg.key
                   AND tgtg.template_id = $4
                   AND tgtg.version_id = $5
                   AND tgtg.section = $6
  JOIN ${MI} tgt ON tgt.group_id = tgtg.id
                 AND tgt.key = src.key
                 AND tgt.template_id = $4
                 AND tgt.version_id = $5
`;

const PARAMS = [SRC_TPL, SRC_VER, SRC_SEC, TGT_TPL, TGT_VER, TGT_SEC];

async function preview() {
  // Total matched pairs
  const total = await sql.unsafe(
    `SELECT COUNT(*) AS n FROM ${JOIN_SQL} WHERE src.template_id = $1 AND src.version_id = $2`,
    PARAMS
  );
  console.log(`Total matched (src key, tgt key) pairs: ${total[0].n}`);

  // Would-be-changed rows
  const changed = await sql.unsafe(
    `SELECT COUNT(*) AS n FROM ${JOIN_SQL}
     WHERE src.template_id = $1 AND src.version_id = $2
       AND (tgt.value IS DISTINCT FROM src.value)`,
    PARAMS
  );
  console.log(`Rows that WOULD be updated (value differs): ${changed[0].n}`);

  // Breakdown by group
  const byGroup = await sql.unsafe(
    `SELECT srcg.key AS group_key, COUNT(*) AS n,
            SUM(CASE WHEN tgt.value IS DISTINCT FROM src.value THEN 1 ELSE 0 END) AS changes
     FROM ${JOIN_SQL}
     WHERE src.template_id = $1 AND src.version_id = $2
     GROUP BY srcg.key
     ORDER BY srcg.key`,
    PARAMS
  );
  console.log("\nBy group:");
  byGroup.forEach((r) => {
    console.log(`  ${r.group_key.padEnd(30)} total=${String(r.n).padStart(4)}  changes=${r.changes}`);
  });

  // Orphans (source has group but target does not)
  const orphans = await sql.unsafe(
    `SELECT DISTINCT srcg.key AS group_key
     FROM ${MIG} srcg
     WHERE srcg.template_id = $1
       AND srcg.version_id = $2
       AND srcg.section = $3
       AND NOT EXISTS (
         SELECT 1 FROM ${MIG} tgtg
         WHERE tgtg.key = srcg.key
           AND tgtg.template_id = $4
           AND tgtg.version_id = $5
           AND tgtg.section = $6
       )`,
    PARAMS
  );
  if (orphans.length > 0) {
    console.log("\nSource groups with NO matching target group:");
    orphans.forEach((r) => console.log(`  ${r.group_key}`));
  } else {
    console.log("\nAll source groups have a matching target group.");
  }
}

async function apply() {
  const res = await sql.unsafe(
    `UPDATE ${MI} AS tgt_upd
     SET value = src.value
     FROM ${MI} AS src
     JOIN ${MIG} AS srcg ON srcg.id = src.group_id
                          AND srcg.template_id = $1
                          AND srcg.version_id = $2
                          AND srcg.section = $3
     JOIN ${MIG} AS tgtg ON tgtg.key = srcg.key
                          AND tgtg.template_id = $4
                          AND tgtg.version_id = $5
                          AND tgtg.section = $6
     WHERE tgt_upd.group_id = tgtg.id
       AND tgt_upd.key = src.key
       AND tgt_upd.template_id = $4
       AND tgt_upd.version_id = $5
       AND (tgt_upd.value IS DISTINCT FROM src.value)`,
    PARAMS
  );
  console.log(`Updated rows: ${res.count}`);
  return res.count;
}

let appliedCount = 0;
try {
  console.log(`Schema: ${SCHEMA}`);
  console.log(`Source: tpl=${SRC_TPL} ver=${SRC_VER} sec=${SRC_SEC}`);
  console.log(`Target: tpl=${TGT_TPL} ver=${TGT_VER} sec=${TGT_SEC}`);
  console.log("");

  await preview();

  if (APPLY) {
    console.log("");
    console.log("--apply flag detected. Running UPDATE...");
    appliedCount = await apply();
    console.log("");
    console.log("Post-update preview (changes should be 0):");
    await preview();
    console.log("");
    console.log(`__APPLIED_COUNT__=${appliedCount}`);
  } else {
    console.log("");
    console.log("Preview only. Re-run with --apply to execute the UPDATE.");
  }
} catch (e) {
  console.error("ERROR:", e.message);
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  await sql.end();
}
