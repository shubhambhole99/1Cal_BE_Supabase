import crypto from "crypto";

/**
 * Convert the legacy `templates.pages` JSONB into the v3 sparse-cell shape.
 *
 * Legacy cell tuple: [displayValue, [formulaExpr, null, depRefs[], rawSrc, ver], styleObject]
 * v3 cell shape:     { v: <display>, s: <styleId>, f?: { expr, deps[] } }   (only non-empty cells)
 */

const styleHash = (s) =>
  crypto.createHash("md5").update(JSON.stringify(s)).digest("hex").slice(0, 8);

/** column index → A1 letters: 0 → A, 25 → Z, 26 → AA, etc. */
export function colIndexToA1(c) {
  let s = "";
  let n = c | 0;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function isStyleEmpty(s) {
  return !s || typeof s !== "object" || Object.keys(s).length === 0;
}

/** True if the cell has no value, no formula, and no style worth keeping. */
function cellIsEmpty(display, compute, style) {
  const hasDisplay = display !== "" && display !== null && display !== undefined;
  const hasFormula =
    Array.isArray(compute) &&
    ((typeof compute[0] === "string" && compute[0] !== "") ||
      (Array.isArray(compute[2]) && compute[2].length > 0));
  const hasStyle = !isStyleEmpty(style);
  return !hasDisplay && !hasFormula && !hasStyle;
}

/**
 * Convert one legacy page object → v3 page row payload.
 * Returns: { name, ord, row_count, col_count, size, orientation, scale, hidden,
 *           is_imported, columns_order, column_widths, cells, styles, merges }
 */
export function convertLegacyPage(legacyPage) {
  const stylesByHash = new Map(); // hash → id ("s1", "s2", ...)
  const stylesById = {}; // id → style object
  let nextStyleId = 1;

  const cells = {};
  const merges = [];

  const rows = Array.isArray(legacyPage.rows) ? legacyPage.rows : [];

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || {};
    const content = Array.isArray(row.content) ? row.content : [];

    for (let c = 0; c < content.length; c++) {
      const lc = content[c];
      if (!Array.isArray(lc)) continue;

      const display = lc[0];
      const compute = lc[1];
      const style = lc[2];

      if (cellIsEmpty(display, compute, style)) continue;

      const a1 = colIndexToA1(c) + (r + 1);
      const cell = {};

      if (display !== undefined && display !== "" && display !== null) {
        cell.v = display;
      }

      // Formula extraction
      if (Array.isArray(compute)) {
        const expr = typeof compute[0] === "string" ? compute[0] : "";
        const deps = Array.isArray(compute[2]) ? compute[2] : [];
        if (expr || deps.length) {
          cell.f = {};
          if (expr) cell.f.expr = expr;
          if (deps.length) cell.f.deps = deps;
        }
      }

      // Style dedup → s1, s2, ...
      if (!isStyleEmpty(style)) {
        const h = styleHash(style);
        if (!stylesByHash.has(h)) {
          const id = `s${nextStyleId++}`;
          stylesByHash.set(h, id);
          stylesById[id] = style;
        }
        cell.s = stylesByHash.get(h);
      }

      cells[a1] = cell;
    }

    // Per-row merge ranges → rectangles
    if (Array.isArray(row.merged)) {
      for (const m of row.merged) {
        if (m && Number.isFinite(m.start) && Number.isFinite(m.end) && m.end > m.start) {
          merges.push({ r1: r, c1: m.start, r2: r, c2: m.end });
        }
      }
    }
  }

  return {
    name: legacyPage.name ?? "Untitled",
    ord: Number.isFinite(legacyPage.order) ? legacyPage.order : 0,
    row_count: rows.length,
    col_count: Array.isArray(legacyPage.columns) ? legacyPage.columns.length : 0,
    size: legacyPage.size ?? "a4",
    orientation: legacyPage.orientation ?? "landscape",
    scale: Number.isFinite(legacyPage.scale) ? legacyPage.scale : 1,
    hidden: !!legacyPage.hidden,
    is_imported: !!legacyPage._isImported,
    columns_order: Array.isArray(legacyPage.columns) ? legacyPage.columns : [],
    column_widths: legacyPage.columnWidths ?? {},
    cells,
    styles: stylesById,
    merges,
  };
}

/**
 * Convert legacy `templates.masterinput` array → array of v3 master input rows.
 */
export function convertLegacyMasterInputs(masterInputsArr) {
  if (!Array.isArray(masterInputsArr)) return [];
  return masterInputsArr.map((mi, idx) => ({
    key: mi.name ?? mi.key ?? `mi_${idx}`,
    value: mi.value == null ? null : String(mi.value),
    ref: mi.pagen ?? mi.cell ?? null,
    type: mi.type ?? "text",
    options: Array.isArray(mi.options) ? mi.options : [],
    section: mi.section ?? null,
    ord: Number.isFinite(mi.ord) ? mi.ord : idx,
  }));
}
