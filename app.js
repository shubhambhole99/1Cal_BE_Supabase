import { config } from "dotenv";
config({ override: true });
import { sql } from "drizzle-orm";
import express from "express";
import compression from "compression";
import { db } from "./db/index.js";
import { ensureTables } from "./db/ensureTables.js";

import userRoutes from "./routes/userRoutes.js";
import templateRoutes from "./routes/templateRoutes.js";
import directRoutes from "./routes/directRoutes.js";
import filetemplateRoutes from "./routes/filetemplateroutes.js";
import downloadlogsRoutes from "./routes/downloadlogsRoutes.js";
import versionRoutes from "./routes/versionRoutes.js";
import specialRoutes from "./routes/specialRoutes.js";
import contactRoutes from "./routes/contactRoutes.js";
import billRoutes from "./routes/billRoutes.js";
import aboutUsRoutes from "./routes/aboutUsRoutes.js";
import commentRoutes from "./routes/commentRoutes.js";
import gdriveRoutes from "./routes/gdriveRoutes.js";

// v3 module (merged from BE 2 — self-contained under ./v3/*)
import v3Routes from "./v3/routes/v3Routes.js";
import { attachV3User } from "./v3/middleware/v3Auth.js";
import { ensureTables as ensureV3Tables } from "./v3/db/ensureTables.js";

// ── Crash backstops ─────────────────────────────────────────────────────────
// A rejected promise in an async route handler that isn't caught would
// otherwise abort the entire process (Node terminates on an unhandled
// rejection). One bad request — e.g. a duplicate-key during a JSON restore —
// must NOT take the server down for everyone. Log it and keep serving;
// individual handlers still return proper 4xx/5xx where they can.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

const app = express();

// gzip/deflate responses. Instance/template payloads are large JSON (several MB
// of cells/styles) — compressing them shrinks the wire transfer ~10x, which is
// the dominant cost for clients on a real network. threshold:1KB skips tiny bodies.
app.use(compression({ threshold: 1024 }));

// Cashfree webhook signatures are computed over the RAW request body, so capture
// it as a Buffer for that one path BEFORE the global JSON parser consumes the
// stream. Every other route falls through to express.json below unchanged.
app.use("/v3/payments/webhook", express.raw({ type: "*/*", limit: "1mb" }));

// Body parsing with high limit for large template payloads (match BE).
// Note: On Vercel, request body is limited to 4.5MB; larger payloads need direct upload to storage.
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ limit: "500mb", extended: true }));

// CORS - allow same patterns as BE
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, X-Client-Id");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, X-Content-Range");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Health and root
app.get("/", (_req, res) => {
  res.status(200).json({ status: "ok", message: "Server is running" });
});

app.get("/health", async (_req, res) => {
  try {
    await db.execute(sql`SELECT 1`);
    res.json({ ok: true, database: "connected" });
  } catch (err) {
    console.error("Health check failed:", err);
    res.status(503).json({ ok: false, database: "disconnected", error: String(err) });
  }
});

// Mount routes (same prefixes as BE)
app.use("/user", userRoutes);
app.use("/template", templateRoutes);
app.use("/filetemplate", filetemplateRoutes);
app.use("/direct", directRoutes);
app.use("/downloadlogs", downloadlogsRoutes);
app.use("/version", versionRoutes);
app.use("/special", specialRoutes);
app.use("/contact", contactRoutes);
app.use("/bill", billRoutes);
app.use("/aboutus", aboutUsRoutes);
app.use("/comments", commentRoutes);
app.use("/gdrive", gdriveRoutes);
// Identity for /v3: verify the token when one is sent, so req.user is available
// to every v3 handler. Deliberately non-rejecting — routes that must not be
// anonymous use requireV3Auth. See BE/v3/middleware/v3Auth.js.
app.use("/v3", attachV3User, v3Routes);

// Error handling
app.use((err, req, res, next) => {
  console.error("[ERROR]", new Date().toISOString(), req.method, req.originalUrl, err.message);
  res.status(err.status || 500).json({ error: err.message });
});

// Local server (skipped on Vercel, which runs the app serverless).
// ENSURE_TABLES="true" in .env -> create/sync DB tables on startup (else skip).
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;

  // 1) Verify DB connectivity first — bail out if we can't reach the DB.
  try {
    await db.execute(sql`SELECT 1`);
    console.log("Supabase connection successful");
  } catch (err) {
    console.error("Supabase connection failed:", err);
    process.exit(1);
  }

  // 2) Optionally create/sync tables. Skipped unless ENSURE_TABLES="true".
  //    Skipping is faster and avoids touching the schema (e.g. the v3
  //    foreign-key error) when the tables already exist.
  if (String(process.env.ENSURE_TABLES).toLowerCase() === "true") {
    await ensureTables();
    console.log("legacy tables ensured");
    // v3 tables live in the schema defined by DB_SCHEMA. Failing to create
    // them shouldn't take the legacy BE down, so we log and continue.
    try {
      await ensureV3Tables();
      console.log("v3 tables ensured");
    } catch (e) {
      console.error("[ensureV3Tables] failed:", e.message);
    }
  } else {
    console.log("Skipping table creation (set ENSURE_TABLES=true to enable)");
  }

  // 3) Start the server.
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export default app;
