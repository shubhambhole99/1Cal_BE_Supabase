// Migrate JSON backup to TEST database (xwfsmegipuwgyuwqeehw)
// Source: H:\...\feasibility_psql_2026-04-23_16-51-28\
// Target: xwfsmegipuwgyuwqeehw in 'prod' schema

// Override env before loading dotenv
process.env.DATABASE_URL = "postgresql://postgres.xwfsmegipuwgyuwqeehw:mlpnkobjivhu@aws-1-ap-south-1.pooler.supabase.com:6543/postgres";
process.env.DB_SCHEMA = "prod";
import postgres from "postgres";
import { readFile } from "fs/promises";
import { readdirSync } from "fs";
import { join } from "path";

const TEST_DB = "postgresql://postgres.xwfsmegipuwgyuwqeehw:mlpnkobjivhu@aws-1-ap-south-1.pooler.supabase.com:6543/postgres";
const BACKUP_DIR = "H:/My Drive/A Github CodeBases/Github 19-03-2025/20.MongoDbCronJob/Clickable Option/feasibility_psql_2026-04-23_16-51-28";
const SCHEMA = "prod";
const BATCH_SIZE = 100;

// Table load order (parents first, children last for FKs)
const LOAD_ORDER = [
  "__drizzle_migrations",
  "users",
  "about_us",
  "contacts",
  "bills",
  "file_templates",
  "pdf_download_logs",
  "templates",
  "versions",
  "direct_feasibilities",
  "stories",
  "files",
  "slides",
  "comment_threads",
  "comments",
];

async function main() {
  console.log("Connecting to TEST DB...");
  const sql = postgres(TEST_DB, { prepare: false, max: 1, idle_timeout: 30 });

  try {
    // Ensure schema exists
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);

    // Check existing tables
    const existing = await sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${SCHEMA}
    `;
    console.log(`Existing tables in ${SCHEMA}:`, existing.map(r => r.table_name).join(", ") || "(none)");
    const existingSet = new Set(existing.map(r => r.table_name));

    const sql2 = sql;

    const ref = (t) => `"${SCHEMA}"."${t}"`;

    for (const table of LOAD_ORDER) {
      const filePath = join(BACKUP_DIR, `${table}.json`);
      console.log(`\n=== ${table} ===`);

      let data;
      try {
        const raw = await readFile(filePath, "utf8");
        data = JSON.parse(raw);
      } catch (e) {
        console.log(`  SKIP: ${e.message}`);
        continue;
      }

      if (!Array.isArray(data) || data.length === 0) {
        console.log(`  Empty, skip`);
        continue;
      }

      // If table doesn't exist, create it with columns inferred from first row
      if (!existingSet.has(table)) {
        const sample = data[0];
        const colDefs = Object.keys(sample).map((k) => {
          const v = sample[k];
          let t = "text";
          if (typeof v === "boolean") t = "boolean";
          else if (typeof v === "number") t = Number.isInteger(v) ? "integer" : "double precision";
          else if (v && typeof v === "object") t = "jsonb";
          else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) t = "timestamptz";
          return `"${k}" ${t}`;
        });
        // Primary key on 'id' if exists
        const pk = sample.id !== undefined ? ", PRIMARY KEY (\"id\")" : "";
        try {
          await sql2.unsafe(`CREATE TABLE ${ref(table)} (${colDefs.join(", ")}${pk})`);
          console.log(`  Created table with ${colDefs.length} cols`);
        } catch (e) {
          console.log(`  Create failed: ${e.message}`);
          continue;
        }
      }

      // Get actual columns in target table
      const actualCols = await sql2`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${SCHEMA} AND table_name = ${table}
      `;
      const colSet = new Set(actualCols.map((c) => c.column_name));

      // Truncate target
      try {
        await sql2.unsafe(`TRUNCATE TABLE ${ref(table)} CASCADE`);
        console.log(`  Truncated`);
      } catch (e) {
        console.log(`  Truncate failed: ${e.message}`);
      }

      // Insert in batches
      const keys = Object.keys(data[0]).filter((k) => colSet.has(k));
      console.log(`  Rows: ${data.length}, Cols: ${keys.length}/${Object.keys(data[0]).length}`);

      let inserted = 0;
      for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = data.slice(i, i + BATCH_SIZE);
        try {
          await sql2.unsafe(
            `INSERT INTO ${ref(table)} (${keys.map((k) => `"${k}"`).join(",")}) VALUES ${batch
              .map(
                (_, bi) =>
                  `(${keys.map((_, ki) => `$${bi * keys.length + ki + 1}`).join(",")})`
              )
              .join(",")}`,
            batch.flatMap((row) =>
              keys.map((k) => {
                const v = row[k];
                if (v === null || v === undefined) return null;
                if (typeof v === "object") return JSON.stringify(v);
                return v;
              })
            )
          );
          inserted += batch.length;
          if (i % 1000 === 0) process.stdout.write(`    ${inserted}/${data.length}\r`);
        } catch (e) {
          console.log(`\n  ERROR at row ${i}: ${e.message.substring(0, 200)}`);
          // Try single-row inserts to isolate the bad row
          for (const row of batch) {
            try {
              const vals = keys.map((k) => {
                const v = row[k];
                if (v === null || v === undefined) return null;
                if (typeof v === "object") return JSON.stringify(v);
                return v;
              });
              await sql2.unsafe(
                `INSERT INTO ${ref(table)} (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, ki) => `$${ki + 1}`).join(",")})`,
                vals
              );
              inserted++;
            } catch (e2) {
              console.log(`    Skip row ${row.id || "?"}: ${e2.message.substring(0, 100)}`);
            }
          }
        }
      }
      console.log(`  Inserted: ${inserted}/${data.length}`);
    }

    await sql2.end();
    console.log("\n✓ Migration complete");
  } catch (err) {
    console.error("FATAL:", err);
    await sql.end().catch(() => {});
    process.exit(1);
  }
}

main();
