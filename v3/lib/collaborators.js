/**
 * Who is on a report, and what they may do.
 *
 * A collaborator is stored EITHER as a bare user id or as { id, role }. The bare
 * form is what every row written before roles existed holds, and it has always
 * meant "may edit" — so that is what it keeps meaning here. Roles are additive:
 * no existing report changes behaviour because this shipped.
 *
 * `open_access` ("off" | "view" | "edit") is the separate, list-free grant to
 * everyone who is NOT named in `collaborators`.
 *
 * These rules live in their own module because BOTH v3Controller and
 * entitlementsController need them and v3Controller already imports
 * entitlementsController — putting them in either controller would make a cycle.
 * The front end mirrors the identical rule in RetemplateTwo.collaboratorRoleOf;
 * the two must agree or the UI offers an edit the server then refuses.
 */

export const COLLAB_ROLES = new Set(["view", "edit"]);
export const OPEN_ACCESS = new Set(["off", "view", "edit"]);

export function normaliseCollaborators(arr) {
  const byId = new Map();
  for (const raw of Array.isArray(arr) ? arr : []) {
    let id;
    let role;
    if (raw && typeof raw === "object") {
      id = String(raw.id ?? raw._id ?? "").trim();
      role = COLLAB_ROLES.has(raw.role) ? raw.role : "edit";
    } else {
      id = String(raw ?? "").trim();
      role = "edit";                    // legacy entry — always an editor
    }
    if (id) byId.set(id, { id, role }); // last one wins, which de-duplicates
  }
  return [...byId.values()];
}

/** Just the ids, either shape — for "is this user on the list at all" checks. */
export function collaboratorIds(arr) {
  const raw = typeof arr === "string" ? safeParse(arr) : arr;
  return normaliseCollaborators(raw).map((c) => c.id);
}

/** "view" | "edit" | null — what this user is listed as. */
export function collaboratorRole(collabs, userid) {
  if (userid == null) return null;
  const me = String(userid);
  const raw = typeof collabs === "string" ? safeParse(collabs) : collabs;
  for (const c of normaliseCollaborators(raw)) {
    if (c.id === me) return c.role;
  }
  return null;
}

/** "off" | "view" | "edit" — what the row grants to everyone else. */
export function openAccessOf(row) {
  const v = row?.open_access;
  return OPEN_ACCESS.has(v) ? v : "off";
}

/**
 * SQL predicate for "user `param` is a collaborator on `col`", written so it
 * matches BOTH shapes. The listing queries used jsonb_array_elements_text and a
 * plain equality, which silently stops matching the moment an entry is an
 * object — a shared report would just disappear from My Files. COALESCE picks
 * the object's id when there is one and the bare string otherwise.
 *
 *   col   — a jsonb column reference, e.g. "i.collaborators"
 *   param — the placeholder holding the user id, e.g. "$1::text"
 */
export function isCollaboratorSql(col, param) {
  return `EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END
    ) AS collab(el)
    WHERE COALESCE(collab.el->>'id', collab.el->>'_id', collab.el #>> '{}') = ${param}
  )`;
}

function safeParse(s) {
  try { return JSON.parse(s || "[]"); } catch { return []; }
}
