// Cashfree Payment Gateway — orders ledger + create/verify/webhook.
//
// One row per payment attempt in `<schema>.v3_payments`. Every row carries a
// `mode` column ('test' | 'prod') chosen PER REQUEST, so the sandbox
// (/testing-payments) and live (/prod-payments) flows coexist and stay
// distinguishable in the admin Payments ledger.
//
// Env (BE/.env):
//   CASHFREE_APP_ID / CASHFREE_SECRET            test (sandbox) keys
//   CASHFREE_PROD_APP_ID / CASHFREE_PROD_SECRET  live (production) keys
//   CASHFREE_API_VERSION                         (default 2025-01-01)
//   CASHFREE_WEBHOOK_URL                         (optional public notify_url)
import crypto from "crypto";
import { getSql } from "../db/index.js";
import { newObjectId } from "../utils/objectId.js";

const SCHEMA = process.env.DB_SCHEMA ?? "prod";
const T = { v3_payments: `"${SCHEMA}"."v3_payments"` };

// ── Cashfree config for a given mode ('test' | 'prod'), resolved fresh each call
//    so a .env edit + restart applies. test → sandbox keys/URL, prod → live.
function cashfreeConfig(mode) {
  const isProd = mode === "prod" || mode === "production";
  return {
    env: isProd ? "production" : "sandbox",
    mode: isProd ? "prod" : "test",
    baseUrl: isProd ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg",
    apiVersion: process.env.CASHFREE_API_VERSION || "2025-01-01",
    appId: isProd ? process.env.CASHFREE_PROD_APP_ID || "" : process.env.CASHFREE_APP_ID || "",
    secret: isProd ? process.env.CASHFREE_PROD_SECRET || "" : process.env.CASHFREE_SECRET || "",
  };
}

