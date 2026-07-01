#!/usr/bin/env node
/**
 * feasibility-mcp — an MCP server for editing 1Cal v3 feasibility templates
 * (formulas, values, formatting, master inputs) over the BE's /v3 API.
 *
 * The retemplate1 editor is already a live MCP *client*: "Set MCP Active"
 * heartbeats the open tab's context to POST /v3/active-context, and the editor
 * subscribes to GET /v3/events (SSE) so any write made here shows up in the UI
 * within a second — no reload. This server is the missing piece: it exposes
 * read/edit tools an agent (Claude) can call against that same backend.
 *
 * Transport: stdio. Configure the backend with FEASIBILITY_BE_URL
 * (default http://localhost:5000).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { backendUrl } from "./lib/be.mjs";
import * as fz from "./lib/feasibility.mjs";

const server = new McpServer({ name: "feasibility-mcp", version: "1.0.0" });

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true });
const tool = (name, description, shape, handler) =>
  server.tool(name, description, shape, async (args) => {
    try {
      return ok(await handler(args || {}));
    } catch (e) {
      return fail(e);
    }
  });

// Resolve ids from the live "active tab" context when the caller omits them.
async function resolvePageId(provided) {
  if (provided) return provided;
  const ctx = await fz.getActiveContext();
  if (!ctx?.pageId)
    throw new Error(
      "No page_id supplied and no active page in context. Open a page in the editor and click 'Set MCP Active' (Alt+M), or pass page_id explicitly.",
    );
  return ctx.pageId;
}
async function resolveTemplateId(provided) {
  if (provided) return provided;
  const ctx = await fz.getActiveContext();
  if (!ctx?.templateId)
    throw new Error(
      "No template_id supplied and no active template in context. Pass template_id, or click 'Set MCP Active' in the editor.",
    );
  return ctx.templateId;
}

// ── Context & navigation ────────────────────────────────────────────────────
tool(
  "get_active_context",
  "Return the template/version/page/selection the user currently has open and bound via 'Set MCP Active'. Call this first to discover templateId, versionId, pageId and the selected cell.",
  {},
  () => fz.getActiveContext(),
);

tool("list_templates", "List all feasibility templates (id, name, scheme, published version).", {}, () =>
  fz.listTemplates(),
);

tool(
  "list_pages",
  "List the pages (sheets) of a template with id, name, dimensions and hidden flag. Falls back to the active template if template_id is omitted.",
  { template_id: z.string().optional() },
  async ({ template_id }) => fz.listPages(await resolveTemplateId(template_id)),
);

// ── Reading cells ───────────────────────────────────────────────────────────
tool(
  "list_cells",
  "List cells on a page with their value, formula (f.expr) and resolved style. Filter with a1_matches (a regex on the A1 ref, e.g. '^D19$' or '^[A-C]'), only_formulas, or only_errors. Falls back to the active page if page_id is omitted.",
  {
    page_id: z.string().optional(),
    a1_matches: z.string().optional(),
    only_formulas: z.boolean().optional(),
    only_errors: z.boolean().optional(),
    limit: z.number().int().positive().max(1000).optional(),
  },
  async ({ page_id, a1_matches, only_formulas, only_errors, limit }) =>
    fz.listCells(await resolvePageId(page_id), {
      a1Matches: a1_matches,
      onlyFormulas: only_formulas,
      onlyErrors: only_errors,
      limit,
    }),
);

tool(
  "find_precedents",
  "For a formula cell, return the cells/ranges its formula references (across sheets) with each precedent's current value and formula. Use this to trace where a wrong number or #REF! comes from.",
  { page_id: z.string().optional(), a1: z.string() },
  async ({ page_id, a1 }) => fz.findPrecedents(await resolvePageId(page_id), a1),
);

tool(
  "get_summary",
  "Scan an entire template and report page count, total cells, formula cells, and the list of cells whose cached value is a spreadsheet error (#REF!, #DIV/0!, …). Falls back to the active template.",
  { template_id: z.string().optional() },
  async ({ template_id }) => fz.getSummary(await resolveTemplateId(template_id)),
);

// ── Writing formulas / values ───────────────────────────────────────────────
tool(
  "set_cells",
  "Set formulas and/or literal values on one or more cells (read-modify-write preserves each cell's existing style). Each edit: { a1, formula?, value?, clear? }. `formula` is stored as f.expr (a leading '=' is added if missing); `value` writes a literal and removes any formula; `clear` deletes the cell. Note: cached values recompute when the editor (with the page open) re-runs its engine.",
  {
    page_id: z.string().optional(),
    edits: z
      .array(
        z.object({
          a1: z.string(),
          formula: z.string().optional(),
          value: z.union([z.string(), z.number(), z.boolean()]).optional(),
          clear: z.boolean().optional(),
        }),
      )
      .min(1),
  },
  async ({ page_id, edits }) => fz.setCells(await resolvePageId(page_id), edits),
);

// ── Formatting ──────────────────────────────────────────────────────────────
const formatShape = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    color: z.string().optional(),
    backgroundColor: z.string().optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    fontFamily: z.string().optional(),
    fontSize: z.union([z.number(), z.string()]).optional(),
    numberFormat: z.enum(["number", "percent", "currency", "text"]).optional(),
    zeroAsDash: z.boolean().optional(),
    border: z
      .object({
        color: z.string().optional(),
        width: z.number().optional(),
        sides: z.array(z.enum(["all", "top", "bottom", "left", "right"])).optional(),
      })
      .optional(),
    noBorder: z.boolean().optional(),
  })
  .optional();

tool(
  "format_cells",
  "Apply formatting to cells/ranges. `targets` is a list of A1 refs or 'A1:B2' ranges. Provide a `format` object (bold/italic/underline/color/backgroundColor/textAlign/fontFamily/fontSize/numberFormat/zeroAsDash/border/noBorder) to set properties, OR `toggle` (e.g. ['bold']) to flip them. Merges with each cell's existing style. Falls back to the active page.",
  {
    page_id: z.string().optional(),
    targets: z.array(z.string()).min(1),
    format: formatShape,
    toggle: z.array(z.enum(["bold", "italic", "underline"])).optional(),
  },
  async ({ page_id, targets, format, toggle }) =>
    fz.formatCells(await resolvePageId(page_id), targets, {
      partial: format ? fz.translateFormat(format) : undefined,
      toggles: toggle,
    }),
);

tool(
  "clear_format",
  "Remove all formatting from the given cells/ranges (resets them to the default style). Falls back to the active page.",
  { page_id: z.string().optional(), targets: z.array(z.string()).min(1) },
  async ({ page_id, targets }) => fz.formatCells(await resolvePageId(page_id), targets, { clear: true }),
);

// ── Master inputs ───────────────────────────────────────────────────────────
tool(
  "list_master_inputs",
  "List a template's master inputs (key, ref, value, type, group). Falls back to the active template. Optional `version` to read a specific version's values.",
  { template_id: z.string().optional(), version: z.string().optional() },
  async ({ template_id, version }) => fz.listMasterInputs(await resolveTemplateId(template_id), version),
);

tool(
  "set_master_input",
  "Set the value of a single master input by its id (from list_master_inputs). The change broadcasts to the editor, which recomputes formulas that reference it.",
  { master_input_id: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) },
  ({ master_input_id, value }) => fz.setMasterInput(master_input_id, value),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP stdio channel and must stay clean.
  console.error(`feasibility-mcp ready · backend ${backendUrl()}`);
}

main().catch((e) => {
  console.error("feasibility-mcp failed to start:", e);
  process.exit(1);
});
