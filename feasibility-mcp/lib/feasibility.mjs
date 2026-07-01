/**
 * Domain operations for the feasibility templates. Each write does a
 * READ-MODIFY-WRITE because `PATCH /v3/pages/:id` shallow-merges the `cells`
 * jsonb with `||` — sending a partial cell object REPLACES that A1 entirely,
 * so we must reattach the existing `v`/`f`/`s` we aren't changing.
 */

import { beGet, bePatch } from "./be.mjs";
import { upsertStyle, mergeStyle, toggleStyleFlag, expandA1, rangeA1s } from "./style.mjs";
import { extractRefs, isErrorValue } from "./formula.mjs";

const enc = encodeURIComponent;

/** Run async `fn` over `items` with bounded concurrency (default 8). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Reads ────────────────────────────────────────────────────────────────
export const getActiveContext = () => beGet("/v3/active-context");
export const listTemplates = () => beGet("/v3/templates");
export const getTemplate = (id) => beGet(`/v3/templates/${enc(id)}`);
export const getPage = (id) => beGet(`/v3/pages/${enc(id)}`);
export const listMasterInputs = (templateId, version) =>
  beGet(`/v3/templates/${enc(templateId)}/master-inputs${version ? `?version=${enc(version)}` : ""}`);

export async function listPages(templateId) {
  const tpl = await getTemplate(templateId);
  return (tpl.pages || []).map((p) => ({
    id: p.id,
    name: p.name,
    ord: p.ord,
    rows: p.row_count,
    cols: p.col_count,
    hidden: p.hidden,
  }));
}

/** Cells of a page, filtered. Returns compact rows the agent can scan. */
export async function listCells(pageId, opts = {}) {
  const { a1Matches, onlyFormulas, onlyErrors, limit = 200 } = opts;
  const page = await getPage(pageId);
  const cells = page.cells || {};
  const styles = page.styles || {};
  let re = null;
  if (a1Matches) re = new RegExp(a1Matches, "i");
  const rows = [];
  for (const [a1, c] of Object.entries(cells)) {
    if (re && !re.test(a1)) continue;
    if (onlyFormulas && !c.f?.expr) continue;
    if (onlyErrors && !isErrorValue(c.v)) continue;
    rows.push({
      a1,
      value: c.v ?? null,
      formula: c.f?.expr || null,
      style: c.s ? styles[c.s] || null : null,
    });
    if (rows.length >= limit) break;
  }
  return { pageId, pageName: page.name, count: rows.length, cells: rows };
}

// ── Formula / value writes ─────────────────────────────────────────────────
/**
 * Apply value/formula edits. Each edit: { a1, formula?, value?, clear? }.
 *  - formula: stored as `cell.f.expr` (a leading "=" is added if missing).
 *  - value:   literal `cell.v`; removes any formula.
 *  - clear:   deletes the cell entirely.
 */
export async function setCells(pageId, edits) {
  const page = await getPage(pageId);
  const cells = page.cells || {};
  const cellPatch = {};
  const removeCells = [];
  for (const e of edits) {
    const a1 = String(e.a1).toUpperCase();
    if (e.clear) {
      removeCells.push(a1);
      continue;
    }
    const next = { ...(cells[a1] || {}) };
    if (e.formula != null && String(e.formula).trim() !== "") {
      let expr = String(e.formula).trim();
      if (!expr.startsWith("=")) expr = "=" + expr;
      next.f = { expr };
    } else if (e.value !== undefined) {
      next.v = e.value;
      delete next.f;
    }
    cellPatch[a1] = next;
  }
  const body = {};
  if (Object.keys(cellPatch).length) body.cells = cellPatch;
  if (removeCells.length) body.removeCells = removeCells;
  if (!body.cells && !body.removeCells) return { updated: 0 };
  await bePatch(`/v3/pages/${enc(pageId)}`, body);
  return { updated: Object.keys(cellPatch).length, cleared: removeCells.length };
}

// ── Formatting ─────────────────────────────────────────────────────────────
/** Friendly format object → internal style partial. */
export function translateFormat(fmt = {}) {
  const s = {};
  const set = (k, v) => {
    if (v !== undefined) s[k] = v;
  };
  if (fmt.bold !== undefined) s.fontWeight = fmt.bold ? "bold" : "normal";
  if (fmt.italic !== undefined) s.fontStyle = fmt.italic ? "italic" : "normal";
  if (fmt.underline !== undefined) s.textDecoration = fmt.underline ? "underline" : "none";
  set("color", fmt.color);
  set("backgroundColor", fmt.backgroundColor);
  set("textAlign", fmt.textAlign);
  set("fontFamily", fmt.fontFamily);
  if (fmt.fontSize !== undefined)
    s.fontSize = typeof fmt.fontSize === "number" ? `${fmt.fontSize}pt` : fmt.fontSize;
  set("numberFormat", fmt.numberFormat);
  if (fmt.zeroAsDash !== undefined) s.zeroAsDash = fmt.zeroAsDash ? true : null;
  if (fmt.border) {
    const b = fmt.border;
    const color = b.color || "#000000";
    const width = b.width != null ? `${b.width}px` : "1px";
    const sides = Array.isArray(b.sides) && b.sides.length ? b.sides : ["all"];
    if (sides.includes("all")) {
      s.borderColor = color;
      s.borderWidth = width;
    } else {
      s.borderColor = color;
      for (const side of ["top", "bottom", "left", "right"]) {
        const cap = side[0].toUpperCase() + side.slice(1);
        s[`border${cap}Width`] = sides.includes(side) ? width : "0px";
      }
    }
  }
  if (fmt.noBorder) {
    s.borderColor = null;
    s.borderWidth = null;
    s.borderTopWidth = null;
    s.borderBottomWidth = null;
    s.borderLeftWidth = null;
    s.borderRightWidth = null;
  }
  return s;
}

