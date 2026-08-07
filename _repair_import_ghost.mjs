// One-shot repair for a corrupted draft state where a page is flagged
// as imported but the import-link is stale, causing the mirror to
// re-clobber the page on every reconcile.
//
// Actions (idempotent):
//   1. DELETE stale row from v3_page_imports for
//      template_id='cb3e949b633809ecaf39e9b8', page_name='ParametersOne'
//   2. UPDATE v3_pages SET is_imported=FALSE for id='54e6f95926686d9590446bcf'
//
// Safe to re-run: DELETE affects 0 rows once gone, UPDATE is a no-op
// once is_imported is already FALSE.
//
// Usage:
//   node _repair_import_ghost.mjs
import { getSql } from "./v3/db/index.js";

const SCHEMA = process.env.DB_SCHEMA ?? "prod";
const PAGE_IMPORTS = `"${SCHEMA}"."v3_page_imports"`;
const PAGES = `"${SCHEMA}"."v3_pages"`;

const TEMPLATE_ID = "cb3e949b633809ecaf39e9b8";
const PAGE_NAME = "ParametersOne";
const PAGE_ID = "54e6f95926686d9590446bcf";

const sql = getSql();

async function repair() {
  console.log(`Schema: ${SCHEMA}`);
  console.log(`Target template_id: ${TEMPLATE_ID}`);
  console.log(`Target page_name:   ${PAGE_NAME}`);
  console.log(`Target page_id:     ${PAGE_ID}`);
  console.log("");

  // 1. Delete stale import link.
  const delRes = await sql.unsafe(
    `DELETE FROM ${PAGE_IMPORTS}
     WHERE template_id = $1 AND page_name = $2`,
    [TEMPLATE_ID, PAGE_NAME]
  );
  console.log(`[1/2] DELETE from v3_page_imports: ${delRes.count} row(s) removed`);

  // 2. Flip the page back to local.
  const updRes = await sql.unsafe(
    `UPDATE ${PAGES}
     SET is_imported = FALSE
     WHERE id = $1 AND is_imported IS DISTINCT FROM FALSE`,
    [PAGE_ID]
  );
  console.log(`[2/2] UPDATE v3_pages set is_imported=FALSE: ${updRes.count} row(s) changed`);

  console.log("");
  console.log("Repair complete.");
}

try {
  await repair();
} catch (e) {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
