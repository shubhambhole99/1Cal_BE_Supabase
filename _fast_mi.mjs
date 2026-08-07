// Fast bulk master-input operations via a SINGLE raw SQL UPDATE.
// One round-trip to the DB instead of thousands of HTTP PATCHes.
//
// Usage:
//   node _fast_mi.mjs reassign-expense-groups
//   node _fast_mi.mjs zero-actuals
//   node _fast_mi.mjs verify
import { getSql } from "./v3/db/index.js";

const SCHEMA = process.env.DB_SCHEMA ?? "prod";
const MI = `"${SCHEMA}"."v3_master_input"`;
const GRP = `"${SCHEMA}"."v3_master_input_group"`;
const TPL = "61522cba81c7a12e506c6612";
const VER = "8f2285c241a63bc1a1972387";

const sql = getSql();

async function reassignExpenseGroups() {
  // 1. Fetch the 37 per-cost groups (key = efm_cost{N})
  const groups = await sql.unsafe(
    `SELECT id, key FROM ${GRP}
     WHERE template_id = $1 AND version_id = $2 AND key ~ '^efm_cost[0-9]+$'`,
    [TPL, VER]
  );
  const map = groups
    .map((g) => [parseInt(g.key.replace("efm_cost", ""), 10), g.id])
    .filter(([n]) => Number.isFinite(n));
  console.log(`Groups found: ${map.length}`);
  if (map.length === 0) throw new Error("No efm_cost groups found");

  // 2. ONE UPDATE: join MIs to the (cost_n -> group_id) mapping via VALUES.
  //    Cost number extracted from key pattern efm_(pred|act)_cost{N}_m{M}.
  const valuesClause = map.map(([n, id]) => `(${n}, '${id}')`).join(",");
  const res = await sql.unsafe(
    `UPDATE ${MI} AS mi
     SET group_id = m.gid, section = 'Scheme_30A_ExpenseFlow'
     FROM (VALUES ${valuesClause}) AS m(cost_n, gid)
     WHERE mi.template_id = $1
       AND mi.version_id = $2
       AND mi.key ~ '^efm_(pred|act)_cost[0-9]+_m[0-9]+$'
       AND (substring(mi.key from 'cost([0-9]+)_m'))::int = m.cost_n
       AND (mi.group_id IS DISTINCT FROM m.gid)`,
    [TPL, VER]
  );
  console.log(`Reassigned rows: ${res.count}`);
}

async function zeroActuals() {
  const res = await sql.unsafe(
    `UPDATE ${MI}
     SET value = '0'
     WHERE template_id = $1 AND version_id = $2
       AND key LIKE 'efm_act_%'
       AND value IS DISTINCT FROM '0'`,
    [TPL, VER]
  );
  console.log(`Zeroed actual MIs: ${res.count}`);
}

async function verify() {
  const rows = await sql.unsafe(
    `SELECT g.display_name, count(*) AS n
     FROM ${MI} mi
     JOIN ${GRP} g ON g.id = mi.group_id
     WHERE mi.template_id = $1 AND mi.version_id = $2
       AND mi.key ~ '^efm_(pred|act)_cost[0-9]+_m[0-9]+$'
     GROUP BY g.display_name ORDER BY g.display_name`,
    [TPL, VER]
  );
  console.log("Per-group MI counts:");
  for (const r of rows) console.log(`  ${r.display_name}: ${r.n}`);
  const total = rows.reduce((a, r) => a + parseInt(r.n, 10), 0);
  console.log(`  TOTAL: ${total}`);
}

const cmd = process.argv[2];
try {
  if (cmd === "reassign-expense-groups") await reassignExpenseGroups();
  else if (cmd === "zero-actuals") await zeroActuals();
  else if (cmd === "verify") await verify();
  else if (cmd === "all") { await zeroActuals(); await reassignExpenseGroups(); await verify(); }
  else console.log("commands: reassign-expense-groups | zero-actuals | verify | all");
} catch (e) {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