/**
 * Apply formatting to a list of A1 targets (each may be a cell or "A1:B2"
 * range). `partial` is an internal style partial (see translateFormat).
 * `toggles` is an optional array of "bold"|"italic"|"underline" to flip.
 * When `clear` is true the cells' style is removed.
 */
export async function formatCells(pageId, targets, { partial, toggles, clear } = {}) {
  const a1List = targets.flatMap((t) => expandA1(t));
  if (a1List.length === 0) return { updated: 0 };
  const page = await getPage(pageId);
  const cells = page.cells || {};
  let stylesDict = page.styles || {};
  const cellPatch = {};
  const stylesDelta = {};
  for (const a1 of a1List) {
    const old = cells[a1] || {};
    const oldStyle = old.s ? stylesDict[old.s] || null : null;
    let newStyle;
    if (clear) newStyle = {};
    else if (toggles && toggles.length) {
      newStyle = { ...(oldStyle || {}) };
      for (const f of toggles) newStyle = toggleStyleFlag(newStyle, f);
    } else newStyle = mergeStyle(oldStyle || {}, partial || {});
    const { stylesDict: nd, styleId } = upsertStyle(stylesDict, newStyle);
    stylesDict = nd;
    const nextCell = { ...old };
    if (styleId) nextCell.s = styleId;
    else delete nextCell.s;
    cellPatch[a1] = nextCell;
    if (styleId && nd[styleId] !== (page.styles || {})[styleId]) stylesDelta[styleId] = nd[styleId];
  }
  const body = { cells: cellPatch };
  if (Object.keys(stylesDelta).length) body.styles = stylesDelta;
  await bePatch(`/v3/pages/${enc(pageId)}`, body);
  return { updated: a1List.length, newStyles: Object.keys(stylesDelta).length };
}

// ── Master inputs ──────────────────────────────────────────────────────────
export async function setMasterInput(id, value) {
  const row = await bePatch(`/v3/master-inputs/${enc(id)}`, { value });
  return { id: row.id, key: row.key, ref: row.ref, value: row.value };
}

// ── Precedents & summary ────────────────────────────────────────────────────
export async function findPrecedents(pageId, a1) {
  const page = await getPage(pageId);
  const target = (page.cells || {})[String(a1).toUpperCase()];
  const expr = target?.f?.expr || null;
  if (!expr) return { sheet: page.name, a1, formula: null, value: target?.v ?? null, precedents: [] };
  const refs = extractRefs(expr);
  const tpl = await getTemplate(page.template_id);
  const nameToId = new Map((tpl.pages || []).map((p) => [p.name.toLowerCase(), p.id]));
  const cache = { [pageId]: page };
  const load = async (id) => (cache[id] ||= await getPage(id));
  const precedents = [];
  for (const ref of refs) {
    const targetId = ref.sheet ? nameToId.get(ref.sheet.toLowerCase()) : pageId;
    if (!targetId) {
      precedents.push({ sheet: ref.sheet, ref: ref.raw, resolved: false });
      continue;
    }
    const pg = await load(targetId);
    const a1s = ref.end ? rangeA1s(ref.a1, ref.end).slice(0, 100) : [ref.a1];
    for (const cellA1 of a1s) {
      const c = (pg.cells || {})[cellA1];
      precedents.push({ sheet: pg.name, a1: cellA1, value: c?.v ?? null, formula: c?.f?.expr || null });
    }
  }
  return { sheet: page.name, a1, formula: expr, value: target?.v ?? null, precedents };
}

export async function getSummary(templateId) {
  const tpl = await getTemplate(templateId);
  const pages = tpl.pages || [];
  const perPage = await mapLimit(pages, 8, async (p) => {
    const page = await getPage(p.id);
    const cells = page.cells || {};
    let total = 0;
    let formulas = 0;
    const errs = [];
    for (const [a1, c] of Object.entries(cells)) {
      total++;
      if (c.f?.expr) formulas++;
      if (isErrorValue(c.v)) errs.push({ page: p.name, pageId: p.id, a1, value: c.v, formula: c.f?.expr || null });
    }
    return { total, formulas, errs };
  });
  let totalCells = 0;
  let formulaCells = 0;
  const errors = [];
  for (const r of perPage) {
    totalCells += r.total;
    formulaCells += r.formulas;
    errors.push(...r.errs);
  }
  return {
    templateId,
    templateName: tpl.name,
    pageCount: pages.length,
    totalCells,
    formulaCells,
    totalErrors: errors.length,
    errors: errors.slice(0, 100),
  };
}
