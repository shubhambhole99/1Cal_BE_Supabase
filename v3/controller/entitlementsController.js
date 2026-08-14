/**
 * Entitlements — who may read a paid page, and what spending one costs.
 *
 * Model (see BE/v3/db/ensureTables.js):
 *   v3_entitlement_grants        what a user was given: 'credits' (reports
 *                                bought) or 'unlimited' (a subscription window)
 *   v3_entitlement_consumptions  every debit, one row each
 *   v3_instances.unlocked_at     denormalised "this report is paid for"
 *   v3_pages.locked              which pages are paid-only
 *
 * Balance is never stored — it is always
 *   SUM(grants.credits) - SUM(consumptions.credits)
 * so it can be recomputed from the ledger and a double charge is visible as
 * two rows for one instance.
 *
 * The whole gate is behind PAYWALL_ENABLED. With it off (the default) reads are
 * unrestricted, which is what lets this ship before any page has been ticked.
 */

import { getSql } from "../db/index.js";
import { newObjectId } from "../utils/objectId.js";
import { verifiedUserId } from "../middleware/v3Auth.js";

const SCHEMA = process.env.DB_SCHEMA || "final";
const T = {
  grants: `"${SCHEMA}"."v3_entitlement_grants"`,
  cons: `"${SCHEMA}"."v3_entitlement_consumptions"`,
  instances: `"${SCHEMA}"."v3_instances"`,
  users: `"${SCHEMA}"."users"`,
  mi: `"${SCHEMA}"."v3_master_input"`,
  imi: `"${SCHEMA}"."v3_instance_master_input"`,
};

export const PAYWALL_ENABLED = String(process.env.PAYWALL_ENABLED || "").toLowerCase() === "true";
/** The master input that holds the plot area. Keyed by the stable `key`, never
 *  by id — the id differs per template, the key is identical everywhere. */
export const PLOT_AREA_KEY = process.env.PLOT_AREA_MI_KEY || "Plot Area";
export const CREDIT_PRICE_INR = 3000;

/**
 * Is this caller an admin? Used ONLY for authorisation — who may grant
 * entitlements, and who may act on someone else's report. Deliberately NOT used
 * to bypass the paywall: admins get an 'unlimited' grant instead, so they see
 * the product the way customers do. Role lives in the JWT and on users.role.
 */
export async function isAdminUser(sql, req, userId) {
  const role = req.user?.role;
  if (role && /^(admin|superadmin|owner)$/i.test(String(role))) return true;
  if (!userId) return false;
  try {
    const [u] = await sql.unsafe(`SELECT role FROM ${T.users} WHERE id = $1 LIMIT 1`, [userId]);
    return !!u?.role && /^(admin|superadmin|owner)$/i.test(String(u.role));
  } catch { return false; }
}

/** { unlimited, balance, granted, consumed } for a user. */
export async function entitlementSummary(sql, userId) {
  if (!userId) return { unlimited: false, balance: 0, granted: 0, consumed: 0 };
  const [g] = await sql.unsafe(
    `SELECT
       COALESCE(SUM(CASE WHEN kind = 'credits' THEN credits ELSE 0 END), 0)::int AS granted,
       BOOL_OR(kind = 'unlimited' AND (expires_at IS NULL OR expires_at > NOW())) AS unlimited
     FROM ${T.grants}
     WHERE user_id = $1 AND revoked_at IS NULL AND starts_at <= NOW()`,
    [userId],
  );
  const [c] = await sql.unsafe(
    `SELECT COALESCE(SUM(credits), 0)::int AS consumed FROM ${T.cons} WHERE user_id = $1`,
    [userId],
  );
  const granted = g?.granted || 0;
  const consumed = c?.consumed || 0;
  return {
    unlimited: !!g?.unlimited,
    balance: Math.max(0, granted - consumed),
    granted,
    consumed,
  };
}

/**
 * May this viewer read the report's locked pages?
 * Unlocking is per-REPORT and permanent, so a collaborator on a report the
 * owner paid for reads it without needing credits of their own.
 */
