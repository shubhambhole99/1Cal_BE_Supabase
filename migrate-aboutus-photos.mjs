// Migrate Feasibility "About Us" team photos from the 1cal AWS S3 bucket → Google
// Drive (bztech68 account, reusing the CRM's GDRIVE creds), then repoint
// about_us.photo_url. Fully reversible: originals stay in S3 and an old→new
// backup JSON is written. Idempotent: only rows whose photo_url still points at
// 1cal.s3 are processed.
//
// Usage:  node migrate-aboutus-photos.mjs           (dry run — lists, no writes)
//         node migrate-aboutus-photos.mjs --run      (executes the migration)
import fs from "fs";
import postgres from "postgres";

const DRY = !process.argv.includes("--run");

const FEAS_ENV = "C:/Users/Shubham(Code)/Desktop/Github/11.Feasibility/From 19-03-2026/3.1.0 Feasibility/BE/.env";
const CRM_ENV  = "C:/Users/Shubham(Code)/Desktop/Github/28.SCRM/1.4 AIO CRM(22-06-2026)(Current Use)/sam-crm-be/.env";

function readEnv(path) {
  const out = {};
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

const feas = readEnv(FEAS_ENV);
const crm  = readEnv(CRM_ENV);
const SCHEMA = feas.DB_SCHEMA || "prod";
const T = `"${SCHEMA}"."about_us"`;

// ── Google Drive helpers (bztech68 account, from CRM creds) ──────────────
async function driveToken() {
  const body = new URLSearchParams({
    client_id: crm.GDRIVE_CLIENT_ID,
    client_secret: crm.GDRIVE_CLIENT_SECRET,
    refresh_token: crm.GDRIVE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("token refresh failed: " + JSON.stringify(d));
  return d.access_token;
}

async function findOrCreateFolder(token, parentId, name) {
  const parentClause = parentId ? ` and '${parentId}' in parents` : "";
  const q = `mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}'${parentClause} and trashed=false`;
  const fr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
    { headers: { Authorization: `Bearer ${token}` } });
  const fd = await fr.json();
  if (fd.files && fd.files[0]) return fd.files[0].id;
  const body = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) body.parents = [parentId];
  const cr = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const cd = await cr.json();
  if (!cd.id) throw new Error("folder create failed: " + JSON.stringify(cd));
  return cd.id;
}

async function uploadToDrive(token, folderId, name, bytes, mime, oldUrl) {
  const cr = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, parents: [folderId], appProperties: { migratedFrom: oldUrl.slice(0, 120) } }),
  });
  const cd = await cr.json();
  if (!cd.id) throw new Error("metadata create failed: " + JSON.stringify(cd));
  const fileId = cd.id;
  const up = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": mime }, body: bytes,
  });
  if (!up.ok) throw new Error("media upload failed: " + (await up.text()));
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  }).catch(() => {});
  return fileId;
}

function fileNameFor(name, url, mime) {
  let ext = (mime && mime.split("/")[1]) || "";
  if (!ext || ext.length > 5) { const seg = decodeURIComponent(url.split("/").pop().split("?")[0]); ext = (seg.split(".").pop() || "jpg"); }
  const safe = name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-");
  return `${safe || "member"}.${ext}`;
}

async function main() {
  const sql = postgres(feas.DATABASE_URL, { prepare: false, max: 1 });
  try {
    const rows = await sql.unsafe(
      `SELECT id, name, photo_url FROM ${T} WHERE photo_url ILIKE '%1cal.s3%' ORDER BY level, name`);
    console.log(`\nFound ${rows.length} About Us photos on 1cal S3:\n`);
    rows.forEach((r, i) => console.log(`  ${i + 1}. ${r.name}  ->  ${r.photo_url.slice(0, 90)}`));
    if (DRY) { console.log("\n[DRY RUN] no changes made. Re-run with --run to migrate."); await sql.end(); return; }

    console.log("\nGetting Drive token + folders…");
    const token = await driveToken();
    const rootId = await findOrCreateFolder(token, null, "1cal-s3");
    const folderId = await findOrCreateFolder(token, rootId, "aboutus");
    console.log(`Drive folder 1cal-s3/aboutus = ${folderId}\n`);

    const mapping = [];
    for (const r of rows) {
      try {
        const res = await fetch(r.photo_url);
        if (!res.ok) { console.log(`  ✗ ${r.name}: S3 fetch ${res.status} — SKIP`); continue; }
        const mime = res.headers.get("content-type") || "image/jpeg";
        const bytes = Buffer.from(await res.arrayBuffer());
        const fname = fileNameFor(r.name, r.photo_url, mime);
        const fileId = await uploadToDrive(token, folderId, fname, bytes, mime, r.photo_url);
        const driveUrl = `https://lh3.googleusercontent.com/d/${fileId}=w1600`;
        await sql.unsafe(`UPDATE ${T} SET photo_url = $1 WHERE id = $2`, [driveUrl, r.id]);
        mapping.push({ id: r.id, name: r.name, oldUrl: r.photo_url, fileId, newUrl: driveUrl, bytes: bytes.length });
        console.log(`  ✓ ${r.name}  (${(bytes.length / 1024).toFixed(0)} KB)  -> ${driveUrl}`);
      } catch (e) {
        console.log(`  ✗ ${r.name}: ${e.message}`);
      }
    }
    const backup = `aboutus-photo-migration-backup-${rows.length}.json`;
    fs.writeFileSync(backup, JSON.stringify(mapping, null, 2));
    console.log(`\nMigrated ${mapping.length}/${rows.length}. Backup (old→new) written to ${backup}`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
