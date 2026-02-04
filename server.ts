import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";

// Works both from source (server.ts) and compiled (dist/server.js)
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

// ============================================================
// RECALL: shared knowledge for the agent
// ============================================================
const RECALL_CHEAT_SHEET = `# Excalidraw Element Format

Call read_me FIRST, then use create_view.

## Color Palette (use consistently across all tools)

### Primary Colors
| Name | Hex | Use |
|------|-----|-----|
| Blue | \`#4a9eed\` | Primary actions, links, data series 1 |
| Amber | \`#f59e0b\` | Warnings, highlights, data series 2 |
| Green | \`#22c55e\` | Success, positive, data series 3 |
| Red | \`#ef4444\` | Errors, negative, data series 4 |
| Purple | \`#8b5cf6\` | Accents, special items, data series 5 |
| Pink | \`#ec4899\` | Decorative, data series 6 |
| Cyan | \`#06b6d4\` | Info, secondary, data series 7 |
| Lime | \`#84cc16\` | Extra, data series 8 |

### Excalidraw Fills (pastel, for shape backgrounds)
| Color | Hex | Good For |
|-------|-----|----------|
| Light Blue | \`#a5d8ff\` | Input, sources, primary nodes |
| Light Green | \`#b2f2bb\` | Success, output, completed |
| Light Orange | \`#ffd8a8\` | Warning, pending, external |
| Light Purple | \`#d0bfff\` | Processing, middleware, special |
| Light Red | \`#ffc9c9\` | Error, critical, alerts |
| Light Yellow | \`#fff3bf\` | Notes, decisions, planning |
| Light Teal | \`#c3fae8\` | Storage, data, memory |
| Light Pink | \`#eebefa\` | Analytics, metrics |

### Background Zones (use with opacity: 30 for layered diagrams)
| Color | Hex | Good For |
|-------|-----|----------|
| Blue zone | \`#dbe4ff\` | UI / frontend layer |
| Purple zone | \`#e5dbff\` | Logic / agent layer |
| Green zone | \`#d3f9d8\` | Data / tool layer |

---

## Excalidraw Elements

### Required Fields (all elements)
\`type\`, \`id\` (unique string), \`x\`, \`y\`, \`width\`, \`height\`

### Defaults (skip these)
strokeColor="#1e1e1e", backgroundColor="transparent", fillStyle="solid", strokeWidth=2, roughness=1, opacity=100
Canvas background is white.

### Element Types

**Rectangle**: \`{ "type": "rectangle", "id": "r1", "x": 100, "y": 100, "width": 200, "height": 100 }\`
- \`roundness: { type: 3 }\` for rounded corners
- \`backgroundColor: "#a5d8ff"\`, \`fillStyle: "solid"\` for filled

**Ellipse**: \`{ "type": "ellipse", "id": "e1", "x": 100, "y": 100, "width": 150, "height": 150 }\`

**Diamond**: \`{ "type": "diamond", "id": "d1", "x": 100, "y": 100, "width": 150, "height": 150 }\`

**Labeled shape (PREFERRED)**: Add \`label\` to any shape for auto-centered text. No separate text element needed.
\`{ "type": "rectangle", "id": "r1", "x": 100, "y": 100, "width": 200, "height": 80, "label": { "text": "Hello", "fontSize": 20 } }\`
- Works on rectangle, ellipse, diamond
- Text auto-centers and container auto-resizes to fit
- Saves tokens vs separate text elements

**Labeled arrow**: \`"label": { "text": "connects" }\` on an arrow element.

**Standalone text** (titles, annotations only):
\`{ "type": "text", "id": "t1", "x": 150, "y": 138, "text": "Hello", "fontSize": 20 }\`
- x is the LEFT edge of the text. To center text at position cx: set x = cx - estimatedWidth/2
- estimatedWidth ≈ text.length × fontSize × 0.5
- Do NOT rely on textAlign or width for positioning — they only affect multi-line wrapping

**Arrow**: \`{ "type": "arrow", "id": "a1", "x": 300, "y": 150, "width": 200, "height": 0, "points": [[0,0],[200,0]], "endArrowhead": "arrow" }\`
- points: [dx, dy] offsets from element x,y
- endArrowhead: null | "arrow" | "bar" | "dot" | "triangle"

### Arrow Bindings
Arrow: \`"startBinding": { "elementId": "r1", "fixedPoint": [1, 0.5] }\`
fixedPoint: top=[0.5,0], bottom=[0.5,1], left=[0,0.5], right=[1,0.5]

### Drawing Order (CRITICAL for streaming)
- Array order = z-order (first = back, last = front)
- **Emit progressively**: background → shape → its label → its arrows → next shape
- BAD: all rectangles → all texts → all arrows
- GOOD: bg_shape → shape1 → text1 → arrow1 → shape2 → text2 → ...

### Example: Two connected labeled boxes
\`\`\`json
[
  { "type": "viewportUpdate", "width": 800, "height": 600, "x": 50, "y": 50 },
  { "type": "rectangle", "id": "b1", "x": 100, "y": 100, "width": 200, "height": 100, "roundness": { "type": 3 }, "backgroundColor": "#a5d8ff", "fillStyle": "solid", "label": { "text": "Start", "fontSize": 20 } },
  { "type": "rectangle", "id": "b2", "x": 450, "y": 100, "width": 200, "height": 100, "roundness": { "type": 3 }, "backgroundColor": "#b2f2bb", "fillStyle": "solid", "label": { "text": "End", "fontSize": 20 } },
  { "type": "arrow", "id": "a1", "x": 300, "y": 150, "width": 150, "height": 0, "points": [[0,0],[150,0]], "endArrowhead": "arrow", "startBinding": { "elementId": "b1", "fixedPoint": [1, 0.5] }, "endBinding": { "elementId": "b2", "fixedPoint": [0, 0.5] } }
]
\`\`\`

### Viewport & Sizing (CRITICAL for readability)

The diagram displays inline at ~700px width. Design for this constraint:

**Canvas size rules:**
- Target viewport: **800×600** (max during streaming). This maps ~1:1 to display.
- NEVER exceed 800px width for the initial viewport — content will be unreadably tiny.
- For complex diagrams: use multiple sections that scroll/pan, NOT one giant canvas.
- Final overview viewport CAN be larger (up to ~1200px wide) to show everything at a glance.

**Font size rules:**
- Minimum fontSize: **16** for body text, labels, descriptions
- Minimum fontSize: **20** for titles and headings
- Minimum fontSize: **14** for secondary annotations only (sparingly)
- NEVER use fontSize below 14 — it becomes unreadable at display scale

**Element sizing rules:**
- Minimum shape size: 120×60 for labeled rectangles/ellipses
- Leave 20-30px gaps between elements minimum
- Prefer fewer, larger elements over many tiny ones

ALWAYS start with a \`viewportUpdate\` as the FIRST element:
\`{ "type": "viewportUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\`

- x, y: top-left corner of visible area (scene coordinates)
- Place additional viewportUpdates between groups to "pan" the camera as you build
- The camera animates smoothly between viewport positions

Tip: For large diagrams, emit a viewportUpdate to focus on each section as you draw it.
IMPORTANT: Always end with a final viewportUpdate that fits the ENTIRE diagram,
so the user sees the complete picture when generation finishes.

## Tips
- Always call \`read_me\` before your first use of create_view
- Use the color palette consistently
- Elements stream in one by one during generation
- Do NOT use emoji in text — they don't render in Excalidraw's font
`;