export async function canReadLockedPages(sql, req, instanceRow) {
  if (!PAYWALL_ENABLED) return { ok: true, reason: "paywall-off" };
  if (instanceRow?.unlocked_at) return { ok: true, reason: "report-unlocked" };
  // No admin bypass. Admins are given an 'unlimited' grant instead, so they
  // walk the same path as a paying customer — unlocking costs them nothing but
  // they still see, and can test, exactly what everyone else sees. A bypass
  // here would mean the people who own the product are the only ones who never
  // look at it.
  return { ok: false, reason: "locked" };
}

/**
 * The "set once, pay to change" rule for a master input.
 *
 * A one-time input is free the first time a report sets it — that's the single
 * question the reader is asked up front. Every later change is another
 * feasibility run, so it has to go through changeLockedInput, which debits.
 * Without this the paywall would be one PATCH away from irrelevant: the normal
 * MI save path could rewrite the plot area for free, forever.
 *
 * Returns { ok: true } to allow the write, or { ok:false, status, body } to
 * refuse it.
 */
export async function guardOneTimeInput(sql, req, instanceId, tmi, nextValue) {
  if (!PAYWALL_ENABLED) return { ok: true };
  if (!tmi?.one_time) return { ok: true };

  const [inst] = await sql.unsafe(
    `SELECT id, unlocked_at FROM ${T.instances} WHERE id = $1 LIMIT 1`, [instanceId]);
  // Already paid for: this report is settled, edit freely.
  if (inst?.unlocked_at) return { ok: true };

  const [prev] = await sql.unsafe(
    `SELECT value FROM ${T.imi} WHERE instance_id = $1 AND template_mi_key = $2 LIMIT 1`,
    [instanceId, tmi.key]);
  // Never set on this report → this is the one free answer.
  if (!prev || prev.value == null || prev.value === "") return { ok: true };
  // Same value re-sent (autosave, a re-render) → not a change, don't charge.
  if (String(prev.value) === String(nextValue ?? "")) return { ok: true };

  return {
    ok: false,
    status: 402,
    body: {
      error: `"${tmi.key}" has already been set for this report. Changing it runs the feasibility again.`,
      code: "ONE_TIME_INPUT_LOCKED",
      key: tmi.key,
      current_value: prev.value,
      price_inr: CREDIT_PRICE_INR,
      // Where the client should send the change instead.
      change_endpoint: `/v3/instances/${instanceId}/change-locked-input`,
    },
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

/** GET /v3/entitlements/me — the signed-in user's plan + balance. */
export async function getMyEntitlement(req, res) {
  const sql = getSql();
  try {
    const uid = verifiedUserId(req);
    const summary = await entitlementSummary(sql, uid);
    res.json({
      ...summary,
      user_id: uid,
      admin: await isAdminUser(sql, req, uid),
      paywall_enabled: PAYWALL_ENABLED,
      price_inr: CREDIT_PRICE_INR,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
}

/** POST /v3/entitlements/grant — admin only. { user_id, kind, credits?, expires_at?, note? } */
export async function grantEntitlement(req, res) {
  const sql = getSql();
  const b = req.body || {};
  try {
    const actor = verifiedUserId(req);
    if (!(await isAdminUser(sql, req, actor))) {
      return res.status(403).json({ error: "Admins only." });
    }
    const userId = b.user_id ? String(b.user_id) : null;
    const kind = b.kind === "unlimited" ? "unlimited" : "credits";
    const credits = kind === "credits" ? Math.max(1, Math.trunc(Number(b.credits) || 0)) : 0;
    if (!userId) return res.status(400).json({ error: "user_id required" });
    if (kind === "credits" && !credits) return res.status(400).json({ error: "credits must be >= 1" });

    const id = newObjectId();
    await sql.unsafe(
      `INSERT INTO ${T.grants} (id, user_id, kind, credits, expires_at, order_id, granted_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, userId, kind, credits, b.expires_at || null, b.order_id ? String(b.order_id) : null,
       actor, b.note ? String(b.note) : "admin grant"],
    );
    res.status(201).json({ id, ...(await entitlementSummary(sql, userId)) });
  } catch (e) {
    if (String(e.message || "").includes("duplicate key")) {
      return res.status(409).json({ error: "That order has already been granted." });
    }
    res.status(500).json({ error: String(e.message || e) });
  }
}

/** GET /v3/entitlements/:userId — admin view of one user's ledger. */
export async function getUserEntitlement(req, res) {
  const sql = getSql();
  try {
    if (!(await isAdminUser(sql, req, verifiedUserId(req)))) {
      return res.status(403).json({ error: "Admins only." });
    }
    const uid = String(req.params.userId);
    const grants = await sql.unsafe(
      `SELECT * FROM ${T.grants} WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [uid]);
    const consumptions = await sql.unsafe(
      `SELECT * FROM ${T.cons} WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [uid]);
    res.json({ ...(await entitlementSummary(sql, uid)), user_id: uid, grants, consumptions });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
}

/**
 * POST /v3/instances/:id/change-plot-area
 * Body: { plot_area, idempotency_key? }
 *
 * The one action that spends a credit. It writes the new plot area AND debits,
 * in a single transaction, so the report can never end up charged-but-unchanged
 * or changed-but-unbilled.
 *
 * - unlimited plan  → recorded with credits = 0
 * - already unlocked → recorded with credits = 0 (you bought this report once;
 *                      re-running it is free, which is what "unlocked forever"
 *                      means)
 * - zero balance    → 402, nothing written
 * - retry/duplicate → idempotency_key is UNIQUE, so the second attempt returns
 *                     the first result instead of charging again
 */
export async function changePlotArea(req, res) {
  const sql = getSql();
  const instanceId = String(req.params.id);
  const b = req.body || {};
  // Works for ANY one-time input; `plot_area` is kept as the original spelling
  // so the existing /change-plot-area route and its callers keep working.
  const miKey = b.key ? String(b.key) : PLOT_AREA_KEY;
  const raw = b.value != null ? b.value : b.plot_area;
  const newValue = raw == null ? null : String(raw);
  if (newValue == null || newValue === "") {
    return res.status(400).json({ error: "value required" });
  }
  try {
    const uid = verifiedUserId(req);
    if (!uid) return res.status(401).json({ error: "Sign in to change the plot area." });

    // pinned_at gates the version switcher; ensure it exists so the SELECT below
    // never 500s on a box that hasn't run the render paths yet (idempotent).
    await sql.unsafe(`ALTER TABLE ${T.instances} ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`).catch(() => {});

    const [inst] = await sql.unsafe(
      `SELECT id, user_id, template_id, version_id, pinned_at, unlocked_at, collaborators
         FROM ${T.instances} WHERE id = $1 LIMIT 1`, [instanceId]);
    if (!inst) return res.status(404).json({ error: "Report not found" });

    // Only the owner or a collaborator may spend against a report.
    const collabs = Array.isArray(inst.collaborators) ? inst.collaborators.map(String)
      : (() => { try { return JSON.parse(inst.collaborators || "[]").map(String); } catch { return []; } })();
    const admin = await isAdminUser(sql, req, uid);
    if (!admin && String(inst.user_id) !== String(uid) && !collabs.includes(String(uid))) {
      return res.status(403).json({ error: "You don't have access to this report." });
    }

    // Resolve the version this report actually RENDERS, so the one-time input we
    // charge for is the same one the viewer sees. Mirrors resolveInstanceVersion
    // in v3Controller (kept inline to avoid an import cycle): a deliberate pin
    // (version_id + pinned_at) wins when valid, otherwise the published version —
    // so the 44 dormant legacy version_id values resolve to published here too.
    const [tplRow] = await sql.unsafe(
      `SELECT published_version_id FROM "${SCHEMA}"."v3_templates" WHERE id = $1 LIMIT 1`,
      [inst.template_id]);
    let effVersionId = tplRow?.published_version_id || null;
    if (inst.version_id && inst.pinned_at) {
      const [v] = await sql.unsafe(
        `SELECT id FROM "${SCHEMA}"."v3_versions" WHERE id = $1 AND template_id = $2 LIMIT 1`,
        [inst.version_id, inst.template_id]);
      if (v) effVersionId = inst.version_id;
    }

    // Resolve the plot-area master input for the version the report renders.
    const [tmi] = await sql.unsafe(
      `SELECT id, key FROM ${T.mi}
        WHERE template_id = $1 AND key = $2
          AND ($3::text IS NULL OR version_id = $3)
        LIMIT 1`,
      [inst.template_id, miKey, effVersionId],
    );
    if (!tmi) return res.status(400).json({ error: `This scheme has no "${miKey}" input.` });

    const [prev] = await sql.unsafe(
      `SELECT value FROM ${T.imi} WHERE instance_id = $1 AND template_mi_key = $2 LIMIT 1`,
      [instanceId, tmi.key]);
    const fromValue = prev?.value ?? null;

    const summary = await entitlementSummary(sql, uid);
    const alreadyUnlocked = !!inst.unlocked_at;
    let coveredBy = null;
    if (summary.unlimited) {
      // Unlimited plan — set or change the plot area freely.
      coveredBy = "unlimited";
    } else if (alreadyUnlocked) {
      // The plot area is already set for this report (it unlocked on the first
      // set). It can be set ONLY ONCE: changing it now requires an unlimited
      // plan. For a different plot area the user opens a new report instead.
      return res.status(402).json({
        error: "The plot area is set for this report and can only be changed on an unlimited plan. To run a different plot area, open a new report with \"Add calculation\".",
        code: "PLOT_AREA_LOCKED",
        needs_unlimited: true,
        price_inr: CREDIT_PRICE_INR,
      });
    } else if (summary.balance > 0) {
      // First time on this report — spend one report to set the plot area and
      // unlock every page.
      coveredBy = "credits";
    } else {
      return res.status(402).json({
        error: "You have no reports left.",
        code: "NO_CREDITS",
        balance: 0,
        price_inr: CREDIT_PRICE_INR,
      });
    }
    const cost = coveredBy === "credits" ? 1 : 0;
    // Same key for a retry of the same change; a genuinely new change gets a
    // new key from the client. Falls back to a value-derived key so a
    // double-clicked button can't charge twice.
    const idem = b.idempotency_key
      ? `${instanceId}:${String(b.idempotency_key)}`
      : `${instanceId}:${uid}:${newValue}`;

    let charged = true;
    await sql.begin(async (tx) => {
      // ON CONFLICT DO NOTHING rather than catching the unique violation: in
      // Postgres a failed statement poisons the whole transaction, so catching
      // it would leave every following statement erroring with "current
      // transaction is aborted". No row back = we've already served this exact
      // request, so don't charge for it twice.
      const ins = await tx.unsafe(
        `INSERT INTO ${T.cons}
           (id, user_id, instance_id, reason, credits, covered_by, plot_area_from, plot_area_to, idempotency_key)
         VALUES ($1,$2,$3,$9,$4,$5,$6,$7,$8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [newObjectId(), uid, instanceId, cost, coveredBy, fromValue, newValue, idem,
         miKey === PLOT_AREA_KEY ? "plot_area_change" : `one_time_change:${miKey}`],
      );
      if (!ins.length) { charged = false; return; }
      // Write the value the user asked for.
      await tx.unsafe(
        `INSERT INTO ${T.imi} (id, instance_id, template_mi_id, template_mi_key, value)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (instance_id, template_mi_key)
         DO UPDATE SET value = EXCLUDED.value, template_mi_id = EXCLUDED.template_mi_id`,
        [newObjectId(), instanceId, tmi.id, tmi.key, newValue],
      );
      // Unlocked forever, from the first paid run.
      await tx.unsafe(
        `UPDATE ${T.instances} SET unlocked_at = COALESCE(unlocked_at, NOW()), updated_at = NOW() WHERE id = $1`,
        [instanceId]);
    });

    const after = await entitlementSummary(sql, uid);
    res.json({
      ok: true,
      instance_id: instanceId,
      key: miKey,
      value: newValue,
      plot_area: newValue,
      unlocked: true,
      charged_credits: charged ? cost : 0,
      covered_by: charged ? coveredBy : "duplicate-request",
      ...after,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
