// One-shot bulk copy of ExpenseFlow MI distribution values.
//
// Source: template 61522cba81c7a12e506c6612 (Scheme_30A_ExpenseFlow)
//         version 8f2285c241a63bc1a1972387 (pilot values)
// Target: template 03ddf54118cf19fd488f7b15 (Scheme_33(7)+33(12B)_ExpenseFlow)
//         version 940d0cb6665c3f2819a0dc94 (edit draft)
//
// Match by key equality. Only copies non-empty, non-zero source values.
// Keys follow the identical pattern efm_pred_cost{N}_m{M} / efm_act_cost{N}_m{M}
// on both templates, so a straight key JOIN is safe.
//
// Usage:
//   node _copy_expenseflow_values_33_7_33_12b.mjs           # preview counts only
//   node _copy_expenseflow_values_33_7_33_12b.mjs --apply   # actually run the UPDATE
//   node _copy_expenseflow_values_33_7_33_12b.mjs --dry     # same as no flag
import { getSql } from "./v3/db/index.js";

const SCHEMA = process.env.DB_SCHEMA ?? "prod";
const MI = `"${SCHEMA}"."v3_master_input"`;

const SRC_TPL = "61522cba81c7a12e506c6612";
const SRC_VER = "8f2285c241a63bc1a1972387";
const SRC_SEC = "Scheme_30A_ExpenseFlow";

const TGT_TPL = "03ddf54118cf19fd488f7b15";
const TGT_VER = "940d0cb6665c3f2819a0dc94";
const TGT_SEC = "Scheme_33(7)+33(12B)_ExpenseFlow";

const APPLY = process.argv.includes("--apply");
const DRY = process.argv.includes("--dry") || !APPLY;

const sql = getSql();

async function preview() {
  const cnt = await sql.unsafe(
    `SELECT COUNT(*) AS n
     FROM ${MI} src
     JOIN ${MI} tgt ON tgt.key = src.key
     WHERE src.template_id = $1 AND src.version_id = $2 AND src.section = $3
       AND src.value IS NOT NULL AND src.value != '' AND src.value != '0'
       AND tgt.template_id = $4 AND tgt.version_id = $5 AND tgt.section = $6
       AND (tgt.value IS DISTINCT FROM src.value)`,
    [SRC_TPL, SRC_VER, SRC_SEC, TGT_TPL, TGT_VER, TGT_SEC]
  );
  console.log(`Rows that WOULD be updated: ${cnt[0].n}`);

  const orphans = await sql.unsafe(
    `SELECT COUNT(*) AS n FROM ${MI} src
     WHERE src.template_id = $1 AND src.version_id = $2 AND src.section = $3
       AND src.value IS NOT NULL AND src.value != '' AND src.value != '0'
       AND NOT EXISTS (
         SELECT 1 FROM ${MI} tgt
         WHERE tgt.template_id = $4 AND tgt.version_id = $5 AND tgt.section = $6
           AND tgt.key = src.key
       )`,
    [SRC_TPL, SRC_VER, SRC_SEC, TGT_TPL, TGT_VER, TGT_SEC]
  );
  console.log(`Source keys with values but no matching target key: ${orphans[0].n}`);
}

async function apply() {
  const res = await sql.unsafe(
    `UPDATE ${MI} AS tgt
     SET value = src.value
     FROM ${MI} AS src
     WHERE tgt.template_id = $4 AND tgt.version_id = $5 AND tgt.section = $6
       AND src.template_id = $1 AND src.version_id = $2 AND src.section = $3
       AND src.key = tgt.key
       AND src.value IS NOT NULL AND src.value != '' AND src.value != '0'
       AND tgt.value IS DISTINCT FROM src.value`,
    [SRC_TPL, SRC_VER, SRC_SEC, TGT_TPL, TGT_VER, TGT_SEC]
  );
  console.log(`Updated rows: ${res.count}`);
  return res.count;
}

let appliedCount = 0;
try {
  console.log(`Schema: ${SCHEMA}`);
  console.log(`Source: tpl=${SRC_TPL} ver=${SRC_VER} sec=${SRC_SEC}`);
  console.log(`Target: tpl=${TGT_TPL} ver=${TGT_VER} sec=${TGT_SEC}`);
  console.log(`Mode:   ${APPLY ? "APPLY" : "DRY (preview only)"}`);
  console.log("");

  await preview();

  if (APPLY) {
    console.log("");
    console.log("--apply flag detected. Running UPDATE...");
    appliedCount = await apply();
    console.log("");
    console.log("Post-update preview (should be 0):");
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
