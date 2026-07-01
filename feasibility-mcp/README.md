# feasibility-mcp

An MCP server for editing **1Cal v3 feasibility templates** — formulas, values,
cell formatting, and master inputs — by an agent (Claude), driving the same
`/v3` backend the `retemplate1` editor uses.

## How it fits together

```
 Claude (agent)  ──stdio──►  feasibility-mcp  ──HTTP /v3──►  1Cal BE (:5000)
                                                                 │ broadcasts SSE
 retemplate1 editor  ◄───────────  GET /v3/events  ◄────────────┘
        │
        └─ "Set MCP Active" (Alt+M) → POST /v3/active-context (the tab you're on)
```

- The editor publishes **which template/version/page/cell you're on** to
  `POST /v3/active-context`. This server reads it, so you can say "make the
  selected cell bold" without copying ids.
- Every write here goes through the BE, which **broadcasts an event**; the open
  editor refetches and updates live (no reload).

## Setup

```bash
cd 1Cal_BE_Supabase/feasibility-mcp
npm install
```

It's already registered for this project in `../../.mcp.json`. **Restart Claude
Code** in the project root and approve the `feasibility-mcp` server; the tools
appear as `mcp__feasibility-mcp__*`.

Backend URL defaults to `http://localhost:5000` — override with
`FEASIBILITY_BE_URL`.

## Tools

| Tool | What it does |
|---|---|
| `get_active_context` | Template/version/page/selection currently bound via "Set MCP Active". Call this first. |
| `list_templates` | All feasibility templates. |
| `list_pages` | Pages (sheets) of a template. |
| `list_cells` | Cells with value + formula + style; filter by `a1_matches` regex, `only_formulas`, `only_errors`. |
| `find_precedents` | The cells/ranges a formula references (cross-sheet) with their values. |
| `get_summary` | Whole-template scan: counts + every error cell (`#REF!`, `#DIV/0!`, …). |
| `set_cells` | Write formulas / literal values / clear cells. Preserves existing style. |
| `format_cells` | Bold, italic, underline, color, background, align, font, size, number format, borders — by `format` object or `toggle`. Ranges (`A1:B2`) supported. |
| `clear_format` | Reset cells to the default style. |
| `list_master_inputs` | A template's master inputs (key, ref, value, type, group). |
| `set_master_input` | Set one master input's value (the editor recomputes dependents). |

`page_id` / `template_id` are optional on most tools — they fall back to the
**active context** when omitted.

## Notes & guardrails

- **Read-modify-write.** `PATCH /v3/pages/:id` shallow-merges the `cells` jsonb,
  so writing a partial cell would drop its other fields. Every write tool reads
  the page first and reattaches `v`/`f`/`s`. (Mirrors the editor's own logic.)
- **Formulas** live in `cell.f.expr` (a leading `=` is added if missing). The
  BE stores a **cached** value; it recomputes when the editor (with the page
  open) runs its formula engine. Keep the tab open + "MCP Active" for live values.
- **Published versions are read-only** (`403`). Edit a draft version — the
  editor's banner offers "Create editable copy"; it auto-promotes on Publish.
- **Styles** are content-deduped into `page.styles[sNN]`; this server reuses the
  editor's exact id-allocation so writes round-trip cleanly.

## Example (agent workflow)

```
1. get_active_context                      → templateId / pageId / selected cell
2. list_cells a1_matches="^D19$"           → see D19's formula + value
3. find_precedents a1="D19"                → trace where its inputs come from
4. set_cells edits=[{a1:"D19", formula:"='Area_30A'!K12*0.5"}]
5. format_cells targets=["D19"] format={bold:true, numberFormat:"currency"}
6. get_summary                             → confirm totalErrors dropped
```