// Authoritative order status straight from Cashfree (server-to-server, signed
// with our secret). Used to VERIFY — never trust a client/webhook-supplied
// status. Returns the parsed order object, or null on any failure.
async function fetchCashfreeOrder(orderId, cfg) {
  const r = await fetch(`${cfg.baseUrl}/orders/${encodeURIComponent(orderId)}`, {
    headers: {
      "x-api-version": cfg.apiVersion,
      "x-client-id": cfg.appId,
      "x-client-secret": cfg.secret,
    },
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// ── Lazy, memoized table create. Belt-and-suspenders: ensureTables.js also
//    creates it on boot (ENSURE_TABLES=true), but this guarantees the endpoint
//    works even where that boot step is skipped (e.g. serverless prod).
let _ensured = null;
function ensurePaymentsTable() {
  if (_ensured) return _ensured;
  const sql = getSql();
  _ensured = (async () => {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${T.v3_payments} (
      id                  VARCHAR(24) PRIMARY KEY,
      order_id            TEXT UNIQUE,
      cf_order_id         TEXT,
      payment_session_id  TEXT,
      cf_payment_id       TEXT,
      payment_method      TEXT,
      user_id             VARCHAR(24),
      username            TEXT,
      customer_phone      TEXT,
      customer_email      TEXT,
      amount              NUMERIC,
      currency            TEXT DEFAULT 'INR',
      status              TEXT DEFAULT 'CREATED',
      mode                TEXT DEFAULT 'test',
      purpose             TEXT,
      raw                 JSONB DEFAULT '{}'::jsonb,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )`);
  })().catch((e) => { _ensured = null; throw e; });
  return _ensured;
}

// GET /v3/payments  (optional ?mode=test|prod) — newest first.
export async function listPayments(req, res) {
  try {
    const sql = getSql();
    await ensurePaymentsTable();
    const cols = `id, order_id, cf_order_id, cf_payment_id, payment_method, user_id, username,
      customer_phone, customer_email, amount, currency, status, mode, purpose, created_at, updated_at`;
    const mode = req.query?.mode;
    let rows;
    if (mode === "test" || mode === "prod") {
      rows = await sql.unsafe(
        `SELECT ${cols} FROM ${T.v3_payments} WHERE mode = $1 ORDER BY created_at DESC LIMIT 500`,
        [mode],
      );
    } else {
      rows = await sql.unsafe(
        `SELECT ${cols} FROM ${T.v3_payments} ORDER BY created_at DESC LIMIT 500`,
      );
    }
    res.json({ payments: Array.from(rows) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

// POST /v3/payments/create-order
// body: { amount, purpose?, customer_phone?, customer_email?, user_id?, username?, currency? }
// Records the attempt, calls Cashfree Create Order, returns payment_session_id.
export async function createPaymentOrder(req, res) {
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "amount must be a positive number" });
  }
  const mode = b.mode === "prod" || b.mode === "production" ? "prod" : "test";
  const cfg = cashfreeConfig(mode);
  const id = newObjectId();
  const orderId = "1cal_" + id;
  const userId = b.user_id ? String(b.user_id) : null;
  const username = b.username ? String(b.username) : null;
  const phone = b.customer_phone ? String(b.customer_phone) : "9999999999";
  const email = b.customer_email ? String(b.customer_email) : null;
  const purpose = b.purpose ? String(b.purpose) : "Test payment";
  const currency = b.currency ? String(b.currency) : "INR";

  let sql;
  try {
    sql = getSql();
    await ensurePaymentsTable();
    // Log the attempt up front so it appears in the ledger regardless of outcome.
    await sql.unsafe(
      `INSERT INTO ${T.v3_payments}
         (id, order_id, user_id, username, customer_phone, customer_email, amount, currency, status, mode, purpose)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, orderId, userId, username, phone, email, amount, currency, "CREATED", cfg.mode, purpose],
    );

    if (!cfg.appId || !cfg.secret) {
      await sql.unsafe(
        `UPDATE ${T.v3_payments} SET status = $1, updated_at = NOW() WHERE id = $2`,
        ["CONFIG_MISSING", id],
      );
      return res.status(400).json({
        error:
          cfg.mode === "prod"
            ? "Live Cashfree keys not configured. Add CASHFREE_PROD_APP_ID and CASHFREE_PROD_SECRET to BE/.env (dashboard → Prod → Developers → API Keys) and restart the backend."
            : "Cashfree test keys not configured. Add CASHFREE_APP_ID and CASHFREE_SECRET to BE/.env (dashboard → Test → Developers → API Keys) and restart the backend.",
        order_id: orderId,
        mode: cfg.mode,
      });
    }

    const origin = req.headers.origin || process.env.FRONTEND_URL || "http://localhost:3000";
    // Cashfree PRODUCTION requires an https return_url (sandbox allows http). On
    // http origins (e.g. localhost) we omit it — the _modal checkout resolves in
    // JS and the client verifies via GET /status, so a return_url isn't required.
    const returnUrl = `${origin}/${cfg.mode === "prod" ? "prod-payments" : "testing-payments"}?order_id={order_id}`;
    const payload = {
      order_id: orderId,
      order_amount: amount,
      order_currency: currency,
      customer_details: {
        customer_id: userId || "guest_" + id.slice(0, 8),
        customer_phone: phone,
        ...(email ? { customer_email: email } : {}),
        ...(username ? { customer_name: username } : {}),
      },
      order_meta: {
        ...(returnUrl.startsWith("https://") ? { return_url: returnUrl } : {}),
        ...(process.env.CASHFREE_WEBHOOK_URL ? { notify_url: process.env.CASHFREE_WEBHOOK_URL } : {}),
      },
      order_note: purpose,
    };

    const r = await fetch(`${cfg.baseUrl}/orders`, {
      method: "POST",
      headers: {
        "x-api-version": cfg.apiVersion,
        "x-client-id": cfg.appId,
        "x-client-secret": cfg.secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      await sql.unsafe(
        `UPDATE ${T.v3_payments} SET status = $1, raw = $2::jsonb, updated_at = NOW() WHERE id = $3`,
        ["FAILED", JSON.stringify(data), id],
      );
      return res.status(502).json({
        error: data?.message || `Cashfree error (HTTP ${r.status})`,
        order_id: orderId,
        mode: cfg.mode,
        details: data,
      });
    }

    await sql.unsafe(
      `UPDATE ${T.v3_payments}
          SET cf_order_id = $1, payment_session_id = $2, status = $3, raw = $4::jsonb, updated_at = NOW()
        WHERE id = $5`,
      [data.cf_order_id || null, data.payment_session_id || null, data.order_status || "ACTIVE", JSON.stringify(data), id],
    );

    return res.status(201).json({
      order_id: orderId,
      cf_order_id: data.cf_order_id,
      payment_session_id: data.payment_session_id,
      order_status: data.order_status,
      mode: cfg.mode,
      cashfree_env: cfg.env,
      amount,
      currency,
    });
  } catch (e) {
    if (sql) {
      await sql
        .unsafe(`UPDATE ${T.v3_payments} SET status = $1, raw = $2::jsonb, updated_at = NOW() WHERE id = $3`, [
          "ERROR",
          JSON.stringify({ error: String(e.message || e) }),
          id,
        ])
        .catch(() => {});
    }
    return res.status(500).json({ error: String(e.message || e), order_id: orderId, mode: cfg.mode });
  }
}

// GET /v3/payments/status/:orderId — re-check with Cashfree, persist, return.
export async function getPaymentStatus(req, res) {
  const orderId = req.params.orderId;
  try {
    const sql = getSql();
    await ensurePaymentsTable();
    const [row] = await sql.unsafe(
      `SELECT id, order_id, status, mode FROM ${T.v3_payments} WHERE order_id = $1 LIMIT 1`,
      [orderId],
    );
    if (!row) return res.status(404).json({ error: "payment not found" });

    const cfg = cashfreeConfig(row.mode);
    if (!cfg.appId || !cfg.secret) {
      return res.json({ order_id: orderId, status: row.status, mode: row.mode });
    }

    const data = await fetchCashfreeOrder(orderId, cfg);
    if (!data) {
      return res.status(502).json({ error: "Cashfree order lookup failed", order_id: orderId });
    }
    const status = data.order_status || row.status;
    await sql.unsafe(
      `UPDATE ${T.v3_payments} SET status = $1, raw = $2::jsonb, updated_at = NOW() WHERE order_id = $3`,
      [status, JSON.stringify(data), orderId],
    );
    return res.json({ order_id: orderId, status, mode: row.mode, order_amount: data.order_amount });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e), order_id: orderId });
  }
}

// POST /v3/payments/webhook — Cashfree server-to-server notification.
// SECURITY: the request body is attacker-forgeable, so we defend twice:
//   (1) verify the Cashfree HMAC signature over the RAW body, and
//   (2) never trust the payload's status — re-fetch the authoritative status
//       from Cashfree with our own secret and persist THAT.
// Always return 200 so Cashfree stops retrying (even when we ignore the body).
export async function cashfreeWebhook(req, res) {
  try {
    // app.js mounts express.raw for this exact path, so req.body is a Buffer.
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body || {});
    const body = JSON.parse(raw || "{}");
    const orderId = body?.data?.order?.order_id || body?.data?.order_id;
    if (!orderId) return res.status(200).json({ ok: true });

    await ensurePaymentsTable();
    const sql = getSql();
    const [row] = await sql.unsafe(
      `SELECT order_id, mode FROM ${T.v3_payments} WHERE order_id = $1 LIMIT 1`,
      [orderId],
    );
    if (!row) return res.status(200).json({ ok: true, ignored: "unknown_order" });

    // Pick the key set for THIS order's environment (test vs prod).
    const cfg = cashfreeConfig(row.mode);

    // (1) Verify signature = base64(HMAC-SHA256(timestamp + rawBody, secret)).
    if (cfg.secret) {
      const sig = req.get("x-webhook-signature") || "";
      const ts = req.get("x-webhook-timestamp") || "";
      const expected = crypto.createHmac("sha256", cfg.secret).update(ts + raw).digest("base64");
      const ok =
        sig.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok) {
        console.warn("[cashfreeWebhook] rejected: bad signature");
        return res.status(200).json({ ok: true, ignored: "bad_signature" });
      }
    }

    // (2) Authoritative status from Cashfree — the body is only a trigger.
    if (cfg.appId && cfg.secret) {
      const auth = await fetchCashfreeOrder(orderId, cfg).catch(() => null);
      if (auth?.order_status) {
        await sql
          .unsafe(
            `UPDATE ${T.v3_payments} SET status = $1, raw = $2::jsonb, updated_at = NOW() WHERE order_id = $3`,
            [auth.order_status, JSON.stringify(auth), orderId],
          )
          .catch(() => {});
      }
    }
  } catch (e) {
    console.error("[cashfreeWebhook]", e.message);
  }
  res.status(200).json({ ok: true });
}
