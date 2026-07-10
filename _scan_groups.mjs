// READ-ONLY: for template "All Feasibilities", how many master inputs in each
// version are actually linked to a group (group_id set)? Finds where the real
// grouped structure lives — i.e. whether the export is dropping grouping.
import fs from "node:fs";
import postgres from "postgres";

const env = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
const url = (env.match(/^DATABASE_URL\s*=\s*"([^"]+)"/m) || [])[1];
const schema = (env.match(/^DB_SCHEMA\s*=\s*"?([A-Za-z0-9_]+)"?/m) || [])[1] || "prod";
const TID = "278ae332cfe0af1b00c6a598";
const ref = (url.match(/postgres\.([a-z0-9]+):/) || [])[1] || "?";
console.log(`DB ref: ${ref}  schema: ${schema}\n`);

const sql = postgres(url, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 15 });
try {
  const rows = await sql.unsafe(`
    SELECT v.label, v.id,
           count(mi.*)::int          AS total,
           count(mi.group_id)::int    AS grouped,
           count(DISTINCT mi.section)::int AS sections
    FROM ${schema}.v3_versions v
    LEFT JOIN ${schema}.v3_master_input mi ON mi.version_id = v.id
    WHERE v.template_id = $1
    GROUP BY v.id, v.label
    ORDER BY grouped DESC, total DESC
  `, [TID]);
  console.log("  grouped / total   secs  version (id)");
  console.log("  ---------------------------------------------------");
  for (const r of rows) {
    const star = r.grouped > 0 ? "★" : " ";
    console.log(`  ${star} ${String(r.grouped).padStart(5)}/${String(r.total).padStart(6)}   ${String(r.sections).padStart(3)}   ${r.label}  (${r.id})`);
  }
  // sample grouped rows from the best version, if any
  const best = rows.find(r => r.grouped > 0);
  if (best) {
    console.log(`\nSample grouped inputs from "${best.label}":`);
    const s = await sql.unsafe(`
      SELECT mi.section, mi.key, mi.group_id, g.display_name AS group_name
      FROM ${schema}.v3_master_input mi
      LEFT JOIN ${schema}.v3_master_input_group g ON g.id = mi.group_id
      WHERE mi.version_id = $1 AND mi.group_id IS NOT NULL
      LIMIT 12
    `, [best.id]);
    s.forEach(r => console.log(`   [${r.section}] ${r.key}  ->  group "${r.group_name}"`));
  } else {
    console.log("\n>>> NO version has ANY grouped inputs. The grouping is not stored as group_id anywhere.");
  }
} catch (e) {
  console.log("ERROR:", e.message);
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(0);
