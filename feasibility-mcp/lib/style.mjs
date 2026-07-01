/**
 * Cell-style helpers — a faithful port of the FE's
 * `lib/retemplate1/styleUtils.js`. The editor stores a cell's style as
 * `cell.s = "sNNN"` referencing `page.styles[id]`, content-deduped. The MCP
 * server MUST reproduce the exact id-allocation + dedup so style writes land
 * in the same shape the editor reads back.
 */

const STYLE_KEYS = [
  "color",
  "backgroundColor",
  "fontStyle",
  "fontWeight",
  "textDecoration",
  "textAlign",
  "fontFamily",
  "fontSize",
  "borderColor",
  "borderWidth",
  "borderTopWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderRightWidth",
  "numberFormat",
  "zeroAsDash",
];

/** Canonical JSON for content-based dedup (sorted keys, drop falsy). */
export function canonicalize(style) {
  if (!style || typeof style !== "object") return "";
  const obj = {};
  for (const k of STYLE_KEYS) {
    const v = style[k];
    if (v && v !== "" && v !== "none" && v !== "normal") obj[k] = v;
  }
  return JSON.stringify(obj, Object.keys(obj).sort());
}

/** Find or create a style id in `stylesDict` for the given style object. */
export function upsertStyle(stylesDict, newStyle) {
  const dict = stylesDict || {};
  const hash = canonicalize(newStyle);
  if (hash === "") return { stylesDict: dict, styleId: null };
  for (const [id, s] of Object.entries(dict)) {
    if (canonicalize(s) === hash) return { stylesDict: dict, styleId: id };
  }
  const ids = Object.keys(dict)
    .filter((k) => /^s\d+$/.test(k))
    .map((k) => parseInt(k.slice(1), 10));
  const next = ids.length ? Math.max(...ids) + 1 : 1;
  const id = `s${next}`;
  return { stylesDict: { ...dict, [id]: JSON.parse(hash) }, styleId: id };
}

/** Merge a partial style update into the existing one (drops empty values). */
export function mergeStyle(existing, partial) {
  const merged = { ...(existing || {}) };
  for (const [k, v] of Object.entries(partial || {})) {
    if (v == null || v === "" || v === "none" || v === "normal") delete merged[k];
    else merged[k] = v;
  }
  return merged;
}

/** Toggle a known style flag (bold, italic, underline). */
export function toggleStyleFlag(style, flag) {
  const s = { ...(style || {}) };
  if (flag === "bold") s.fontWeight = s.fontWeight === "bold" ? "normal" : "bold";
  else if (flag === "italic") s.fontStyle = s.fontStyle === "italic" ? "normal" : "italic";
  else if (flag === "underline") s.textDecoration = s.textDecoration === "underline" ? "none" : "underline";
  return mergeStyle({}, s);
}

/** A1 ↔ (row, col) helpers (0-based). */
export function a1ToRC(a1) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(a1).trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: parseInt(m[2], 10) - 1, c: c - 1 };
}

export function rcToA1(r, c) {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s + (r + 1);
}

/** Inclusive rectangle from two A1 corners → list of A1 refs. */
export function rangeA1s(aA1, bA1) {
  const a = a1ToRC(aA1);
  const b = a1ToRC(bA1);
  if (!a || !b) return [];
  const r1 = Math.min(a.r, b.r);
  const r2 = Math.max(a.r, b.r);
  const c1 = Math.min(a.c, b.c);
  const c2 = Math.max(a.c, b.c);
  const out = [];
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(rcToA1(r, c));
  return out;
}

/**
 * Expand an A1 token that may be a single cell ("D19") or a range ("D19:F22")
 * into a flat list of A1 refs. Caps expansion so an accidental huge range
 * can't blow up a tool response.
 */
export function expandA1(token, cap = 400) {
  const t = String(token).trim();
  const m = /^([A-Za-z]+\d+):([A-Za-z]+\d+)$/.exec(t);
  if (m) return rangeA1s(m[1], m[2]).slice(0, cap);
  return a1ToRC(t) ? [t.toUpperCase()] : [];
}
