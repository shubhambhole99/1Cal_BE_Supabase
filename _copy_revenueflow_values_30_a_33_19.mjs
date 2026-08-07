// One-shot bulk copy of RevenueFlow MI distribution values.
//
// Source: template 61522cba81c7a12e506c6612 (Scheme_30A_RevenueFlow)
//         version 8f2285c241a63bc1a1972387 (pilot values)
// Target: template 210c89739b1a0720a6b2efe0 (Scheme_30(A)+33(19)_RevenueFlow)
//         version eca52a81c0ac5b1888e1fd04 (edit draft)
//
// Covers:
//   - Sales Distribution (resi, comm, retail, parking)
//   - Custom Price (resi, comm, retail, parking) — copy zeros too (defaults are meaningful)
//   - Collection Slab % (rfm_collslab) — DUPLICATE keys exist on 30A source;
//     use DISTINCT ON (key) ORDER BY value::float DESC NULLS LAST so the raw
//     human-entered number wins over any derived duplicate row (0/blank).
//
// Match by (group.key, mi.key). Copies EVERY row, including zeros/blanks,
// because Custom Price zeros are meaningful ("no override" default).
//
// Usage:
//   node _copy_revenueflow_values_30_a_33_19.mjs           # preview counts only
//   node _copy_revenueflow_values_30_a_33_19.mjs --apply   # actually run the UPDATE
//   node _copy_revenueflow_values_30_a_33_19.mjs --dry     # same as no flag
import { getSql } from "./v3/db/index.js";

const SCHEMA = process.env.DB_SCHEMA ?? "prod";
const MI = `"${SCHEMA}"."v3_master_input"`;
const MIG = `"${SCHEMA}"."v3_master_input_group"`;

const SRC_TPL = "61522cba81c7a12e506c6612";
const SRC_VER = "8f2285c241a63bc1a1972387";
const SRC_SEC = "Scheme_30A_RevenueFlow";

const TGT_TPL = "210c89739b1a0720a6b2efe0";
const TGT_VER = "eca52a81c0ac5b1888e1fd04";
const TGT_SEC = "Scheme_30(A)+33(19)_RevenueFlow";

// rfm_collslab has duplicate keys on 30A source. Everywhere else keys are unique.
const COLLSLAB_GROUP_KEY = "rfm_collslab";

const APPLY = process.argv.includes("--apply");
const DRY = process.argv.includes("--dry") || !APPLY;

const sql = getSql();

// Deduped source CTE:
//   - For non-collslab groups, keys are already unique; DISTINCT ON is a no-op.
//   - For rfm_collslab (dup keys), keep the row with the highest numeric value,
//     which reliably picks the human-entered slab % over the derived 0 duplicate.
//   - Sort NULLS/blanks LAST so a real number always wins.
const SRC_DEDUPED = `
  SELECT DISTINCT ON (srcg.key, src.key)
         srcg.key AS group_key,
         src.key  AS mi_key,
         src.value AS value
  FROM ${MI} src
  JOIN ${MIG} srcg ON srcg.id = src.group_id
                   AND srcg.template_id = $1
                   AND srcg.version_id = $2
                   AND srcg.section = $3
  WHERE src.template_id = $1
    AND src.version_id = $2
  ORDER BY srcg.key,
           src.key,
           CASE
             WHEN src.value IS NULL OR src.value = '' THEN 1
             ELSE 0
           END,
           NULLIF(src.value, '')::float DESC NULLS LAST
`;

const PARAMS = [SRC_TPL, SRC_VER, SRC_SEC, TGT_TPL, TGT_VER, TGT_SEC];

async function preview() {
  const total = await sql.unsafe(
    `WITH src_dedup AS (${SRC_DEDUPED})
     SELECT COUNT(*) AS n
     FROM src_dedup s
     JOIN ${MIG} tgtg ON tgtg.key = s.group_key
                      AND tgtg.template_id = $4
                      AND tgtg.version_id = $5
                      AND tgtg.section = $6
     JOIN ${MI} tgt ON tgt.group_id = tgtg.id
                    AND tgt.key = s.mi_key
                    AND tgt.template_id = $4
                    AND tgt.version_id = $5`,
    PARAMS
  );
  console.log(`Total matched (src key, tgt key) pairs (deduped): ${total[0].n}`);

  const changed = await sql.unsafe(
    `WITH src_dedup AS (${SRC_DEDUPED})
     SELECT COUNT(*) AS n
     FROM src_dedup s
     JOIN ${MIG} tgtg ON tgtg.key = s.group_key
                      AND tgtg.template_id = $4
                      AND tgtg.version_id = $5
                      AND tgtg.section = $6
     JOIN ${MI} tgt ON tgt.group_id = tgtg.id
                    AND tgt.key = s.mi_key
                    AND tgt.template_id = $4
                    AND tgt.version_id = $5
     WHERE tgt.value IS DISTINCT FROM s.value`,
    PARAMS
  );
  console.log(`Rows that WOULD be updated (value differs): ${changed[0].n}`);

  const byGroup = await sql.unsafe(
    `WITH src_dedup AS (${SRC_DEDUPED})
     SELECT s.group_key,
            COUNT(*) AS n,
            SUM(CASE WHEN tgt.value IS DISTINCT FROM s.value THEN 1 ELSE 0 END) AS changes
     FROM src_dedup s
     JOIN ${MIG} tgtg ON tgtg.key = s.group_key
                      AND tgtg.template_id = $4
                      AND tgtg.version_id = $5
                      AND tgtg.section = $6
     JOIN ${MI} tgt ON tgt.group_id = tgtg.id
                    AND tgt.key = s.mi_key
                    AND tgt.template_id = $4
                    AND tgt.version_id = $5
     GROUP BY s.group_key
     ORDER BY s.group_key`,
    PARAMS
  );
  console.log("\nBy group:");
  byGroup.forEach((r) => {
    console.log(`  ${r.group_key.padEnd(30)} total=${String(r.n).padStart(4)}  changes=${r.changes}`);
  });

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
    `WITH src_dedup AS (${SRC_DEDUPED})
     UPDATE ${MI} AS tgt_upd
     SET value = s.value
     FROM src_dedup s
     JOIN ${MIG} AS tgtg ON tgtg.key = s.group_key
                          AND tgtg.template_id = $4
                          AND tgtg.version_id = $5
                          AND tgtg.section = $6
     WHERE tgt_upd.group_id = tgtg.id
       AND tgt_upd.key = s.mi_key
       AND tgt_upd.template_id = $4
       AND tgt_upd.version_id = $5
       AND (tgt_upd.value IS DISTINCT FROM s.value)`,
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
  console.log(`Note:   ${COLLSLAB_GROUP_KEY} deduped via DISTINCT ON, highest numeric wins.`);
  console.log(`Mode:   ${APPLY ? "APPLY" : "DRY (preview only)"}`);
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
