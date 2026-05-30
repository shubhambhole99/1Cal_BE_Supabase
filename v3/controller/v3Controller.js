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
  projects: `"${SCHEMA}"."projects"`,
  active_context: `"${SCHEMA}"."active_context"`,
  legacy_templates: `"${SCHEMA}"."templates"`,
};

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
  const fields = [
    ["name", "name"],
    ["scheme", "scheme"],
    ["description", "description"],
    ["input_sections", "input_sections"],
    ["page_groups", "page_groups"],
    ["disabled", "disabled"],
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
  sets.push(`updated_at = NOW()`);
  const [row] = await sql.unsafe(
    `UPDATE ${T.v3_templates} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
    params,
  );
  if (!row) return res.status(404).json({ error: "Template not found" });
  // Broadcast template metadata changes so open editors repaint without a
  // manual reload. The page-group and input-section UIs in retemplate1
  // listen for this event and patch `tpl` in place. We also surface which
  // fields changed so listeners can skip irrelevant updates cheaply.
  broadcast({
    type: "template.updated",
    templateId: row.id,
    fields: fields.filter(([, key]) => Object.prototype.hasOwnProperty.call(b, key)).map(([, key]) => key),
    template: row,
    clientId: req.get("x-client-id") || null,
  });
  res.json(row);
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
  const ids = [];
  try {
    await sql.begin(async (tx) => {
      for (let i = 0; i < b.masterInputs.length; i++) {
        const mi = b.masterInputs[i];
        if (!mi || !mi.key) continue;
        if (mi.type === "group") continue; // groups are inserted via /v3/master-input-groups/bulk
        const id = newObjectId();
        ids.push(id);
        await tx.unsafe(
          `INSERT INTO ${T.master_input}
             (id, template_id, version_id, key, display_name, value, ref, type, options,
              section, kind, group_id, ord)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
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
          ],
        );
      }
    });
  } catch (e) {
    return res.status(500).json({ error: `Bulk create failed: ${e.message}` });
  }
  res.status(201).json({ count: ids.length, ids });
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
            hidden, is_imported, version_id, schemes
     FROM ${T.v3_pages}
     WHERE template_id = $1 AND ($2::text IS NULL OR version_id = $2)
     ORDER BY ord ASC, name ASC`,
    [id, versionId],
  );

  const versions = await sql.unsafe(
    `SELECT id, label, author_id, created_at FROM ${T.v3_versions}
     WHERE template_id = $1 ORDER BY created_at ASC`,
    [id],
  );

  res.json({ ...tpl, pages, versions, active_version_id: versionId });
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
  const versionId = await resolveVersionId(sql, b.template_id, b.version_id);
  if (!versionId) {
    return res.status(400).json({ error: "Template has no published version yet" });
  }

  let ord = b.ord;
  if (!Number.isFinite(ord)) {
    const [row] = await sql.unsafe(
      `SELECT COALESCE(MAX(ord), -1) AS max_ord FROM ${T.v3_pages}
       WHERE template_id = $1 AND version_id = $2`,
      [b.template_id, versionId],
    );
    ord = (row?.max_ord ?? -1) + 1;
  }

  const id = newObjectId();
  // Persist content fields on insert when the caller supplies them — the
  // JSON-restore flow POSTs a page WITH its cells/styles/merges, and without
  // this the restore would silently drop everything and the user would have
  // to run it a second time (when the page already exists and PATCH lands
  // the data). Default each one to a sane empty value when absent.
  await sql.unsafe(
    `INSERT INTO ${T.v3_pages}
       (id, template_id, version_id, name, ord, row_count, col_count,
        hidden, cells, styles, merges, column_widths, row_heights, schemes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      id,
      b.template_id,
      versionId,
      b.name,
      ord,
      Number.isFinite(b.row_count) ? b.row_count : 50,
      Number.isFinite(b.col_count) ? b.col_count : 26,
      typeof b.hidden === "boolean" ? b.hidden : false,
      b.cells && typeof b.cells === "object" ? b.cells : {},
      b.styles && typeof b.styles === "object" ? b.styles : {},
      Array.isArray(b.merges) ? b.merges : [],
      b.column_widths && typeof b.column_widths === "object" ? b.column_widths : {},
      b.row_heights && typeof b.row_heights === "object" ? b.row_heights : {},
      Array.isArray(b.schemes) ? b.schemes : [],
    ],
  );

  const [page] = await sql.unsafe(
    `SELECT * FROM ${T.v3_pages} WHERE id = $1 LIMIT 1`,
    [id],
  );
  res.status(201).json(page);
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
  res.json(page);
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
  res.json({
    masterInputs: rows,
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
  res.json(row);
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
  const id = newObjectId();
  await sql.unsafe(
    `INSERT INTO ${T.master_input}
       (id, template_id, version_id, key, display_name, value, ref, type, options,
        section, kind, group_id, ord)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
      b.group_id ?? null,
      Number.isFinite(b.ord) ? b.ord : 0,
    ],
  );
  const [row] = await sql.unsafe(`SELECT * FROM ${T.master_input} WHERE id = $1`, [id]);
  res.status(201).json(row);
}

// ── PATCH /v3/master-inputs/:id ───────────────────────────────────────────────
export async function patchMasterInput(req, res) {
  const sql = getSql();
  const b = req.body || {};
  if (b.type === "group") {
    return res.status(400).json({ error: "type='group' is not a valid master-input type" });
  }
  const fields = [
    ["key", "key"],
    ["display_name", "display_name"],
    ["value", "value"],
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
  res.json(row);
}

// ── DELETE /v3/master-inputs/:id ──────────────────────────────────────────────
export async function deleteMasterInput(req, res) {
  const sql = getSql();
  const [row] = await sql.unsafe(
    `DELETE FROM ${T.master_input} WHERE id = $1 RETURNING id`,
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "Master input not found" });
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
  const id = newObjectId();
  try {
    await sql.unsafe(
      `INSERT INTO ${T.master_input_group}
         (id, template_id, version_id, key, display_name, section, ord, parent_group_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
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
  } catch (e) {
    return res.status(500).json({ error: `Create group failed: ${e.message}` });
  }
  const [row] = await sql.unsafe(`SELECT * FROM ${T.master_input_group} WHERE id = $1`, [id]);
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
  res.status(201).json({ count: ids.length, ids, keyToId });
}

// ── PATCH /v3/master-input-groups/:id ─────────────────────────────────────────
export async function patchMasterInputGroup(req, res) {
  const sql = getSql();
  const b = req.body || {};
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
  res.json(row);
}

// ── DELETE /v3/master-input-groups/:id ────────────────────────────────────────
// Children of this group survive (their group_id is set to NULL by the FK).
export async function deleteMasterInputGroup(req, res) {
  const sql = getSql();
  const [row] = await sql.unsafe(
    `DELETE FROM ${T.master_input_group} WHERE id = $1 RETURNING id`,
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "Group not found" });
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
  res.json({ ok: true, count: ids.length });
}

// ── PATCH /v3/pages/:id ────────────────────────────────────────────────────────
// Sparse patch — merge into existing cells / styles JSONB.
export async function patchPage(req, res) {
  const sql = getSql();
  const { id } = req.params;
  const { cells, removeCells, styles, removeStyles, merges, name, hidden, ord, schemes, column_widths, row_heights } = req.body || {};

  const updates = [];
  const params = [id];
  let i = 2;

  // Combine cells merge + removeCells into a single SET to avoid Postgres
  // error 42601 "multiple assignments to same column" — happens when both
  // are sent in one PATCH (e.g. during a row/col shift).
  const hasCells = cells && typeof cells === "object";
  const hasRemoveCells = Array.isArray(removeCells) && removeCells.length > 0;
  if (hasCells && hasRemoveCells) {
    updates.push(`cells = (cells || $${i}) - $${i + 1}::text[]`);
    params.push(cells, removeCells);
    i += 2;
  } else if (hasCells) {
    updates.push(`cells = cells || $${i}`);
    params.push(cells);
    i++;
  } else if (hasRemoveCells) {
    updates.push(`cells = cells - $${i}::text[]`);
    params.push(removeCells);
    i++;
  }
  const hasStyles = styles && typeof styles === "object";
  const hasRemoveStyles = Array.isArray(removeStyles) && removeStyles.length > 0;
  if (hasStyles && hasRemoveStyles) {
    updates.push(`styles = (styles || $${i}) - $${i + 1}::text[]`);
    params.push(styles, removeStyles);
    i += 2;
  } else if (hasStyles) {
    updates.push(`styles = styles || $${i}`);
    params.push(styles);
    i++;
  } else if (hasRemoveStyles) {
    updates.push(`styles = styles - $${i}::text[]`);
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
    updates.push(`column_widths = column_widths || $${i}`);
    params.push(column_widths);
    i++;
  }
  if (row_heights && typeof row_heights === "object" && !Array.isArray(row_heights)) {
    updates.push(`row_heights = row_heights || $${i}`);
    params.push(row_heights);
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
  const result = await sql.unsafe(
    `DELETE FROM ${T.v3_pages} WHERE id = $1 RETURNING id`,
    [id],
  );
  if (!result.length) return res.status(404).json({ error: "Page not found" });
  res.json({ ok: true, id });
}

// ─── Version management ───────────────────────────────────────────────────────

// GET /v3/templates/:id/versions
export async function listVersions(req, res) {
  const sql = getSql();
  const rows = await sql.unsafe(
    `SELECT id, label, author_id, created_at FROM ${T.v3_versions}
     WHERE template_id = $1 ORDER BY created_at ASC`,
    [req.params.id],
  );
  const [tpl] = await sql.unsafe(
    `SELECT published_version_id FROM ${T.v3_templates} WHERE id = $1`,
    [req.params.id],
  );
  res.json({
    versions: rows,
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

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO ${T.v3_versions} (id, template_id, label) VALUES ($1, $2, $3)`,
        [newVersionId, templateId, finalLabel],
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

        // 1) Pages — copy every column except (id, version_id). Generate
        //    a fresh id per row server-side via `gen_random_uuid()` mapped
        //    to a 24-char hex (matches the newObjectId() shape — uses the
        //    first 24 hex chars of a UUID v4 cast to text).
        await tx.unsafe(
          `INSERT INTO ${T.v3_pages}
             (id, template_id, version_id, name, ord, row_count, col_count, size,
              orientation, scale, hidden, is_imported, columns_order, column_widths,
              row_heights, cells, styles, merges, schemes)
           SELECT
             substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
             template_id, $1, name, ord, row_count, col_count, size,
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
        await tx.unsafe(
          `INSERT INTO ${T.master_input_group}
             (id, template_id, version_id, key, display_name, section, ord, parent_group_id)
           SELECT
             substr(encode(digest($1 || g.id, 'sha256'), 'hex'), 1, 24),
             g.template_id, $1, g.key, g.display_name, g.section, g.ord,
             CASE WHEN g.parent_group_id IS NULL THEN NULL
                  ELSE substr(encode(digest($1 || g.parent_group_id, 'sha256'), 'hex'), 1, 24)
             END
           FROM ${T.master_input_group} g
           WHERE g.template_id = $2 AND g.version_id = $3`,
          [newVersionId, templateId, sourceVersionId],
        );

        // 3) Master inputs — group_id remapped via the same SHA256(newVer || id)
        //    scheme used in step 2 so the FK lines up without a JS map round-trip.
        await tx.unsafe(
          `INSERT INTO ${T.master_input}
             (id, template_id, version_id, key, value, ref, type, options,
              section, ord, display_name, kind, group_id)
           SELECT
             substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
             m.template_id, $1, m.key, m.value, m.ref, m.type, m.options,
             m.section, m.ord, m.display_name, m.kind,
             CASE WHEN m.group_id IS NULL THEN NULL
                  ELSE substr(encode(digest($1 || m.group_id, 'sha256'), 'hex'), 1, 24)
             END
           FROM ${T.master_input} m
           WHERE m.template_id = $2 AND m.version_id = $3`,
          [newVersionId, templateId, sourceVersionId],
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

    // Copy pages one by one; emit progress per page.
    const srcPages = await sql.unsafe(
      `SELECT * FROM ${T.v3_pages} WHERE template_id = $1 AND version_id = $2 ORDER BY ord`,
      [templateId, sourceVersionId],
    );
    for (let i = 0; i < srcPages.length; i++) {
      const p = srcPages[i];
      await sql.unsafe(
        `INSERT INTO ${T.v3_pages}
           (id, template_id, version_id, name, ord, row_count, col_count, size,
            orientation, scale, hidden, is_imported, columns_order, column_widths,
            cells, styles, merges)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          newObjectId(), templateId, targetVersionId,
          p.name, p.ord, p.row_count, p.col_count, p.size,
          p.orientation, p.scale, p.hidden, p.is_imported,
          p.columns_order, p.column_widths, p.cells, p.styles, p.merges,
        ],
      );
      emit({ phase: "pages", done: i + 1, total: srcPages.length, name: p.name });
    }

    // Copy MI groups; emit per group.
    const srcGroups = await sql.unsafe(
      `SELECT * FROM ${T.master_input_group}
       WHERE template_id = $1 AND version_id = $2 ORDER BY ord`,
      [templateId, sourceVersionId],
    );
    const oldToNewGroupId = new Map();
    for (let i = 0; i < srcGroups.length; i++) {
      const g = srcGroups[i];
      const newId = newObjectId();
      oldToNewGroupId.set(g.id, newId);
      await sql.unsafe(
        `INSERT INTO ${T.master_input_group}
           (id, template_id, version_id, key, display_name, section, ord, parent_group_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          newId, templateId, targetVersionId,
          g.key, g.display_name, g.section, g.ord, null,
        ],
      );
      emit({
        phase: "groups", done: i + 1, total: srcGroups.length,
        name: g.display_name || g.key,
      });
    }
    // Second pass: remap parent_group_id (no progress needed — fast).
    for (const g of srcGroups) {
      if (!g.parent_group_id) continue;
      const newId = oldToNewGroupId.get(g.id);
      const newParent = oldToNewGroupId.get(g.parent_group_id);
      if (newId && newParent) {
        await sql.unsafe(
          `UPDATE ${T.master_input_group} SET parent_group_id = $1 WHERE id = $2`,
          [newParent, newId],
        );
      }
    }

    // Copy master inputs; emit every BATCH inserts to avoid flooding the wire
    // (~600+ MIs is common, so per-row events would create 600+ chunks).
    const srcMIs = await sql.unsafe(
      `SELECT * FROM ${T.master_input} WHERE template_id = $1 AND version_id = $2 ORDER BY ord`,
      [templateId, sourceVersionId],
    );
    const BATCH = 20;
    for (let i = 0; i < srcMIs.length; i++) {
      const mi = srcMIs[i];
      await sql.unsafe(
        `INSERT INTO ${T.master_input}
           (id, template_id, version_id, key, value, ref, type, options,
            section, ord, display_name, kind, group_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          newObjectId(), templateId, targetVersionId,
          mi.key, mi.value, mi.ref, mi.type, mi.options,
          mi.section, mi.ord, mi.display_name, mi.kind,
          mi.group_id ? (oldToNewGroupId.get(mi.group_id) ?? null) : null,
        ],
      );
      const done = i + 1;
      if (done === srcMIs.length || done % BATCH === 0) {
        emit({
          phase: "mis", done, total: srcMIs.length,
          name: mi.display_name || mi.key,
        });
      }
    }

    emit({ phase: "done" });
    res.end();
  } catch (e) {
    try { emit({ phase: "error", error: e.message }); } catch {}
    try { res.end(); } catch {}
  }
}

// POST /v3/templates/:id/publish
// Body: { version_id }
// Flips published_version_id to point at the chosen version. The previously
// published version still exists — it just isn't "live" anymore.
export async function publishVersion(req, res) {
  const sql = getSql();
  const { id: templateId } = req.params;
  const { version_id } = req.body || {};
  if (!version_id) return res.status(400).json({ error: "version_id required" });

  const [v] = await sql.unsafe(
    `SELECT id FROM ${T.v3_versions} WHERE id = $1 AND template_id = $2 LIMIT 1`,
    [version_id, templateId],
  );
  if (!v) return res.status(404).json({ error: "Version not found for this template" });

  const [tpl] = await sql.unsafe(
    `UPDATE ${T.v3_templates}
       SET published_version_id = $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [version_id, templateId],
  );
  res.json(tpl);
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
  res.json({ instances: rows });
}

// POST /v3/instances
// Body: { template_id, name?, user_id?, version_id? }
//
// REFERENCE + OVERRIDES model: creates EXACTLY one row in v3_instances.
// No per-MI rows are fan-out-inserted. Instance MI values are pulled live
// from v3_master_input at GET time (via LEFT JOIN), and overrides land in
// v3_instance_master_input lazily — only when the user sets a value.
//
// The instance pins its `version_id` (snapshot of the template's published
// version at creation time). Subsequent template edits within the same
// version propagate to the instance automatically. Forking a new template
// version leaves existing instances pinned to their original version.
export async function createInstance(req, res) {
  const sql = getSql();
  const b = req.body || {};
  if (!b.template_id) return res.status(400).json({ error: "template_id required" });

  const [tpl] = await sql.unsafe(
    `SELECT id, name, published_version_id FROM ${T.v3_templates} WHERE id = $1 LIMIT 1`,
    [b.template_id],
  );
  if (!tpl) return res.status(404).json({ error: "Template not found" });

  const versionId = b.version_id || tpl.published_version_id || null;
  const instanceId = newObjectId();
  const instanceName =
    (b.name && String(b.name).trim()) ||
    `${tpl.name || "Untitled"} — instance ${new Date().toISOString().slice(0, 10)}`;

  try {
    await sql.unsafe(
      `INSERT INTO ${T.v3_instances}
         (id, template_id, version_id, name, user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [instanceId, b.template_id, versionId, instanceName, b.user_id ?? null],
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
  const versionId = inst.version_id || tpl?.published_version_id || null;

  const pages = await sql.unsafe(
    // NOTE: `row_heights` must be included here — the instance grid in
    // RetemplateTwo reads it the same way the editor does to make row
    // heights match. Dropping it makes every editor-resized row collapse
    // back to the browser-natural height in the instance view.
    `SELECT id, name, ord, row_count, col_count, size, orientation, scale,
            hidden, is_imported, columns_order, column_widths, row_heights,
            cells, styles, merges, schemes
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
        COALESCE(imi.value, tmi.value) AS value
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

  res.json({
    instance: inst,
    template: tpl ? {
      id: tpl.id,
      name: tpl.name,
      scheme: tpl.scheme,
      description: tpl.description,
      input_sections: tpl.input_sections,
      published_version_id: tpl.published_version_id,
    } : null,
    pages,
    masterInputs: mis,
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
  const fields = [
    ["name", "name"],
    ["collaborators", "collaborators"],
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

// DELETE /v3/instances/:id
// Cascade-deletes the instance's MIs via FK ON DELETE CASCADE.
export async function deleteInstance(req, res) {
  const sql = getSql();
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
    `SELECT template_id, version_id FROM ${T.v3_instances} WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (!inst) return res.status(404).json({ error: "Instance not found" });
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
        COALESCE(imi.value, tmi.value) AS value
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
    [id, inst.template_id, inst.version_id],
  );
  res.json({ masterInputs: rows });
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
        COALESCE(imi.value, tmi.value) AS value
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
  res.json(row);
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

// GET /v3/calculations/:id — single
export async function getCalculation(req, res) {
  const sql = getSql();
  try {
    const [row] = await sql.unsafe(
      `SELECT id, name, description, sector, author, ord, disabled, template_id, instance_id, retemplate_id, prefill_master_inputs, created_at, updated_at
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
      SELECT id, name, description, sector, author, ord, disabled, template_id, instance_id, retemplate_id, prefill_master_inputs, created_at, updated_at
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
       RETURNING id, name, description, sector, author, ord, disabled, template_id, instance_id, retemplate_id, prefill_master_inputs, created_at, updated_at`,
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
  if (b.prefill_master_inputs !== undefined) { fields.push(`prefill_master_inputs = $${i++}::jsonb`); args.push(JSON.stringify(Array.isArray(b.prefill_master_inputs) ? b.prefill_master_inputs : [])); }
  if (fields.length === 0) return res.status(400).json({ error: "no fields to update" });
  fields.push(`updated_at = NOW()`);
  args.push(req.params.id);
  try {
    const [row] = await sql.unsafe(
      `UPDATE ${T.v3_calculations} SET ${fields.join(", ")}
       WHERE id = $${i}
       RETURNING id, name, description, sector, author, ord, disabled, template_id, instance_id, retemplate_id, prefill_master_inputs, created_at, updated_at`,
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
