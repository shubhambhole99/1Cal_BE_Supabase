# Agent Workflow Builder - Implementation Plan

## Overview

A drag-and-drop, node-based workflow builder (using React Flow) integrated into the admin Template V5 page. This system lets admins visually design AI agent workflows per template — defining agent types, context/summaries, and follow-up question sequences. The configured workflow context automatically flows into DirectFeasibilityV7's chat bar, giving the AI structured guidance on how to assist users.

---

## 1. Core Concept

```
┌─────────────────────────────────────────────────────────────┐
│  ADMIN (Template V5)                                        │
│                                                             │
│  [Dashboards] [Agent Workflow] <── new tab                  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  React Flow Canvas                                   │    │
│  │                                                      │    │
│  │   ┌──────────────┐                                   │    │
│  │   │ Orchestrator  │ (Start Node)                     │    │
│  │   │  Agent        │                                  │    │
│  │   └──────┬───────┘                                   │    │
│  │          │                                           │    │
│  │    ┌─────┼──────┐                                    │    │
│  │    ▼     ▼      ▼                                    │    │
│  │  ┌────┐┌────┐┌──────┐┌──────┐                         │    │
│  │  │Sum ││Mas ││Follow││ Info │                         │    │
│  │  │mary││ter ││Up Q  ││Agent │                         │    │
│  │  │    ││Inp ││      ││      │                         │    │
│  │  └────┘└────┘└──────┘└──────┘                         │    │
│  │                                                      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
          │
          │  Saved to DB (template.agentWorkflow)
          ▼
┌─────────────────────────────────────────────────────────────┐
│  USER (DirectFeasibilityV7 - /direct7/[id])                 │
│                                                             │
│  Chat bar reads agentWorkflow from template                 │
│  → Injects node summaries into system prompt                │
│  → Follow-up agents guide user step-by-step                 │
│  → Orchestrator routes to correct specialist                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Agent Node Types

### 2.1 Orchestrator (Start Node)
- **Purpose**: Entry point. Routes user queries to the correct specialist agent.
- **Config Fields**:
  - `name`: "Orchestrator" (default)
  - `systemPrompt`: High-level instructions for routing
  - `description`: What this feasibility template is about
- **Behavior**: Reads connected child nodes and their summaries to decide which agent handles each user query.
- **There is only ONE orchestrator per workflow.**

### 2.2 Summary Agent
- **Purpose**: Provides summaries/overviews of pages, sections, or the entire feasibility.
- **Config Fields**:
  - `name`: e.g., "Costing Summary Agent"
  - `summary`: What this agent summarizes (e.g., "Summarizes the Costing page including total construction cost, per-unit cost, and cost breakdowns")
  - `targetPages`: Array of page names this agent has access to
  - `outputFormat`: How to present the summary (bullet points, paragraph, table)
- **Behavior**: When orchestrator routes a summary-type query, this agent fetches relevant page data and presents it.

### 2.3 Master Input Agent
- **Purpose**: Handles reading and updating master inputs.
- **Config Fields**:
  - `name`: e.g., "Land Input Agent"
  - `summary`: What inputs this agent manages (e.g., "Handles all land-related inputs: plot area, FSI, road width, setbacks")
  - `targetInputs`: Array of master input names/IDs this agent can modify
  - `validationRules`: Optional constraints (e.g., "Plot area must be > 0", "FSI between 1.0 and 5.0")
  - `inputGrouping`: Which section/group of master inputs
- **Behavior**: Reads/updates specific master inputs. Can validate before applying.

### 2.4 Info Agent
- **Purpose**: The "knowledge base" agent — it understands what the entire calculation is about, its purpose, how the pages relate to each other, what the output means, and can explain any part of the feasibility to the user without modifying anything.
- **Config Fields**:
  - `name`: e.g., "Feasibility Explainer"
  - `summary`: High-level description of the calculation (e.g., "This is a 20B Residential Feasibility for Maharashtra DCPR 2034. It calculates land cost, construction cost, revenue from sale of flats, and project profitability.")
  - `calculationPurpose`: What this feasibility is designed to answer (e.g., "Whether a residential project on a given plot is financially viable under DCPR 2034 regulations")
  - `pageDescriptions`: Object mapping each page name to a human-readable description:
    ```json
    {
      "Area Statement": "Calculates total buildable area based on plot area, FSI, TDR, and fungible FSI. Output: net saleable area.",
      "Costing": "Breaks down all project costs — land, construction, premiums, statutory charges, interest, and overheads.",
      "Revenue": "Projects revenue from sale of residential units, parking, and other components at given sale rates.",
      "Profitability": "Compares total cost vs total revenue. Shows profit, margin %, IRR, and payback period."
    }
    ```
  - `glossary`: Optional key terms and definitions specific to this calculation:
    ```json
    {
      "FSI": "Floor Space Index — ratio of total built-up area to plot area",
      "TDR": "Transfer of Development Rights — additional buildable area purchased from the market",
      "Ready Reckoner": "Government-published land valuation rates used for stamp duty calculation",
      "Fungible FSI": "Additional 35% FSI available by paying a premium to the government"
    }
    ```
  - `howToUse`: Instructions for end users on how to use this feasibility (e.g., "Start by filling land details, then check the Area Statement, then review Costing and Revenue. The Profitability page gives you the final answer.")
  - `allowedTools`: Read-only tools only — `fetchPageData`, `fetchCells`, `summarizePage`, `fetchMasterInputs` (NO update tools)
- **Behavior**:
  - Never modifies any data — purely informational
  - Can explain what any page does, what a cell formula means, why a number is what it is
  - Can answer "what is this feasibility about?", "how do I read the costing page?", "what does FSI mean?"
  - Acts as a contextual help system / onboarding guide for the calculation itself
- **Why this is a built-in type**: Every feasibility template needs an agent that knows what the calculation *is*. Without this, the AI can read numbers but can't explain their meaning or context. This is the difference between "Cell B5 = 45000" and "The Ready Reckoner rate is Rs. 45,000/sq.mt, which is the government-published land valuation used for stamp duty and premium calculations in your zone."

### 2.5 Custom Agent (One-Off)
- **Purpose**: A blank agent where the admin defines everything from scratch — name, role, tools, system prompt. For unique, template-specific needs that don't fit the predefined types.
- **Config Fields**:
  - `name`: e.g., "TDR Calculation Helper"
  - `summary`: What this agent does (free-text, detailed)
  - `systemPrompt`: Full custom system prompt for this agent
  - `allowedTools`: Checkboxes for which tools this agent can use:
    - `fetchMasterInputs` — read master inputs
    - `fetchPageData` — read page/cell data
    - `updateMasterInput` — modify a single input
    - `updateMasterInputs` — modify multiple inputs
    - `summarizePage` — get page summary
    - `fetchCells` — get specific cell values
  - `targetPages`: Optional — restrict to specific pages
  - `targetInputs`: Optional — restrict to specific master inputs
  - `triggerPhrase`: Optional — when to activate this agent
  - `customInstructions`: Any additional behavioral instructions (e.g., "Always show calculations step-by-step", "Never change inputs without confirming first")
- **Behavior**: Fully defined by the admin. The orchestrator uses the `summary` to decide when to route to this agent, and the `systemPrompt` + `customInstructions` drive its behavior.
- **Use Cases**:
  - A "TDR Advisor" that only reads FSI-related pages and advises on TDR purchases
  - A "Cost Optimizer" that analyzes costing pages and suggests input changes
  - A "Compliance Checker" that verifies inputs against regulatory rules
  - Any domain-specific agent the admin dreams up

### 2.6 Follow-Up Question Agent (Key Feature)
- **Purpose**: Guides users through a structured, step-by-step input flow.
- **Config Fields**:
  - `name`: e.g., "20B Feasibility Setup Guide"
  - `summary`: What this guided flow achieves
  - `triggerPhrase`: What activates this agent (e.g., "help me make a 20B feasibility", "guide me", "setup")
  - `steps`: Ordered array of step objects:
    ```json
    [
      {
        "stepNumber": 1,
        "question": "Let's start with the Gross Plot Area. What is the total plot area in sq.mt?",
        "targetInput": "grossPlotArea",
        "inputType": "number",
        "hint": "You can find this in the 7/12 extract or property card",
        "validation": "Must be greater than 0",
        "followUp": "Got it! Plot area set to {value} sq.mt."
      },
      {
        "stepNumber": 2,
        "question": "What is the road width adjacent to the plot (in meters)?",
        "targetInput": "roadWidth",
        "inputType": "number",
        "hint": "This determines the FSI multiplier. Common values: 9m, 12m, 18m, 24m, 30m",
        "validation": "Must be between 6 and 60",
        "followUp": "Road width set to {value}m. This gives you a base FSI of {calculatedFSI}."
      },
      {
        "stepNumber": 3,
        "question": "What is the Ready Reckoner rate (per sq.mt)?",
        "targetInput": "readyReckonerRate",
        "inputType": "number",
        "hint": "Check the annual statement of rates (ASR) for your zone",
        "validation": "Must be greater than 0",
        "followUp": "Ready reckoner rate set to Rs. {value}/sq.mt."
      }
    ]
    ```
  - `completionMessage`: What to say when all steps are done (e.g., "All basic inputs are set! Your feasibility is ready for review. Would you like me to summarize the results?")
- **Behavior**:
  1. AI greets user: "How can I help you make a 20B feasibility?"
  2. Walks through steps one-by-one
  3. After each answer, updates the master input and confirms
  4. Tracks which steps are completed
  5. Can skip steps if user says "skip" or "later"
  6. At the end, offers to summarize or move to next agent

### 2.7 Saving Custom Agents as Reusable Types

Admins can save any custom agent as a **reusable agent type** that appears in the Tool Palette alongside the built-in types. This allows creating a library of domain-specific agents that can be dragged onto any workflow.

#### How It Works

1. **Create a custom agent** on the canvas (type: `custom`)
2. Configure it fully (name, summary, system prompt, tools, etc.)
3. Click **"Save as Reusable Type"** button in the Node Config Panel
4. Provide:
   - `typeName`: e.g., "TDR Advisor"
   - `typeDescription`: Short description for the palette
   - `typeColor`: Color for the node on canvas (hex)
   - `typeIcon`: Icon identifier (optional)
   - `isGlobal`: Whether this type is available across all templates or just the current one
5. The saved type now appears in the **Tool Palette** under a "Custom Types" section

#### Tool Palette Layout (Updated)

```
┌──────────────┐
│  BUILT-IN    │
│  ─────────── │
│  [+] Orchest │
│  [+] Summary │
│  [+] Master  │
│  [+] Info    │
│  [+] FollowUp│
│  [+] Custom  │
│              │
│  SAVED TYPES │
│  ─────────── │
│  [+] TDR Adv │  ← saved from a previous custom agent
│  [+] Cost Op │  ← saved from a previous custom agent
│  [+] Complia │
│              │
│  [Create New │
│   Type... ]  │  ← opens a modal to define a new type from scratch
└──────────────┘
```

#### Creating a New Type from Scratch (Without Canvas First)

The **"Create New Type..."** button at the bottom of the palette opens a modal where admins can define a reusable type directly:

```
┌─────────────────────────────────────────────────┐
│  Create New Agent Type                          │
│                                                 │
│  Type Name:    [______________________]         │
│  Description:  [______________________]         │
│  Color:        [#4A90D9  ■]                     │
│  Icon:         [🔍 ▼]                           │
│                                                 │
│  Default System Prompt:                         │
│  [                                      ]       │
│  [  (pre-filled template for this type) ]       │
│  [                                      ]       │
│                                                 │
│  Default Allowed Tools:                         │
│  ☑ fetchMasterInputs   ☑ fetchPageData          │
│  ☐ updateMasterInput   ☐ updateMasterInputs     │
│  ☑ summarizePage       ☑ fetchCells             │
│                                                 │
│  Default Config Fields:                         │
│  [+ Add Field]  (key-value pairs that instances │
│                  of this type will have)         │
│                                                 │
│  Availability:                                  │
│  ○ This template only                           │
│  ● All templates (global)                       │
│                                                 │
│  [Cancel]                    [Save Agent Type]  │
└─────────────────────────────────────────────────┘
```

When dragged onto a canvas, instances of saved types inherit all defaults but can be **overridden per-node**. The type acts as a template — each instance on the canvas is independent and editable.

#### Saved Type vs Instance

```
Saved Type (in DB)              Instance (on canvas)
──────────────────              ────────────────────
typeName: "TDR Advisor"         id: "node-5"
defaultSystemPrompt: "..."      type: "savedType:tdr-advisor-001"
defaultTools: [fetch, summary]  data.name: "TDR Advisor (Plot A)"
defaultConfig: {...}            data.systemPrompt: "..." (overridden)
                                data.tools: [fetch, summary, update] (added one)
                                data.targetPages: ["FSI", "TDR"]
```

---

## 3. Database Schema Changes

### 3.1 New Table: `agent_workflows` (BE/schema/agentWorkflows.js)

```javascript
const agentWorkflows = pgTable("agent_workflows", {
  id: varchar("id", { length: 24 }).primaryKey(),
  templateId: varchar("template_id", { length: 24 }).notNull(),

  // React Flow serialized state
  nodes: jsonb("nodes").default([]),       // Array of node objects
  edges: jsonb("edges").default([]),       // Array of edge connections

  // Metadata
  name: varchar("name", { length: 255 }).default("Default Workflow"),
  isActive: boolean("is_active").default(true),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
```

### 3.2 New Table: `custom_agent_types` (BE/schema/customAgentTypes.js)

```javascript
const customAgentTypes = pgTable("custom_agent_types", {
  id: varchar("id", { length: 24 }).primaryKey(),

  // Who created it and scope
  createdBy: varchar("created_by", { length: 24 }),       // user ID
  templateId: varchar("template_id", { length: 24 }),     // null if global
  isGlobal: boolean("is_global").default(false),

  // Type definition
  typeName: varchar("type_name", { length: 255 }).notNull(),
  typeDescription: text("type_description"),
  typeColor: varchar("type_color", { length: 7 }).default("#6B7280"),  // hex
  typeIcon: varchar("type_icon", { length: 50 }),

  // Defaults for instances
  defaultSystemPrompt: text("default_system_prompt"),
  defaultAllowedTools: jsonb("default_allowed_tools").default([]),
  defaultConfig: jsonb("default_config").default({}),       // default field values

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
```

### 3.3 Node Object Shape (stored in `nodes` JSONB)

```javascript
{
  // React Flow fields
  id: "node-1",
  type: "orchestrator" | "summary" | "masterInput" | "info" | "followUpQuestion" | "custom" | "savedType:<typeId>",
  position: { x: 250, y: 0 },

  // Custom data
  data: {
    name: "Orchestrator",
    summary: "Routes queries for 20B Residential Feasibility",

    // Type-specific fields (built-in types)
    targetPages: ["Costing", "Revenue"],           // summary type
    targetInputs: ["plotArea", "fsi", "roadWidth"], // masterInput type
    steps: [...],                                   // followUpQuestion type
    triggerPhrase: "guide me",                      // followUpQuestion type
    validationRules: [...],                         // masterInput type
    outputFormat: "bullets",                        // summary type
    completionMessage: "All done!...",              // followUpQuestion type
    calculationPurpose: "Whether a project is...", // info type
    pageDescriptions: { "Costing": "Breaks..." },  // info type
    glossary: { "FSI": "Floor Space Index..." },   // info type
    howToUse: "Start by filling land details...",   // info type

    // Custom / savedType fields
    systemPrompt: "You are a TDR advisor...",      // custom & savedType
    allowedTools: ["fetchPageData", "summarize"],   // custom & savedType
    customInstructions: "Always show calculations", // custom & savedType
    savedTypeId: "tdr-advisor-001",                 // savedType only (reference)
  }
}
```

### 3.3 Edge Object Shape (stored in `edges` JSONB)

```javascript
{
  id: "edge-1",
  source: "node-orchestrator",
  target: "node-summary-1",
  label: "summary queries",    // Optional label describing the routing condition
}
```

---

## 4. Backend Changes

### 4.1 New Schema File: `BE/schema/agentWorkflows.js`
- Define the `agent_workflows` table as above.

### 4.2 New Controller: `BE/controller/agentWorkflowController.js`

| Method | Route | Purpose |
|--------|-------|---------|
| `getWorkflowByTemplateId` | `GET /agent-workflow/:templateId` | Fetch workflow for a template |
| `saveWorkflow` | `PUT /agent-workflow/:templateId` | Save/update workflow nodes & edges |
| `deleteWorkflow` | `DELETE /agent-workflow/:id` | Delete a workflow |
| `generateWorkflow` | `POST /agent-workflow/generate/:templateId` | AI-analyze template and auto-generate workflow |
| `resetToSimple` | `POST /agent-workflow/reset/:templateId` | Replace workflow with default 5-node layout |

### 4.3 New Controller: `BE/controller/customAgentTypeController.js`

| Method | Route | Purpose |
|--------|-------|---------|
| `getTypesByTemplate` | `GET /agent-type/template/:templateId` | Fetch types available for a template (template-specific + global) |
| `getAllGlobalTypes` | `GET /agent-type/global` | Fetch all global reusable types |
| `createType` | `POST /agent-type` | Create a new reusable agent type |
| `updateType` | `PUT /agent-type/:id` | Update type defaults |
| `deleteType` | `DELETE /agent-type/:id` | Delete a reusable type |
| `saveNodeAsType` | `POST /agent-type/from-node` | Convert an existing canvas node into a saved type |

### 4.4 New Route Files

**`BE/routes/agentWorkflowRoutes.js`**:
```javascript
router.get("/:templateId", agentWorkflowController.getWorkflowByTemplateId);
router.put("/:templateId", agentWorkflowController.saveWorkflow);
router.delete("/:id", agentWorkflowController.deleteWorkflow);
router.post("/generate/:templateId", agentWorkflowController.generateWorkflow);
router.post("/reset/:templateId", agentWorkflowController.resetToSimple);
```

**`BE/routes/customAgentTypeRoutes.js`**:
```javascript
router.get("/template/:templateId", customAgentTypeController.getTypesByTemplate);
router.get("/global", customAgentTypeController.getAllGlobalTypes);
router.post("/", customAgentTypeController.createType);
router.post("/from-node", customAgentTypeController.saveNodeAsType);
router.put("/:id", customAgentTypeController.updateType);
router.delete("/:id", customAgentTypeController.deleteType);
```

### 4.5 Mount in `BE/app.js`

```javascript
const agentWorkflowRoutes = require("./routes/agentWorkflowRoutes");
const customAgentTypeRoutes = require("./routes/customAgentTypeRoutes");
app.use("/agent-workflow", agentWorkflowRoutes);
app.use("/agent-type", customAgentTypeRoutes);
```

### 4.5 Modify `directController.getFormulaTemplateById`
- After fetching the template, also fetch the `agent_workflow` for that templateId.
- Include `agentWorkflow: { nodes, edges }` in the response JSON.
- This way DirectV7 automatically receives the workflow context.

---

## 5. Frontend Changes

### 5.1 New Tab in Admin Template V5

**File**: `FE/pages/admin/feasibilitytestv5/FeasibilityTestV5.jsx`

Add a new tab next to "Dashboards":

```
[Template] [Pages] [Master Inputs] [Dashboards] [Agent Workflow]  <── NEW
```

When "Agent Workflow" tab is selected, render the `<AgentWorkflowBuilder />` component.

### 5.2 New Component: `FE/components/AgentWorkflowBuilder/`

```
components/AgentWorkflowBuilder/
├── AgentWorkflowBuilder.jsx        # Main React Flow canvas
├── nodes/
│   ├── OrchestratorNode.jsx        # Start node (purple)
│   ├── SummaryNode.jsx             # Summary agent (blue)
│   ├── MasterInputNode.jsx         # Master input agent (green)
│   ├── InfoNode.jsx                # Info/knowledge agent (teal)
│   ├── FollowUpQuestionNode.jsx    # Follow-up question agent (orange)
│   ├── CustomNode.jsx              # Blank custom agent (gray, fully configurable)
│   └── SavedTypeNode.jsx           # Instance of a saved reusable type (type's color)
├── panels/
│   ├── NodeConfigPanel.jsx         # Right-side panel for editing selected node
│   ├── CustomAgentPanel.jsx        # Config panel for custom/savedType nodes
│   ├── StepEditor.jsx              # Editor for follow-up question steps
│   ├── ToolPalette.jsx             # Left-side drag source for node types
│   └── CreateTypeModal.jsx         # Modal to create a new reusable type from scratch
├── hooks/
│   ├── useAgentWorkflow.js         # Fetch/save workflow API calls
│   └── useCustomAgentTypes.js      # Fetch/create/delete reusable agent types
└── utils/
    └── workflowToContext.js         # Convert workflow to system prompt text
```

### 5.3 AgentWorkflowBuilder.jsx — Main Canvas

```
┌──────────┬─────────────────────────────────┬──────────────────┐
│          │                                 │                  │
│  Tool    │     React Flow Canvas           │   Node Config    │
│  Palette │                                 │   Panel          │
│          │     (drag & drop nodes,         │                  │
│  --------│      connect with edges)        │   (edit selected │
│  [+] Orc │                                 │    node's name,  │
│  [+] Sum │                                 │    summary,      │
│  [+] Mas │                                 │    steps, etc.)  │
│  [+] Fol │                                 │                  │
│          │                                 │                  │
│          │                                 │                  │
├──────────┴─────────────────────────────────┴──────────────────┤
│  [Save Workflow]                    [Preview Context Output]  │
└───────────────────────────────────────────────────────────────┘
```

**Key Features**:
- Drag nodes from palette onto canvas
- Connect nodes with edges (orchestrator → specialists)
- Click a node to open config panel on the right
- Save persists to DB via `PUT /agent-workflow/:templateId`
- "Preview Context Output" shows the generated system prompt text

### 5.4 Node Config Panel (Right Side)

When a node is selected, show editable fields based on type:

**Orchestrator Node**:
- Name (text)
- Description / System Prompt (textarea)

**Summary Node**:
- Name (text)
- Summary — what this agent does (textarea)
- Target Pages — multi-select from template's pages
- Output Format — dropdown (bullets, paragraph, table)

**Master Input Node**:
- Name (text)
- Summary (textarea)
- Target Inputs — multi-select from template's master inputs
- Validation Rules — key-value editor

**Info Agent Node**:
- Name (text)
- Summary (textarea)
- Calculation Purpose — what this feasibility answers (textarea)
- Page Descriptions — key-value editor (page name → description)
- Glossary — key-value editor (term → definition)
- How To Use — instructions for end users (textarea)
- Note: Read-only tools only (no update tools available)

**Follow-Up Question Node**:
- Name (text)
- Summary (textarea)
- Trigger Phrase (text)
- Steps — ordered list editor (StepEditor component):
  - Each step: question, targetInput (dropdown from master inputs), hint, validation, followUp message
  - Drag to reorder steps
  - Add/remove steps
- Completion Message (textarea)

**Custom Agent Node** (blank slate):
- Name (text)
- Summary — what this agent does (textarea)
- System Prompt — full custom instructions for the AI (textarea, large)
- Allowed Tools — checkboxes:
  - ☐ fetchMasterInputs
  - ☐ fetchPageData
  - ☐ fetchCells
  - ☐ summarizePage
  - ☐ updateMasterInput
  - ☐ updateMasterInputs
- Target Pages — optional multi-select (restrict scope)
- Target Inputs — optional multi-select (restrict scope)
- Trigger Phrase — optional (text)
- Custom Instructions — additional behavioral rules (textarea)
- **[Save as Reusable Type]** button — saves this config as a reusable type

**Saved Type Node** (instance of a reusable type):
- Shows inherited defaults from the saved type (grayed out)
- All fields are overridable — editing a field makes it bold to indicate override
- **[Reset to Type Defaults]** button — reverts all overrides
- **[Edit Base Type]** button — opens the type definition (affects all future instances)

### 5.5 StepEditor Component (for Follow-Up Question nodes)

```
┌─────────────────────────────────────────────────┐
│ Step 1                                    [x]   │
│ Question: [What is the gross plot area?      ]  │
│ Target Input: [grossPlotArea ▼]                 │
│ Hint: [Find this in the 7/12 extract         ]  │
│ Validation: [Must be > 0                     ]  │
│ After Answer: [Plot area set to {value} sq.mt]  │
├─────────────────────────────────────────────────┤
│ Step 2                                    [x]   │
│ Question: [What is the road width?           ]  │
│ Target Input: [roadWidth ▼]                     │
│ ...                                             │
├─────────────────────────────────────────────────┤
│ [+ Add Step]                                    │
└─────────────────────────────────────────────────┘
```

---

## 6. Context Injection into DirectV7 Chat

### 6.1 How Workflow Context Reaches the Chat

```
Admin saves workflow
    ↓
DB: agent_workflows table
    ↓
User opens /direct7/[id]
    ↓
GET /direct/:id returns { ...data, agentWorkflow: { nodes, edges } }
    ↓
DirectFeasibilityV7 stores agentWorkflow in state
    ↓
Chat bar sends agentWorkflow as part of context to API route
    ↓
FE API route (chat/route.js or chat-coordinator/route.js)
converts workflow to system prompt additions
```

### 6.2 New Utility: `workflowToContext.js`

Converts the React Flow nodes/edges into structured text for the system prompt:

```javascript
function workflowToSystemPrompt(workflow) {
  // Returns something like:

  `
  ## AGENT WORKFLOW CONTEXT

  You are the Orchestrator for a "20B Residential Feasibility" template.

  ### Available Specialist Agents:

  1. **Costing Summary Agent** (type: summary)
     - Purpose: Summarizes the Costing page including total construction cost,
       per-unit cost, and cost breakdowns
     - Has access to pages: Costing, Revenue
     - Output format: bullet points

  2. **Land Input Agent** (type: masterInput)
     - Purpose: Handles all land-related inputs
     - Can modify: plotArea, fsi, roadWidth, setbacks
     - Validation: plotArea > 0, fsi between 1.0 and 5.0

  3. **20B Setup Guide** (type: followUpQuestion)
     - Trigger: When user says "help me", "guide me", or "setup"
     - Purpose: Walk user through setting up a 20B feasibility step by step
     - Steps:
       Step 1: Ask for Gross Plot Area → update grossPlotArea
       Step 2: Ask for Road Width → update roadWidth
       Step 3: Ask for Ready Reckoner Rate → update readyReckonerRate
     - After all steps: "All basic inputs are set! Would you like a summary?"

  ### Routing Rules:
  - If user asks for a summary/overview → route to Costing Summary Agent
  - If user wants to change a land input → route to Land Input Agent
  - If user says "guide me" or asks how to start → route to 20B Setup Guide
  - For follow-up questions, proceed step by step. Only ask ONE question at a time.
  - After each answer, update the master input and confirm before moving to next step.
  `
}
```

### 6.3 Modify Chat API Routes

**`FE/app/api/direct/chat/route.js`** (Flat mode):
- Accept `agentWorkflow` in the request body
- Call `workflowToSystemPrompt(agentWorkflow)`
- Append result to system prompt after the existing context

**`FE/app/api/direct/chat-coordinator/route.js`** (Coordinator mode):
- Accept `agentWorkflow` in the request body
- Use workflow nodes to dynamically configure specialist agents instead of hardcoded ones
- Each node's summary becomes that specialist's system prompt context

### 6.4 Modify DirectChatBarBase.jsx
- Include `agentWorkflow` in the body sent to the chat API:
  ```javascript
  body: {
    context: getDirectContext(),
    agentWorkflow: agentWorkflow,  // from DirectFeasibilityV7 props
  }
  ```

---

## 7. Follow-Up Question Flow (Detailed)

This is the most important user-facing feature. Here's the exact flow:

```
User opens feasibility → Chat bar loads
    ↓
System prompt includes follow-up agent context with steps
    ↓
User: "Help me make a 20B feasibility"
    ↓
AI recognizes trigger phrase → activates follow-up flow
    ↓
AI: "I'd love to help you set up a 20B feasibility!
     Let's start with the basics.

     What is the Gross Plot Area (in sq.mt)?
     💡 Hint: You can find this in the 7/12 extract or property card"
    ↓
User: "5000"
    ↓
AI: [calls updateMasterInput("grossPlotArea", 5000)]
AI: "Got it! Plot area set to 5,000 sq.mt. ✓

     Next — what is the road width adjacent to the plot (in meters)?
     💡 Hint: Common values are 9m, 12m, 18m, 24m, 30m"
    ↓
User: "18"
    ↓
AI: [calls updateMasterInput("roadWidth", 18)]
AI: "Road width set to 18m. ✓

     Now, what is the Ready Reckoner rate (per sq.mt)?
     💡 Hint: Check the ASR for your zone"
    ↓
User: "45000"
    ↓
AI: [calls updateMasterInput("readyReckonerRate", 45000)]
AI: "Ready reckoner rate set to ₹45,000/sq.mt. ✓

     All basic inputs are set! Your feasibility is ready for review.
     Would you like me to summarize the results?"
    ↓
User: "Yes"
    ↓
AI: [Routes to Summary Agent → fetches page data → presents summary]
```

### 7.1 Step State Tracking

The follow-up flow needs to track which steps have been completed. This is handled in the conversation context:

- The system prompt includes ALL steps
- The AI uses conversation history to know which steps are done
- If a user re-enters the flow mid-way, the AI checks current master input values and skips already-filled steps
- Users can say "skip" to move to the next step

---

## 8. Implementation Phases

### Phase 1: Backend Foundation
1. Create `BE/schema/agentWorkflows.js` — agent_workflows table
2. Create `BE/schema/customAgentTypes.js` — custom_agent_types table
3. Create `BE/controller/agentWorkflowController.js` — workflow CRUD
4. Create `BE/controller/customAgentTypeController.js` — type CRUD + save-from-node
5. Create `BE/routes/agentWorkflowRoutes.js` — workflow routes
6. Create `BE/routes/customAgentTypeRoutes.js` — type routes
7. Mount both route sets in `BE/app.js`
8. Modify `directController.getFormulaTemplateById` to include workflow data
9. Run migration to create both tables

### Phase 2: Admin UI — Workflow Builder
1. Install `@xyflow/react` (React Flow v12) in FE
2. Add "Agent Workflow" tab in FeasibilityTestV5.jsx
3. Build `AgentWorkflowBuilder.jsx` with React Flow canvas
4. Build built-in node components (Orchestrator, Summary, MasterInput, FollowUpQuestion)
5. Build `CustomNode.jsx` and `SavedTypeNode.jsx` for custom agents
6. Build `ToolPalette.jsx` — drag source with built-in types + saved types section + "Create New Type" button
7. Build `NodeConfigPanel.jsx` — right-side editor (routes to type-specific panels)
8. Build `CustomAgentPanel.jsx` — config panel for custom/savedType nodes with tool checkboxes
9. Build `StepEditor.jsx` — ordered step list for follow-up nodes
10. Build `CreateTypeModal.jsx` — modal to create reusable types from scratch
11. Build `useAgentWorkflow.js` hook — fetch/save workflow
12. Build `useCustomAgentTypes.js` hook — fetch/create/delete types
13. Wire up save/load to backend
14. Implement "Save as Reusable Type" flow (custom node → saved type)

### Phase 3: Context Integration
1. Build `workflowToContext.js` — converts workflow to system prompt text
2. Modify `DirectFeasibilityV7.jsx` to pass `agentWorkflow` to chat bar
3. Modify `DirectChatBarBase.jsx` to include workflow in API requests
4. Modify `FE/app/api/direct/chat/route.js` to use workflow context
5. Modify `FE/app/api/direct/chat-coordinator/route.js` to use workflow context
6. Test flat mode with workflow context
7. Test coordinator mode with dynamic specialist routing

### Phase 4: Follow-Up Question Flow
1. Refine system prompt generation for step-by-step guidance
2. Test multi-step follow-up conversations
3. Handle edge cases: skip, go back, re-enter flow
4. Validate inputs before applying (per step validation rules)
5. Test completion message and handoff to other agents

### Phase 5: Polish & Edge Cases
1. Workflow validation — ensure one orchestrator, no orphan nodes
2. Preview mode — show generated system prompt before saving
3. Duplicate workflow from another template
4. Export/import workflow as JSON
5. Visual feedback on canvas — node status colors, edge labels

---

## 9. File Change Summary

### New Files (Backend)
| File | Purpose |
|------|---------|
| `BE/schema/agentWorkflows.js` | agent_workflows table definition |
| `BE/schema/customAgentTypes.js` | custom_agent_types table definition |
| `BE/controller/agentWorkflowController.js` | Workflow CRUD controller |
| `BE/controller/customAgentTypeController.js` | Reusable type CRUD + save-from-node |
| `BE/routes/agentWorkflowRoutes.js` | Workflow routes |
| `BE/routes/customAgentTypeRoutes.js` | Agent type routes |

### New Files (Frontend)
| File | Purpose |
|------|---------|
| `FE/components/AgentWorkflowBuilder/AgentWorkflowBuilder.jsx` | Main React Flow canvas |
| `FE/components/AgentWorkflowBuilder/nodes/OrchestratorNode.jsx` | Start node component (purple) |
| `FE/components/AgentWorkflowBuilder/nodes/SummaryNode.jsx` | Summary agent node (blue) |
| `FE/components/AgentWorkflowBuilder/nodes/MasterInputNode.jsx` | Master input agent node (green) |
| `FE/components/AgentWorkflowBuilder/nodes/InfoNode.jsx` | Info/knowledge agent node (teal) |
| `FE/components/AgentWorkflowBuilder/nodes/FollowUpQuestionNode.jsx` | Follow-up question node (orange) |
| `FE/components/AgentWorkflowBuilder/nodes/CustomNode.jsx` | Blank custom agent node (gray) |
| `FE/components/AgentWorkflowBuilder/nodes/SavedTypeNode.jsx` | Instance of a reusable type (type's color) |
| `FE/components/AgentWorkflowBuilder/panels/NodeConfigPanel.jsx` | Right-side config editor |
| `FE/components/AgentWorkflowBuilder/panels/CustomAgentPanel.jsx` | Config for custom/savedType nodes |
| `FE/components/AgentWorkflowBuilder/panels/StepEditor.jsx` | Step list editor for follow-up |
| `FE/components/AgentWorkflowBuilder/panels/ToolPalette.jsx` | Left-side drag palette (built-in + saved types) |
| `FE/components/AgentWorkflowBuilder/panels/CreateTypeModal.jsx` | Modal to create new reusable type |
| `FE/components/AgentWorkflowBuilder/hooks/useAgentWorkflow.js` | Workflow fetch/save API hook |
| `FE/components/AgentWorkflowBuilder/hooks/useCustomAgentTypes.js` | Type CRUD API hook |
| `FE/components/AgentWorkflowBuilder/utils/workflowToContext.js` | Workflow → system prompt |

### Modified Files
| File | Change |
|------|--------|
| `BE/app.js` | Mount `/agent-workflow` routes |
| `BE/controller/directController.js` | Include agentWorkflow in GET response |
| `FE/pages/admin/feasibilitytestv5/FeasibilityTestV5.jsx` | Add "Agent Workflow" tab |
| `FE/components/DirectFeasibilityV7/DirectFeasibilityV7.jsx` | Pass agentWorkflow to chat bar |
| `FE/components/DirectFeasibilityV7/DirectChatBarBase.jsx` | Send agentWorkflow in API body |
| `FE/app/api/direct/chat/route.js` | Parse & inject workflow context |
| `FE/app/api/direct/chat-coordinator/route.js` | Dynamic specialist routing from workflow |

---

## 10. Dependencies

### New npm packages (FE only)
- `@xyflow/react` — React Flow v12 (drag-and-drop node canvas)
- No additional BE dependencies needed

---

## 11. Example Workflow JSON (Saved in DB)

```json
{
  "id": "wf-001",
  "templateId": "tmpl-20b-residential",
  "name": "20B Residential Feasibility Workflow",
  "isActive": true,
  "nodes": [
    {
      "id": "orch-1",
      "type": "orchestrator",
      "position": { "x": 400, "y": 0 },
      "data": {
        "name": "20B Feasibility Orchestrator",
        "summary": "Routes user queries for a 20B Residential Feasibility calculation. Guides new users through setup, answers questions about costs and revenue, and helps modify inputs."
      }
    },
    {
      "id": "followup-1",
      "type": "followUpQuestion",
      "position": { "x": 100, "y": 200 },
      "data": {
        "name": "Feasibility Setup Guide",
        "summary": "Walks user through filling basic inputs for a 20B feasibility",
        "triggerPhrase": "help me start|guide me|setup|how do I begin",
        "steps": [
          {
            "stepNumber": 1,
            "question": "Let's start! What is the Gross Plot Area (in sq.mt)?",
            "targetInput": "grossPlotArea",
            "inputType": "number",
            "hint": "Find this in the 7/12 extract or property card",
            "validation": "Must be greater than 0",
            "followUp": "Plot area set to {value} sq.mt."
          },
          {
            "stepNumber": 2,
            "question": "What is the road width adjacent to the plot (in meters)?",
            "targetInput": "roadWidth",
            "inputType": "number",
            "hint": "Common values: 9m, 12m, 18m, 24m, 30m. This affects your FSI.",
            "validation": "Must be between 6 and 60",
            "followUp": "Road width set to {value}m."
          },
          {
            "stepNumber": 3,
            "question": "What is the Ready Reckoner rate for your zone (Rs. per sq.mt)?",
            "targetInput": "readyReckonerRate",
            "inputType": "number",
            "hint": "Check the Annual Statement of Rates (ASR) for your area",
            "validation": "Must be greater than 0",
            "followUp": "Ready Reckoner rate set to Rs. {value}/sq.mt."
          },
          {
            "stepNumber": 4,
            "question": "What is the expected sale rate (Rs. per sq.ft)?",
            "targetInput": "saleRate",
            "inputType": "number",
            "hint": "Check recent comparable sales in the area",
            "validation": "Must be greater than 0",
            "followUp": "Sale rate set to Rs. {value}/sq.ft."
          }
        ],
        "completionMessage": "All basic inputs are set! Your 20B feasibility now has initial values. Would you like me to summarize the results, or would you like to fine-tune any specific inputs?"
      }
    },
    {
      "id": "summary-1",
      "type": "summary",
      "position": { "x": 400, "y": 200 },
      "data": {
        "name": "Cost & Revenue Summary",
        "summary": "Provides summaries of construction costs, revenue projections, and profitability metrics",
        "targetPages": ["Costing", "Revenue", "Profitability"],
        "outputFormat": "bullets"
      }
    },
    {
      "id": "master-1",
      "type": "masterInput",
      "position": { "x": 700, "y": 200 },
      "data": {
        "name": "Input Manager",
        "summary": "Handles all master input modifications including land details, construction parameters, and financial assumptions",
        "targetInputs": ["all"],
        "validationRules": {
          "grossPlotArea": "> 0",
          "fsi": "between 1.0 and 8.0",
          "roadWidth": "between 6 and 60"
        }
      }
    }
  ],
    {
      "id": "info-1",
      "type": "info",
      "position": { "x": 1000, "y": 200 },
      "data": {
        "name": "Calculation Guide",
        "summary": "Explains what this 20B feasibility calculates, how pages relate, and domain terminology",
        "calculationPurpose": "Determines whether a residential real estate project on a given plot is financially viable under Maharashtra DCPR 2034 regulations. Answers: What is the buildable area? What will it cost? What revenue will it generate? Is it profitable?",
        "pageDescriptions": {
          "Area Statement": "Calculates total buildable area based on plot area, FSI, TDR, and fungible FSI. Key output: net saleable area in sq.ft.",
          "Costing": "Breaks down all project costs — land acquisition, construction, government premiums, statutory charges, interest on borrowing, and project overheads.",
          "Revenue": "Projects total revenue from sale of residential units and parking at the configured sale rate per sq.ft.",
          "Profitability": "Compares total cost vs total revenue. Shows net profit, profit margin %, IRR, and estimated payback period."
        },
        "glossary": {
          "FSI": "Floor Space Index — ratio of total built-up area to plot area. Higher FSI = more floors allowed.",
          "TDR": "Transfer of Development Rights — additional buildable area purchased from the open market.",
          "Ready Reckoner Rate": "Government-published annual land valuation rates used for stamp duty and premium calculations.",
          "Fungible FSI": "Additional 35% FSI available by paying a premium to the government (flower bed / balcony area).",
          "DCPR 2034": "Development Control and Promotion Regulations 2034 — the building code governing Mumbai region.",
          "Carpet Area": "Net usable floor area inside walls, excluding common areas.",
          "RERA": "Real Estate Regulatory Authority — regulates project registration and disclosures."
        },
        "howToUse": "1. Start by filling in land details (plot area, road width, zone). 2. Check the Area Statement to see your buildable potential. 3. Review Costing for total project cost. 4. Check Revenue at your expected sale rate. 5. The Profitability page gives you the final verdict."
      }
    },
    {
      "id": "custom-1",
      "type": "custom",
      "position": { "x": 400, "y": 400 },
      "data": {
        "name": "TDR Advisor",
        "summary": "Analyzes FSI utilization and advises on TDR purchase decisions",
        "systemPrompt": "You are a TDR (Transfer of Development Rights) advisor for real estate feasibility. Analyze the current FSI utilization, remaining potential, and advise whether purchasing TDR is financially viable. Always show your calculations step-by-step. Compare TDR cost vs additional revenue from extra built-up area.",
        "allowedTools": ["fetchPageData", "fetchCells", "summarizePage", "fetchMasterInputs"],
        "targetPages": ["FSI Calculation", "TDR", "Revenue"],
        "targetInputs": ["fsi", "tdrRate", "tdrArea"],
        "triggerPhrase": "TDR|transfer of development rights|should I buy TDR",
        "customInstructions": "Always compare: (TDR cost) vs (extra revenue from additional area). Show break-even analysis."
      }
    },
    {
      "id": "saved-1",
      "type": "savedType:compliance-checker-001",
      "position": { "x": 700, "y": 400 },
      "data": {
        "name": "RERA Compliance Check",
        "savedTypeId": "compliance-checker-001",
        "summary": "Verifies inputs against RERA and DCPR regulations",
        "targetPages": ["FSI Calculation", "Setbacks", "Parking"],
        "customInstructions": "Check against DCPR 2034 rules for Mumbai region"
      }
    }
  ],
  "edges": [
    { "id": "e1", "source": "orch-1", "target": "followup-1", "label": "guided setup" },
    { "id": "e2", "source": "orch-1", "target": "summary-1", "label": "summaries & overviews" },
    { "id": "e3", "source": "orch-1", "target": "master-1", "label": "input changes" },
    { "id": "e4", "source": "followup-1", "target": "summary-1", "label": "after setup complete" },
    { "id": "e5", "source": "orch-1", "target": "info-1", "label": "explanations & help" },
    { "id": "e6", "source": "orch-1", "target": "custom-1", "label": "TDR queries" },
    { "id": "e7", "source": "orch-1", "target": "saved-1", "label": "compliance checks" }
  ]
}
```

---

## 12. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Where to store workflow | Separate `agent_workflows` table | Keeps template table clean; workflows can be versioned independently |
| How context reaches chat | Injected into system prompt | No changes to LLM tool-calling needed; works with both flat and coordinator modes |
| Follow-up step tracking | Via conversation history | No need for extra state management; LLM reads previous messages to know current step |
| One workflow per template | Yes (for now) | Simplicity; can add multiple workflows later with an `isActive` flag |
| React Flow version | v12 (`@xyflow/react`) | Latest stable, better TypeScript support, controlled/uncontrolled modes |
| Node type extensibility | `type` field on node | Built-in types + `custom` + `savedType:<id>` covers all use cases |
| Custom vs Saved types | Both | Custom = one-off on canvas; Saved = reusable across workflows. Admins can promote custom → saved |
| Saved type scope | Global or per-template | Global types build an org-wide agent library; per-template types stay scoped |
| Saved type inheritance | Override model | Instances inherit defaults but any field can be overridden per-node, like CSS inheritance |
| Custom agent tools | Checkbox selection | Admins pick which tools each custom agent can use — prevents accidental data modification |

---

## 13. Additional Features & Missing Pieces

### 13.1 Welcome / Greeting Message (Orchestrator Config)

Currently, the chat bar just shows an empty input. The orchestrator node should have a configurable **welcome message** — the first thing the AI says when a user opens the chat.

**Added to Orchestrator `data`:**
```javascript
{
  welcomeMessage: "Hi! I'm your 20B Feasibility assistant. I can help you:\n• Set up your feasibility step by step\n• Summarize costs, revenue, and profitability\n• Modify any input\n• Analyze TDR options\n\nWhat would you like to do?",
  showWelcomeOnLoad: true,   // auto-show vs wait for first message
}
```

**How it works:**
- When chat bar mounts and `showWelcomeOnLoad` is true, the welcome message is displayed as the first AI message (not sent to the API — just rendered client-side).
- This gives users immediate guidance on what the chat can do.
- If `showWelcomeOnLoad` is false, the welcome is only shown after the user sends their first message.

### 13.2 Edge Routing Conditions (Smart Edges)

Currently edges are just visual connections with labels. They should carry actual **routing logic** so the orchestrator knows *when* to use each agent.

**Updated Edge Shape:**
```javascript
{
  id: "e1",
  source: "orch-1",
  target: "followup-1",
  data: {
    label: "guided setup",
    routingCondition: "intent",           // "intent" | "keyword" | "always" | "fallback"
    keywords: ["guide", "setup", "help me start", "how do I begin"],
    intentDescription: "User wants to be walked through setting up the feasibility step by step",
    priority: 1,                          // lower = higher priority (checked first)
  }
}
```

**Routing condition types:**
| Type | Behavior |
|------|----------|
| `intent` | Orchestrator uses `intentDescription` to judge if user's message matches this intent |
| `keyword` | Direct keyword/phrase match from `keywords` array |
| `always` | This agent is always included in context (e.g., a validation agent) |
| `fallback` | Used when no other agent matches (e.g., a general Q&A agent) |

**Generated system prompt from edges:**
```
### Routing Rules (check in priority order):
1. [Priority 1] → "Feasibility Setup Guide": When user wants to be walked through setup.
   Keywords: guide, setup, help me start, how do I begin
2. [Priority 2] → "Cost & Revenue Summary": When user asks for summaries or overviews.
   Keywords: summary, total cost, revenue, profitability
3. [Priority 3] → "Input Manager": When user wants to change or check specific inputs.
4. [Priority 4] → "TDR Advisor": When user asks about TDR or FSI optimization.
   Keywords: TDR, transfer of development rights, should I buy TDR
5. [Fallback] → "Input Manager": For any other query, default to the input manager.
```

### 13.3 Node Enable/Disable Toggle

Admins should be able to **disable a node without deleting it**. Useful for temporarily removing an agent from the workflow while keeping its configuration.

- Each node gets an `enabled` toggle (default: true)
- Disabled nodes appear grayed out on the canvas with a strikethrough on the name
- Disabled nodes are excluded from `workflowToContext.js` output
- Their edges become dashed lines

```javascript
// In node data
data: {
  ...existingFields,
  enabled: true,  // toggle in config panel
}
```

### 13.4 Duplicate Node

Right-click a node → "Duplicate" creates a copy with:
- Same type and all config fields
- New unique ID
- Position offset by (+50, +50) from original
- Name suffixed with " (Copy)"
- No edges (user connects manually)

This is essential for quickly creating similar agents (e.g., multiple summary agents for different page groups).

### 13.5 Workflow Test / Simulate Mode

A **"Test Workflow"** button on the canvas opens a split-screen view:

```
┌─────────────────────────────┬──────────────────────────┐
│                             │                          │
│  React Flow Canvas          │  Test Chat Simulation    │
│  (read-only, highlights     │                          │
│   active node in real-time) │  [AI]: Hi! I'm your     │
│                             │  20B assistant...        │
│   ┌──────┐                  │                          │
│   │Orch ●│ ← active        │  [You]: guide me         │
│   └──┬───┘                  │                          │
│      │                      │  [AI]: Let's start!      │
│   ┌──▼───┐                  │  What is the plot area?  │
│   │Setup●│ ← routed to     │                          │
│   └──────┘                  │  [Type a message...]     │
│                             │                          │
└─────────────────────────────┴──────────────────────────┘
```

**Features:**
- Uses the same chat API but with a `testMode: true` flag
- In test mode, `updateMasterInput` calls are logged but NOT actually saved to DB
- The canvas highlights which node is currently active (glowing border)
- Shows routing decisions: "Orchestrator → routed to Setup Guide (matched keyword: 'guide me')"
- Admin can verify the workflow works before deploying

### 13.6 Template Variables in Prompts

System prompts and summaries should support **template variables** that get replaced at runtime:

| Variable | Replaced With |
|----------|---------------|
| `{templateName}` | Name of the template (e.g., "20B Residential") |
| `{userName}` | Current user's name |
| `{feasibilityId}` | The direct feasibility document ID |
| `{masterInput.plotArea}` | Current value of a specific master input |
| `{page.Costing.A1}` | Current value of a specific cell |
| `{totalPages}` | Number of pages in the template |
| `{totalInputs}` | Number of master inputs |

**Example usage in a follow-up step:**
```json
{
  "question": "The current plot area is {masterInput.grossPlotArea} sq.mt. Would you like to change it?",
  "followUp": "Updated from {masterInput.grossPlotArea} to {value} sq.mt."
}
```

This makes prompts dynamic and context-aware without the admin needing to hardcode values.

### 13.7 Agent Analytics & Logging

Track how agents are being used to help admins optimize their workflows.

**New Table: `agent_usage_logs`**
```javascript
const agentUsageLogs = pgTable("agent_usage_logs", {
  id: varchar("id", { length: 24 }).primaryKey(),
  workflowId: varchar("workflow_id", { length: 24 }),
  nodeId: varchar("node_id", { length: 50 }),        // which agent was used
  nodeType: varchar("node_type", { length: 50 }),
  feasibilityId: varchar("feasibility_id", { length: 24 }),
  userId: varchar("user_id", { length: 24 }),

  // What happened
  action: varchar("action", { length: 50 }),          // "routed" | "tool_call" | "completed" | "skipped"
  userMessage: text("user_message"),                   // what the user said
  routingReason: text("routing_reason"),               // why orchestrator chose this agent
  toolsUsed: jsonb("tools_used").default([]),          // which tools were called
  stepNumber: integer("step_number"),                  // for follow-up agents

  // Outcome
  success: boolean("success").default(true),
  duration_ms: integer("duration_ms"),                 // how long the agent took

  createdAt: timestamp("created_at").defaultNow(),
});
```

**Dashboard in Admin (Agent Workflow tab):**
```
┌─────────────────────────────────────────────────┐
│  Agent Usage (Last 30 Days)                     │
│                                                 │
│  Setup Guide      ████████████████  45 uses     │
│  Input Manager    ██████████        28 uses     │
│  Cost Summary     ████████          22 uses     │
│  TDR Advisor      ███               8 uses      │
│  Compliance       █                 3 uses      │
│                                                 │
│  Most common first message: "guide me" (38%)    │
│  Avg. follow-up steps completed: 3.2 / 4        │
│  Most modified input: grossPlotArea (67 times)  │
└─────────────────────────────────────────────────┘
```

This tells the admin which agents are valuable and which aren't being used, and where users tend to drop off in follow-up flows.

### 13.8 Agent Chaining (Agent → Agent Handoff)

Currently only the orchestrator can route to agents. But agents should be able to **hand off to each other**:

```
Follow-Up Guide (completes all steps)
    ↓ (edge: "after setup complete")
Summary Agent (auto-triggered, summarizes results)
    ↓ (edge: "if issues found")
Compliance Check (auto-triggered)
```

**How it works:**
- Non-orchestrator nodes can have outgoing edges
- Edge `data.handoffCondition`: `"onComplete"` | `"onError"` | `"conditional"`
- When an agent finishes (e.g., follow-up completes all steps), it checks outgoing edges
- If a handoff edge exists, the next agent is triggered automatically
- The `completionMessage` of the first agent becomes part of the context for the next

**Edge handoff data:**
```javascript
{
  id: "e4",
  source: "followup-1",
  target: "summary-1",
  data: {
    label: "after setup complete",
    handoffCondition: "onComplete",
    handoffMessage: "Now let me summarize your feasibility results...",
    autoTrigger: true,    // true = automatic, false = AI suggests but user confirms
  }
}
```

### 13.9 Workflow Versioning (Simple Snapshots)

Every time a workflow is saved, keep the previous version as a snapshot.

**Added to `agent_workflows` table:**
```javascript
  version: integer("version").default(1),
  snapshots: jsonb("snapshots").default([]),  // Array of { version, nodes, edges, savedAt }
```

**Features:**
- "Version History" dropdown in the workflow builder toolbar
- Click a version to preview it (read-only overlay on canvas)
- "Restore this version" button to roll back
- Keep last 20 snapshots (auto-prune older ones)
- No separate table needed — snapshots stored in the workflow row itself

### 13.10 Auto-Layout & Canvas UX

React Flow has built-in features that should be enabled:

- **Minimap** — small overview of the full canvas (bottom-right corner)
- **Auto-Layout button** — uses dagre or elkjs to automatically arrange nodes in a tree layout
- **Snap-to-grid** — nodes align to a grid when dragged
- **Keyboard shortcuts**:
  - `Delete` / `Backspace` — remove selected node/edge
  - `Ctrl+D` — duplicate selected node
  - `Ctrl+S` — save workflow
  - `Ctrl+Z` / `Ctrl+Y` — undo/redo (React Flow supports this)
- **Zoom controls** — zoom in/out/fit buttons in toolbar
- **Selection box** — drag to select multiple nodes

### 13.11 Page-Specific Agent Activation

Some agents should only be active when the user is viewing a specific page in the feasibility. For example, a "Costing Breakdown Agent" should only respond when the user is on the Costing page.

**Added to node `data`:**
```javascript
{
  activeOnPages: ["Costing"],       // only active when user is on these pages
  activeOnAllPages: true,           // or active everywhere (default)
}
```

**How it works:**
- `DirectChatBarBase` sends the current active page name along with the context
- `workflowToContext.js` filters nodes based on the active page
- Agents not active on the current page are excluded from the system prompt
- This reduces prompt size and makes routing more precise

### 13.12 Conditional Follow-Up Steps (Branching)

Follow-up question flows are currently linear (step 1 → 2 → 3 → 4). But sometimes steps should **branch based on answers**.

**Example:** If road width < 12m, skip the TDR question (TDR not applicable for narrow roads).

**Updated step object:**
```javascript
{
  "stepNumber": 2,
  "question": "What is the road width adjacent to the plot (in meters)?",
  "targetInput": "roadWidth",
  "inputType": "number",
  "validation": "Must be between 6 and 60",
  "followUp": "Road width set to {value}m.",
  "conditionalNext": [
    {
      "condition": "value < 12",
      "skipToStep": 4,
      "reason": "TDR not applicable for roads < 12m, skipping TDR question"
    },
    {
      "condition": "value >= 30",
      "insertSteps": [
        {
          "question": "For roads >= 30m, you qualify for additional FSI. What premium FSI percentage would you like to apply?",
          "targetInput": "premiumFSIPercent",
          "inputType": "number",
          "hint": "Typically 20-40% additional",
          "validation": "Must be between 0 and 100"
        }
      ]
    }
  ]
}
```

This makes follow-up flows intelligent — they adapt based on the user's actual inputs rather than rigidly following a fixed sequence.

### 13.13 AI Auto-Layout Agent ("Generate Workflow" Button)

The most powerful feature: an **AI agent inside the admin workflow builder** that reads the template's pages, master inputs, formulas, and page structure — then **automatically generates a complete agent workflow layout**.

Instead of the admin manually dragging nodes and writing summaries, they click one button and the AI builds it all.

#### How It Works

**Button Location**: Top toolbar of the Agent Workflow tab, prominent placement:
```
┌───────────────────────────────────────────────────────────────┐
│  [🤖 Generate Workflow]  [Save]  [Test]  [Reset to Simple]   │
└───────────────────────────────────────────────────────────────┘
```

**Flow:**

```
Admin clicks "Generate Workflow"
    ↓
Confirmation modal:
  "This will analyze your template's pages, master inputs,
   and formulas to auto-generate an agent workflow.
   Any existing workflow will be replaced.
   [Cancel] [Generate]"
    ↓
POST /api/agent-workflow/generate/:templateId
    ↓
Backend:
  1. Fetch template (pages, masterinput, formulas)
  2. Build a structured description of the calculation:
     - Page names + row/column structure
     - Master input names, types, sections, groups
     - Formula dependencies (which inputs affect which pages)
     - Page-to-page references
  3. Send to LLM with a meta-prompt:
     "Analyze this feasibility calculation and generate an
      agent workflow. Create appropriate agents..."
  4. LLM returns a complete workflow JSON (nodes + edges)
    ↓
Response: { nodes: [...], edges: [...] }
    ↓
Frontend loads the generated workflow onto the React Flow canvas
    ↓
Admin reviews, tweaks, saves
```

#### The Meta-Prompt (what the AI receives)

```
You are an agent workflow designer for a real estate feasibility calculation tool.

Given the following template structure, generate a complete agent workflow
with nodes and edges in the exact JSON format specified.

## Template: "{templateName}"

### Pages:
{foreach page}
- **{pageName}** ({rowCount} rows, {colCount} columns)
  Key cells: {list of cells with formulas referencing master inputs}
  Purpose: {inferred from page name and content}
{/foreach}

### Master Inputs ({count} total):
{foreach section}
**{sectionName}**:
  {foreach input in section}
  - {inputName} (type: {type}, current value: {value})
  {/foreach}
{/foreach}

### Formula Dependencies:
- {inputName} → affects pages: {pageList}
- ...

## Required Output:

Generate a workflow with these nodes:
1. ONE Orchestrator node
2. ONE Info Agent — describe what this calculation is about, page descriptions, glossary
3. Summary agents — one per logical page group (don't create one per page, group related pages)
4. ONE Master Input agent — handles all inputs (unless there are clearly distinct input groups)
5. ONE Follow-Up Question agent — walk users through the most important inputs in logical order
   (analyze formula dependencies to determine the right input order — inputs that feed into
    other calculations should be asked first)

For the Follow-Up agent steps:
- Analyze which master inputs are "root" inputs (not derived from other inputs)
- Order them by dependency: inputs that affect the most downstream calculations come first
- Generate natural-language questions, hints, and validation rules
- Typically 4-8 steps covering the critical inputs

Return valid JSON: { nodes: [...], edges: [...] }
```

#### What the AI Generates (Example Output)

For a "20B Residential Feasibility" template with pages [Area Statement, Costing, Revenue, Profitability] and 25 master inputs, the AI might generate:

```json
{
  "nodes": [
    {
      "id": "orch-auto",
      "type": "orchestrator",
      "position": { "x": 400, "y": 0 },
      "data": {
        "name": "20B Feasibility Assistant",
        "summary": "Routes queries for a 20B Residential Feasibility under DCPR 2034",
        "welcomeMessage": "Hi! I'm your 20B Residential Feasibility assistant. I can guide you through setup, explain any calculation, summarize costs & revenue, or modify inputs. What would you like to do?"
      }
    },
    {
      "id": "info-auto",
      "type": "info",
      "position": { "x": 100, "y": 150 },
      "data": {
        "name": "Calculation Explainer",
        "summary": "Explains what this 20B feasibility calculates and how to interpret results",
        "calculationPurpose": "Determines financial viability of a residential project...",
        "pageDescriptions": {
          "Area Statement": "Calculates buildable area from plot area, FSI, TDR...",
          "Costing": "Total project cost breakdown...",
          "Revenue": "Projected sales revenue...",
          "Profitability": "Net profit, margin, IRR..."
        },
        "glossary": {
          "FSI": "Floor Space Index...",
          "TDR": "Transfer of Development Rights...",
          ...
        }
      }
    },
    {
      "id": "followup-auto",
      "type": "followUpQuestion",
      "position": { "x": 300, "y": 150 },
      "data": {
        "name": "Setup Guide",
        "summary": "Walk through essential inputs",
        "triggerPhrase": "guide|setup|help me start|new feasibility",
        "steps": [
          {
            "stepNumber": 1,
            "question": "What is the Gross Plot Area (sq.mt)?",
            "targetInput": "grossPlotArea",
            "hint": "From 7/12 extract. This is the foundation of all area calculations.",
            ...
          },
          ...AI determines the optimal order based on formula dependencies...
        ]
      }
    },
    ...summary agent, master input agent...
  ],
  "edges": [ ...auto-generated connections with routing conditions... ]
}
```

#### Key Intelligence

The AI doesn't just mechanically create nodes — it **understands the calculation**:

1. **Input ordering**: It traces formula dependencies. If `plotArea` feeds into `buildableArea` which feeds into `constructionCost`, it knows to ask `plotArea` first.
2. **Page grouping**: If "Costing" and "Cost Breakup" are related, it creates ONE summary agent for both, not two.
3. **Glossary generation**: It reads cell names, page headers, and input names to infer domain-specific terms.
4. **Validation inference**: If an input is used as a divisor somewhere, it knows to add "> 0" validation. If it's a percentage, "between 0 and 100".
5. **Trigger phrases**: It generates natural trigger phrases based on what each agent does.

#### Backend Endpoint

**`POST /api/agent-workflow/generate/:templateId`**

```javascript
// In FE: app/api/agent-workflow/generate/[templateId]/route.js
// OR in BE: controller/agentWorkflowController.js

async function generateWorkflow(templateId) {
  // 1. Fetch full template data
  const template = await getTemplateById(templateId);

  // 2. Build structured description
  const description = buildTemplateDescription(template);

  // 3. Call LLM with meta-prompt
  const response = await callLLM({
    system: WORKFLOW_GENERATOR_SYSTEM_PROMPT,
    user: description,
    response_format: "json",
  });

  // 4. Parse and validate the generated workflow
  const workflow = JSON.parse(response);
  validateWorkflowStructure(workflow);

  // 5. Return (don't save yet — admin reviews first)
  return workflow;
}
```

#### UX Flow

1. Admin clicks **"Generate Workflow"**
2. Loading state with progress: "Analyzing template... Reading 4 pages, 25 inputs... Generating workflow..."
3. Generated workflow appears on canvas
4. Toast notification: "Workflow generated! Review the agents and click Save when ready."
5. Admin can:
   - Edit any node's config (the AI's output is a starting point)
   - Add/remove nodes
   - Adjust edges and routing
   - Click "Generate" again to start over

### 13.14 Reset to Simple (Default Workflow)

A **"Reset to Simple"** button that replaces the current workflow with a clean, minimal, default layout. This is the "I don't need a complex workflow, just give me the basics" option.

#### Button Location

```
┌───────────────────────────────────────────────────────────────┐
│  [🤖 Generate Workflow]  [Save]  [Test]  [Reset to Simple]   │
└───────────────────────────────────────────────────────────────┘
```

#### What "Reset to Simple" Creates

A fixed, predictable, 5-node workflow that works for any template:

```
                ┌──────────────────┐
                │   Orchestrator   │
                │   (auto-named)   │
                └────────┬─────────┘
                         │
          ┌──────┬───────┼───────┬──────┐
          ▼      ▼       ▼       ▼      ▼
     ┌────────┐┌──────┐┌──────┐┌──────┐
     │Summary ││Master││Follow││ Info │
     │Agent   ││Input ││Up Q  ││Agent │
     │        ││Agent ││Agent ││      │
     └────────┘└──────┘└──────┘└──────┘
```

#### Default Node Configs

The simple workflow reads the template's actual data to fill in minimal but functional defaults:

**Orchestrator:**
- `name`: "{templateName} Assistant"
- `summary`: "Helps users work with the {templateName} calculation"
- `welcomeMessage`: "Hi! I can help you with your {templateName}. Ask me anything or say 'guide me' to get started."

**Summary Agent:**
- `name`: "Summary"
- `summary`: "Summarizes any page or the overall calculation"
- `targetPages`: ALL pages (no restriction)
- `outputFormat`: "bullets"

**Master Input Agent:**
- `name`: "Input Manager"
- `summary`: "Reads and updates any master input"
- `targetInputs`: ALL inputs (no restriction)
- `validationRules`: {} (none — trust the user)

**Follow-Up Question Agent:**
- `name`: "Setup Guide"
- `summary`: "Walks through filling in the key inputs"
- `triggerPhrase`: "guide me|setup|help me start|get started"
- `steps`: Auto-generated from master inputs — takes the first 5-6 inputs from the first section, creates basic steps:
  ```json
  [
    { "stepNumber": 1, "question": "What is the {inputDisplayName}?", "targetInput": "{inputName}", "hint": "", "validation": "" },
    { "stepNumber": 2, ... },
    ...
  ]
  ```
- `completionMessage`: "Basic inputs are set! Would you like me to summarize the results?"

**Info Agent:**
- `name`: "Calculation Guide"
- `summary`: "Explains what this calculation does and how to use it"
- `calculationPurpose`: "This is a {templateName} calculation."
- `pageDescriptions`: Auto-generated from page names: `{ "{pageName}": "The {pageName} page" }`
- `glossary`: {} (empty — admin fills in)
- `howToUse`: "Fill in the master inputs on the left, then review each page for results."

#### Edges (Default)

```javascript
[
  { source: "orch", target: "summary", data: { routingCondition: "intent", intentDescription: "User asks for a summary or overview", priority: 2 } },
  { source: "orch", target: "master",  data: { routingCondition: "intent", intentDescription: "User wants to change or check an input", priority: 3 } },
  { source: "orch", target: "followup", data: { routingCondition: "keyword", keywords: ["guide", "setup", "start", "help me"], priority: 1 } },
  { source: "orch", target: "info",    data: { routingCondition: "intent", intentDescription: "User asks what this calculation does, how to use it, or what a term means", priority: 4 } },
  { source: "followup", target: "summary", data: { handoffCondition: "onComplete", autoTrigger: true } },
]
```

#### Key Differences: Reset vs Generate

| | Reset to Simple | Generate Workflow |
|--|-----------------|-------------------|
| **Speed** | Instant (no AI call) | 5-15 seconds (LLM call) |
| **Intelligence** | Dumb defaults from template metadata | Smart analysis of formulas, dependencies, page content |
| **Follow-up steps** | Basic — first 5 inputs, generic questions | Optimized — dependency-ordered, with hints and validation |
| **Info agent** | Empty glossary, generic descriptions | Rich glossary, detailed page descriptions |
| **Page grouping** | Single summary agent for all pages | Grouped summary agents for related pages |
| **When to use** | Quick start, simple templates, "I'll configure it myself" | Complex templates, want AI to do the heavy lifting |

#### Confirmation Dialog

```
┌─────────────────────────────────────────┐
│  Reset to Simple Workflow?              │
│                                         │
│  This will replace your current         │
│  workflow with a basic 5-node layout:   │
│                                         │
│  • Orchestrator                         │
│  • Summary Agent (all pages)            │
│  • Master Input Agent (all inputs)      │
│  • Follow-Up Question Agent             │
│  • Info Agent                           │
│                                         │
│  Your current workflow will be saved    │
│  as a version snapshot before resetting.│
│                                         │
│  [Cancel]              [Reset]          │
└─────────────────────────────────────────┘
```

The current workflow is auto-saved as a snapshot (Section 13.9) before resetting, so it can be restored from version history if needed.

---

## 14. Updated Implementation Phases (with new features)

### Phase 1: Backend Foundation (same as before + analytics table)
- Add `agent_usage_logs` table to schema

### Phase 2: Admin UI — Workflow Builder (same as before + UX features)
- Enable minimap, snap-to-grid, keyboard shortcuts, auto-layout
- Add duplicate node (right-click menu)
- Add node enable/disable toggle
- Build InfoNode component (teal) with page descriptions, glossary, howToUse editors
- Add "Reset to Simple" button — generates instant 5-node default workflow
- Add "Generate Workflow" button — calls AI to auto-generate full workflow from template analysis

### Phase 3: Context Integration (same as before + smart edges)
- Implement edge routing conditions (intent, keyword, always, fallback)
- Implement template variables replacement
- Implement page-specific agent activation
- Send active page name from chat bar

### Phase 4: Follow-Up Question Flow (same as before + branching)
- Implement conditional next steps
- Implement branch/skip logic based on input values

### Phase 5: Agent Chaining & Handoffs
- Implement agent → agent edges with handoff conditions
- Auto-trigger next agent on completion
- Test multi-agent chains (follow-up → summary → compliance)

### Phase 6: Welcome Message & Test Mode
- Implement orchestrator welcome message
- Build test/simulate mode with split-screen view
- Highlight active node on canvas during simulation

### Phase 7: Analytics & Versioning
- Log agent usage from chat API routes
- Build analytics dashboard in admin UI
- Implement workflow version snapshots
- Build version history viewer and restore

### Phase 8: Polish
- Workflow validation (one orchestrator, no orphans, no circular chains)
- Export/import workflow JSON
- Duplicate workflow from another template
- Responsive design for the builder UI
