// Tiny in-memory SSE pub/sub. Used so the retemplate1 FE can react live to
// edits made by other clients — most notably the feasibility-mcp server —
// without a manual reload. Clients connect via GET /v3/events?templateId=…
// and receive `data: {json}\n\n` frames whenever the BE mutates anything
// scoped to that template.

const clients = new Set();

export function addClient(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(": connected\n\n");

  const client = {
    res,
    templateId: typeof req.query?.templateId === "string" ? req.query.templateId : null,
  };
  clients.add(client);

  // Heartbeat every 25s — keeps proxies / Chrome from killing idle streams.
  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(client);
    try { res.end(); } catch {}
  });
}

export function broadcast(evt) {
  if (!evt || typeof evt !== "object") return;
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const c of clients) {
    if (c.templateId && evt.templateId && c.templateId !== evt.templateId) continue;
    try { c.res.write(payload); } catch {}
  }
}
