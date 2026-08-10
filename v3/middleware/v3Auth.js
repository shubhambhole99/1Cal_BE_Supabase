/**
 * Identity for /v3.
 *
 * Background: /v3 was mounted with no auth at all, and requesterId() read the
 * caller's id out of the request body — i.e. every caller named itself. That is
 * fine for a tool nobody pays for, but it cannot carry a paywall: anyone could
 * POST someone else's user_id, or simply GET an instance anonymously and read
 * every page's formulas.
 *
 * Rolling that out in one step would break ~220 frontend call sites and the MCP
 * server at once, so identity arrives in two stages:
 *
 *   attachV3User  — always on. If an Authorization header is present and valid,
 *                   req.user is populated. Never rejects, so nothing that works
 *                   today stops working.
 *   requireV3Auth — put on the routes that must not be anonymous (entitlements,
 *                   payments, the paywalled reads/writes). Rejects with 401 when
 *                   V3_AUTH_STRICT is on and no verified user is present.
 *
 * Flip V3_AUTH_STRICT=true once the frontend is confirmed to be sending tokens;
 * until then requireV3Auth logs the anonymous hit instead of blocking it, so the
 * gap is visible in the logs before it becomes an outage.
 */

import jwt from "jsonwebtoken";

// The rest of the app signs with `process.env.JWT_SECRET || "your_secret_key"`
// (BE/controller/userController.js:10), so we must verify with the same secret
// or every existing session would be rejected. But that default is a literal
// string in the repository: while it is in use, ANYONE can mint a token for
// ANY user id — including one that grants themselves an unlimited plan. Set a
// real JWT_SECRET before this gates anything that costs money. Doing so logs
// every current user out once, which is why it is a deliberate, separate step.
const DEFAULT_SECRET = "your_secret_key";
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
export const USING_DEFAULT_SECRET = !process.env.JWT_SECRET;
export const V3_AUTH_STRICT = String(process.env.V3_AUTH_STRICT || "").toLowerCase() === "true";

if (USING_DEFAULT_SECRET) {
  console.warn(
    "[v3Auth] JWT_SECRET is not set — signing/verifying with the built-in default. " +
    "Tokens are forgeable; do not treat auth as a security boundary until this is set.",
  );
}
if (V3_AUTH_STRICT && USING_DEFAULT_SECRET) {
  // Strict mode is the switch that makes the paywall authoritative. Turning it
  // on while the secret is guessable would advertise a control that isn't one.
  throw new Error("[v3Auth] V3_AUTH_STRICT requires a real JWT_SECRET — refusing to start with the default secret.");
}

/** Verify the Authorization header if there is one. Never rejects. */
export function attachV3User(req, _res, next) {
  const raw = req.get("Authorization");
  if (raw) {
    // The rest of the app sends the bare token; tolerate "Bearer x" too.
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      // An expired/garbage token is treated as anonymous, not as an error —
      // the route decides whether anonymous is acceptable.
      req.v3AuthError = e.message;
    }
  }
  next();
}

/** The verified user id, or null. This is the ONLY trustworthy identity. */
export function verifiedUserId(req) {
  return req.user?.userId ?? req.user?.id ?? req.user?._id ?? null;
}

/** Guard for routes that must not be anonymous. */
export function requireV3Auth(req, res, next) {
  if (verifiedUserId(req)) return next();
  if (!V3_AUTH_STRICT) {
    console.warn(`[v3Auth] anonymous ${req.method} ${req.originalUrl}${req.v3AuthError ? ` (token rejected: ${req.v3AuthError})` : " (no token)"}`);
    return next();
  }
  res.status(401).json({ error: "Sign in required." });
}
