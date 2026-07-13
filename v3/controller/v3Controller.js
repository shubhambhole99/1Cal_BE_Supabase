import { getSql } from "../db/index.js";
import { newObjectId } from "../utils/objectId.js";
import { convertLegacyPage, convertLegacyMasterInputs } from "../lib/legacyToV3.js";
import { broadcast } from "../lib/events.js";

// Active editing context used to live in BE/v3/.active-context.json. That
// file path doesn't work on Vercel (read-only fs), so the active-context
// handlers below now use the `active_context` DB singleton instead. The
// fs/promises + path imports that the JSON variant needed are gone.

const SCHEMA = process.env.DB_SCHEMA ?? "prod";
const T = {
  v3_templates: `"${SCHEMA}"."v3_templates"`,
  v3_pages: `"${SCHEMA}"."v3_pages"`,
  master_input: `"${SCHEMA}"."v3_master_input"`,
  master_input_group: `"${SCHEMA}"."v3_master_input_group"`,
  v3_instances: `"${SCHEMA}"."v3_instances"`,
  instance_mi: `"${SCHEMA}"."v3_instance_master_input"`,
  v3_versions: `"${SCHEMA}"."v3_versions"`,
  v3_vdiffs: `"${SCHEMA}"."v3_version_diffs"`,
  v3_calculations: `"${SCHEMA}"."v3_calculations"`,
  dcpr_rules: `"${SCHEMA}"."mumbai_dcpr_workflow_rules"`,
  dcpr_runs: `"${SCHEMA}"."mumbai_dcpr_workflow_runs"`,
  dcpr_graph: `"${SCHEMA}"."mumbai_dcpr_workflow_graph"`,
  projects: `"${SCHEMA}"."projects"`,
  active_context: `"${SCHEMA}"."active_context"`,
  legacy_templates: `"${SCHEMA}"."templates"`,
};