/**
 * Creates a new MCP server instance with Excalidraw drawing tools.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "Excalidraw",
    version: "1.0.0",
  });

  const resourceUri = "ui://excalidraw/mcp-app.html";

  // ============================================================
  // Tool 1: read_me (call before drawing)
  // ============================================================
  server.registerTool(
    "read_me",
    {
      description: "Returns the Excalidraw element format reference with color palettes, examples, and tips. Call this BEFORE using create_view for the first time.",
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      return { content: [{ type: "text", text: RECALL_CHEAT_SHEET }] };
    },
  );

  // ============================================================
  // Tool 2: create_view (Excalidraw SVG)
  // ============================================================
  registerAppTool(server,
    "create_view",
    {
      title: "Draw Diagram",
      description: `Renders a hand-drawn diagram using Excalidraw elements.
Elements stream in one by one with draw-on animations.
Call read_me first to learn the element format.`,
      inputSchema: z.object({
        elements: z.string().describe(
          "JSON array string of Excalidraw elements. Must be valid JSON — no comments, no trailing commas. Keep compact. Call read_me first for format reference."
        ),
      }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri } },
    },
    async ({ elements }): Promise<CallToolResult> => {
      try {
        JSON.parse(elements);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid JSON in elements: ${(e as Error).message}. Ensure no comments, no trailing commas, and proper quoting.` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: "Diagram displayed. If the user edits the diagram in fullscreen, updated elements JSON is sent as model context." }] };
    },
  );

  // CSP: allow Excalidraw to load fonts from esm.sh
  // resourceDomains = font-src/script-src/style-src/img-src
  // connectDomains = connect-src (Fetch API, used by Excalidraw's font loader)
  const cspMeta = {
    ui: {
      csp: {
        resourceDomains: ["https://esm.sh"],
        connectDomains: ["https://esm.sh"],
      },
    },
  };

  // Register the single shared resource for all UI tools
  registerAppResource(server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
      return {
        contents: [{
          uri: resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              ...cspMeta.ui,
              prefersBorder: true,
            },
          },
        }],
      };
    },
  );

  return server;
}
