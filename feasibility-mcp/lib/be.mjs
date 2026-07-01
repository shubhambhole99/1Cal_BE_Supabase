/**
 * Thin HTTP client for the 1Cal v3 backend. Every write carries
 * `x-client-id: feasibility-mcp` so the FE's live event stream can tell which
 * edits came from the agent (it skips re-applying its own, but reacts to ours).
 */

const BE = (process.env.FEASIBILITY_BE_URL || "http://localhost:5000").replace(/\/+$/, "");
const CLIENT_ID = "feasibility-mcp";

export function backendUrl() {
  return BE;
}

async function call(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${BE}${path}`, opts);
  } catch (e) {
    throw new Error(
      `Cannot reach backend at ${BE} (${e.message}). Is the BE running on that host? ` +
        `Set FEASIBILITY_BE_URL to override.`,
    );
  }
  const text = await res.text();
  let data = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  // `/v3/active-context` returns a DOUBLE-encoded JSON string (a JSON string
  // stored inside jsonb). Peel one more layer when the parsed value is itself
  // a JSON-looking string.
  if (typeof data === "string") {
    const s = data.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        data = JSON.parse(s);
      } catch {
        /* leave as string */
      }
    }
  }
  if (!res.ok) {
    const detail = typeof data === "object" && data ? data.error || JSON.stringify(data) : data;
    const err = new Error(`Backend ${res.status} on ${path}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const jsonHeaders = { "Content-Type": "application/json", "x-client-id": CLIENT_ID };

export const beGet = (path) => call(path, { headers: { "x-client-id": CLIENT_ID } });

export const bePatch = (path, body) =>
  call(path, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) });

export const bePost = (path, body) =>
  call(path, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
