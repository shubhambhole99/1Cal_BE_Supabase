/**
 * Google Drive upload broker — never touches file bytes.
 *
 * The browser calls GET /gdrive/token and gets a short-lived access token tied
 * to a single fixed Google account (bztech68 — same account the CRM uses). The
 * browser then uploads bytes DIRECTLY to Drive's resumable endpoint, so files
 * land in OUR Drive regardless of who is logged in, and Vercel's body limit
 * never applies.
 *
 * Env (BE/.env):
 *   GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN
 *   GDRIVE_FOLDER_ID  (optional root folder id; sent to the FE)
 *   GDRIVE_PUBLIC     (optional "true" → FE marks each upload anyone-with-link)
 */
let cached = { token: null, expiresAt: 0 };
let refreshPromise = null;

async function refreshAccessToken() {
  const clientId = process.env.GDRIVE_CLIENT_ID;
  const clientSecret = process.env.GDRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GDRIVE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Drive broker not configured (GDRIVE_CLIENT_ID / SECRET / REFRESH_TOKEN missing)");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error || r.status}`);
  }
  cached = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000 };
  return cached.token;
}

async function getCachedAccessToken() {
  if (cached.token && cached.expiresAt > Date.now()) return cached.token;
  // Dedup concurrent refreshes so a burst of uploads doesn't fire N token calls.
  if (!refreshPromise) refreshPromise = refreshAccessToken().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function getDriveUploadToken(_req, res) {
  try {
    const token = await getCachedAccessToken();
    res.json({
      accessToken: token,
      expiresAt: cached.expiresAt,
      folderId: process.env.GDRIVE_FOLDER_ID || null,
      makePublic: String(process.env.GDRIVE_PUBLIC || "").toLowerCase() === "true",
    });
  } catch (err) {
    console.error("[gdrive] token error:", err.message);
    res.status(500).json({ error: "Failed to issue Drive token" });
  }
}
