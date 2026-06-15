import { config } from "dotenv";
config({ override: true });
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

// Allowlist of users permitted to see the "Create Report V3" button on
// calculation pages. One row per allowed user. Admins are always allowed
// (checked against the users table) regardless of this list.

const SCHEMA = process.env.DB_SCHEMA ?? "final";
const q = (name) => (SCHEMA === "public" ? name : `"${SCHEMA}".${name}`);
const TABLE = q("report_v3_allowlist");
const USERS = q("users");

// Create the table on first use so the feature works even when
// ENSURE_TABLES=false (no startup migration required). Idempotent.
let _ensured = null;
function ensureTable() {
  if (!_ensured) {
    _ensured = (async () => {
      if (SCHEMA !== "public") {
        await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`));
      }
      await db.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
            `user_id varchar(24) PRIMARY KEY, ` +
            `created_at timestamptz DEFAULT now())`,
        ),
      );
    })().catch((e) => {
      _ensured = null; // allow a retry on the next request
      throw e;
    });
  }
  return _ensured;
}

// GET /restricted/allowlist  (admin) -> { userIds: [...] }
export async function getAllowlist(_req, res) {
  try {
    await ensureTable();
    const rows = await db.execute(
      sql.raw(`SELECT user_id FROM ${TABLE} ORDER BY created_at ASC`),
    );
    res.json({ userIds: Array.from(rows).map((r) => r.user_id) });
  } catch (e) {
    console.error("[restricted] getAllowlist:", e.message);
    res.status(500).json({ error: e.message });
  }
}

// PUT /restricted/allowlist  (admin)  body { userIds: [...] } -> replace list
export async function setAllowlist(req, res) {
  try {
    await ensureTable();
    const incoming = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const ids = Array.from(
      new Set(
        incoming
          .filter((x) => typeof x === "string" && x.trim())
          .map((x) => x.trim()),
      ),
    );
    await db.execute(sql.raw(`DELETE FROM ${TABLE}`));
    for (const id of ids) {
      await db.execute(
        sql`INSERT INTO ${sql.raw(TABLE)} (user_id) VALUES (${id}) ON CONFLICT (user_id) DO NOTHING`,
      );
    }
    res.json({ ok: true, userIds: ids });
  } catch (e) {
    console.error("[restricted] setAllowlist:", e.message);
    res.status(500).json({ error: e.message });
  }
}

// GET /restricted/allowlist/check?userId=...  (public) -> { allowed: bool }
// Admins are always allowed.
export async function checkAllowed(req, res) {
  try {
    await ensureTable();
    const userId = String(req.query?.userId || "").trim();
    if (!userId) return res.json({ allowed: false });

    const urows = await db.execute(
      sql`SELECT role FROM ${sql.raw(USERS)} WHERE id = ${userId} LIMIT 1`,
    );
    const role = Array.from(urows)[0]?.role;
    if (role === "admin") return res.json({ allowed: true, admin: true });

    const rows = await db.execute(
      sql`SELECT 1 FROM ${sql.raw(TABLE)} WHERE user_id = ${userId} LIMIT 1`,
    );
    res.json({ allowed: Array.from(rows).length > 0 });
  } catch (e) {
    console.error("[restricted] checkAllowed:", e.message);
    res.status(500).json({ error: e.message });
  }
}
