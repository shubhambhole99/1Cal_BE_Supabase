// Replicates the FE retemplate1 runJsonRestore, scoped to ONE version, driven
// entirely through the BE HTTP API (same calls the editor makes — no direct DB).
// DRY RUN by default. Pass "GO" as the 1st arg to actually write.
//
//   node _load_export.mjs            -> dry run (read-only)
//   node _load_export.mjs GO         -> execute the restore
import fs from "node:fs";

const BE = process.env.BE_URL || "http://localhost:5000";
const TEMPLATE_ID = "278ae332cfe0af1b00c6a598";
const VERSION_ID  = "25005c230cb09c90ccb065c6";        // "01-07-2026"
const FILE = "C:/Users/Shubham(Code)/Downloads/LAtest.json";
const GO = process.argv[2] === "GO";

const j = (r) => r.json();
async function api(method, path, body) {
  const res = await fetch(`${BE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res;
}
function asOptionsArray(o) {
  if (Array.isArray(o)) return o;
  if (typeof o === "string") { try { const p = JSON.parse(o); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}
const log = (...a) => console.log(...a);

// ── load export ────────────────────────────────────────────────────────────
const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
const pages = parsed.pages || [];
const backupGroups = Array.isArray(parsed.masterInputGroups) ? parsed.masterInputGroups : [];
const backupMIs = Array.isArray(parsed.masterInputs) ? parsed.masterInputs : [];

log(`\n=== LOAD ${FILE.split("/").pop()} -> template ${TEMPLATE_ID} @ version 01-07-2026 (${VERSION_ID}) ===`);
log(`mode: ${GO ? "EXECUTE (writes)" : "DRY RUN (read-only)"}`);
log(`export: ${pages.length} pages, ${backupGroups.length} groups, ${backupMIs.length} master-inputs`);

// ── current state of target version ──────────────────────────────────────────
const tpl = await api("GET", `/v3/templates/${TEMPLATE_ID}?version=${VERSION_ID}`).then(j);
const existingPages = tpl.pages || [];
const existingByName = new Map(existingPages.map((p) => [p.name, p]));
log(`\ncurrent version state: ${existingPages.length} page(s): ${existingPages.map(p=>p.name).join(", ") || "(none)"}`);

const miList = await api("GET", `/v3/templates/${TEMPLATE_ID}/master-inputs?version=${VERSION_ID}`).then(j).catch(() => ({}));
const curMIs = miList.masterInputs || [];
const curGroups = miList.masterInputGroups || [];
log(`current version MIs to WIPE: ${curMIs.length}   groups to WIPE: ${curGroups.length}`);

const willPatch = pages.filter(p => existingByName.has(p.name)).length;
const willCreate = pages.length - willPatch;
log(`\nplan:`);
log(`  1. PATCH template input_sections(${(parsed.template.input_sections||[]).length}) + page_groups(${(parsed.template.page_groups||[]).length}) @ version`);
log(`  2. pages: ${willPatch} patch-by-name, ${willCreate} create`);
log(`  3. groups: wipe ${curGroups.length}, insert ${backupGroups.length}`);
log(`  4. MIs: wipe ${curMIs.length} (1 call), insert ${backupMIs.length} (chunks of 2000 = ${Math.ceil(backupMIs.length/2000)} requests, batched INSERTs server-side)`);
log(`  sample MI keys: ${Object.keys(backupMIs[0]||{}).join(", ")}`);

if (!GO) { log(`\nDRY RUN complete — no writes made. Re-run with "GO" to execute.\n`); process.exit(0); }

// ═══════════════ EXECUTE ═══════════════
log(`\n--- 1. template meta ---`);
await api("PATCH", `/v3/templates/${TEMPLATE_ID}?version=${encodeURIComponent(VERSION_ID)}`, {
  input_sections: parsed.template.input_sections || [],
  page_groups: parsed.template.page_groups || [],
  version_id: VERSION_ID,
});
log(`  ✓ input_sections + page_groups`);

log(`--- 2. pages (${pages.length}) ---`);
for (let i = 0; i < pages.length; i++) {
  const pp = pages[i];
  const body = {
    cells: pp.cells || {}, styles: pp.styles || {}, merges: pp.merges || [],
    column_widths: pp.column_widths || {}, row_heights: pp.row_heights || {},
    row_count: pp.row_count, col_count: pp.col_count, hidden: pp.hidden ?? false,
    schemes: pp.schemes || [],
  };
  const existing = existingByName.get(pp.name);
  if (existing) {
    await api("PATCH", `/v3/pages/${existing.id}`, body);
  } else {
    await api("POST", `/v3/pages`, {
      template_id: TEMPLATE_ID, version_id: VERSION_ID, name: pp.name, ord: pp.ord ?? 0,
      ...body, row_count: body.row_count || 50, col_count: body.col_count || 26,
    });
  }
  if ((i + 1) % 10 === 0 || i === pages.length - 1) log(`  pages ${i + 1}/${pages.length}`);
}

log(`--- 3. master-input groups ---`);
for (const g of curGroups) await api("DELETE", `/v3/master-input-groups/${g.id}`).catch(() => {});
const groupIdMap = new Map();
if (backupGroups.length) {
  const gJson = await api("POST", `/v3/master-input-groups/bulk`, {
    template_id: TEMPLATE_ID, version_id: VERSION_ID,
    masterInputGroups: backupGroups.map((g, i) => ({
      key: g.key, display_name: g.display_name, section: g.section, ord: g.ord ?? i,
    })),
  }).then(j);
  const newIds = gJson.ids || [];
  for (let i = 0; i < backupGroups.length && i < newIds.length; i++) groupIdMap.set(backupGroups[i].id, newIds[i]);
  log(`  ✓ inserted ${newIds.length} groups (remap captured)`);
}

log(`--- 4. master-inputs (wipe existing in ONE call, insert ${backupMIs.length}) ---`);
const wiped = await api("POST", `/v3/master-inputs/wipe`, { template_id: TEMPLATE_ID, version_id: VERSION_ID }).then(j);
log(`  ✓ wiped ${wiped.count ?? "?"} existing MIs (single DELETE)`);
const CHUNK = 2000; // big HTTP chunks; endpoint sub-batches into 1000-row INSERTs
for (let off = 0; off < backupMIs.length; off += CHUNK) {
  const chunk = backupMIs.slice(off, off + CHUNK);
  await api("POST", `/v3/master-inputs/bulk`, {
    template_id: TEMPLATE_ID, version_id: VERSION_ID,
    masterInputs: chunk.map((mi) => ({
      key: mi.key, display_name: mi.display_name, value: mi.value, ref: mi.ref,
      type: mi.type, options: asOptionsArray(mi.options), section: mi.section,
      kind: mi.kind, group_id: mi.group_id ? (groupIdMap.get(mi.group_id) || null) : null,
      ord: mi.ord,
    })),
  });
  log(`  MIs ${Math.min(off + CHUNK, backupMIs.length)}/${backupMIs.length}`);
}

log(`\n✅ DONE. Loaded ${pages.length} pages, ${backupGroups.length} groups, ${backupMIs.length} MIs into version 01-07-2026.\n`);
process.exit(0);
