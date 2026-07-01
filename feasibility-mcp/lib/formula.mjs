/**
 * Lightweight formula-reference extraction for `find_precedents`. This is NOT
 * a full formula parser — it pulls out the cell/range references a formula
 * depends on (optionally sheet-qualified) so the agent can inspect precedents.
 */

const ERROR_VALUES = new Set([
  "#REF!",
  "#DIV/0!",
  "#VALUE!",
  "#NAME?",
  "#N/A",
  "#NULL!",
  "#NUM!",
  "#ERROR!",
  "#CIRC!",
]);

/** True when a cached cell value is a spreadsheet error literal. */
export function isErrorValue(v) {
  return typeof v === "string" && ERROR_VALUES.has(v.trim().toUpperCase());
}

const stripAbs = (s) => s.replace(/\$/g, "").toUpperCase();

// Sheet-qualified: 'Sheet Name'!A1 | Sheet!A1[:B2]
const QUALIFIED =
  /(?:'([^']+)'|([A-Za-z_][\w.]*))!(\$?[A-Za-z]{1,3}\$?\d{1,7})(?::(\$?[A-Za-z]{1,3}\$?\d{1,7}))?/g;
// Bare A1[:B2] not already part of a sheet-qualified ref, a function name, or a number.
const BARE = /(?<![A-Za-z0-9_!'$.])(\$?[A-Za-z]{1,3}\$?\d{1,7})(?::(\$?[A-Za-z]{1,3}\$?\d{1,7}))?/g;

/**
 * Extract references from a formula expression.
 * @returns {Array<{sheet: string|null, a1: string, end: string|null, raw: string}>}
 */
export function extractRefs(expr) {
  if (typeof expr !== "string" || !expr) return [];
  const out = [];
  const seen = new Set();
  const push = (sheet, a1, end, raw) => {
    const key = `${sheet || ""}!${a1}:${end || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ sheet: sheet || null, a1, end: end || null, raw });
  };

  let m;
  const masked = expr.replace(QUALIFIED, (raw, q, bare, start, end) => {
    push(q || bare, stripAbs(start), end ? stripAbs(end) : null, raw);
    return " ".repeat(raw.length); // blank it so BARE doesn't re-match the A1 part
  });

  BARE.lastIndex = 0;
  while ((m = BARE.exec(masked)) !== null) {
    push(null, stripAbs(m[1]), m[2] ? stripAbs(m[2]) : null, m[0]);
  }
  return out;
}