// ── JSONB read normalization ──────────────────────────────────────────────────
// Several JSONB columns (master_input.options, page cells/styles/merges/
// column_widths/row_heights/columns_order/schemes/print_settings, template
// input_sections, instance collaborators/print_overrides) hold values that were
// *double-encoded* at import/migration time — a JSON string was written into the
// jsonb column. The driver unwraps one layer and hands back a STRING, so every
// frontend that does `options.map(...)` / `column_widths?.[k]` / `Array.isArray
// (input_sections)` breaks (`TypeError: (mi.options || []).map is not a function`).
//
// Parse those fields once on read. The guard only parses strings, so rows that
// are already proper JSON (clean data) pass through untouched — safe whether the
// underlying data is double-encoded or correct.
function parseJsonbStr(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value; // already parsed by the driver
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function normalizePage(p) {
  if (!p || typeof p !== "object") return p;
  const out = { ...p };
  if ("cells" in out) out.cells = parseJsonbStr(out.cells, {});
  if ("styles" in out) out.styles = parseJsonbStr(out.styles, {});
  if ("merges" in out) out.merges = parseJsonbStr(out.merges, []);
  if ("column_widths" in out) out.column_widths = parseJsonbStr(out.column_widths, {});
  if ("row_heights" in out) out.row_heights = parseJsonbStr(out.row_heights, {});
  if ("columns_order" in out) out.columns_order = parseJsonbStr(out.columns_order, []);
  if ("schemes" in out) out.schemes = parseJsonbStr(out.schemes, null);
  if ("print_settings" in out) out.print_settings = parseJsonbStr(out.print_settings, null);
  return out;
}

function normalizeMasterInput(mi) {
  if (!mi || typeof mi !== "object") return mi;
  return { ...mi, options: parseJsonbStr(mi.options, []) };
}

function normalizeTemplate(t) {
  if (!t || typeof t !== "object") return t;
  const out = { ...t };
  if ("input_sections" in out) out.input_sections = parseJsonbStr(out.input_sections, []);
  return out;
}

function normalizeInstance(inst) {
  if (!inst || typeof inst !== "object") return inst;
  const out = { ...inst };
  if ("collaborators" in out) out.collaborators = parseJsonbStr(out.collaborators, []);
  if ("print_overrides" in out) out.print_overrides = parseJsonbStr(out.print_overrides, null);
  return out;
}

// Helper — resolve the version_id for a request: explicit ?version wins,
// else the template's published_version_id.
async function resolveVersionId(sql, templateId, explicit) {
  if (explicit) return explicit;
  const [t] = await sql.unsafe(
    `SELECT published_version_id FROM ${T.v3_templates} WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  return t?.published_version_id || null;
}

// ── Published-version write guard ─────────────────────────────────────────────
// The published version is a LOCKED release: editing happens on the draft, and
// Publish promotes the draft. These helpers let content-mutating endpoints
// reject any write whose target version is the published one (403). Version-
// management handlers (createVersion / publish / restore / ensureDraft) are
// intentionally NOT guarded — they legitimately operate across versions.
const PUBLISHED_LOCK_MSG =
  "The published version is locked. Edit the draft (it auto-promotes on Publish).";
async function isPublishedVersion(sql, templateId, versionId) {
  if (!templateId || !versionId) return false;
  const [t] = await sql.unsafe(
    `SELECT published_version_id FROM ${T.v3_templates} WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  return !!(t && t.published_version_id && t.published_version_id === versionId);
}
// For by-id PATCH/DELETE: look up the row's (template_id, version_id) and check.
// Returns true when the row belongs to the published version (caller should 403).
async function rowIsPublished(sql, table, rowId) {
  const [row] = await sql.unsafe(
    `SELECT template_id, version_id FROM ${table} WHERE id = $1 LIMIT 1`,
    [rowId],
  );
  if (!row) return false; // let the handler 404 naturally
  return isPublishedVersion(sql, row.template_id, row.version_id);
}

// ── Copy one version's full content (pages + groups + master inputs) into a
// pre-created NEW version, inside an existing transaction. Extracted from
// createVersion so ensureDraft / publish can reuse the exact same forking SQL
// (deterministic SHA-256 id remapping for page ids, group ids, parent_group_id,
// MI group_id, and multiselect options.pages[]).
async function copyVersionContentInTx(tx, templateId, sourceVersionId, newVersionId) {
  // 1) Pages
  await tx.unsafe(
    `INSERT INTO ${T.v3_pages}
       (id, template_id, version_id, name, ord, row_count, col_count, size,
        orientation, scale, hidden, is_imported, columns_order, column_widths,
        row_heights, cells, styles, merges, schemes, freeze_rows, freeze_cols, print_settings)
     SELECT
       substr(encode(digest($1::text || id, 'sha256'), 'hex'), 1, 24),
       template_id, $1::text, name, ord, row_count, col_count, size,
       orientation, scale, hidden, is_imported, columns_order, column_widths,
       row_heights, cells, styles, merges, schemes, freeze_rows, freeze_cols, print_settings
     FROM ${T.v3_pages}
     WHERE template_id = $2 AND version_id = $3`,
    [newVersionId, templateId, sourceVersionId],
  );
  // 2) Master-input groups
  await tx.unsafe(
    `INSERT INTO ${T.master_input_group}
       (id, template_id, version_id, key, display_name, section, ord, parent_group_id)
     SELECT
       substr(encode(digest($1::text || g.id, 'sha256'), 'hex'), 1, 24),
       g.template_id, $1::text, g.key, g.display_name, g.section, g.ord,
       CASE WHEN g.parent_group_id IS NULL THEN NULL
            ELSE substr(encode(digest($1::text || g.parent_group_id, 'sha256'), 'hex'), 1, 24)
       END
     FROM ${T.master_input_group} g
     WHERE g.template_id = $2 AND g.version_id = $3`,
    [newVersionId, templateId, sourceVersionId],
  );
  // 3) Master inputs (group_id + multiselect options.pages[] remapped)
  await tx.unsafe(
    `INSERT INTO ${T.master_input}
       (id, template_id, version_id, key, value, ref, type, options,
        section, ord, display_name, kind, group_id, default_value)
     SELECT
       substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
       m.template_id, $1::text, m.key, m.value, m.ref, m.type,
       CASE
         WHEN m.options IS NULL OR jsonb_typeof(m.options) <> 'array' THEN m.options
         ELSE (
           SELECT jsonb_agg(
             CASE
               WHEN jsonb_typeof(opt) = 'object' AND opt ? 'pages' THEN
                 jsonb_set(
                   opt,
                   '{pages}',
                   COALESCE(
                     (SELECT jsonb_agg(
                        substr(encode(digest($1::text || pid, 'sha256'), 'hex'), 1, 24)
                      )
                      FROM jsonb_array_elements_text(opt->'pages') AS pid),
                     '[]'::jsonb
                   )
                 )
               ELSE opt
             END
           )
           FROM jsonb_array_elements(m.options) AS opt
         )
       END AS options,
       m.section, m.ord, m.display_name, m.kind,
       CASE WHEN m.group_id IS NULL THEN NULL
            ELSE substr(encode(digest($1::text || m.group_id, 'sha256'), 'hex'), 1, 24)
       END,
       m.default_value
     FROM ${T.master_input} m
     WHERE m.template_id = $2 AND m.version_id = $3`,
    [newVersionId, templateId, sourceVersionId],
  );
}

// ── GET /v3/templates ──────────────────────────────────────────────────────────
export async function listTemplates(_req, res) {
  const sql = getSql();
  const rows = await sql.unsafe(`
    SELECT id, name, scheme, description, legacy_template_id,
           published_version_id, ord, disabled, created_at, updated_at
    FROM ${T.v3_templates}
    ORDER BY ord ASC, created_at DESC
    LIMIT 500
  `);
  res.json({ templates: rows });
}

// ── POST /v3/templates/reorder ────────────────────────────────────────────────
// Body: { ids: [id, id, ...] }. Rewrites each row's `ord` to (idx+1)*10
// so future single-row inserts can slot in without renumbering.
export async function reorderTemplates(req, res) {
  const sql = getSql();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids || ids.length === 0) {
    return res.status(400).json({ error: "ids[] required" });
  }
  try {
    await sql.begin(async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        await tx.unsafe(
          `UPDATE ${T.v3_templates} SET ord = $1, updated_at = NOW() WHERE id = $2`,
          [(i + 1) * 10, ids[i]],
        );
      }
    });
    res.json({ ok: true, count: ids.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// ── POST /v3/templates ─────────────────────────────────────────────────────────
// Create a fresh v3 template with a single empty "Sheet1" page and an initial
// v1 version that is auto-published.
// Body: { name?, scheme?, description?, user_id? }
export async function createTemplate(req, res) {
  const sql = getSql();
  const b = req.body || {};
  const templateId = newObjectId();
  const versionId = newObjectId();
  const pageId = newObjectId();

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO ${T.v3_templates}
           (id, name, scheme, description, user_id, published_version_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          templateId,
          b.name ?? "Untitled template",
          b.scheme ?? null,
          b.description ?? null,
          b.user_id ?? null,
          versionId,
        ],
      );

      await tx.unsafe(
        `INSERT INTO ${T.v3_versions} (id, template_id, label) VALUES ($1, $2, $3)`,
        [versionId, templateId, "v1"],
      );

      // Seed a single empty page so the editor opens with something visible.
      await tx.unsafe(
        `INSERT INTO ${T.v3_pages}
           (id, template_id, version_id, name, ord, row_count, col_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [pageId, templateId, versionId, "Sheet1", 0, 50, 26],
      );
    });
  } catch (e) {
    return res.status(500).json({ error: `Create template failed: ${e.message}` });
  }

  const [row] = await sql.unsafe(
    `SELECT * FROM ${T.v3_templates} WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  res.status(201).json(row);
}

// ── PATCH /v3/templates/:id ───────────────────────────────────────────────────
export async function patchTemplate(req, res) {
  const sql = getSql();
  const b = req.body || {};

  // ── page_groups is VERSION-scoped content now ──────────────────────────────
  // It no longer lives on v3_templates. Route it to the active version's row
  // (resolved from ?version= / body.version_id, else the published version) and
  // strip it from the template-column update below. Written as an explicit
  // array so an empty list persists as '[]' (user removed every group) rather
  // than NULL (never set) — the read path in getTemplate depends on that.
  let pgUpdate = null;
  if (Object.prototype.hasOwnProperty.call(b, "page_groups")) {
    const versionId = await resolveVersionId(sql, req.params.id, req.query.version ?? b.version_id);
    if (!versionId) {
      return res.status(400).json({ error: "Template has no version to attach page groups to" });
    }
    const pg = Array.isArray(b.page_groups) ? b.page_groups : [];
    const [vrow] = await sql.unsafe(
      `UPDATE ${T.v3_versions} SET page_groups = $1::jsonb
         WHERE id = $2 AND template_id = $3 RETURNING id`,
      [JSON.stringify(pg), versionId, req.params.id],
    );
    if (!vrow) return res.status(404).json({ error: "Version not found for this template" });
    pgUpdate = { versionId, page_groups: pg };
  }

  const fields = [
    ["name", "name"],
    ["scheme", "scheme"],
    ["description", "description"],
    ["input_sections", "input_sections"],
    ["disabled", "disabled"],
    ["ord", "ord"],
    // Persisted pointer to the version the editor currently has open (the
    // "active editing version"). The published version is locked; any other
    // version is editable. Saved here so reopening returns to the same version.
    ["draft_version_id", "draft_version_id"],
  ];
  const sets = [];
  const params = [req.params.id];
  let i = 2;
  for (const [col, key] of fields) {
    if (Object.prototype.hasOwnProperty.call(b, key)) {
      sets.push(`"${col}" = $${i}`);
      params.push(b[key]);
      i++;
    }
  }

  let row;
  if (sets.length > 0) {
    sets.push(`updated_at = NOW()`);
    [row] = await sql.unsafe(
      `UPDATE ${T.v3_templates} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
    if (!row) return res.status(404).json({ error: "Template not found" });
  } else if (pgUpdate) {
    // Only page_groups changed — fetch the current template row for the
    // response / broadcast payload.
    [row] = await sql.unsafe(`SELECT * FROM ${T.v3_templates} WHERE id = $1`, [req.params.id]);
    if (!row) return res.status(404).json({ error: "Template not found" });
  } else {
    return res.status(400).json({ error: "No fields to update" });
  }

  // Broadcast template metadata changes so open editors repaint without a
  // manual reload. For page_groups we include the versionId + the new list so
  // ONLY editors viewing that same version apply it (version-scoped now).
  const changedFields = fields
    .filter(([, key]) => Object.prototype.hasOwnProperty.call(b, key))
    .map(([, key]) => key);
  if (pgUpdate) changedFields.push("page_groups");
  broadcast({
    type: "template.updated",
    templateId: row.id,
    fields: changedFields,
    template: pgUpdate ? { ...row, page_groups: pgUpdate.page_groups } : row,
    versionId: pgUpdate ? pgUpdate.versionId : null,
    clientId: req.get("x-client-id") || null,
  });
  res.json(
    pgUpdate
      ? { ...row, page_groups: pgUpdate.page_groups, active_version_id: pgUpdate.versionId }
      : row,
  );
}

// ── POST /v3/master-inputs/bulk ──────────────────────────────────────────────
// Insert many master inputs in a single transaction. Used by the Excel import
// path so the FE doesn't fire one HTTP request per row.
// Body: { template_id, version_id?, masterInputs: [{ key, value?, ref?, type?,
//         options?, section?, kind?, group_id?, display_name?, ord? }, …] }
// Groups are NOT created here — POST /v3/master-input-groups/bulk first.
export async function bulkCreateMasterInputs(req, res) {
  const sql = getSql();
  const b = req.body || {};
  if (!b.template_id || !Array.isArray(b.masterInputs)) {
    return res.status(400).json({ error: "template_id and masterInputs[] required" });
  }
  if (b.masterInputs.length === 0) return res.json({ count: 0, ids: [] });

  const versionId = await resolveVersionId(sql, b.template_id, b.version_id);
  if (await isPublishedVersion(sql, b.template_id, versionId)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  // Build every row up front, then INSERT them in multi-row batches — ONE
  // round-trip per batch instead of one per row. With a remote DB (prod is in
  // ap-southeast-2) the per-row loop was the entire cost: 100 rows = 100 RTTs.
  const ids = [];
  const rows = [];
  for (let i = 0; i < b.masterInputs.length; i++) {
    const mi = b.masterInputs[i];
    if (!mi || !mi.key) continue;
    if (mi.type === "group") continue; // groups go through /v3/master-input-groups/bulk
    const id = newObjectId();
    ids.push(id);
    rows.push([
      id,
      b.template_id,
      versionId,
      mi.key,
      mi.display_name ?? null,
      mi.value == null ? null : String(mi.value),
      mi.ref ?? null,
      mi.type ?? "text",
      mi.options ?? [],
      mi.section ?? null,
      mi.kind ?? "basic",
      mi.group_id ?? null,
      Number.isFinite(mi.ord) ? mi.ord : i,
      // default_value preserved on restore/import; multiselect excluded (NULL →
      // falls back to value). Older exports without it seed default == value.
      mi.default_value == null
        ? (mi.type === "multiselect" ? null : (mi.value == null ? null : String(mi.value)))
        : String(mi.default_value),
    ]);
  }

  const COLS = 14;
  const BATCH = 1000; // 13 cols × 1000 = 13k binds, well under Postgres' 65535 cap
  try {
    for (let off = 0; off < rows.length; off += BATCH) {
      const slice = rows.slice(off, off + BATCH);
      const tuples = slice
        .map(
          (_, r) =>
            `(${Array.from({ length: COLS }, (_, c) => `$${r * COLS + c + 1}`).join(",")})`,
        )
        .join(",");
      await sql.unsafe(
        `INSERT INTO ${T.master_input}
           (id, template_id, version_id, key, display_name, value, ref, type, options,
            section, kind, group_id, ord, default_value)
         VALUES ${tuples}`,
        slice.flat(),
      );
    }
  } catch (e) {
    return res.status(500).json({ error: `Bulk create failed: ${e.message}` });
  }
  broadcast({
    type: "masterInput.updated",
    templateId: b.template_id,
    versionId,
    reason: "mis.bulk_created",
    count: ids.length,
    clientId: req.get("x-client-id") || null,
  });
  res.status(201).json({ count: ids.length, ids });
}

// ── POST /v3/master-inputs/wipe ───────────────────────────────────────────────
// Body: { template_id, version_id? } — delete every master-input in that
// (template, version) in ONE statement. Restore/import calls this before a fresh
// bulk-insert so it doesn't fire thousands of per-row DELETE round-trips.
export async function wipeVersionMasterInputs(req, res) {
  const sql = getSql();
  const { template_id, version_id } = req.body || {};
  if (!template_id) return res.status(400).json({ error: "template_id required" });
  const versionId = await resolveVersionId(sql, template_id, version_id);
  if (await isPublishedVersion(sql, template_id, versionId)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  const del = await sql.unsafe(
    `DELETE FROM ${T.master_input}
       WHERE template_id = $1 AND ($2::text IS NULL OR version_id = $2)`,
    [template_id, versionId ?? null],
  );
  const count = del.count ?? 0;
  broadcast({
    type: "masterInput.updated",
    templateId: template_id,
    versionId,
    reason: "mis.wiped",
    count,
    clientId: req.get("x-client-id") || null,
  });
  res.json({ count });
}

// ── POST /v3/master-inputs/reorder ────────────────────────────────────────────
// Body: { template_id, ids: [...], version_id? }
// Scoped to (template_id, version_id) so reorders inside one branch don't
// touch another version.
export async function reorderMasterInputs(req, res) {
  const sql = getSql();
  const { template_id, ids, version_id } = req.body || {};
  if (!template_id || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "template_id and non-empty ids[] required" });
  }
  const vId = await resolveVersionId(sql, template_id, version_id);
  if (await isPublishedVersion(sql, template_id, vId)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  try {
    await sql.begin(async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        await tx.unsafe(
          `UPDATE ${T.master_input}
             SET ord = $1
           WHERE id = $2 AND template_id = $3
             AND ($4::text IS NULL OR version_id = $4)`,
          [i, ids[i], template_id, vId],
        );
      }
    });
  } catch (e) {
    return res.status(500).json({ error: `reorder failed: ${e.message}` });
  }
  broadcast({
    type: "masterInput.updated",
    templateId: template_id,
    versionId: vId,
    reason: "mis.reordered",
    clientId: req.get("x-client-id") || null,
  });
  res.json({ ok: true, count: ids.length });
}

// ── GET /v3/templates/:id ──────────────────────────────────────────────────────
// Returns the template + pages for the *active* version (?version=... or
// published_version_id) + all known versions.
export async function getTemplate(req, res) {
  const sql = getSql();
  const { id } = req.params;
  const [tpl] = await sql.unsafe(
    `SELECT * FROM ${T.v3_templates} WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (!tpl) return res.status(404).json({ error: "Template not found" });

  const versionId = await resolveVersionId(sql, id, req.query.version);

  const pages = await sql.unsafe(
    `SELECT id, name, ord, row_count, col_count, size, orientation, scale,
            hidden, is_imported, version_id, schemes, freeze_rows, freeze_cols,
            print_settings
     FROM ${T.v3_pages}
     WHERE template_id = $1 AND ($2::text IS NULL OR version_id = $2)
     ORDER BY ord ASC, name ASC`,
    [id, versionId],
  );

  await ensureVerForkCol(sql);
  const versionRows = await sql.unsafe(
    `SELECT id, label, notes, author_id, created_at, forked_from_version_id FROM ${T.v3_versions}
     WHERE template_id = $1 ORDER BY created_at ASC`,
    [id],
  );
  // Attach each version's SOURCE label — the label of the version it was forked
  // from — so the version list can show "Forked from <label>". Every version of
  // the template is in this set, so resolve the id→label map in-memory (no JOIN).
  const versionLabelById = new Map(versionRows.map((r) => [r.id, r.label]));
  const versions = versionRows.map((r) => ({
    ...r,
    source_label: r.forked_from_version_id
      ? versionLabelById.get(r.forked_from_version_id) || null
      : null,
  }));

  // Page groups are version-scoped: return the ACTIVE version's set, not the
  // legacy template-level blob. Only fall back to the template column when the
  // version's page_groups IS NULL (never set its own yet) — an explicit empty
  // array means the user removed every group on this version and MUST be
  // respected (don't resurrect the template's groups).
  const tplPageGroups = Array.isArray(parseJsonbStr(tpl.page_groups, []))
    ? parseJsonbStr(tpl.page_groups, [])
    : [];
  let pageGroups = tplPageGroups;
  if (versionId) {
    const [ver] = await sql.unsafe(
      `SELECT page_groups FROM ${T.v3_versions} WHERE id = $1 LIMIT 1`,
      [versionId],
    );
    if (ver && ver.page_groups != null) {
      const verPg = parseJsonbStr(ver.page_groups, []);
      pageGroups = Array.isArray(verPg) ? verPg : [];
    }
    // else: version has no groups of its own yet → keep template fallback.
  }

  res.json({
    ...normalizeTemplate(tpl),
    page_groups: pageGroups,
    pages: pages.map(normalizePage),
    versions,
    active_version_id: versionId,
  });
}

// ── POST /v3/pages/reorder ───────────────────────────────────────────────────
// Body: { template_id, version_id?, ids: [...] }
// Sets ord = index for each id in the array, scoped to (template_id, version_id).
// Uses two passes (offset by 100000 then rewrite to final) to avoid clashing
// with the (template_id, version_id, ord) UNIQUE constraint mid-update.
export async function reorderPages(req, res) {
  const sql = getSql();
  const { template_id, ids, version_id } = req.body || {};
  if (!template_id || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "template_id and non-empty ids[] required" });
  }
  const vId = await resolveVersionId(sql, template_id, version_id);
  if (await isPublishedVersion(sql, template_id, vId)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  try {
    await sql.begin(async (tx) => {
      // Pass 1 — bump every affected ord by a large offset so the constraint
      // can't collide while we shuffle.
      for (let i = 0; i < ids.length; i++) {
        await tx.unsafe(
          `UPDATE ${T.v3_pages}
             SET ord = $1
           WHERE id = $2 AND template_id = $3
             AND ($4::text IS NULL OR version_id = $4)`,
          [100000 + i, ids[i], template_id, vId],
        );
      }
      // Pass 2 — assign the final ord = array index.
      for (let i = 0; i < ids.length; i++) {
        await tx.unsafe(
          `UPDATE ${T.v3_pages}
             SET ord = $1, updated_at = NOW()
           WHERE id = $2 AND template_id = $3
             AND ($4::text IS NULL OR version_id = $4)`,
          [i, ids[i], template_id, vId],
        );
      }
    });
  } catch (e) {
    return res.status(500).json({ error: `reorder failed: ${e.message}` });
  }
  res.json({ ok: true, count: ids.length });
}

// ── POST /v3/pages ────────────────────────────────────────────────────────────
// Create a single new page on a template + version.
// Body: { template_id, version_id?, name, ord?, row_count?, col_count? }
// If `ord` is omitted it appends after the last page in that version.
export async function createPage(req, res) {
  const sql = getSql();
  const b = req.body || {};
  if (!b.template_id || !b.name) {
    return res.status(400).json({ error: "template_id and name required" });
  }
  try {
    const versionId = await resolveVersionId(sql, b.template_id, b.version_id);
    if (!versionId) {
      return res.status(400).json({ error: "Template has no published version yet" });
    }
    if (await isPublishedVersion(sql, b.template_id, versionId)) {
      return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
    }

    const nextFreeOrd = async () => {
      const [row] = await sql.unsafe(
        `SELECT COALESCE(MAX(ord), -1) AS max_ord FROM ${T.v3_pages}
         WHERE template_id = $1 AND version_id = $2`,
        [b.template_id, versionId],
      );
      return (row?.max_ord ?? -1) + 1;
    };

    let ord = Number.isFinite(b.ord) ? b.ord : await nextFreeOrd();
    const id = newObjectId();
    // Persist content fields on insert when the caller supplies them — the
    // JSON-restore flow POSTs a page WITH its cells/styles/merges, and without
    // this the restore would silently drop everything and the user would have
    // to run it a second time (when the page already exists and PATCH lands
    // the data). Default each one to a sane empty value when absent.
    const insertWithOrd = (ordVal) =>
      sql.unsafe(
        `INSERT INTO ${T.v3_pages}
           (id, template_id, version_id, name, ord, row_count, col_count,
            hidden, cells, styles, merges, column_widths, row_heights, schemes,
            freeze_rows, freeze_cols, print_settings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          id,
          b.template_id,
          versionId,
          b.name,
          ordVal,
          Number.isFinite(b.row_count) ? b.row_count : 50,
          Number.isFinite(b.col_count) ? b.col_count : 26,
          typeof b.hidden === "boolean" ? b.hidden : false,
          b.cells && typeof b.cells === "object" ? b.cells : {},
          b.styles && typeof b.styles === "object" ? b.styles : {},
          Array.isArray(b.merges) ? b.merges : [],
          b.column_widths && typeof b.column_widths === "object" ? b.column_widths : {},
          b.row_heights && typeof b.row_heights === "object" ? b.row_heights : {},
          Array.isArray(b.schemes) ? b.schemes : [],
          Number.isFinite(b.freeze_rows) ? Math.max(0, Math.min(20, Math.trunc(b.freeze_rows))) : 0,
          Number.isFinite(b.freeze_cols) ? Math.max(0, Math.min(20, Math.trunc(b.freeze_cols))) : 0,
          b.print_settings && typeof b.print_settings === "object" && !Array.isArray(b.print_settings) ? b.print_settings : {},
        ],
      );

    try {
      await insertWithOrd(ord);
    } catch (e) {
      // Duplicate (template_id, version_id, ord): the caller's requested ord is
      // already taken — common when JSON-restore POSTs a backup page (ord 0..N)
      // into a template that already has pages at those ords. Append at the next
      // free ord and retry once instead of crashing the process.
      if (e?.code === "23505" && /ord/.test(String(e?.constraint_name || ""))) {
        ord = await nextFreeOrd();
        await insertWithOrd(ord);
      } else {
        throw e;
      }
    }

    const [page] = await sql.unsafe(
      `SELECT * FROM ${T.v3_pages} WHERE id = $1 LIMIT 1`,
      [id],
    );
    res.status(201).json(page);
  } catch (e) {
    console.error("[createPage] error:", e?.message || e);
    res.status(500).json({ error: String(e?.message || e) });
  }
}

// ── GET /v3/pages/:id ──────────────────────────────────────────────────────────
export async function getPage(req, res) {
  const sql = getSql();
  const { id } = req.params;
  const [page] = await sql.unsafe(
    `SELECT * FROM ${T.v3_pages} WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (!page) return res.status(404).json({ error: "Page not found" });
  res.json(normalizePage(page));
}

// ── Group name-reference helpers ──────────────────────────────────────────────
// Master inputs are persisted with a `group_id` FK (the internal source of
// truth, stable for FK integrity + version/instance id-remapping). The API
// surface, however, references a group by its NAME via `group_key`, resolved
// against the unique (template_id, version_id, section, key) tuple. These two
// helpers translate at the edge so callers can work in names.
async function resolveGroupId(sql, templateId, versionId, section, groupKey) {
  if (groupKey == null || groupKey === "") return null;
  const rows = await sql.unsafe(
    `SELECT id FROM ${T.master_input_group}
     WHERE template_id = $1
       AND version_id IS NOT DISTINCT FROM $2
       AND section IS NOT DISTINCT FROM $3
       AND key = $4
     LIMIT 1`,
    [templateId, versionId ?? null, section ?? null, groupKey],
  );
  return rows[0]?.id ?? null;
}

async function groupKeyOf(sql, groupId) {
  if (!groupId) return null;
  const rows = await sql.unsafe(
    `SELECT key FROM ${T.master_input_group} WHERE id = $1 LIMIT 1`,
    [groupId],
  );
  return rows[0]?.key ?? null;
}

// ── GET /v3/templates/:id/master-inputs ────────────────────────────────────────
// Returns BOTH masterInputs and masterInputGroups for the active version.
export async function getMasterInputs(req, res) {
  const sql = getSql();
  const { id } = req.params;
  const versionId = await resolveVersionId(sql, id, req.query.version);
  const rows = await sql.unsafe(
    `SELECT * FROM ${T.master_input}
     WHERE template_id = $1 AND ($2::text IS NULL OR version_id = $2)
     ORDER BY ord ASC`,
    [id, versionId],
  );
  const groups = await sql.unsafe(
    `SELECT * FROM ${T.master_input_group}
     WHERE template_id = $1 AND ($2::text IS NULL OR version_id = $2)
     ORDER BY ord ASC`,
    [id, versionId],
  );
  // Attach group_key (name-reference) from the already-loaded groups — no extra
  // query. group_id stays on each row as the internal source of truth.
  const idToKey = new Map(groups.map((g) => [g.id, g.key]));
  res.json({
    masterInputs: rows.map((r) => ({
      ...normalizeMasterInput(r),
      group_key: r.group_id ? idToKey.get(r.group_id) ?? null : null,
    })),
    masterInputGroups: groups,
    active_version_id: versionId,
  });
}

// ── GET /v3/master-inputs/:id ─────────────────────────────────────────────────
export async function getMasterInput(req, res) {
  const sql = getSql();
  const [row] = await sql.unsafe(
    `SELECT * FROM ${T.master_input} WHERE id = $1 LIMIT 1`,
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "Master input not found" });
  const out = normalizeMasterInput(row);
  out.group_key = await groupKeyOf(sql, row.group_id);
  res.json(out);
}

// ── POST /v3/master-inputs ────────────────────────────────────────────────────
// Body: { template_id, key, version_id?, display_name?, value?, ref?, type?,
//         options?, section?, kind?, group_id?, ord? }
// Groups are created via POST /v3/master-input-groups, not here.
export async function createMasterInput(req, res) {
  const sql = getSql();
  const b = req.body || {};
  if (!b.template_id || !b.key) {
    return res.status(400).json({ error: "template_id and key required" });
  }
  if (b.type === "group") {
    return res.status(400).json({ error: "Use POST /v3/master-input-groups to create a group" });
  }
  const versionId = await resolveVersionId(sql, b.template_id, b.version_id);
  if (await isPublishedVersion(sql, b.template_id, versionId)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  // Name-reference: if the caller passed a `group_key`, resolve it to the
  // internal group_id. An explicit group_id (legacy callers) still works.
  const groupId = Object.prototype.hasOwnProperty.call(b, "group_key")
    ? await resolveGroupId(sql, b.template_id, versionId, b.section ?? null, b.group_key)
    : (b.group_id ?? null);
  const id = newObjectId();
  await sql.unsafe(
    `INSERT INTO ${T.master_input}
       (id, template_id, version_id, key, display_name, value, ref, type, options,
        section, kind, group_id, ord, default_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      b.template_id,
      versionId,
      b.key,
      b.display_name ?? null,
      b.value ?? null,
      b.ref ?? null,
      b.type ?? "text",
      b.options ?? [],
      b.section ?? null,
      b.kind ?? "basic",
      groupId,
      Number.isFinite(b.ord) ? b.ord : 0,
      // New instances seed from default_value. multiselect is excluded (stays
      // NULL → falls back to value); other types start with default == value.
      b.type === "multiselect" ? null : (b.default_value ?? b.value ?? null),
    ],
  );
  const [row] = await sql.unsafe(`SELECT * FROM ${T.master_input} WHERE id = $1`, [id]);
  broadcast({
    type: "masterInput.updated",
    templateId: row.template_id,
    versionId: row.version_id,
    masterInputId: row.id,
    reason: "mi.created",
    clientId: req.get("x-client-id") || null,
  });
  res.status(201).json({ ...row, group_key: await groupKeyOf(sql, row.group_id) });
}

// ── PATCH /v3/master-inputs/:id ───────────────────────────────────────────────
export async function patchMasterInput(req, res) {
  const sql = getSql();
  const b = req.body || {};
  if (b.type === "group") {
    return res.status(400).json({ error: "type='group' is not a valid master-input type" });
  }
  if (await rowIsPublished(sql, T.master_input, req.params.id)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  // Name-reference: a `group_key` in the body is the authoritative group
  // reference. Resolve it to the internal group_id against the row's current
  // section (group_key and section are never patched in the same request), then
  // let it flow through the normal group_id update below.
  if (Object.prototype.hasOwnProperty.call(b, "group_key")) {
    const [cur] = await sql.unsafe(
      `SELECT template_id, version_id, section FROM ${T.master_input} WHERE id = $1 LIMIT 1`,
      [req.params.id],
    );
    if (!cur) return res.status(404).json({ error: "Master input not found" });
    b.group_id = await resolveGroupId(sql, cur.template_id, cur.version_id, cur.section, b.group_key);
  }
  const fields = [
    ["key", "key"],
    ["display_name", "display_name"],
    ["value", "value"],
    ["default_value", "default_value"],
    ["ref", "ref"],
    ["type", "type"],
    ["options", "options"],
    ["section", "section"],
    ["kind", "kind"],
    ["group_id", "group_id"],
    ["ord", "ord"],
  ];
  const sets = [];
  const params = [req.params.id];
  let i = 2;
  for (const [col, key] of fields) {
    if (Object.prototype.hasOwnProperty.call(b, key)) {
      sets.push(`"${col}" = $${i}`);
      params.push(b[key]);
      i++;
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
  const [row] = await sql.unsafe(
    `UPDATE ${T.master_input} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
    params,
  );
  if (!row) return res.status(404).json({ error: "Master input not found" });
  broadcast({
    type: "masterInput.updated",
    templateId: row.template_id,
    versionId: row.version_id,
    masterInputId: row.id,
    key: row.key,
    ref: row.ref,
    value: row.value,
    clientId: req.get("x-client-id") || null,
  });
  res.json({ ...row, group_key: await groupKeyOf(sql, row.group_id) });
}

// ── DELETE /v3/master-inputs/:id ──────────────────────────────────────────────
export async function deleteMasterInput(req, res) {
  const sql = getSql();
  if (await rowIsPublished(sql, T.master_input, req.params.id)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  const [row] = await sql.unsafe(
    `DELETE FROM ${T.master_input} WHERE id = $1 RETURNING id, template_id, version_id`,
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "Master input not found" });
  broadcast({
    type: "masterInput.updated",
    templateId: row.template_id,
    versionId: row.version_id,
    masterInputId: row.id,
    reason: "mi.deleted",
    clientId: req.get("x-client-id") || null,
  });
  res.status(204).end();
}

// ─── Master-input groups (first-class entity) ─────────────────────────────────
// A group lives in `v3_master_input_group`. Master inputs reference it via
// `group_id` (FK with ON DELETE SET NULL). Deleting a group leaves its children
// alive but ungrouped.

// ── GET /v3/templates/:id/master-input-groups ────────────────────────────────
export async function listMasterInputGroups(req, res) {
  const sql = getSql();
  const { id } = req.params;
  const versionId = await resolveVersionId(sql, id, req.query.version);
  const rows = await sql.unsafe(
    `SELECT * FROM ${T.master_input_group}
     WHERE template_id = $1 AND ($2::text IS NULL OR version_id = $2)
     ORDER BY ord ASC`,
    [id, versionId],
  );
  res.json({ masterInputGroups: rows, active_version_id: versionId });
}

// ── POST /v3/master-input-groups ──────────────────────────────────────────────
// Body: { template_id, key, version_id?, display_name?, section?, ord?, parent_group_id? }
export async function createMasterInputGroup(req, res) {
  const sql = getSql();
  const b = req.body || {};
  if (!b.template_id || !b.key) {
    return res.status(400).json({ error: "template_id and key required" });
  }
  const versionId = await resolveVersionId(sql, b.template_id, b.version_id);
  if (await isPublishedVersion(sql, b.template_id, versionId)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  const id = newObjectId();
  let row;
  try {
    // UPSERT (not a plain INSERT) so re-adding a group whose previous row is
    // still present — e.g. the client removed it but the DELETE hasn't been
    // flushed yet in manual-save mode, or a delete/create race in auto-sync —
    // revives the existing row instead of failing the unique constraint
    // (template_id, version_id, section, key). On conflict the existing id is
    // kept; the client cancels its pending delete for that id. Mirrors the
    // bulk-create route's ON CONFLICT handling.
    const rows = await sql.unsafe(
      `INSERT INTO ${T.master_input_group}
         (id, template_id, version_id, key, display_name, section, ord, parent_group_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (template_id, version_id, section, key) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             ord = EXCLUDED.ord,
             parent_group_id = EXCLUDED.parent_group_id
       RETURNING *`,
      [
        id,
        b.template_id,
        versionId,
        b.key,
        b.display_name ?? null,
        b.section ?? null,
        Number.isFinite(b.ord) ? b.ord : 0,
        b.parent_group_id ?? null,
      ],
    );
    row = rows[0];
  } catch (e) {
    return res.status(500).json({ error: `Create group failed: ${e.message}` });
  }
  broadcast({
    type: "masterInput.updated",
    templateId: row.template_id,
    versionId: row.version_id,
    groupId: row.id,
    reason: "group.created",
    clientId: req.get("x-client-id") || null,
  });
  res.status(201).json(row);
}

// ── POST /v3/master-input-groups/bulk ─────────────────────────────────────────
// Body: { template_id, version_id?, masterInputGroups: [{ key, display_name?,
//         section?, ord?, parent_group_key? }, …] }
// Returns: { count, ids: [...], keyToId: { "<section>::<key>": "<id>", … } }
// The keyToId map lets the importer resolve children's group_key → group_id.
export async function bulkCreateMasterInputGroups(req, res) {
  const sql = getSql();
  const b = req.body || {};
  if (!b.template_id || !Array.isArray(b.masterInputGroups)) {
    return res.status(400).json({ error: "template_id and masterInputGroups[] required" });
  }
  if (b.masterInputGroups.length === 0) {
    return res.json({ count: 0, ids: [], keyToId: {} });
  }
  const versionId = await resolveVersionId(sql, b.template_id, b.version_id);
  if (await isPublishedVersion(sql, b.template_id, versionId)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  const ids = [];
  const keyToId = {};
  try {
    await sql.begin(async (tx) => {
      for (let i = 0; i < b.masterInputGroups.length; i++) {
        const g = b.masterInputGroups[i];
        if (!g || !g.key) continue;
        const newId = newObjectId();
        const rows = await tx.unsafe(
          `INSERT INTO ${T.master_input_group}
             (id, template_id, version_id, key, display_name, section, ord)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (template_id, version_id, section, key) DO UPDATE
             SET display_name = EXCLUDED.display_name,
                 ord = EXCLUDED.ord
           RETURNING id`,
          [
            newId,
            b.template_id,
            versionId,
            g.key,
            g.display_name ?? null,
            g.section ?? null,
            Number.isFinite(g.ord) ? g.ord : i,
          ],
        );
        const realId = rows[0]?.id || newId;
        ids.push(realId);
        keyToId[`${g.section ?? ""}::${g.key}`] = realId;
      }
    });
  } catch (e) {
    return res.status(500).json({ error: `Bulk create groups failed: ${e.message}` });
  }
  broadcast({
    type: "masterInput.updated",
    templateId: b.template_id,
    versionId,
    reason: "groups.bulk_created",
    count: ids.length,
    clientId: req.get("x-client-id") || null,
  });
  res.status(201).json({ count: ids.length, ids, keyToId });
}

// ── PATCH /v3/master-input-groups/:id ─────────────────────────────────────────
export async function patchMasterInputGroup(req, res) {
  const sql = getSql();
  const b = req.body || {};
  if (await rowIsPublished(sql, T.master_input_group, req.params.id)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  const fields = [
    ["key", "key"],
    ["display_name", "display_name"],
    ["section", "section"],
    ["ord", "ord"],
    ["parent_group_id", "parent_group_id"],
  ];
  const sets = [];
  const params = [req.params.id];
  let i = 2;
  for (const [col, key] of fields) {
    if (Object.prototype.hasOwnProperty.call(b, key)) {
      sets.push(`"${col}" = $${i}`);
      params.push(b[key]);
      i++;
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
  const [row] = await sql.unsafe(
    `UPDATE ${T.master_input_group} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
    params,
  );
  if (!row) return res.status(404).json({ error: "Group not found" });
  // Re-use the masterInput.updated event the FE already handles — it refetches
  // BOTH the MI list and the group list when it fires, so changing a group's
  // section / display_name / ord / parent flows into the open editor without
  // a reload. Cell + page broadcasts have their own event types; this one
  // covers everything under /v3/templates/:id/master-inputs.
  broadcast({
    type: "masterInput.updated",
    templateId: row.template_id,
    versionId: row.version_id,
    groupId: row.id,
    reason: "group.patched",
    clientId: req.get("x-client-id") || null,
  });
  res.json(row);
}

// ── DELETE /v3/master-input-groups/:id ────────────────────────────────────────
// Children of this group survive (their group_id is set to NULL by the FK).
export async function deleteMasterInputGroup(req, res) {
  const sql = getSql();
  if (await rowIsPublished(sql, T.master_input_group, req.params.id)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  const [row] = await sql.unsafe(
    `DELETE FROM ${T.master_input_group} WHERE id = $1 RETURNING id, template_id, version_id`,
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "Group not found" });
  broadcast({
    type: "masterInput.updated",
    templateId: row.template_id,
    versionId: row.version_id,
    groupId: row.id,
    reason: "group.deleted",
    clientId: req.get("x-client-id") || null,
  });
  res.status(204).end();
}

// ── POST /v3/master-input-groups/reorder ──────────────────────────────────────
// Body: { template_id, ids: [...], version_id? }
// Uses the same two-pass UPDATE pattern as reorderPages so the unique-index
// (if added later) can't collide mid-update.
export async function reorderMasterInputGroups(req, res) {
  const sql = getSql();
  const { template_id, ids, version_id } = req.body || {};
  if (!template_id || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "template_id and non-empty ids[] required" });
  }
  const vId = await resolveVersionId(sql, template_id, version_id);
  if (await isPublishedVersion(sql, template_id, vId)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  try {
    await sql.begin(async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        await tx.unsafe(
          `UPDATE ${T.master_input_group}
             SET ord = $1
           WHERE id = $2 AND template_id = $3
             AND ($4::text IS NULL OR version_id = $4)`,
          [i, ids[i], template_id, vId],
        );
      }
    });
  } catch (e) {
    return res.status(500).json({ error: `reorder failed: ${e.message}` });
  }
  broadcast({
    type: "masterInput.updated",
    templateId: template_id,
    versionId: vId,
    reason: "groups.reordered",
    clientId: req.get("x-client-id") || null,
  });
  res.json({ ok: true, count: ids.length });
}

// ── PATCH /v3/pages/:id ────────────────────────────────────────────────────────
// Sparse patch — merge into existing cells / styles JSONB.
// Page fields that are purely cosmetic / view-only — allowed even on the
// published (locked) version, since they don't change the released content or
// calculations. A patch touching ONLY these skips the publish lock.
const COSMETIC_PAGE_FIELDS = new Set(["freeze_rows", "freeze_cols", "print_settings"]);

export async function patchPage(req, res) {
  const sql = getSql();
  const { id } = req.params;
  const bodyKeys = Object.keys(req.body || {});
  const cosmeticOnly =
    bodyKeys.length > 0 && bodyKeys.every((k) => COSMETIC_PAGE_FIELDS.has(k));
  if (!cosmeticOnly && (await rowIsPublished(sql, T.v3_pages, id))) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  const { cells, removeCells, styles, removeStyles, merges, name, hidden, ord, schemes, column_widths, row_heights } = req.body || {};

  const updates = [];
  const params = [id];
  let i = 2;

  // ── Legacy double-encoded jsonb guard (prevents page-wipe on save) ────────
  // Some v3_pages rows store cells/styles/column_widths/row_heights as a
  // DOUBLE-ENCODED jsonb STRING (a JSON string inside jsonb) rather than a jsonb
  // object — a relic of the import/migration. Postgres `||` on (string || object)
  // does NOT merge; it ARRAY-WRAPS into `[oldString, newObject]`. The FE then
  // reads that array back as "no cells", so the entire page (inputs + layout)
  // looks DELETED after the first save on a freshly-forked editable version.
  // Normalize the column to a real object (one `#>> '{}'` peel) before every
  // merge/subtract so the operation stays an object merge regardless of how the
  // value was stored. Clean rows (already objects) pass through unchanged.
  const asObj = (col) =>
    `(CASE WHEN jsonb_typeof(${col}) = 'string' THEN (${col} #>> '{}')::jsonb ` +
    `WHEN ${col} IS NULL THEN '{}'::jsonb ELSE ${col} END)`;

  // Combine cells merge + removeCells into a single SET to avoid Postgres
  // error 42601 "multiple assignments to same column" — happens when both
  // are sent in one PATCH (e.g. during a row/col shift).
  const hasCells = cells && typeof cells === "object";
  const hasRemoveCells = Array.isArray(removeCells) && removeCells.length > 0;
  if (hasCells && hasRemoveCells) {
    updates.push(`cells = (${asObj("cells")} || $${i}) - $${i + 1}::text[]`);
    params.push(cells, removeCells);
    i += 2;
  } else if (hasCells) {
    updates.push(`cells = ${asObj("cells")} || $${i}`);
    params.push(cells);
    i++;
  } else if (hasRemoveCells) {
    updates.push(`cells = ${asObj("cells")} - $${i}::text[]`);
    params.push(removeCells);
    i++;
  }
  const hasStyles = styles && typeof styles === "object";
  const hasRemoveStyles = Array.isArray(removeStyles) && removeStyles.length > 0;
  if (hasStyles && hasRemoveStyles) {
    updates.push(`styles = (${asObj("styles")} || $${i}) - $${i + 1}::text[]`);
    params.push(styles, removeStyles);
    i += 2;
  } else if (hasStyles) {
    updates.push(`styles = ${asObj("styles")} || $${i}`);
    params.push(styles);
    i++;
  } else if (hasRemoveStyles) {
    updates.push(`styles = ${asObj("styles")} - $${i}::text[]`);
    params.push(removeStyles);
    i++;
  }
  if (Array.isArray(merges)) {
    updates.push(`merges = $${i}`);
    params.push(merges);
    i++;
  }
  if (typeof name === "string") {
    updates.push(`name = $${i}`);
    params.push(name);
    i++;
  }
  if (typeof hidden === "boolean") {
    updates.push(`hidden = $${i}`);
    params.push(hidden);
    i++;
  }
  if (Number.isFinite(ord)) {
    updates.push(`ord = $${i}`);
    params.push(ord);
    i++;
  }
  if (Number.isFinite(req.body?.row_count)) {
    updates.push(`row_count = $${i}`);
    params.push(req.body.row_count);
    i++;
  }
  if (Number.isFinite(req.body?.col_count)) {
    updates.push(`col_count = $${i}`);
    params.push(req.body.col_count);
    i++;
  }
  if (Array.isArray(schemes)) {
    // Full-replace semantics: pass the new array, BE writes it verbatim.
    updates.push(`schemes = $${i}`);
    params.push(schemes);
    i++;
  }
  if (column_widths && typeof column_widths === "object" && !Array.isArray(column_widths)) {
    // Merge into existing column_widths (same semantics as cells/styles).
    // asObj() guards the same double-encoded-string → array-wrap wipe.
    updates.push(`column_widths = ${asObj("column_widths")} || $${i}`);
    params.push(column_widths);
    i++;
  }
  if (row_heights && typeof row_heights === "object" && !Array.isArray(row_heights)) {
    updates.push(`row_heights = ${asObj("row_heights")} || $${i}`);
    params.push(row_heights);
    i++;
  }
  if (Number.isFinite(req.body?.freeze_rows)) {
    updates.push(`freeze_rows = $${i}`);
    params.push(Math.max(0, Math.min(20, Math.trunc(req.body.freeze_rows))));
    i++;
  }
  if (Number.isFinite(req.body?.freeze_cols)) {
    updates.push(`freeze_cols = $${i}`);
    params.push(Math.max(0, Math.min(20, Math.trunc(req.body.freeze_cols))));
    i++;
  }
  if (req.body?.print_settings && typeof req.body.print_settings === "object" && !Array.isArray(req.body.print_settings)) {
    // Full-replace the page's print settings object (FE sends the whole bag).
    updates.push(`print_settings = $${i}`);
    params.push(req.body.print_settings);
    i++;
  }

  if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

  updates.push(`updated_at = NOW()`);

  let row;
  try {
    [row] = await sql.unsafe(
      `UPDATE ${T.v3_pages} SET ${updates.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
  } catch (e) {
    console.error("[patchPage] SQL error:", e.message, "fields:", Object.keys(req.body || {}));
    return res.status(500).json({ error: String(e.message || e) });
  }
  if (!row) return res.status(404).json({ error: "Page not found" });
  broadcast({
    type: "page.updated",
    templateId: row.template_id,
    versionId: row.version_id,
    pageId: row.id,
    pageName: row.name,
    cells: cells ? Object.keys(cells) : [],
    removeCells: Array.isArray(removeCells) ? removeCells : [],
    clientId: req.get("x-client-id") || null,
  });
  res.json(row);
}

// ── DELETE /v3/pages/:id ───────────────────────────────────────────────────────
export async function deletePage(req, res) {
  const sql = getSql();
  const { id } = req.params;
  if (await rowIsPublished(sql, T.v3_pages, id)) {
    return res.status(403).json({ error: PUBLISHED_LOCK_MSG });
  }
  const result = await sql.unsafe(
    `DELETE FROM ${T.v3_pages} WHERE id = $1 RETURNING id`,
    [id],
  );
  if (!result.length) return res.status(404).json({ error: "Page not found" });
  res.json({ ok: true, id });
}

// ─── Version management ───────────────────────────────────────────────────────

// GET /v3/templates/:id/versions
// Version lineage column (forked_from_version_id) is added lazily so the
// feature works even when ENSURE_TABLES=false. Guarded to run once per process.
let _v3VerForkColEnsured = false;
async function ensureVerForkCol(sql) {
  if (_v3VerForkColEnsured) return;
  try {
    await sql.unsafe(`ALTER TABLE ${T.v3_versions} ADD COLUMN IF NOT EXISTS forked_from_version_id VARCHAR(24)`);
  } catch {}
  _v3VerForkColEnsured = true;
}

export async function listVersions(req, res) {
  const sql = getSql();
  await ensureVerForkCol(sql);
  const rows = await sql.unsafe(
    `SELECT id, label, notes, author_id, created_at, forked_from_version_id FROM ${T.v3_versions}
     WHERE template_id = $1 ORDER BY created_at ASC`,
    [req.params.id],
  );
  // Resolve each version's source label from the same result set (no JOIN).
  const versionLabelById = new Map(rows.map((r) => [r.id, r.label]));
  const versions = rows.map((r) => ({
    ...r,
    source_label: r.forked_from_version_id
      ? versionLabelById.get(r.forked_from_version_id) || null
      : null,
  }));
  const [tpl] = await sql.unsafe(
    `SELECT published_version_id FROM ${T.v3_templates} WHERE id = $1`,
    [req.params.id],
  );
  res.json({
    versions,
    published_version_id: tpl?.published_version_id || null,
  });
}

// POST /v3/templates/:id/versions
// Body: { label?, copyFromVersionId?, empty? }
// If `empty` is true, the new version is seeded with a single blank Sheet1
// and no master inputs (mirrors the createTemplate seed).
// Otherwise, if copyFromVersionId is provided (or defaults to published),
// every page + master input belonging to that version is duplicated under
// the new version.
export async function createVersion(req, res) {
  const sql = getSql();
  const { id: templateId } = req.params;
  const { label, copyFromVersionId, empty } = req.body || {};

  const [tpl] = await sql.unsafe(
    `SELECT id, published_version_id FROM ${T.v3_templates} WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  if (!tpl) return res.status(404).json({ error: "Template not found" });

  // Default the source for the copy to the published version (acts like
  // "branch from published" which is the most common case).
  // If `empty: true`, skip the copy entirely and seed a blank Sheet1.
  const sourceVersionId = empty
    ? null
    : copyFromVersionId || tpl.published_version_id || null;

  const newVersionId = newObjectId();
  const finalLabel = (label && String(label).trim()) || `v${Date.now()}`;
  await ensureVerForkCol(sql);

  try {
    await sql.begin(async (tx) => {
      // forked_from_version_id records which version this copy was branched from,
      // so the lineage ("this version started from version X") is traceable later.
      await tx.unsafe(
        `INSERT INTO ${T.v3_versions} (id, template_id, label, forked_from_version_id) VALUES ($1, $2, $3, $4)`,
        [newVersionId, templateId, finalLabel, sourceVersionId],
      );

      if (empty) {
        // Seed a single blank Sheet1 so the editor opens with something visible.
        await tx.unsafe(
          `INSERT INTO ${T.v3_pages}
             (id, template_id, version_id, name, ord, row_count, col_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [newObjectId(), templateId, newVersionId, "Sheet1", 0, 50, 26],
        );
      } else if (sourceVersionId) {
        // Bulk-copy via single-statement SET-based inserts. The previous
        // row-by-row loops did ~1000 sequential round-trips against the
        // Supabase pooler — on Vercel with `maxDuration: 60s` that often
        // timed out and the browser surfaced "Failed to fetch" on the
        // Backup button. INSERT … SELECT keeps the data in Postgres so
        // it's a single round-trip per table.

        // 1) Pages — copy every column except (id, version_id). New page
        //    id is DETERMINISTIC: substr(sha256(newVerId || oldId), 24).
        //    Picking SHA-256 instead of gen_random_uuid() so the master-
        //    input copy in step 3 can remap multiselect options.pages[]
        //    (which holds page IDs) using the exact same formula —
        //    otherwise those references die after a backup.
        await tx.unsafe(
          `INSERT INTO ${T.v3_pages}
             (id, template_id, version_id, name, ord, row_count, col_count, size,
              orientation, scale, hidden, is_imported, columns_order, column_widths,
              row_heights, cells, styles, merges, schemes)
           SELECT
             substr(encode(digest($1::text || id, 'sha256'), 'hex'), 1, 24),
             template_id, $1::text, name, ord, row_count, col_count, size,
             orientation, scale, hidden, is_imported, columns_order, column_widths,
             row_heights, cells, styles, merges, schemes
           FROM ${T.v3_pages}
           WHERE template_id = $2 AND version_id = $3`,
          [newVersionId, templateId, sourceVersionId],
        );

        // 2) Master-input groups — two passes still (we need a stable
        //    old→new id map for both group_id on MIs and parent_group_id
        //    on groups themselves), but each pass is now ONE statement.
        //    The id mapping is built in-SQL via a deterministic hash on
        //    (group_id, new_version_id) so the parent_group_id remap can
        //    target the same generated id without a round-trip.
        //    `$1::text` cast on every use of $1 inside digest() — without
        //    it Postgres tries to infer $1 as VARCHAR (from the INSERT
        //    column type) AND as text (from the `||` concat) and bails
        //    with "inconsistent types deduced for parameter $1".
        await tx.unsafe(
          `INSERT INTO ${T.master_input_group}
             (id, template_id, version_id, key, display_name, section, ord, parent_group_id)
           SELECT
             substr(encode(digest($1::text || g.id, 'sha256'), 'hex'), 1, 24),
             g.template_id, $1::text, g.key, g.display_name, g.section, g.ord,
             CASE WHEN g.parent_group_id IS NULL THEN NULL
                  ELSE substr(encode(digest($1::text || g.parent_group_id, 'sha256'), 'hex'), 1, 24)
             END
           FROM ${T.master_input_group} g
           WHERE g.template_id = $2 AND g.version_id = $3`,
          [newVersionId, templateId, sourceVersionId],
        );

        // 3) Master inputs — group_id remapped via the same SHA256(newVer || id)
        //    scheme used in step 2 so the FK lines up without a JS map round-trip.
        //
        //    `options` ALSO needs remapping for multiselect MIs: each option
        //    object carries a `pages` array of 24-char page IDs (see
        //    FE/.../schemeVisibility.js — `option.pages[i]` is matched
        //    against `page.id` to compute scheme-driven page visibility).
        //    Without remap, the new version's options keep referencing the
        //    OLD version's page IDs and every selected scheme resolves to
        //    zero visible pages.
        //
        //    The CASE below walks the options array (only when it IS a JSON
        //    array — `select`-type options can be plain strings; `boolean`
        //    has no options); for each entry that's an OBJECT with a
        //    `pages` key, it rewrites every page-id under that key via the
        //    same `substr(sha256(newVer || pid), 24)` formula step 1 uses
        //    to derive new page IDs. Non-multiselect entries and entries
        //    without `pages` pass through unchanged. `option.cell` (page-
        //    name-based) is untouched on purpose.
        await tx.unsafe(
          `INSERT INTO ${T.master_input}
             (id, template_id, version_id, key, value, ref, type, options,
              section, ord, display_name, kind, group_id, default_value)
           SELECT
             substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
             m.template_id, $1::text, m.key, m.value, m.ref, m.type,
             CASE
               WHEN m.options IS NULL OR jsonb_typeof(m.options) <> 'array' THEN m.options
               ELSE (
                 SELECT jsonb_agg(
                   CASE
                     WHEN jsonb_typeof(opt) = 'object' AND opt ? 'pages' THEN
                       jsonb_set(
                         opt,
                         '{pages}',
                         COALESCE(
                           (SELECT jsonb_agg(
                              substr(encode(digest($1::text || pid, 'sha256'), 'hex'), 1, 24)
                            )
                            FROM jsonb_array_elements_text(opt->'pages') AS pid),
                           '[]'::jsonb
                         )
                       )
                     ELSE opt
                   END
                 )
                 FROM jsonb_array_elements(m.options) AS opt
               )
             END AS options,
             m.section, m.ord, m.display_name, m.kind,
             CASE WHEN m.group_id IS NULL THEN NULL
                  ELSE substr(encode(digest($1::text || m.group_id, 'sha256'), 'hex'), 1, 24)
             END,
             m.default_value
           FROM ${T.master_input} m
           WHERE m.template_id = $2 AND m.version_id = $3`,
          [newVersionId, templateId, sourceVersionId],
        );
      }

      // Page groups (version-scoped): a copied version inherits the source's
      // set — membership is name-based (pageNames), stable across the fork, so
      // no page-id remap is needed. A blank/empty version starts with none
      // (explicit '[]', not NULL, so it doesn't fall back to the template blob).
      if (empty || !sourceVersionId) {
        await tx.unsafe(
          `UPDATE ${T.v3_versions} SET page_groups = '[]'::jsonb WHERE id = $1`,
          [newVersionId],
        );
      } else {
        await tx.unsafe(
          `UPDATE ${T.v3_versions} nv
              SET page_groups = (SELECT sv.page_groups FROM ${T.v3_versions} sv WHERE sv.id = $2)
            WHERE nv.id = $1`,
          [newVersionId, sourceVersionId],
        );
      }
    });
  } catch (e) {
    return res.status(500).json({ error: `Create version failed: ${e.message}` });
  }

  const [version] = await sql.unsafe(
    `SELECT * FROM ${T.v3_versions} WHERE id = $1`,
    [newVersionId],
  );
  res.status(201).json(version);
}

// POST /v3/templates/:id/versions/:targetVersionId/restore
// Body: { sourceVersionId }
//
// Replace the data inside `targetVersionId` with a fresh copy from
// `sourceVersionId`. The target's row in `v3_versions` (id + label) is left
// untouched — only its pages / master inputs / groups are wiped and re-seeded.
// Used by the "Restore from backup" button so the user can roll the live
// version back to a snapshot without renaming or losing the version slot.
//
// Response: NDJSON stream. Each chunk is a JSON object on its own line so the
// FE can drive a progress bar:
//   {phase:"plan", pages, groups, mis}
//   {phase:"wipe-done"}
//   {phase:"pages", done, total, name}
//   {phase:"groups", done, total, name}
//   {phase:"mis", done, total, name}
//   {phase:"done"}     ← success
//   {phase:"error", error}  ← any failure mid-flight
// Restore is NOT wrapped in a single transaction so progress can stream —
// partial corruption is possible on error and the FE should surface that.
export async function restoreVersion(req, res) {
  const sql = getSql();
  const { id: templateId, targetVersionId } = req.params;
  const { sourceVersionId } = req.body || {};
  if (!sourceVersionId) return res.status(400).json({ error: "sourceVersionId required" });
  if (sourceVersionId === targetVersionId) {
    return res.status(400).json({ error: "Source and target are the same version" });
  }

  const [tpl] = await sql.unsafe(
    `SELECT id FROM ${T.v3_templates} WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  if (!tpl) return res.status(404).json({ error: "Template not found" });

  const [target] = await sql.unsafe(
    `SELECT id FROM ${T.v3_versions} WHERE id = $1 AND template_id = $2 LIMIT 1`,
    [targetVersionId, templateId],
  );
  if (!target) return res.status(404).json({ error: "Target version not found" });

  const [source] = await sql.unsafe(
    `SELECT id FROM ${T.v3_versions} WHERE id = $1 AND template_id = $2 LIMIT 1`,
    [sourceVersionId, templateId],
  );
  if (!source) return res.status(404).json({ error: "Source version not found" });

  // Switch to NDJSON streaming mode. `flushHeaders` forces the response head
  // out so the client starts reading immediately; `X-Accel-Buffering: no`
  // disables proxy buffering (nginx/Vercel/etc).
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const emit = (event) => {
    res.write(JSON.stringify(event) + "\n");
  };

  try {
    // Plan: pre-count so the FE can size the progress bar before work starts.
    const [{ count: pageCount }] = await sql.unsafe(
      `SELECT COUNT(*)::int AS count FROM ${T.v3_pages} WHERE template_id = $1 AND version_id = $2`,
      [templateId, sourceVersionId],
    );
    const [{ count: groupCount }] = await sql.unsafe(
      `SELECT COUNT(*)::int AS count FROM ${T.master_input_group} WHERE template_id = $1 AND version_id = $2`,
      [templateId, sourceVersionId],
    );
    const [{ count: miCount }] = await sql.unsafe(
      `SELECT COUNT(*)::int AS count FROM ${T.master_input} WHERE template_id = $1 AND version_id = $2`,
      [templateId, sourceVersionId],
    );
    emit({ phase: "plan", pages: pageCount, groups: groupCount, mis: miCount });

    // Wipe target's data (NOT its v3_versions row — id + label stay).
    await sql.unsafe(
      `DELETE FROM ${T.master_input} WHERE template_id = $1 AND version_id = $2`,
      [templateId, targetVersionId],
    );
    await sql.unsafe(
      `DELETE FROM ${T.master_input_group} WHERE template_id = $1 AND version_id = $2`,
      [templateId, targetVersionId],
    );
    await sql.unsafe(
      `DELETE FROM ${T.v3_pages} WHERE template_id = $1 AND version_id = $2`,
      [templateId, targetVersionId],
    );
    emit({ phase: "wipe-done" });

    // Bulk copy via INSERT…SELECT — keeps the data inside Postgres so it's ONE
    // round-trip per table instead of ~1700. Uses the same deterministic
    // SHA-256 id remapping as the version-fork, so group ids, parent_group_id,
    // MI group_id, and multiselect options.pages[] all line up without a JS
    // map. Progress is emitted per table (each statement is fast).
    // 1) Pages — new id = substr(sha256(targetVerId || oldId), 24).
    await sql.unsafe(
      `INSERT INTO ${T.v3_pages}
         (id, template_id, version_id, name, ord, row_count, col_count, size,
          orientation, scale, hidden, is_imported, columns_order, column_widths,
          row_heights, cells, styles, merges, schemes, freeze_rows, freeze_cols, print_settings)
       SELECT
         substr(encode(digest($1::text || id, 'sha256'), 'hex'), 1, 24),
         template_id, $1::text, name, ord, row_count, col_count, size,
         orientation, scale, hidden, is_imported, columns_order, column_widths,
         row_heights, cells, styles, merges, schemes, freeze_rows, freeze_cols, print_settings
       FROM ${T.v3_pages}
       WHERE template_id = $2 AND version_id = $3`,
      [targetVersionId, templateId, sourceVersionId],
    );
    emit({ phase: "pages", done: pageCount, total: pageCount });

    // 2) MI groups — group id + parent_group_id remapped via the same hash.
    await sql.unsafe(
      `INSERT INTO ${T.master_input_group}
         (id, template_id, version_id, key, display_name, section, ord, parent_group_id)
       SELECT
         substr(encode(digest($1::text || g.id, 'sha256'), 'hex'), 1, 24),
         g.template_id, $1::text, g.key, g.display_name, g.section, g.ord,
         CASE WHEN g.parent_group_id IS NULL THEN NULL
              ELSE substr(encode(digest($1::text || g.parent_group_id, 'sha256'), 'hex'), 1, 24)
         END
       FROM ${T.master_input_group} g
       WHERE g.template_id = $2 AND g.version_id = $3`,
      [targetVersionId, templateId, sourceVersionId],
    );
    emit({ phase: "groups", done: groupCount, total: groupCount });

    // 3) Master inputs — group_id + multiselect options.pages[] remapped via
    // the same SHA-256 scheme. One INSERT…SELECT for the whole set.
    await sql.unsafe(
      `INSERT INTO ${T.master_input}
         (id, template_id, version_id, key, value, ref, type, options,
          section, ord, display_name, kind, group_id, default_value)
       SELECT
         substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
         m.template_id, $1::text, m.key, m.value, m.ref, m.type,
         CASE
           WHEN m.options IS NULL OR jsonb_typeof(m.options) <> 'array' THEN m.options
           ELSE (
             SELECT jsonb_agg(
               CASE
                 WHEN jsonb_typeof(opt) = 'object' AND opt ? 'pages' THEN
                   jsonb_set(opt, '{pages}', COALESCE(
                     (SELECT jsonb_agg(substr(encode(digest($1::text || pid, 'sha256'), 'hex'), 1, 24))
                      FROM jsonb_array_elements_text(opt->'pages') AS pid),
                     '[]'::jsonb))
                 ELSE opt
               END
             )
             FROM jsonb_array_elements(m.options) AS opt
           )
         END AS options,
         m.section, m.ord, m.display_name, m.kind,
         CASE WHEN m.group_id IS NULL THEN NULL
              ELSE substr(encode(digest($1::text || m.group_id, 'sha256'), 'hex'), 1, 24)
         END,
         m.default_value
       FROM ${T.master_input} m
       WHERE m.template_id = $2 AND m.version_id = $3`,
      [targetVersionId, templateId, sourceVersionId],
    );
    emit({ phase: "mis", done: miCount, total: miCount });

    // Page groups (version-scoped): replace the target's set with the source's.
    // Name-based membership is stable across versions, so no page-id remap.
    await sql.unsafe(
      `UPDATE ${T.v3_versions} t
          SET page_groups = COALESCE(
                (SELECT s.page_groups FROM ${T.v3_versions} s WHERE s.id = $2),
                '[]'::jsonb)
        WHERE t.id = $1`,
      [targetVersionId, sourceVersionId],
    );

    emit({ phase: "done" });
    res.end();
  } catch (e) {
    try { emit({ phase: "error", error: e.message }); } catch {}
    try { res.end(); } catch {}
  }
}

// POST /v3/templates/:id/publish
// Body: { version_id, label? }
// Promotes a (non-published) version to the live published release. Pure
// pointer flip — NO fork, NO new "draft". The version being published becomes
// locked; the PREVIOUSLY published version is now just another non-published
// version and is editable again. Existing instances stay pinned to their own
// version; only NEW instances use the new release.
export async function publishVersion(req, res) {
  const sql = getSql();
  const { id: templateId } = req.params;
  const { version_id, label } = req.body || {};
  if (!version_id) return res.status(400).json({ error: "version_id required" });

  const [v] = await sql.unsafe(
    `SELECT id FROM ${T.v3_versions} WHERE id = $1 AND template_id = $2 LIMIT 1`,
    [version_id, templateId],
  );
  if (!v) return res.status(404).json({ error: "Version not found for this template" });

  try {
    await sql.begin(async (tx) => {
      if (label && String(label).trim()) {
        await tx.unsafe(`UPDATE ${T.v3_versions} SET label = $1 WHERE id = $2`, [
          String(label).trim(),
          version_id,
        ]);
      }
      await tx.unsafe(
        `UPDATE ${T.v3_templates} SET published_version_id = $1, updated_at = NOW() WHERE id = $2`,
        [version_id, templateId],
      );
    });
  } catch (e) {
    return res.status(500).json({ error: `Publish failed: ${e.message}` });
  }

  const [tpl] = await sql.unsafe(`SELECT * FROM ${T.v3_templates} WHERE id = $1`, [templateId]);
  res.json(tpl);
}

// POST /v3/templates/:id/promote
// Body: { sourceVersionId, targetVersionId, pages?: [name...], masterInputs?: [{key, section}...] }
//
// Selectively copies SPECIFIC pages and/or master inputs from a SOURCE version
// (typically the editable draft) into a TARGET version (typically the published
// one) WITHOUT republishing the whole version. Pages match by name; master
// inputs by (key, section). This is the sanctioned way to push a single change
// live, so it deliberately bypasses the published-lock the PATCH handlers
// enforce. Returns a summary of what was updated / created / skipped.
export async function promoteToPublished(req, res) {
  const sql = getSql();
  const { id: templateId } = req.params;
  const b = req.body || {};
  const { sourceVersionId, targetVersionId } = b;
  const pageNames = Array.isArray(b.pages) ? b.pages.filter((n) => typeof n === "string") : [];
  const mis = Array.isArray(b.masterInputs) ? b.masterInputs.filter((m) => m && m.key) : [];
  // Whole-section promote. "—" is the UI placeholder for the no-section bucket;
  // exclude it (those loose inputs are promoted individually).
  const sectionNames = Array.isArray(b.sections)
    ? b.sections.filter((s) => typeof s === "string" && s !== "—")
    : [];

  if (!sourceVersionId || !targetVersionId) {
    return res.status(400).json({ error: "sourceVersionId and targetVersionId required" });
  }
  if (sourceVersionId === targetVersionId) {
    return res.status(400).json({ error: "Source and target are the same version" });
  }
  if (pageNames.length === 0 && mis.length === 0 && sectionNames.length === 0) {
    return res.status(400).json({ error: "Nothing to promote: provide pages, masterInputs and/or sections" });
  }

  try {
    const [src] = await sql.unsafe(
      `SELECT id FROM ${T.v3_versions} WHERE id = $1 AND template_id = $2 LIMIT 1`,
      [sourceVersionId, templateId],
    );
    if (!src) return res.status(404).json({ error: "Source version not found" });
    const [tgt] = await sql.unsafe(
      `SELECT id FROM ${T.v3_versions} WHERE id = $1 AND template_id = $2 LIMIT 1`,
      [targetVersionId, templateId],
    );
    if (!tgt) return res.status(404).json({ error: "Target version not found" });

    const out = {
      pages: { updated: [], created: [], missing: [] },
      masterInputs: { updated: [], missing: [] },
      sections: { promoted: [], empty: [] },
    };

    // ── Pages (match by name) ───────────────────────────────────────────────
    for (const name of pageNames) {
      const [srcPage] = await sql.unsafe(
        `SELECT id FROM ${T.v3_pages} WHERE template_id = $1 AND version_id = $2 AND name = $3 LIMIT 1`,
        [templateId, sourceVersionId, name],
      );
      if (!srcPage) {
        out.pages.missing.push(name);
        continue;
      }
      // Overwrite the target page's CONTENT from the source (keep target's id,
      // version_id, name and ord). One UPDATE…FROM matched by name.
      const updated = await sql.unsafe(
        `UPDATE ${T.v3_pages} t SET
           row_count = s.row_count, col_count = s.col_count, size = s.size,
           orientation = s.orientation, scale = s.scale, hidden = s.hidden,
           is_imported = s.is_imported, columns_order = s.columns_order,
           column_widths = s.column_widths, row_heights = s.row_heights,
           cells = s.cells, styles = s.styles, merges = s.merges, schemes = s.schemes,
           freeze_rows = s.freeze_rows, freeze_cols = s.freeze_cols,
           print_settings = s.print_settings, updated_at = NOW()
         FROM ${T.v3_pages} s
         WHERE t.template_id = $1 AND t.version_id = $2 AND t.name = $4
           AND s.template_id = $1 AND s.version_id = $3 AND s.name = $4
         RETURNING t.id`,
        [templateId, targetVersionId, sourceVersionId, name],
      );
      if (updated.length) {
        out.pages.updated.push(name);
        broadcast({ type: "page.updated", templateId, versionId: targetVersionId, pageId: updated[0].id, pageName: name });
      } else {
        // Target has no page with that name — create a copy at the next free ord.
        const [{ max_ord }] = await sql.unsafe(
          `SELECT COALESCE(MAX(ord), -1) AS max_ord FROM ${T.v3_pages} WHERE template_id = $1 AND version_id = $2`,
          [templateId, targetVersionId],
        );
        const newId = newObjectId();
        await sql.unsafe(
          `INSERT INTO ${T.v3_pages}
             (id, template_id, version_id, name, ord, row_count, col_count, size, orientation, scale,
              hidden, is_imported, columns_order, column_widths, row_heights, cells, styles, merges,
              schemes, freeze_rows, freeze_cols, print_settings)
           SELECT $4, template_id, $2::text, name, $5, row_count, col_count, size, orientation, scale,
              hidden, is_imported, columns_order, column_widths, row_heights, cells, styles, merges,
              schemes, freeze_rows, freeze_cols, print_settings
           FROM ${T.v3_pages} WHERE template_id = $1 AND version_id = $3 AND name = $6`,
          [templateId, targetVersionId, sourceVersionId, newId, (max_ord ?? -1) + 1, name],
        );
        out.pages.created.push(name);
        broadcast({ type: "page.updated", templateId, versionId: targetVersionId, pageId: newId, pageName: name });
      }
    }

    // ── Master inputs (match by key + section; UPDATE existing only) ─────────
    // multiselect `options[].pages` hold page IDs that are version-scoped, so
    // they're remapped source→target by page NAME during the copy.
    for (const m of mis) {
      const key = String(m.key);
      const section = m.section == null ? null : String(m.section);
      const updated = await sql.unsafe(
        `UPDATE ${T.master_input} t SET
           value = s.value, default_value = s.default_value, ref = s.ref, type = s.type,
           display_name = s.display_name, kind = s.kind,
           options = CASE
             WHEN s.options IS NULL OR jsonb_typeof(s.options) <> 'array' THEN s.options
             ELSE (
               SELECT jsonb_agg(
                 CASE WHEN jsonb_typeof(opt) = 'object' AND opt ? 'pages' THEN
                   jsonb_set(opt, '{pages}', COALESCE(
                     (SELECT jsonb_agg(tp.id)
                      FROM jsonb_array_elements_text(opt->'pages') AS pid
                      JOIN ${T.v3_pages} sp ON sp.id = pid AND sp.template_id = $1 AND sp.version_id = $3
                      JOIN ${T.v3_pages} tp ON tp.name = sp.name AND tp.template_id = $1 AND tp.version_id = $2),
                     '[]'::jsonb))
                 ELSE opt END)
               FROM jsonb_array_elements(s.options) AS opt)
           END
         FROM ${T.master_input} s
         WHERE t.template_id = $1 AND t.version_id = $2 AND t.key = $4 AND COALESCE(t.section,'') = COALESCE($5,'')
           AND s.template_id = $1 AND s.version_id = $3 AND s.key = $4 AND COALESCE(s.section,'') = COALESCE($5,'')
         RETURNING t.id, t.key, t.ref, t.value`,
        [templateId, targetVersionId, sourceVersionId, key, section],
      );
      if (updated.length) {
        out.masterInputs.updated.push(key);
        const r = updated[0];
        broadcast({ type: "masterInput.updated", templateId, versionId: targetVersionId, masterInputId: r.id, key: r.key, ref: r.ref, value: r.value });
      } else {
        out.masterInputs.missing.push(key);
      }
    }

    // ── Whole sections (replace the published section's groups + inputs with
    // the draft's). Done as delete-then-reinsert inside ONE transaction per
    // section so it stays atomic — handles edits, additions AND removals.
    // Group ids are remapped deterministically (sha256(targetVer || srcId)) so
    // each MI's group_id lines up with the freshly inserted group; multiselect
    // options[].pages are remapped source→target by page NAME.
    for (const section of sectionNames) {
      // How much is in the SOURCE section (for the result + skip empties).
      const [{ count: srcMiCount }] = await sql.unsafe(
        `SELECT COUNT(*)::int AS count FROM ${T.master_input} WHERE template_id=$1 AND version_id=$2 AND COALESCE(section,'')=COALESCE($3,'')`,
        [templateId, sourceVersionId, section],
      );
      const [{ count: srcGroupCount }] = await sql.unsafe(
        `SELECT COUNT(*)::int AS count FROM ${T.master_input_group} WHERE template_id=$1 AND version_id=$2 AND COALESCE(section,'')=COALESCE($3,'')`,
        [templateId, sourceVersionId, section],
      );
      if (srcMiCount === 0 && srcGroupCount === 0) {
        out.sections.empty.push(section);
        continue;
      }

      await sql.begin(async (tx) => {
        // 1) Wipe the target section's inputs then groups (FK order).
        await tx.unsafe(
          `DELETE FROM ${T.master_input} WHERE template_id=$1 AND version_id=$2 AND COALESCE(section,'')=COALESCE($3,'')`,
          [templateId, targetVersionId, section],
        );
        await tx.unsafe(
          `DELETE FROM ${T.master_input_group} WHERE template_id=$1 AND version_id=$2 AND COALESCE(section,'')=COALESCE($3,'')`,
          [templateId, targetVersionId, section],
        );
        // 2) Copy the source section's groups (id + parent_group_id remapped).
        await tx.unsafe(
          `INSERT INTO ${T.master_input_group}
             (id, template_id, version_id, key, display_name, section, ord, parent_group_id)
           SELECT
             substr(encode(digest($1::text || g.id, 'sha256'), 'hex'), 1, 24),
             g.template_id, $1::text, g.key, g.display_name, g.section, g.ord,
             CASE WHEN g.parent_group_id IS NULL THEN NULL
                  ELSE substr(encode(digest($1::text || g.parent_group_id, 'sha256'), 'hex'), 1, 24) END
           FROM ${T.master_input_group} g
           WHERE g.template_id = $2 AND g.version_id = $3 AND COALESCE(g.section,'') = COALESCE($4,'')`,
          [targetVersionId, templateId, sourceVersionId, section],
        );
        // 3) Copy the source section's inputs (group_id remapped to match the
        //    inserted groups; options[].pages remapped to target pages by name).
        await tx.unsafe(
          `INSERT INTO ${T.master_input}
             (id, template_id, version_id, key, value, ref, type, options,
              section, ord, display_name, kind, group_id, default_value)
           SELECT
             substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
             m.template_id, $1::text, m.key, m.value, m.ref, m.type,
             CASE
               WHEN m.options IS NULL OR jsonb_typeof(m.options) <> 'array' THEN m.options
               ELSE (
                 SELECT jsonb_agg(
                   CASE WHEN jsonb_typeof(opt) = 'object' AND opt ? 'pages' THEN
                     jsonb_set(opt, '{pages}', COALESCE(
                       (SELECT jsonb_agg(tp.id)
                        FROM jsonb_array_elements_text(opt->'pages') AS pid
                        JOIN ${T.v3_pages} sp ON sp.id = pid AND sp.template_id = $2 AND sp.version_id = $3
                        JOIN ${T.v3_pages} tp ON tp.name = sp.name AND tp.template_id = $2 AND tp.version_id = $1),
                       '[]'::jsonb))
                   ELSE opt END)
                 FROM jsonb_array_elements(m.options) AS opt)
             END AS options,
             m.section, m.ord, m.display_name, m.kind,
             CASE WHEN m.group_id IS NULL THEN NULL
                  ELSE substr(encode(digest($1::text || m.group_id, 'sha256'), 'hex'), 1, 24) END,
             m.default_value
           FROM ${T.master_input} m
           WHERE m.template_id = $2 AND m.version_id = $3 AND COALESCE(m.section,'') = COALESCE($4,'')`,
          [targetVersionId, templateId, sourceVersionId, section],
        );
      });

      out.sections.promoted.push({ name: section, mis: srcMiCount, groups: srcGroupCount });
      // One broadcast nudges any viewer of the published version to refetch MIs.
      broadcast({ type: "masterInput.updated", templateId, versionId: targetVersionId, section });
    }

    res.json({ ok: true, ...out });
  } catch (e) {
    console.error("[promoteToPublished] error:", e?.message || e);
    res.status(500).json({ error: String(e?.message || e) });
  }
}

// POST /v3/templates/:id/push-to-published
// Body: { sourceVersionId }
// One-click "Push to Publish": syncs EVERYTHING from the given (editable) source
// version into the template's live published version — every page, every whole
// section (groups + MIs, including removals) and every loose master input. The
// published pointer does NOT move: its version id stays the same, so instance
// print-overrides and instance MI value overrides (keyed by stable MI key)
// survive; the source version stays editable. Implemented by enumerating the
// source's content and delegating to promoteToPublished — the sanctioned,
// lock-bypassing sync path — so there is one code path for "push changes live".
export async function pushToPublished(req, res) {
  const sql = getSql();
  const { id: templateId } = req.params;
  const { sourceVersionId } = req.body || {};
  if (!sourceVersionId) return res.status(400).json({ error: "sourceVersionId required" });

  const [tpl] = await sql.unsafe(
    `SELECT published_version_id FROM ${T.v3_templates} WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  const targetVersionId = tpl?.published_version_id || null;
  if (!targetVersionId) {
    return res.status(400).json({ error: "Template has no published version to push to" });
  }
  if (sourceVersionId === targetVersionId) {
    return res.status(400).json({ error: "This version is already the published version" });
  }

  // Enumerate everything on the source (edit) version.
  const pages = (
    await sql.unsafe(
      `SELECT name FROM ${T.v3_pages} WHERE template_id = $1 AND version_id = $2 ORDER BY ord ASC`,
      [templateId, sourceVersionId],
    )
  ).map((r) => r.name).filter((n) => typeof n === "string");
  const sections = (
    await sql.unsafe(
      `SELECT DISTINCT section FROM ${T.master_input}
        WHERE template_id = $1 AND version_id = $2 AND section IS NOT NULL AND section <> ''`,
      [templateId, sourceVersionId],
    )
  ).map((r) => r.section);
  // Loose (no-section) master inputs are promoted individually by (key, section).
  const masterInputs = (
    await sql.unsafe(
      `SELECT key, section FROM ${T.master_input}
        WHERE template_id = $1 AND version_id = $2 AND (section IS NULL OR section = '')`,
      [templateId, sourceVersionId],
    )
  ).map((r) => ({ key: r.key, section: r.section ?? null }));

  if (pages.length === 0 && sections.length === 0 && masterInputs.length === 0) {
    return res.status(400).json({ error: "Nothing to push — the source version is empty" });
  }

  // Delegate to the existing, tested promote path with the full lists.
  req.body = { sourceVersionId, targetVersionId, pages, sections, masterInputs };
  return promoteToPublished(req, res);
}

// POST /v3/templates/:id/push-to-published/preview  { sourceVersionId }
// Diffs the (editable) source version against the live published version and
// returns what Push to Publish WOULD change — so the UI can say "no changes"
// when they're identical, or summarise the diff otherwise. Compares only the
// content fields Push actually syncs and that are NOT version-scoped ids:
// page cells/styles/merges + dimensions, and MI value/default_value/ref/type/
// display_name/kind. (MI options + group_id embed version-scoped page/group ids
// remapped per version, so they'd false-positive and are intentionally skipped.)
export async function pushToPublishedPreview(req, res) {
  const sql = getSql();
  const { id: templateId } = req.params;
  const { sourceVersionId } = req.body || {};
  if (!sourceVersionId) return res.status(400).json({ error: "sourceVersionId required" });

  const [tpl] = await sql.unsafe(
    `SELECT published_version_id FROM ${T.v3_templates} WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  const targetVersionId = tpl?.published_version_id || null;
  if (!targetVersionId) return res.status(400).json({ error: "Template has no published version" });

  const empty = { hasChanges: false, samePublished: sourceVersionId === targetVersionId, pages: { changed: [], added: [], removed: [] }, masterInputs: { changed: [], added: [], removed: [] } };
  if (sourceVersionId === targetVersionId) return res.json(empty);

  try {
    // Pages — matched by name.
    const pageRows = await sql.unsafe(
      `SELECT
         COALESCE(s.name, t.name) AS name,
         (s.name IS NOT NULL) AS in_src,
         (t.name IS NOT NULL) AS in_tgt,
         (s.name IS NOT NULL AND t.name IS NOT NULL AND (
            s.cells IS DISTINCT FROM t.cells OR s.styles IS DISTINCT FROM t.styles OR
            s.merges IS DISTINCT FROM t.merges OR s.row_count IS DISTINCT FROM t.row_count OR
            s.col_count IS DISTINCT FROM t.col_count OR s.column_widths IS DISTINCT FROM t.column_widths OR
            s.row_heights IS DISTINCT FROM t.row_heights OR s.hidden IS DISTINCT FROM t.hidden OR
            s.print_settings IS DISTINCT FROM t.print_settings
         )) AS changed
       FROM (SELECT * FROM ${T.v3_pages} WHERE template_id = $1 AND version_id = $2) s
       FULL OUTER JOIN (SELECT * FROM ${T.v3_pages} WHERE template_id = $1 AND version_id = $3) t
         ON s.name = t.name`,
      [templateId, sourceVersionId, targetVersionId],
    );
    const pages = { changed: [], added: [], removed: [] };
    for (const r of pageRows) {
      if (r.in_src && !r.in_tgt) pages.added.push(r.name);
      else if (!r.in_src && r.in_tgt) pages.removed.push(r.name);
      else if (r.changed) pages.changed.push(r.name);
    }

    // Master inputs — matched by (key, section).
    const miRows = await sql.unsafe(
      `SELECT
         COALESCE(s.key, t.key) AS key,
         (s.id IS NOT NULL) AS in_src,
         (t.id IS NOT NULL) AS in_tgt,
         (s.id IS NOT NULL AND t.id IS NOT NULL AND (
            s.value IS DISTINCT FROM t.value OR s.default_value IS DISTINCT FROM t.default_value OR
            s.ref IS DISTINCT FROM t.ref OR s.type IS DISTINCT FROM t.type OR
            s.display_name IS DISTINCT FROM t.display_name OR s.kind IS DISTINCT FROM t.kind
         )) AS changed
       FROM (SELECT * FROM ${T.master_input} WHERE template_id = $1 AND version_id = $2) s
       FULL OUTER JOIN (SELECT * FROM ${T.master_input} WHERE template_id = $1 AND version_id = $3) t
         ON s.key = t.key AND COALESCE(s.section,'') = COALESCE(t.section,'')`,
      [templateId, sourceVersionId, targetVersionId],
    );
    const masterInputs = { changed: [], added: [], removed: [] };
    for (const r of miRows) {
      if (r.in_src && !r.in_tgt) masterInputs.added.push(r.key);
      else if (!r.in_src && r.in_tgt) masterInputs.removed.push(r.key);
      else if (r.changed) masterInputs.changed.push(r.key);
    }

    const hasChanges =
      pages.changed.length + pages.added.length + pages.removed.length +
      masterInputs.changed.length + masterInputs.added.length + masterInputs.removed.length > 0;
    res.json({ hasChanges, samePublished: false, pages, masterInputs });
  } catch (e) {
    console.error("[pushToPublishedPreview] error:", e?.message || e);
    res.status(500).json({ error: String(e?.message || e) });
  }
}

// PATCH /v3/templates/:id/versions/:versionId  { label?, notes? }
// Edit a version's metadata — its label (rename) and/or its `notes` markdown
// changelog. Content (pages/MIs) is untouched. Works for any version,
// including the published one (label + notes are metadata, not content).
export async function patchVersion(req, res) {
  const sql = getSql();
  const { id: templateId, versionId } = req.params;
  const b = req.body || {};

  const sets = [];
  const params = [versionId, templateId];
  let i = 3;
  if (Object.prototype.hasOwnProperty.call(b, "label")) {
    const label = String(b.label ?? "").trim();
    if (!label) return res.status(400).json({ error: "label cannot be empty" });
    sets.push(`label = $${i++}`);
    params.push(label);
  }
  if (Object.prototype.hasOwnProperty.call(b, "notes")) {
    // notes may be empty (clearing the changelog) — keep it as-is, just stringify.
    sets.push(`notes = $${i++}`);
    params.push(b.notes == null ? null : String(b.notes));
  }
  if (sets.length === 0) return res.status(400).json({ error: "label or notes required" });

  const [row] = await sql.unsafe(
    `UPDATE ${T.v3_versions} SET ${sets.join(", ")}
       WHERE id = $1 AND template_id = $2
     RETURNING id, label, notes, author_id, created_at`,
    params,
  );
  if (!row) return res.status(404).json({ error: "Version not found for this template" });
  res.json(row);
}

// DELETE /v3/templates/:id/versions/:versionId
// Removes a version and all pages + master inputs that belong to it.
// Refuses to delete the published version.
export async function deleteVersion(req, res) {
  const sql = getSql();
  const { id: templateId, versionId } = req.params;
  const [tpl] = await sql.unsafe(
    `SELECT published_version_id FROM ${T.v3_templates} WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  if (!tpl) return res.status(404).json({ error: "Template not found" });
  if (tpl.published_version_id === versionId) {
    return res.status(400).json({ error: "Cannot delete the published version" });
  }
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(
        `DELETE FROM ${T.v3_pages} WHERE template_id = $1 AND version_id = $2`,
        [templateId, versionId],
      );
      await tx.unsafe(
        `DELETE FROM ${T.master_input} WHERE template_id = $1 AND version_id = $2`,
        [templateId, versionId],
      );
      await tx.unsafe(
        `DELETE FROM ${T.master_input_group} WHERE template_id = $1 AND version_id = $2`,
        [templateId, versionId],
      );
      await tx.unsafe(
        `DELETE FROM ${T.v3_versions} WHERE id = $1 AND template_id = $2`,
        [versionId, templateId],
      );
    });
  } catch (e) {
    return res.status(500).json({ error: `Delete version failed: ${e.message}` });
  }
  res.status(204).end();
}

// ── POST /v3/migrate/:legacyTemplateId ─────────────────────────────────────────
// Ingest a legacy `templates` row → fresh v3_templates + v1 version + pages + MIs.
export async function migrateLegacy(req, res) {
  const sql = getSql();
  const { legacyTemplateId } = req.params;
  const force = req.query.force === "1";

  const [existing] = await sql.unsafe(
    `SELECT id FROM ${T.v3_templates} WHERE legacy_template_id = $1 LIMIT 1`,
    [legacyTemplateId],
  );
  if (existing && !force) {
    return res.json({ ok: true, v3TemplateId: existing.id, alreadyMigrated: true });
  }

  const [legacy] = await sql.unsafe(
    `SELECT id, name, scheme, description, userid, pages, masterinput
     FROM ${T.legacy_templates} WHERE id = $1 LIMIT 1`,
    [legacyTemplateId],
  );
  if (!legacy) return res.status(404).json({ error: "Legacy template not found" });

  if (existing && force) {
    // Cascade-delete everything tied to the existing v3 template id.
    await sql.unsafe(`DELETE FROM ${T.master_input} WHERE template_id = $1`, [existing.id]);
    await sql.unsafe(`DELETE FROM ${T.master_input_group} WHERE template_id = $1`, [existing.id]);
    await sql.unsafe(`DELETE FROM ${T.v3_pages} WHERE template_id = $1`, [existing.id]);
    await sql.unsafe(`DELETE FROM ${T.v3_versions} WHERE template_id = $1`, [existing.id]);
    await sql.unsafe(`DELETE FROM ${T.v3_templates} WHERE id = $1`, [existing.id]);
  }

  const v3TemplateId = newObjectId();
  const versionId = newObjectId();

  // Template + initial "v1" version (which is also auto-published).
  await sql.unsafe(
    `INSERT INTO ${T.v3_templates}
       (id, name, scheme, description, user_id, legacy_template_id, published_version_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      v3TemplateId,
      legacy.name ?? null,
      legacy.scheme ?? null,
      legacy.description ?? null,
      legacy.userid ?? null,
      legacy.id,
      versionId,
    ],
  );
  await sql.unsafe(
    `INSERT INTO ${T.v3_versions} (id, template_id, label) VALUES ($1, $2, $3)`,
    [versionId, v3TemplateId, "v1"],
  );

  // Pages
  const legacyPages = Array.isArray(legacy.pages) ? legacy.pages : [];
  let pagesMigrated = 0;
  let cellsTotal = 0;
  let stylesTotal = 0;
  for (let idx = 0; idx < legacyPages.length; idx++) {
    const lp = legacyPages[idx] || {};
    const conv = convertLegacyPage(lp);
    if (!Number.isFinite(conv.ord)) conv.ord = idx;
    conv.ord = idx;

    const pageId = newObjectId();
    await sql.unsafe(
      `INSERT INTO ${T.v3_pages}
         (id, template_id, version_id, name, ord, row_count, col_count, size,
          orientation, scale, hidden, is_imported, columns_order, column_widths,
          cells, styles, merges)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        pageId, v3TemplateId, versionId,
        conv.name, conv.ord, conv.row_count, conv.col_count, conv.size,
        conv.orientation, conv.scale, conv.hidden, conv.is_imported,
        conv.columns_order, conv.column_widths, conv.cells, conv.styles, conv.merges,
      ],
    );
    pagesMigrated++;
    cellsTotal += Object.keys(conv.cells).length;
    stylesTotal += Object.keys(conv.styles).length;
  }

  // Master inputs
  const mis = convertLegacyMasterInputs(legacy.masterinput);
  const sectionOrder = [];
  const seenSections = new Set();
  for (const mi of mis) {
    await sql.unsafe(
      `INSERT INTO ${T.master_input}
         (id, template_id, version_id, key, value, ref, type, options, section, ord)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        newObjectId(), v3TemplateId, versionId,
        mi.key, mi.value, mi.ref, mi.type, mi.options, mi.section, mi.ord,
      ],
    );
    if (mi.section && !seenSections.has(mi.section)) {
      seenSections.add(mi.section);
      sectionOrder.push(mi.section);
    }
  }

  if (sectionOrder.length) {
    const inputSections = sectionOrder.map((name, idx) => ({ name, ord: idx }));
    await sql.unsafe(
      `UPDATE ${T.v3_templates} SET input_sections = $1 WHERE id = $2`,
      [inputSections, v3TemplateId],
    );
  }

  res.json({
    ok: true,
    v3TemplateId,
    versionId,
    legacyTemplateId,
    pagesMigrated,
    cellsTotal,
    stylesTotal,
    masterInputsMigrated: mis.length,
  });
}

// ── GET /v3/legacy/templates ───────────────────────────────────────────────────
export async function listLegacyTemplates(_req, res) {
  const sql = getSql();
  const rows = await sql.unsafe(`
    SELECT t.id, t.name, t.scheme, t.description,
           (SELECT id FROM ${T.v3_templates} WHERE legacy_template_id = t.id LIMIT 1) AS v3_template_id
    FROM ${T.legacy_templates} t
    WHERE COALESCE(t.is_disabled, FALSE) = FALSE
    ORDER BY COALESCE(t."order", 0) ASC, t.name ASC
    LIMIT 200
  `);
  res.json({ legacyTemplates: rows });
}

// ─── Instances (per-feasibility copies of a template) ─────────────────────────
// An instance is a lightweight pointer to a template plus its own master-input
// values. Pages / formulas / groups are NOT duplicated — they read through the
// template_id FK. The instance UI (RetemplateTwo) computes formulas client-side
// the way DirectFeasibilityV7 does.

// GET /v3/instances
export async function listInstances(req, res) {
  const sql = getSql();
  const templateId = req.query.template_id || null;
  let rows;
  if (templateId) {
    rows = await sql.unsafe(
      `SELECT i.*, t.name AS template_name, t.scheme AS template_scheme
       FROM ${T.v3_instances} i
       LEFT JOIN ${T.v3_templates} t ON t.id = i.template_id
       WHERE i.template_id = $1
       ORDER BY i.created_at DESC
       LIMIT 500`,
      [templateId],
    );
  } else {
    rows = await sql.unsafe(
      `SELECT i.*, t.name AS template_name, t.scheme AS template_scheme
       FROM ${T.v3_instances} i
       LEFT JOIN ${T.v3_templates} t ON t.id = i.template_id
       ORDER BY i.created_at DESC
       LIMIT 500`,
    );
  }
  res.json({ instances: rows.map(normalizeInstance) });
}

// POST /v3/instances
// Body: { template_id, name?, user_id?, version_id? }
//
// REFERENCE + OVERRIDES model: creates EXACTLY one row in v3_instances.
// No per-MI rows are fan-out-inserted. Instance MI values are pulled live
// from v3_master_input at GET time (via LEFT JOIN), and overrides land in
// v3_instance_master_input lazily — only when the user sets a value.
//
// The instance stores version_id = NULL and ALWAYS follows the template's
// CURRENT published_version_id (resolved at read time in getInstance). So
// publishing a new version auto-upgrades every instance to that release —
// instances are never pinned to a stale version.
// Resolve the requesting user's id from the request (body for parity with the
// direct-feasibility model; falls back to an auth-middleware-populated req.user).
function requesterId(req) {
  const b = req.body || {};
  return b.user_id ?? b.userid ?? req.user?.id ?? req.user?.userId ?? null;
}

// Edit-permission gate for an instance. The owner (v3_instances.user_id) or any
// listed collaborator may write; everyone else (incl. anonymous) is rejected with
// 403 — but ONLY once the instance has an owner set. Legacy owner-less instances
// stay open for backward compatibility (same rule as direct feasibilities).
async function checkInstancePermission(sql, instanceId, userid) {
  const [inst] = await sql.unsafe(
    `SELECT id, user_id, collaborators FROM ${T.v3_instances} WHERE id = $1 LIMIT 1`,
    [instanceId],
  );
  if (!inst) return { ok: false, status: 404, error: "Instance not found" };
  const owner = inst.user_id;
  const collabs = Array.isArray(inst.collaborators) ? inst.collaborators : [];
  const uid = userid == null ? null : String(userid);
  const isOwner = !!(owner && uid && String(owner) === uid);
  const isCollaborator = !!(uid && collabs.some((c) => String(c) === uid));
  if (owner && !isOwner && !isCollaborator) {
    return { ok: false, status: 403, error: "You are not authorized to edit this instance.", inst };
  }
  return { ok: true, inst, isOwner, isCollaborator };
}

export async function createInstance(req, res) {
  const sql = getSql();
  const b = req.body || {};
  if (!b.template_id) return res.status(400).json({ error: "template_id required" });
  // Require a logged-in user — no anonymous report creation. The created
  // instance is owned by this user (which then locks editing to them).
  const ownerId = requesterId(req);
  if (!ownerId) return res.status(401).json({ error: "Sign in required to create a report." });

  const [tpl] = await sql.unsafe(
    `SELECT id, name, published_version_id FROM ${T.v3_templates} WHERE id = $1 LIMIT 1`,
    [b.template_id],
  );
  if (!tpl) return res.status(404).json({ error: "Template not found" });

  // Do NOT pin the version. Store NULL so the instance ALWAYS resolves to the
  // template's CURRENT published_version_id at read time (see getInstance) —
  // publishing a new version auto-upgrades every instance to it. A caller may
  // still pass an explicit version_id to deliberately pin a snapshot.
  const versionId = b.version_id || null;
  const instanceId = newObjectId();
  const instanceName =
    (b.name && String(b.name).trim()) ||
    `${tpl.name || "Untitled"} — instance ${new Date().toISOString().slice(0, 10)}`;

  try {
    // Remember which calculation this instance was created from, so its scheme
    // can be re-resolved on every open (see getInstance). Idempotent column add
    // works even when ENSURE_TABLES=false.
    await sql.unsafe(`ALTER TABLE ${T.v3_instances} ADD COLUMN IF NOT EXISTS calculation_id VARCHAR(24)`).catch(() => {});
    const calculationId = b.calculation_id ? String(b.calculation_id) : null;
    await sql.unsafe(
      `INSERT INTO ${T.v3_instances}
         (id, template_id, version_id, name, user_id, calculation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [instanceId, b.template_id, versionId, instanceName, String(ownerId), calculationId],
    );
  } catch (e) {
    return res.status(500).json({ error: `Create instance failed: ${e.message}` });
  }

  const [row] = await sql.unsafe(`SELECT * FROM ${T.v3_instances} WHERE id = $1`, [instanceId]);
  res.status(201).json(row);
}

// GET /v3/instances/:id
// Returns the instance + the underlying template + its pages (the active
// version's pages) + the instance's composed master inputs + the template's
// groups. One round-trip → enough to render the client editor.
//
// REFERENCE + OVERRIDES read: master inputs are composed via LEFT JOIN
// (v3_master_input ↔ v3_instance_master_input). Metadata comes from the
// template (so a typo fix in display_name reaches existing instances);
// `value` comes from the override row if one exists, otherwise falls back
// to the template's authored default `tmi.value`. The returned `id` is the
// TEMPLATE MI's id — that's the stable identifier the FE uses to PATCH
// values; the override row's id is never surfaced.
export async function getInstance(req, res) {
  const sql = getSql();
  const { id } = req.params;
  const [inst] = await sql.unsafe(
    `SELECT * FROM ${T.v3_instances} WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (!inst) return res.status(404).json({ error: "Instance not found" });

  const [tpl] = await sql.unsafe(
    `SELECT * FROM ${T.v3_templates} WHERE id = $1 LIMIT 1`,
    [inst.template_id],
  );
  // Always follow the template's CURRENT published version, ignoring any
  // version_id pinned on the instance row — so every report (old or new)
  // auto-resolves to the latest published release with no per-row DB edits.
  const versionId = tpl?.published_version_id || inst.version_id || null;

  const pages = await sql.unsafe(
    // NOTE: `row_heights` must be included here — the instance grid in
    // RetemplateTwo reads it the same way the editor does to make row
    // heights match. Dropping it makes every editor-resized row collapse
    // back to the browser-natural height in the instance view.
    `SELECT id, name, ord, row_count, col_count, size, orientation, scale,
            hidden, is_imported, columns_order, column_widths, row_heights,
            cells, styles, merges, schemes, freeze_rows, freeze_cols, print_settings
     FROM ${T.v3_pages}
     WHERE template_id = $1 AND ($2::text IS NULL OR version_id = $2)
     ORDER BY ord ASC, name ASC`,
    [inst.template_id, versionId],
  );
  const mis = await sql.unsafe(
    `SELECT
        tmi.id,
        tmi.id            AS template_mi_id,
        tmi.template_id,
        tmi.version_id,
        tmi.key,
        tmi.display_name,
        tmi.ref,
        tmi.type,
        tmi.options,
        tmi.section,
        tmi.ord,
        tmi.kind,
        tmi.group_id,
        COALESCE(imi.value, tmi.default_value, tmi.value) AS value
     FROM ${T.master_input} tmi
     LEFT JOIN ${T.instance_mi} imi
       ON imi.instance_id = $1
       AND (
         imi.template_mi_key = tmi.key
         OR (imi.template_mi_key IS NULL AND imi.template_mi_id = tmi.id)
       )
     WHERE tmi.template_id = $2
       AND ($3::text IS NULL OR tmi.version_id = $3)
     ORDER BY tmi.ord ASC`,
    [id, inst.template_id, versionId],
  );
  const groups = await sql.unsafe(
    `SELECT * FROM ${T.master_input_group}
     WHERE template_id = $1 AND ($2::text IS NULL OR version_id = $2)
     ORDER BY ord ASC`,
    [inst.template_id, versionId],
  );

  // ── Always reflect the owning calculation's scheme ──────────────────────
  // On EVERY open (from /my-files, a direct link, anywhere), resolve which
  // calculation this instance belongs to and apply that calc's prefill
  // selections — notably the "Schemes" multiselect — onto the composed master
  // inputs. RetemplateTwo computes page + master-input visibility from these
  // values, so a 33(11) report always shows only 33(11) pages, regardless of
  // what (if anything) was written at creation time.
  try {
    let calc = null;
    if (inst.calculation_id) {
      [calc] = await sql.unsafe(
        `SELECT prefill_master_inputs FROM ${T.v3_calculations} WHERE id = $1 LIMIT 1`,
        [inst.calculation_id],
      );
    }
    if (!calc) {
      // Fallback for instances created before calculation_id existed: instances
      // are named "<calc name> — <date>", so match by re-template + name prefix
      // (longest matching calc name wins, e.g. "33(11)" over "33(1)").
      const cands = await sql.unsafe(
        `SELECT name, prefill_master_inputs FROM ${T.v3_calculations} WHERE retemplate_id = $1`,
        [inst.template_id],
      );
      const nm = String(inst.name || "");
      let best = null;
      for (const c of cands || []) {
        const cn = String(c.name || "");
        if (!cn) continue;
        if (nm === cn || nm.startsWith(cn + " — ")) {
          if (!best || cn.length > String(best.name || "").length) best = c;
        }
      }
      calc = best;
    }
    if (calc && calc.prefill_master_inputs != null) {
      const raw = calc.prefill_master_inputs;
      const arr = Array.isArray(raw) ? raw : JSON.parse(String(raw) || "[]");
      const byKey = new Map();
      for (const p of Array.isArray(arr) ? arr : []) {
        if (p && p.key) byKey.set(String(p.key), p.value == null ? null : String(p.value));
      }
      if (byKey.size) {
        for (const mi of mis) {
          if (byKey.has(mi.key)) mi.value = byKey.get(mi.key);
        }
      }
    }
  } catch (e) {
    // Non-fatal: if calc resolution fails, fall back to the composed values.
    console.error("[getInstance] scheme resolve failed:", e.message);
  }

  res.json({
    instance: normalizeInstance(inst),
    template: tpl ? {
      id: tpl.id,
      name: tpl.name,
      scheme: tpl.scheme,
      description: tpl.description,
      input_sections: parseJsonbStr(tpl.input_sections, []),
      published_version_id: tpl.published_version_id,
    } : null,
    pages: pages.map(normalizePage),
    masterInputs: mis.map(normalizeMasterInput),
    masterInputGroups: groups,
    active_version_id: versionId,
  });
}

// PATCH /v3/instances/:id
// Body: { name?, collaborators? (full array replace) }
// collaborators is a JSONB array — pass the whole new list to update.
export async function patchInstance(req, res) {
  const sql = getSql();
  const b = req.body || {};
  const perm = await checkInstancePermission(sql, req.params.id, requesterId(req));
  if (!perm.ok) return res.status(perm.status).json({ error: perm.error });
  // First authenticated edit of an owner-less instance claims ownership (locks it).
  if (perm.inst && !perm.inst.user_id) {
    const uid = requesterId(req);
    if (uid) await sql.unsafe(`UPDATE ${T.v3_instances} SET user_id = $1 WHERE id = $2 AND user_id IS NULL`, [String(uid), req.params.id]);
  }
  const fields = [
    ["name", "name"],
    ["collaborators", "collaborators"],
    ["print_overrides", "print_overrides"],
  ];
  const sets = [];
  const params = [req.params.id];
  let i = 2;
  for (const [col, key] of fields) {
    if (Object.prototype.hasOwnProperty.call(b, key)) {
      sets.push(`"${col}" = $${i}`);
      // De-duplicate + trim collaborator strings as a safety belt.
      if (key === "collaborators") {
        const arr = Array.isArray(b[key]) ? b[key] : [];
        const cleaned = [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
        params.push(cleaned);
      } else {
        params.push(b[key]);
      }
      i++;
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
  sets.push(`updated_at = NOW()`);
  const [row] = await sql.unsafe(
    `UPDATE ${T.v3_instances} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
    params,
  );
  if (!row) return res.status(404).json({ error: "Instance not found" });
  res.json(row);
}

// POST /v3/instances/:id/copy
// Body: { user_id?, name? }
//
// Duplicates an instance — the row PLUS every master-input override — into a
// brand-new instance OWNED BY THE REQUESTER. Pages/formulas/groups are NOT
// copied; like the source they read through the template_id FK. The copy starts
// with NO collaborators (a private clone) and carries over calculation_id +
// print_overrides. Any logged-in user who can view the source may copy it (the
// copy is theirs and never mutates the source). Returns the new instance row.
export async function copyInstance(req, res) {
  const sql = getSql();
  const srcId = req.params.id;
  const requester = requesterId(req);
  if (!requester) return res.status(401).json({ error: "Sign in required to copy a report." });

  const [src] = await sql.unsafe(
    `SELECT * FROM ${T.v3_instances} WHERE id = $1 LIMIT 1`,
    [srcId],
  );
  if (!src) return res.status(404).json({ error: "Instance not found" });

  const newId = newObjectId();
  const newName =
    (req.body?.name && String(req.body.name).trim()) ||
    `${src.name || "Untitled"} (Copy)`;
  // print_overrides comes back as a raw JSON string from the driver; pass it
  // through, or NULL → '{}' if the source had none.
  const printOv =
    src.print_overrides == null
      ? null
      : typeof src.print_overrides === "string"
        ? src.print_overrides
        : JSON.stringify(src.print_overrides);

  try {
    // Parity with createInstance — calculation_id may be missing on old DBs.
    await sql.unsafe(`ALTER TABLE ${T.v3_instances} ADD COLUMN IF NOT EXISTS calculation_id VARCHAR(24)`).catch(() => {});

    // 1) Clone the instance row (new id + owner, fresh collaborators).
    await sql.unsafe(
      `INSERT INTO ${T.v3_instances}
         (id, template_id, version_id, name, user_id, calculation_id, collaborators, print_overrides)
       VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, COALESCE($7::jsonb, '{}'::jsonb))`,
      [newId, src.template_id, src.version_id ?? null, newName, String(requester), src.calculation_id ?? null, printOv],
    );

    // 2) Clone every master-input override (the edited values) in one insert.
    const overrides = await sql.unsafe(
      `SELECT template_mi_id, template_mi_key, value FROM ${T.instance_mi} WHERE instance_id = $1`,
      [srcId],
    );
    if (overrides.length) {
      const placeholders = [];
      const params = [];
      let p = 1;
      for (const o of overrides) {
        placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(newObjectId(), newId, o.template_mi_id, o.template_mi_key, o.value);
      }
      await sql.unsafe(
        `INSERT INTO ${T.instance_mi} (id, instance_id, template_mi_id, template_mi_key, value)
         VALUES ${placeholders.join(", ")}`,
        params,
      );
    }
  } catch (e) {
    return res.status(500).json({ error: `Copy instance failed: ${e.message}` });
  }

  const [row] = await sql.unsafe(`SELECT * FROM ${T.v3_instances} WHERE id = $1`, [newId]);
  res.status(201).json(row);
}

// DELETE /v3/instances/:id
// Cascade-deletes the instance's MIs via FK ON DELETE CASCADE.
export async function deleteInstance(req, res) {
  const sql = getSql();
  const perm = await checkInstancePermission(sql, req.params.id, requesterId(req));
  if (!perm.ok) return res.status(perm.status).json({ error: perm.error });
  const [row] = await sql.unsafe(
    `DELETE FROM ${T.v3_instances} WHERE id = $1 RETURNING id`,
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "Instance not found" });
  res.status(204).end();
}

// GET /v3/instances/:id/master-inputs
// Returns the same composed shape as getInstance — template metadata +
// instance value override (or template default).
export async function getInstanceMasterInputs(req, res) {
  const sql = getSql();
  const id = req.params.id;
  const [inst] = await sql.unsafe(
    `SELECT i.template_id, i.version_id, t.published_version_id
       FROM ${T.v3_instances} i
       LEFT JOIN ${T.v3_templates} t ON t.id = i.template_id
      WHERE i.id = $1 LIMIT 1`,
    [id],
  );
  if (!inst) return res.status(404).json({ error: "Instance not found" });
  // Always follow the template's current published version (see getInstance).
  const miVersionId = inst.published_version_id || inst.version_id || null;
  const rows = await sql.unsafe(
    `SELECT
        tmi.id,
        tmi.id            AS template_mi_id,
        tmi.template_id,
        tmi.version_id,
        tmi.key,
        tmi.display_name,
        tmi.ref,
        tmi.type,
        tmi.options,
        tmi.section,
        tmi.ord,
        tmi.kind,
        tmi.group_id,
        COALESCE(imi.value, tmi.default_value, tmi.value) AS value
     FROM ${T.master_input} tmi
     LEFT JOIN ${T.instance_mi} imi
       ON imi.instance_id = $1
       AND (
         imi.template_mi_key = tmi.key
         OR (imi.template_mi_key IS NULL AND imi.template_mi_id = tmi.id)
       )
     WHERE tmi.template_id = $2
       AND ($3::text IS NULL OR tmi.version_id = $3)
     ORDER BY tmi.ord ASC`,
    [id, inst.template_id, miVersionId],
  );
  res.json({ masterInputs: rows.map(normalizeMasterInput) });
}

// PATCH /v3/instances/:instanceId/master-inputs/:templateMiId
// Body: { value }
//
// UPSERT semantics: writes an override row keyed by
// (instance_id, template_mi_id). The `value` is the ONLY thing the instance
// can override — everything else (display_name, ref, type, options, etc.)
// lives on the template and is read-only from the instance's perspective.
export async function patchInstanceMasterInput(req, res) {
  const sql = getSql();
  const b = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(b, "value")) {
    return res.status(400).json({ error: "value required" });
  }
  const { instanceId, templateMiId } = req.params;

  const perm = await checkInstancePermission(sql, instanceId, requesterId(req));
  if (!perm.ok) return res.status(perm.status).json({ error: perm.error });
  // First authenticated edit of an owner-less instance claims ownership (locks it).
  if (perm.inst && !perm.inst.user_id) {
    const uid = requesterId(req);
    if (uid) await sql.unsafe(`UPDATE ${T.v3_instances} SET user_id = $1 WHERE id = $2 AND user_id IS NULL`, [String(uid), instanceId]);
  }

  // Cheap sanity check — confirm the template MI actually exists. Read its
  // `key` too so we can persist a key-keyed override row (id may change if
  // the template MI is later re-created under the same key; the key is the
  // stable identifier from the instance's perspective).
  const [tmi] = await sql.unsafe(
    `SELECT id, key FROM ${T.master_input} WHERE id = $1 LIMIT 1`,
    [templateMiId],
  );
  if (!tmi) return res.status(404).json({ error: "Template master input not found" });

  const value = b.value == null ? null : String(b.value);
  await sql.unsafe(
    `INSERT INTO ${T.instance_mi} (id, instance_id, template_mi_id, template_mi_key, value)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (instance_id, template_mi_key)
     DO UPDATE SET value = EXCLUDED.value, template_mi_id = EXCLUDED.template_mi_id`,
    [newObjectId(), instanceId, templateMiId, tmi.key, value],
  );

  // Return the composed row (same shape as getInstance.masterInputs[i]).
  const [row] = await sql.unsafe(
    `SELECT
        tmi.id,
        tmi.id            AS template_mi_id,
        tmi.template_id,
        tmi.version_id,
        tmi.key,
        tmi.display_name,
        tmi.ref,
        tmi.type,
        tmi.options,
        tmi.section,
        tmi.ord,
        tmi.kind,
        tmi.group_id,
        COALESCE(imi.value, tmi.default_value, tmi.value) AS value
     FROM ${T.master_input} tmi
     LEFT JOIN ${T.instance_mi} imi
       ON imi.instance_id = $1
       AND (
         imi.template_mi_key = tmi.key
         OR (imi.template_mi_key IS NULL AND imi.template_mi_id = tmi.id)
       )
     WHERE tmi.id = $2
     LIMIT 1`,
    [instanceId, templateMiId],
  );
  res.json(normalizeMasterInput(row));
}

// ── GET /v3/active-context ────────────────────────────────────────────────────
// Returns whatever the FE last reported as the user's active editing context.
// Used by the feasibility MCP server so the agent knows which template/page is
// currently open without the user having to spell it out. DB-backed singleton
// row (id='current') so it survives across Vercel cold starts and serverless
// instances (the previous file-based store didn't work on read-only fs).
export async function getActiveContext(_req, res) {
  try {
    const sql = getSql();
    const [row] = await sql.unsafe(
      `SELECT payload FROM ${T.active_context} WHERE id = 'current' LIMIT 1`,
    );
    if (!row) return res.json({ active: false });
    res.json(row.payload);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// ── POST /v3/active-context ───────────────────────────────────────────────────
// FE heartbeat: writes the current template/page selection so the MCP server
// (and any other consumer) can read it back. Single upsert into the
// `active_context` singleton row (id='current').
export async function setActiveContext(req, res) {
  try {
    const b = req.body || {};
    const payload = {
      active: true,
      templateId: b.templateId ?? null,
      templateName: b.templateName ?? null,
      versionId: b.versionId ?? null,
      pageId: b.pageId ?? null,
      pageName: b.pageName ?? null,
      selectedA1: b.selectedA1 ?? null,
      selectionAnchor: b.selectionAnchor ?? null,
      selectionFocus: b.selectionFocus ?? null,
      updatedAt: new Date().toISOString(),
    };
    const sql = getSql();
    await sql.unsafe(
      `INSERT INTO ${T.active_context} (id, payload, updated_at)
       VALUES ('current', $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE
         SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [JSON.stringify(payload)],
    );
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// ── Real Estate calculations ──────────────────────────────────────────────────

// GET /v3/calculations/applicable?land_title=&plot_area= — schemes whose
// report-workflow rule matches the chosen land title + plot area. Drives the
// report workflow's Step 3: a scheme applies when its applicable_land_titles
// contains the land title AND the plot area falls within its (nullable) range.
export async function applicableCalculations(req, res) {
  const sql = getSql();
  const landTitle = String(req.query?.land_title || "").trim();
  // Land-title values are distinct, non-substring tokens (MHADA / SOCIETY /
  // SLUM_SRA). Sanitise to those chars so the LIKE below can't be injected.
  const safe = landTitle.replace(/[^A-Za-z0-9_]/g, "");
  const locality = String(req.query?.locality || "").trim();
  const safeLoc = locality.replace(/[^A-Za-z0-9_]/g, "");
  const raw = req.query?.plot_area;
  const plotArea = raw == null || raw === "" || isNaN(Number(raw)) ? null : Number(raw);
  if (!safe) return res.json({ calculations: [] });
  try {
    const rows = await sql.unsafe(
      `SELECT id, name, description, sector, retemplate_id, prefill_master_inputs,
              applicable_land_titles, applicable_localities, min_plot_area, max_plot_area
       FROM ${T.v3_calculations}
       WHERE disabled = FALSE
         -- These jsonb columns round-trip double-encoded (like prefill_master_inputs),
         -- so match on the text form — robust to both array and stringified encodings.
         -- Land-title / locality values are distinct, non-substring tokens.
         AND applicable_land_titles::text LIKE $1
         AND applicable_localities::text LIKE $3
         AND ($2::numeric IS NULL OR min_plot_area IS NULL OR $2::numeric >= min_plot_area)
         AND ($2::numeric IS NULL OR max_plot_area IS NULL OR $2::numeric <= max_plot_area)
       ORDER BY ord ASC, created_at DESC`,
      [`%${safe}%`, plotArea, `%${safeLoc}%`],
    );
    res.json({ calculations: rows });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// ── Mumbai DCPR workflow (rules + runs) ──────────────────────────────────────
// Persisted decision tree: a rule maps a (land_title, locality, plot-area range)
// to a set of scheme calculation ids. `dcpr_workflow_runs` records every
// completed run and the V3 instance (report) it produced.

// GET /v3/dcpr/rules — all rules (admin load + frontend run).
export async function listDcprRules(_req, res) {
  const sql = getSql();
  try {
    const rows = await sql.unsafe(
      `SELECT id, land_title, locality, min_plot_area, max_plot_area, scheme_calculation_ids, ord
       FROM ${T.dcpr_rules} ORDER BY land_title ASC, ord ASC, created_at ASC`,
    );
    res.json({
      rules: Array.from(rows).map((r) => ({
        ...r,
        scheme_calculation_ids: parseJsonbStr(r.scheme_calculation_ids, []),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// PUT /v3/dcpr/rules — replace all rules for one land title.
// body: { land_title, rules: [{ locality, min_plot_area, max_plot_area, scheme_calculation_ids }] }
export async function saveDcprRules(req, res) {
  const sql = getSql();
  const b = req.body || {};
  const landTitle = String(b.land_title || "").trim();
  if (!landTitle) return res.status(400).json({ error: "land_title is required" });
  const rules = Array.isArray(b.rules) ? b.rules : [];
  try {
    await sql.unsafe(`DELETE FROM ${T.dcpr_rules} WHERE land_title = $1`, [landTitle]);
    let ord = 0;
    for (const r of rules) {
      await sql.unsafe(
        `INSERT INTO ${T.dcpr_rules}
           (id, land_title, locality, min_plot_area, max_plot_area, scheme_calculation_ids, ord)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          newObjectId(),
          landTitle,
          r.locality ? String(r.locality) : null,
          r.min_plot_area === "" || r.min_plot_area == null ? null : Number(r.min_plot_area),
          r.max_plot_area === "" || r.max_plot_area == null ? null : Number(r.max_plot_area),
          JSON.stringify(Array.isArray(r.scheme_calculation_ids) ? r.scheme_calculation_ids : []),
          ord++,
        ],
      );
    }
    res.json({ ok: true, land_title: landTitle, count: rules.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// GET /v3/dcpr/schemes?land_title=&locality=&plot_area= — evaluate the rules.
// A rule matches when land_title equals, locality matches (or the rule's
// locality is null = any), and the plot area is in [min, max) — nulls unbounded.
export async function evaluateDcprSchemes(req, res) {
  const sql = getSql();
  const landTitle = String(req.query?.land_title || "").trim();
  const locality = String(req.query?.locality || "").trim() || null;
  const rawPlot = req.query?.plot_area;
  const plot = rawPlot == null || rawPlot === "" || isNaN(Number(rawPlot)) ? null : Number(rawPlot);
  if (!landTitle) return res.json({ schemes: [] });
  try {
    const rules = await sql.unsafe(
      `SELECT scheme_calculation_ids FROM ${T.dcpr_rules}
       WHERE land_title = $1
         AND (locality IS NULL OR locality = $2)
         AND (min_plot_area IS NULL OR ($3::numeric IS NOT NULL AND $3::numeric >= min_plot_area))
         AND (max_plot_area IS NULL OR ($3::numeric IS NOT NULL AND $3::numeric < max_plot_area))
       ORDER BY ord ASC`,
      [landTitle, locality, plot],
    );
    const ids = [];
    for (const r of Array.from(rules)) {
      for (const cid of parseJsonbStr(r.scheme_calculation_ids, [])) {
        if (!ids.includes(cid)) ids.push(cid);
      }
    }
    if (!ids.length) return res.json({ schemes: [] });
    const calcs = await sql.unsafe(
      `SELECT id, name, retemplate_id, prefill_master_inputs, hide_v3, disabled
       FROM ${T.v3_calculations} WHERE id = ANY($1)`,
      [ids],
    );
    const byId = new Map(Array.from(calcs).map((c) => [c.id, c]));
    const schemes = ids
      .map((cid) => byId.get(cid))
      .filter(Boolean)
      .map((c) => ({
        calculation_id: c.id,
        name: c.name,
        retemplate_id: c.retemplate_id,
        prefill_master_inputs: c.prefill_master_inputs,
        hide_v3: c.hide_v3,
        disabled: c.disabled,
      }));
    res.json({ schemes });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// POST /v3/dcpr/runs — record a workflow run. Called the moment a user starts
// a new report (status defaults to 'started'); the row is then PATCHed as they
// progress and again when the V3 report (instance) is opened.
export async function createDcprRun(req, res) {
  const sql = getSql();
  const b = req.body || {};
  try {
    const [row] = await sql.unsafe(
      `INSERT INTO ${T.dcpr_runs}
         (id, user_id, username, status, land_title, locality, plot_area, scheme_calculation_id, scheme_name, instance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, user_id, username, status, land_title, locality, plot_area, scheme_calculation_id, scheme_name, instance_id, created_at, updated_at`,
      [
        newObjectId(),
        b.user_id ? String(b.user_id) : null,
        b.username ? String(b.username) : null,
        b.status ? String(b.status) : "started",
        b.land_title ? String(b.land_title) : null,
        b.locality ? String(b.locality) : null,
        b.plot_area === "" || b.plot_area == null ? null : Number(b.plot_area),
        b.scheme_calculation_id ? String(b.scheme_calculation_id) : null,
        b.scheme_name ? String(b.scheme_name) : null,
        b.instance_id ? String(b.instance_id) : null,
      ],
    );
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// PATCH /v3/dcpr/runs/:id — update a run as it progresses (land title, plot,
// locality, chosen scheme, produced instance, status). Only provided fields
// are touched; updated_at is always bumped.
export async function updateDcprRun(req, res) {
  const sql = getSql();
  const b = req.body || {};
  try {
    const sets = [];
    const vals = [];
    let i = 1;
    const add = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };

    if ("land_title" in b) add("land_title", b.land_title ? String(b.land_title) : null);
    if ("locality" in b) add("locality", b.locality ? String(b.locality) : null);
    if ("plot_area" in b) add("plot_area", b.plot_area === "" || b.plot_area == null ? null : Number(b.plot_area));
    if ("scheme_calculation_id" in b) add("scheme_calculation_id", b.scheme_calculation_id ? String(b.scheme_calculation_id) : null);
    if ("scheme_name" in b) add("scheme_name", b.scheme_name ? String(b.scheme_name) : null);
    if ("instance_id" in b) add("instance_id", b.instance_id ? String(b.instance_id) : null);
    if ("status" in b) add("status", b.status ? String(b.status) : null);

    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);

    const [row] = await sql.unsafe(
      `UPDATE ${T.dcpr_runs} SET ${sets.join(", ")}
       WHERE id = $${i}
       RETURNING id, user_id, username, status, land_title, locality, plot_area, scheme_calculation_id, scheme_name, instance_id, created_at, updated_at`,
      vals,
    );
    if (!row) return res.status(404).json({ error: "not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// GET /v3/dcpr/runs — recent runs (who started what, and which reports resulted).
export async function listDcprRuns(_req, res) {
  const sql = getSql();
  try {
    const rows = await sql.unsafe(
      `SELECT id, user_id, username, status, land_title, locality, plot_area, scheme_calculation_id, scheme_name, instance_id, created_at, updated_at
       FROM ${T.dcpr_runs} ORDER BY created_at DESC LIMIT 500`,
    );
    res.json({ runs: Array.from(rows) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// GET /v3/dcpr/runs/by-instance/:instanceId — the workflow run (if any) that
// produced this V3 instance. Lets the report page know it was created from a
// Mumbai DCPR workflow and recover the workflow context (land title, plot,
// locality, scheme) so it can auto-continue the guided flow. Returns
// { run: null } when the instance wasn't created from a workflow.
export async function getDcprRunByInstance(req, res) {
  const sql = getSql();
  try {
    const [row] = await sql.unsafe(
      `SELECT id, user_id, username, status, land_title, locality, plot_area, scheme_calculation_id, scheme_name, instance_id, created_at, updated_at
       FROM ${T.dcpr_runs}
       WHERE instance_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.params.instanceId],
    );
    res.json({ run: row || null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// GET /v3/dcpr/graph — the saved decision-tree (React Flow nodes + edges).
export async function getDcprGraph(_req, res) {
  const sql = getSql();
  try {
    const [row] = await sql.unsafe(
      `SELECT payload, updated_at FROM ${T.dcpr_graph} WHERE id = 'current' LIMIT 1`,
    );
    const raw = row?.payload;
    const graph = typeof raw === "string" ? JSON.parse(raw || "null") : (raw || null);
    res.json({ graph: graph && graph.nodes ? graph : null, updated_at: row?.updated_at || null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// PUT /v3/dcpr/graph — save the decision-tree { nodes, edges }.
export async function saveDcprGraph(req, res) {
  const sql = getSql();
  const b = req.body || {};
  const graph = { nodes: Array.isArray(b.nodes) ? b.nodes : [], edges: Array.isArray(b.edges) ? b.edges : [] };
  try {
    const [row] = await sql.unsafe(
      `INSERT INTO ${T.dcpr_graph} (id, payload, updated_at)
       VALUES ('current', $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
       RETURNING updated_at`,
      [JSON.stringify(graph)],
    );
    res.json({ ok: true, updated_at: row?.updated_at || null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// GET /v3/calculations/:id — single
export async function getCalculation(req, res) {
  const sql = getSql();
  try {
    const [row] = await sql.unsafe(
      `SELECT id, name, description, sector, author, ord, disabled, template_id, instance_id, retemplate_id, prefill_master_inputs, hide_v3, applicable_land_titles, applicable_localities, min_plot_area, max_plot_area, created_at, updated_at
       FROM ${T.v3_calculations}
       WHERE id = $1
       LIMIT 1`,
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: "not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// GET /v3/calculations — ordered by user-defined `ord` (admin DnD),
// with newest-first as a tiebreaker.
export async function listCalculations(_req, res) {
  const sql = getSql();
  try {
    const rows = await sql.unsafe(`
      SELECT id, name, description, sector, author, ord, disabled, template_id, instance_id, retemplate_id, prefill_master_inputs, hide_v3, applicable_land_titles, applicable_localities, min_plot_area, max_plot_area, created_at, updated_at
      FROM ${T.v3_calculations}
      ORDER BY ord ASC, created_at DESC
      LIMIT 500
    `);
    res.json({ calculations: rows });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// POST /v3/calculations — body: { name, description?, sector?, author? }
// New rows land at the end of their sector — ord = (max + 10).
export async function createCalculation(req, res) {
  const sql = getSql();
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  const id = newObjectId();
  try {
    const [maxRow] = await sql.unsafe(
      `SELECT COALESCE(MAX(ord), 0) AS max_ord FROM ${T.v3_calculations}`,
    );
    const nextOrd = Number(maxRow?.max_ord || 0) + 10;
    const [row] = await sql.unsafe(
      `INSERT INTO ${T.v3_calculations} (id, name, description, sector, author, ord, template_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, description, sector, author, ord, disabled, template_id, instance_id, retemplate_id, prefill_master_inputs, hide_v3, applicable_land_titles, applicable_localities, min_plot_area, max_plot_area, created_at, updated_at`,
      [id, String(b.name).trim(), b.description ?? null, b.sector ?? null, b.author ?? null, nextOrd, b.template_id ?? null],
    );
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// PATCH /v3/calculations/:id — partial update
export async function patchCalculation(req, res) {
  const sql = getSql();
  const b = req.body || {};
  const fields = [];
  const args = [];
  let i = 1;
  if (b.name !== undefined) { fields.push(`name = $${i++}`); args.push(String(b.name).trim()); }
  if (b.description !== undefined) { fields.push(`description = $${i++}`); args.push(b.description); }
  if (b.sector !== undefined) { fields.push(`sector = $${i++}`); args.push(b.sector); }
  if (b.author !== undefined) { fields.push(`author = $${i++}`); args.push(b.author); }
  if (b.ord !== undefined) { fields.push(`ord = $${i++}`); args.push(Number(b.ord) || 0); }
  if (b.disabled !== undefined) { fields.push(`disabled = $${i++}`); args.push(Boolean(b.disabled)); }
  if (b.template_id !== undefined) { fields.push(`template_id = $${i++}`); args.push(b.template_id || null); }
  if (b.instance_id !== undefined) { fields.push(`instance_id = $${i++}`); args.push(b.instance_id || null); }
  if (b.retemplate_id !== undefined) { fields.push(`retemplate_id = $${i++}`); args.push(b.retemplate_id || null); }
  if (b.hide_v3 !== undefined) { fields.push(`hide_v3 = $${i++}`); args.push(Boolean(b.hide_v3)); }
  if (b.applicable_land_titles !== undefined) { fields.push(`applicable_land_titles = $${i++}::jsonb`); args.push(JSON.stringify(Array.isArray(b.applicable_land_titles) ? b.applicable_land_titles : [])); }
  if (b.applicable_localities !== undefined) { fields.push(`applicable_localities = $${i++}::jsonb`); args.push(JSON.stringify(Array.isArray(b.applicable_localities) ? b.applicable_localities : [])); }
  if (b.min_plot_area !== undefined) { fields.push(`min_plot_area = $${i++}`); args.push(b.min_plot_area === null || b.min_plot_area === "" ? null : Number(b.min_plot_area)); }
  if (b.max_plot_area !== undefined) { fields.push(`max_plot_area = $${i++}`); args.push(b.max_plot_area === null || b.max_plot_area === "" ? null : Number(b.max_plot_area)); }
  if (b.prefill_master_inputs !== undefined) { fields.push(`prefill_master_inputs = $${i++}::jsonb`); args.push(JSON.stringify(Array.isArray(b.prefill_master_inputs) ? b.prefill_master_inputs : [])); }
  if (fields.length === 0) return res.status(400).json({ error: "no fields to update" });
  fields.push(`updated_at = NOW()`);
  args.push(req.params.id);
  try {
    const [row] = await sql.unsafe(
      `UPDATE ${T.v3_calculations} SET ${fields.join(", ")}
       WHERE id = $${i}
       RETURNING id, name, description, sector, author, ord, disabled, template_id, instance_id, retemplate_id, prefill_master_inputs, hide_v3, applicable_land_titles, applicable_localities, min_plot_area, max_plot_area, created_at, updated_at`,
      args,
    );
    if (!row) return res.status(404).json({ error: "not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// POST /v3/calculations/reorder — body: { ids: [id, id, ...] }
// Writes `ord = idx * 10` to each row in order, so the next list result
// reflects the new order. Step of 10 leaves room for cheap single-row
// inserts later without renumbering.
export async function reorderCalculations(req, res) {
  const sql = getSql();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids || ids.length === 0) {
    return res.status(400).json({ error: "ids[] required" });
  }
  try {
    await sql.begin(async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        await tx.unsafe(
          `UPDATE ${T.v3_calculations} SET ord = $1, updated_at = NOW() WHERE id = $2`,
          [(i + 1) * 10, ids[i]],
        );
      }
    });
    res.json({ ok: true, count: ids.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// Note: hard-delete was intentionally removed — calculations are
// soft-disabled via PATCH { disabled: true }. Admin still sees them and
// can flip the flag; landing-L hides disabled rows.
