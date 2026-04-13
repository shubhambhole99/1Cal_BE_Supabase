import { config } from "dotenv";
config({ override: true });
import { sql } from "drizzle-orm";
import express from "express";
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

const app = express();

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");
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

// Error handling
app.use((err, req, res, next) => {
  console.error("[ERROR]", new Date().toISOString(), req.method, req.originalUrl, err.message);
  res.status(err.status || 500).json({ error: err.message });
});

// Local server: DB check + listen (skipped on Vercel)
if (!process.env.VERCEL) {
  const PORT = 5000;
  try {
    await db.execute(sql`SELECT 1`);
    console.log("Supabase connection successful");
    await ensureTables();
  } catch (err) {
    console.error("Supabase connection failed:", err);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export default app;
