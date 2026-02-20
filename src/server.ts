import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { platform } from "node:os";
import { deflateSync } from "node:zlib";
import { z } from "zod/v4";
import type { CheckpointStore } from "./checkpoint-store.js";

/** Maximum allowed size for element/data input strings (5 MB). */
const MAX_INPUT_BYTES = 5 * 1024 * 1024;

/** Sanitize a string for use as filename (no path, no unsafe chars). */
function sanitizeFilenamePart(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "diagram";
}

/** Build Obsidian excalidraw-plugin markdown (frontmatter, Text Elements, Drawing JSON block). */
function buildObsidianExcalidrawMarkdown(json: string, planLink?: string): string {
  let elements: any[] = [];
  try {
    const doc = JSON.parse(json) as { elements?: any[] };
    elements = Array.isArray(doc.elements) ? doc.elements : [];
  } catch {
    // keep elements empty
  }
  const textLines: string[] = [];
  for (const el of elements) {
    if (el && el.type === "text" && el.id && !el.isDeleted) {
      const text = (el.text ?? el.rawText ?? "").replace(/\n/g, " ");
      textLines.push(`${text} ^${el.id}`);
    }
  }
  const textSection =
    textLines.length > 0
      ? "\n## Text Elements\n" + textLines.join("\n") + "\n"
      : "\n";
  const introLine = planLink ? `*This diagram was auto-generated via Excalidraw MCP. Plan: ${planLink}*\n\n` : "";
  return `---
excalidraw-plugin: parsed
tags: [excalidraw]

---
${introLine}==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'


# Excalidraw Data
${textSection}%%
## Drawing
\`\`\`json
${json}
\`\`\`
%%`;
}

/** Build plan markdown file content. */
function buildPlanMarkdown(plan: string): string {
  return `---
tags: [excalidraw, plan]
---

# Diagram Plan

${plan}
`;
}

// Works both from source (src/server.ts) and compiled (dist/server.js)
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "..", "dist")
  : import.meta.dirname;

// ============================================================
// RECALL: shared knowledge for the agent
// ============================================================
const RECALL_CHEAT_SHEET = `# Excalidraw Element Format

Thanks for calling read_me! Do NOT call it again in this conversation — you will not see anything new. Now use create_view to draw.

## REQUIRED: plan parameter

create_view requires a \`plan\` parameter. Provide 2-5 sentences or bullet points describing:
- Diagram structure and what each part represents
- Narrative or camera flow
This plan is saved with the diagram and becomes a \`.plan.md\` file in Obsidian when the user saves — for traceability.

## Visual Style Guide — Black-Dominant, Hierarchy-First

### Dominance Rule
Diagrams should be **predominantly black/slate** (neutral tones). Use colors **only when they carry clear semantic meaning**. Avoid rainbow diagrams — color should signal meaning, not decorate.

### Color Palette (Background + Text Pairings)
| Name | Background | Text | Use |
|------|------------|------|-----|
| White | \`#ffffff\` | \`#4b5c6b\` | Light nodes, chips, details |
| Smoke | \`#c3cfd9\` | \`#4b5c6b\` | Light siblings separation |
| Slate | \`#4b5c6b\` | \`#ffffff\` | Primary dark nodes (default) |
| Black | \`#1e1e1e\` | \`#ffffff\` | Deep containers, emphasis |
| Blue | \`#2c88d9\` | \`#ffffff\` | User / human entities |
| Green | \`#207868\` | \`#ffffff\` | Positive: deposit, reward, addition, validation |
| Red | \`#d3455b\` | \`#ffffff\` | Negative: removal, withdraw, suppression, delete |
| Yellow | \`#f7c325\` | \`#ffffff\` | Pending, waiting, in-progress |
| Orange | \`#e8833a\` | \`#ffffff\` | Caution, retry, deferred |
| Mint | \`#1aae9f\` | \`#ffffff\` | Info, secondary positive |
| Indigo | \`#6558f5\` | \`#ffffff\` | Accent, special |
| Pink | \`#bd34d1\` | \`#ffffff\` | Accent, decorative |

### Hierarchy Styling Rules (ALTERNATE BY DEPTH)

**Level 0 — Primary nodes/entities:**
- Solid dark fill (\`#4b5c6b\` or \`#1e1e1e\`), no visible border/stroke, **white text**
- These are standalone entities, not containers

**Level 1 — Sub-elements (details inside Level 0):**
- Light fill (\`#ffffff\` or \`#c3cfd9\`), no visible border/stroke, **dark text** (\`#4b5c6b\`)
- Displayed as small chips or tags inside their parent
- Example: feature list inside a container, attributes of an entity

**Level 2 — Nested inside Level 1:**
- Back to dark solid fill + white text (same as Level 0)
- Use when you have deeper nesting: container → chips → sub-chips

**Pattern: Always alternate dark↔light by depth.**
- Dark parent → contains → Light children → contains → Dark grandchildren → ...

### Zones / Grouping (boundaries only)
- Stroke only, **no fill**
- Dashed border, muted color (\`#788896\` or similar)
- Used to visually group related elements without competing for attention

### Connections / Arrows
- Default: single neutral line color (Slate \`#4b5c6b\` or Black \`#1e1e1e\`)
- Short descriptive labels (white text on dark arrows, dark text on light arrows)
- Flow follows hierarchy (top-down or left-to-right)

### Text Contrast Rule (CRITICAL)
- On dark fills (\`#4b5c6b\`, \`#1e1e1e\`, colored) → **white text only** (\`#ffffff\`)
- On light fills (\`#ffffff\`, \`#c3cfd9\`) → **dark text only** (\`#4b5c6b\`)
- **Never use colored text** — only black or white depending on background

### Semantic Color Mapping (USE SPARINGLY)
- **Green \`#207868\`**: deposit, reward, addition, validation, success, completed
- **Red \`#d3455b\`**: removal, withdraw, suppression, delete, error, critical
- **Blue \`#2c88d9\`**: user, human actor, person entity
- **Yellow \`#f7c325\`**: pending, waiting, in-progress state
- **Orange \`#e8833a\`**: caution, retry, deferred, postponed

**Rule:** If color has no clear meaning → use black/slate (neutral)

---

## Excalidraw Elements

### Required Fields (all elements)
\`type\`, \`id\` (unique string), \`x\`, \`y\`, \`width\`, \`height\`

### Defaults (skip these)
strokeColor="#1e1e1e", backgroundColor="transparent", fillStyle="solid", strokeWidth=2, roughness=0, opacity=100
Canvas background is white.

### Element Types

**Rectangle**: \`{ "type": "rectangle", "id": "r1", "x": 100, "y": 100, "width": 200, "height": 100 }\`
- \`roundness: { type: 3 }\` for rounded corners
- \`backgroundColor: "#a5d8ff"\`, \`fillStyle: "solid"\` for filled

**Ellipse**: \`{ "type": "ellipse", "id": "e1", "x": 100, "y": 100, "width": 150, "height": 150 }\`

**Diamond**: \`{ "type": "diamond", "id": "d1", "x": 100, "y": 100, "width": 150, "height": 150 }\`

**Labeled shape (REQUIRED for all shape text)** — ALWAYS use \`label\` on shapes. NEVER use standalone text for group/section titles or labels inside/on shapes.
\`{ "type": "rectangle", "id": "r1", "x": 100, "y": 100, "width": 200, "height": 80, "label": { "text": "Hello", "fontSize": 20 } }\`
- Works on rectangle, ellipse, diamond
- Text auto-centers and container auto-resizes to fit; avoids truncation bugs from floating text
- For group containers: put the group title in the container's \`label\`, e.g. \`{ "type": "rectangle", "id": "group1", "x": 50, "y": 50, "width": 400, "height": 300, "label": { "text": "Smart Contracts & Protocol", "fontSize": 20 } }\`
- Inner boxes: also use \`label\` on each shape (e.g. "contract-audits", "contracts-v2")

**Labeled arrow**: \`"label": { "text": "connects" }\` on an arrow element.

**Standalone text** — use ONLY for annotations that are not titles or labels of a shape (e.g. a note outside any box). Do NOT use for group titles or labels on/in shapes; those MUST be shape \`label\` to avoid truncation.
\`{ "type": "text", "id": "t1", "x": 150, "y": 138, "text": "Hello", "fontSize": 20 }\`
- x is the LEFT edge of the text. estimatedWidth ≈ text.length × fontSize × 0.5

**Arrow**: \`{ "type": "arrow", "id": "a1", "x": 300, "y": 150, "width": 200, "height": 0, "points": [[0,0],[200,0]], "endArrowhead": "triangle" }\`
- points: [dx, dy] offsets from element x,y
- endArrowhead: use "triangle" (MCP enforces this)
- ALWAYS add startBinding and endBinding so arrows follow shapes when groups move

### Arrow Bindings (REQUIRED)
Arrow: \`"startBinding": { "elementId": "r1", "fixedPoint": [1, 0.5] }\`, \`"endBinding": { "elementId": "r2", "fixedPoint": [0, 0.5] }\`
fixedPoint: top=[0.5,0], bottom=[0.5,1], left=[0,0.5], right=[1,0.5]
- MCP auto-binds arrows to closest shapes when bindings are missing

**cameraUpdate** (pseudo-element — controls the viewport, not drawn):
\`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\`
- x, y: top-left corner of the visible area (scene coordinates)
- width, height: size of the visible area — MUST be 4:3 ratio (400×300, 600×450, 800×600, 1200×900, 1600×1200)
- Animates smoothly between positions — use multiple cameraUpdates to guide attention as you draw
- No \`id\` needed — this is not a drawn element

**delete** (pseudo-element — removes elements by id):
\`{ "type": "delete", "ids": "b2,a1,t3" }\`
- Comma-separated list of element ids to remove
- Also removes bound text elements (matching \`containerId\`)
- Place AFTER the elements you want to remove
- Never reuse a deleted id — always assign new ids to replacements

### Drawing Order (CRITICAL for streaming)
- Array order = z-order (first = back, last = front)
- **Emit progressively**: each shape WITH its \`label\` (no separate text element for that shape's title/label) → arrows → next shape
- BAD: all rectangles → all texts → all arrows; or group title as floating text
- GOOD: bg_shape (with label if it has a title) → shape1 (with label) → arrow1 → shape2 (with label) → ...

### Example: Two connected labeled boxes
\`\`\`json
[
  { "type": "cameraUpdate", "width": 800, "height": 600, "x": 50, "y": 50 },
  { "type": "rectangle", "id": "b1", "x": 100, "y": 100, "width": 200, "height": 100, "roundness": { "type": 3 }, "backgroundColor": "#a5d8ff", "fillStyle": "solid", "label": { "text": "Start", "fontSize": 20 } },
  { "type": "rectangle", "id": "b2", "x": 450, "y": 100, "width": 200, "height": 100, "roundness": { "type": 3 }, "backgroundColor": "#b2f2bb", "fillStyle": "solid", "label": { "text": "End", "fontSize": 20 } },
  { "type": "arrow", "id": "a1", "x": 300, "y": 150, "width": 150, "height": 0, "points": [[0,0],[150,0]], "endArrowhead": "triangle", "startBinding": { "elementId": "b1", "fixedPoint": [1, 0.5] }, "endBinding": { "elementId": "b2", "fixedPoint": [0, 0.5] } }
]
\`\`\`

### Camera & Sizing (CRITICAL for readability)

The diagram displays inline at ~700px width. Design for this constraint.

**Recommended camera sizes (4:3 aspect ratio ONLY):**
- Camera **S**: width 400, height 300 — close-up on a small group (2-3 elements)
- Camera **M**: width 600, height 450 — medium view, a section of a diagram
- Camera **L**: width 800, height 600 — standard full diagram (DEFAULT)
- Camera **XL**: width 1200, height 900 — large diagram overview. WARNING: font size smaller than 18 is unreadable
- Camera **XXL**: width 1600, height 1200 — panorama / final overview of complex diagrams. WARNING: minimum readable font size is 21

ALWAYS use one of these exact sizes. Non-4:3 viewports cause distortion.

**Font size rules:**
- Minimum fontSize: **16** for body text, labels, descriptions
- Minimum fontSize: **20** for titles and headings
- Minimum fontSize: **14** for secondary annotations only (sparingly)
- NEVER use fontSize below 14 — it becomes unreadable at display scale

**Element sizing rules:**
- Minimum shape size: 120×60 for labeled rectangles/ellipses
- Leave 20-30px gaps between elements minimum
- Prefer fewer, larger elements over many tiny ones

ALWAYS start with a \`cameraUpdate\` as the FIRST element. For example:
\`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\`

- x, y: top-left corner of visible area (scene coordinates)
- ALWAYS emit the cameraUpdate BEFORE drawing the elements it frames — camera moves first, then content appears
- The camera animates smoothly between positions
- Leave padding: don't match camera size to content size exactly (e.g., 500px content in 800x600 camera)

Examples:
\`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\` — standard view
\`{ "type": "cameraUpdate", "width": 400, "height": 300, "x": 200, "y": 100 }\` — zoom into a detail
\`{ "type": "cameraUpdate", "width": 1600, "height": 1200, "x": -50, "y": -50 }\` — panorama overview

Tip: For large diagrams, emit a cameraUpdate to focus on each section as you draw it.

## Diagram Example

Example prompt: "Explain how photosynthesis works"

Uses 2 camera positions: start zoomed in (M) for title, then zoom out (L) to reveal the full diagram. Sun art drawn last as a finishing touch.

- **Camera 1** (400x300): Draw the title "Photosynthesis" and formula subtitle zoomed in
- **Camera 2** (800x600): Zoom out — draw the leaf zone (dashed boundary), dark container for the leaf, light chip elements inside for inputs/outputs, arrows showing flow

\`\`\`json
[
  {"type":"cameraUpdate","width":400,"height":300,"x":200,"y":-20},
  {"type":"text","id":"ti","x":280,"y":10,"text":"Photosynthesis","fontSize":28,"strokeColor":"#1e1e1e"},
  {"type":"text","id":"fo","x":245,"y":48,"text":"6CO2 + 6H2O --> C6H12O6 + 6O2","fontSize":16,"strokeColor":"#4b5c6b"},
  {"type":"cameraUpdate","width":800,"height":600,"x":0,"y":-20},
  {"type":"rectangle","id":"leafZone","x":150,"y":90,"width":520,"height":380,"fillStyle":"solid","strokeColor":"#788896","strokeWidth":1,"strokeStyle":"dashed","backgroundColor":"transparent"},
  {"type":"text","id":"lfl","x":170,"y":96,"text":"Inside the Leaf","fontSize":16,"strokeColor":"#4b5c6b"},
  {"type":"rectangle","id":"leafContainer","x":180,"y":140,"width":460,"height":300,"fillStyle":"solid","strokeColor":"transparent","backgroundColor":"#4b5c6b","label":{"text":"Leaf Cell","fontSize":18}},
  {"type":"rectangle","id":"lr","x":200,"y":210,"width":180,"height":60,"fillStyle":"solid","strokeColor":"transparent","backgroundColor":"#ffffff","label":{"text":"Light Reactions","fontSize":16}},
  {"type":"rectangle","id":"cc","x":420,"y":210,"width":180,"height":60,"fillStyle":"solid","strokeColor":"transparent","backgroundColor":"#ffffff","label":{"text":"Calvin Cycle","fontSize":16}},
  {"type":"arrow","id":"a1","x":380,"y":240,"width":40,"height":0,"points":[[0,0],[40,0]],"strokeColor":"#1e1e1e","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"ATP","fontSize":14}},
  {"type":"rectangle","id":"sl","x":30,"y":200,"width":100,"height":40,"fillStyle":"solid","strokeColor":"transparent","backgroundColor":"#f7c325","label":{"text":"Sunlight","fontSize":14}},
  {"type":"arrow","id":"a2","x":130,"y":220,"width":70,"height":0,"points":[[0,0],[70,0]],"strokeColor":"#f7c325","strokeWidth":2,"endArrowhead":"arrow"},
  {"type":"rectangle","id":"wa","x":200,"y":360,"width":100,"height":35,"fillStyle":"solid","strokeColor":"transparent","backgroundColor":"#2c88d9","label":{"text":"H2O","fontSize":14}},
  {"type":"arrow","id":"a3","x":250,"y":360,"width":0,"height":-80,"points":[[0,0],[0,-80]],"strokeColor":"#2c88d9","strokeWidth":2,"endArrowhead":"arrow"},
  {"type":"rectangle","id":"co","x":480,"y":360,"width":80,"height":35,"fillStyle":"solid","strokeColor":"transparent","backgroundColor":"#ffffff","label":{"text":"CO2","fontSize":14}},
  {"type":"arrow","id":"a4","x":520,"y":360,"width":0,"height":-80,"points":[[0,0],[0,-80]],"strokeColor":"#4b5c6b","strokeWidth":2,"endArrowhead":"arrow"},
  {"type":"rectangle","id":"ox","x":530,"y":130,"width":80,"height":35,"fillStyle":"solid","strokeColor":"transparent","backgroundColor":"#207868","label":{"text":"O2","fontSize":14}},
  {"type":"arrow","id":"a5","x":290,"y":210,"width":240,"height":-50,"points":[[0,0],[240,-50]],"strokeColor":"#207868","strokeWidth":2,"endArrowhead":"arrow"},
  {"type":"rectangle","id":"gl","x":660,"y":210,"width":100,"height":50,"fillStyle":"solid","strokeColor":"transparent","backgroundColor":"#207868","label":{"text":"Glucose","fontSize":16}},
  {"type":"arrow","id":"a6","x":600,"y":235,"width":60,"height":0,"points":[[0,0],[60,0]],"strokeColor":"#207868","strokeWidth":2,"endArrowhead":"arrow"},
  {"type":"ellipse","id":"sun","x":30,"y":100,"width":50,"height":50,"fillStyle":"solid","strokeColor":"#f7c325","strokeWidth":2,"backgroundColor":"#f7c325"},
  {"type":"arrow","id":"r1","x":55,"y":98,"width":0,"height":-14,"points":[[0,0],[0,-14]],"strokeColor":"#f7c325","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r2","x":55,"y":152,"width":0,"height":14,"points":[[0,0],[0,14]],"strokeColor":"#f7c325","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r3","x":28,"y":125,"width":-14,"height":0,"points":[[0,0],[-14,0]],"strokeColor":"#f7c325","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r4","x":82,"y":125,"width":14,"height":0,"points":[[0,0],[14,0]],"strokeColor":"#f7c325","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r5","x":73,"y":107,"width":10,"height":-10,"points":[[0,0],[10,-10]],"strokeColor":"#f7c325","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r6","x":37,"y":107,"width":-10,"height":-10,"points":[[0,0],[-10,-10]],"strokeColor":"#f7c325","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r7","x":73,"y":143,"width":10,"height":10,"points":[[0,0],[10,10]],"strokeColor":"#f7c325","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r8","x":37,"y":143,"width":-10,"height":10,"points":[[0,0],[-10,10]],"strokeColor":"#f7c325","strokeWidth":2,"endArrowhead":null,"startArrowhead":null}
]
\`\`\`

Common mistakes to avoid:
- **Camera size must match content with padding** — if your content is 500px tall, use 800x600 camera, not 500px. No padding = truncated edges
- **Center titles relative to the diagram below** — estimate the diagram's total width and center the title text over it, not over the canvas
- **Arrow labels need space** — long labels like "ATP + NADPH" overflow short arrows. Keep labels short or make arrows wider
- **Elements overlap when y-coordinates are close** — always check that text, boxes, and labels don't stack on top of each other (e.g., an output box overlapping a zone label)
- **Draw art/illustrations LAST** — cute decorations (sun, stars, icons) should appear as the final drawing step so they don't distract from the main content being built

## Sequence flow Diagram Example

Example prompt: "show a sequence diagram explaining MCP Apps"

This demonstrates a UML-style sequence diagram with 4 actors (User, Agent, App iframe, MCP Server), dashed lifelines, and labeled arrows showing the full MCP Apps request/response flow. Camera pans progressively across the diagram:

- **Camera 1** (600x450): Title "MCP Apps — Sequence Flow"
- **Cameras 2–5** (400x300 each): Zoom into each actor column right-to-left — draw header box + dashed lifeline for Server, App, Agent, User. Right-to-left so the camera snakes smoothly: pan left across actors, then pan right following the first message arrows
- **Camera 6** (400x300): Zoom into User — draw stick figure (head + body)
- **Camera 7** (600x450): Zoom out — draw first message arrows: user prompt → agent, agent tools/call → server, tool result back, result forwarded to app iframe
- **Camera 8** (600x450): Pan down — draw user interaction with app, app requesting tools/call back to agent
- **Camera 9** (600x450): Pan further down — agent forwards to server, fresh data flows back through the chain, context update from app to agent
- **Camera 10** (800x600): Final zoom-out showing the complete sequence

\`\`\`json
[
  {"type":"cameraUpdate","width":600,"height":450,"x":80,"y":-10},
  {"type":"text","id":"title","x":200,"y":15,"text":"MCP Apps — Sequence Flow","fontSize":24,"strokeColor":"#1e1e1e"},

  {"type":"cameraUpdate","width":400,"height":300,"x":450,"y":-5},
  {"type":"rectangle","id":"sHead","x":600,"y":60,"width":130,"height":40,"backgroundColor":"#4b5c6b","fillStyle":"solid","strokeColor":"transparent","label":{"text":"MCP Server","fontSize":16}},
  {"type":"arrow","id":"sLine","x":665,"y":100,"width":0,"height":490,"points":[[0,0],[0,490]],"strokeColor":"#788896","strokeWidth":1,"strokeStyle":"dashed","endArrowhead":null},

  {"type":"cameraUpdate","width":400,"height":300,"x":250,"y":-5},
  {"type":"rectangle","id":"appHead","x":400,"y":60,"width":130,"height":40,"backgroundColor":"#ffffff","fillStyle":"solid","strokeColor":"transparent","label":{"text":"App iframe","fontSize":16}},
  {"type":"arrow","id":"appLine","x":465,"y":100,"width":0,"height":490,"points":[[0,0],[0,490]],"strokeColor":"#788896","strokeWidth":1,"strokeStyle":"dashed","endArrowhead":null},

  {"type":"cameraUpdate","width":400,"height":300,"x":80,"y":-5},
  {"type":"rectangle","id":"aHead","x":230,"y":60,"width":100,"height":40,"backgroundColor":"#ffffff","fillStyle":"solid","strokeColor":"transparent","label":{"text":"Agent","fontSize":16}},
  {"type":"arrow","id":"aLine","x":280,"y":100,"width":0,"height":490,"points":[[0,0],[0,490]],"strokeColor":"#788896","strokeWidth":1,"strokeStyle":"dashed","endArrowhead":null},

  {"type":"cameraUpdate","width":400,"height":300,"x":-10,"y":-5},
  {"type":"rectangle","id":"uHead","x":60,"y":60,"width":100,"height":40,"backgroundColor":"#2c88d9","fillStyle":"solid","strokeColor":"transparent","label":{"text":"User","fontSize":16}},
  {"type":"arrow","id":"uLine","x":110,"y":100,"width":0,"height":490,"points":[[0,0],[0,490]],"strokeColor":"#788896","strokeWidth":1,"strokeStyle":"dashed","endArrowhead":null},

  {"type":"cameraUpdate","width":400,"height":300,"x":-40,"y":50},
  {"type":"ellipse","id":"uh","x":58,"y":110,"width":20,"height":20,"backgroundColor":"#2c88d9","fillStyle":"solid","strokeColor":"transparent"},
  {"type":"rectangle","id":"ub","x":57,"y":132,"width":22,"height":26,"backgroundColor":"#2c88d9","fillStyle":"solid","strokeColor":"transparent"},

  {"type":"cameraUpdate","width":600,"height":450,"x":-20,"y":-30},
  {"type":"arrow","id":"m1","x":110,"y":135,"width":170,"height":0,"points":[[0,0],[170,0]],"strokeColor":"#1e1e1e","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"display a chart","fontSize":14}},
  {"type":"rectangle","id":"note1","x":130,"y":162,"width":310,"height":26,"backgroundColor":"#c3cfd9","fillStyle":"solid","strokeColor":"transparent","label":{"text":"Interactive app rendered in chat","fontSize":14}},

  {"type":"cameraUpdate","width":600,"height":450,"x":170,"y":25},
  {"type":"arrow","id":"m2","x":280,"y":210,"width":385,"height":0,"points":[[0,0],[385,0]],"strokeColor":"#4b5c6b","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"tools/call","fontSize":16}},
  {"type":"arrow","id":"m3","x":665,"y":250,"width":-385,"height":0,"points":[[0,0],[-385,0]],"strokeColor":"#4b5c6b","strokeWidth":2,"endArrowhead":"arrow","strokeStyle":"dashed","label":{"text":"tool input/result","fontSize":16}},
  {"type":"arrow","id":"m4","x":280,"y":290,"width":185,"height":0,"points":[[0,0],[185,0]],"strokeColor":"#4b5c6b","strokeWidth":2,"endArrowhead":"arrow","strokeStyle":"dashed","label":{"text":"result → app","fontSize":16}},

  {"type":"cameraUpdate","width":600,"height":450,"x":-10,"y":135},
  {"type":"arrow","id":"m5","x":110,"y":340,"width":355,"height":0,"points":[[0,0],[355,0]],"strokeColor":"#2c88d9","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"user interacts","fontSize":16}},
  {"type":"arrow","id":"m6","x":465,"y":380,"width":-185,"height":0,"points":[[0,0],[-185,0]],"strokeColor":"#207868","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"tools/call request","fontSize":16}},

  {"type":"cameraUpdate","width":600,"height":450,"x":170,"y":235},
  {"type":"arrow","id":"m7","x":280,"y":420,"width":385,"height":0,"points":[[0,0],[385,0]],"strokeColor":"#4b5c6b","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"tools/call (forwarded)","fontSize":16}},
  {"type":"arrow","id":"m8","x":665,"y":460,"width":-385,"height":0,"points":[[0,0],[-385,0]],"strokeColor":"#4b5c6b","strokeWidth":2,"endArrowhead":"arrow","strokeStyle":"dashed","label":{"text":"fresh data","fontSize":16}},
  {"type":"arrow","id":"m9","x":280,"y":500,"width":185,"height":0,"points":[[0,0],[185,0]],"strokeColor":"#4b5c6b","strokeWidth":2,"endArrowhead":"arrow","strokeStyle":"dashed","label":{"text":"fresh data","fontSize":16}},

  {"type":"cameraUpdate","width":600,"height":450,"x":50,"y":327},
  {"type":"rectangle","id":"note2","x":130,"y":522,"width":310,"height":26,"backgroundColor":"#c3cfd9","fillStyle":"solid","strokeColor":"transparent","label":{"text":"App updates with new data","fontSize":14}},
  {"type":"arrow","id":"m10","x":465,"y":570,"width":-185,"height":0,"points":[[0,0],[-185,0]],"strokeColor":"#207868","strokeWidth":2,"endArrowhead":"arrow","strokeStyle":"dashed","label":{"text":"context update","fontSize":16}},

  {"type":"cameraUpdate","width":800,"height":600,"x":-5,"y":2}
]
\`\`\`

## Checkpoints (restoring previous state)

Every create_view call returns a \`checkpointId\` in its response. To continue from a previous diagram state, start your elements array with a restoreCheckpoint element:

\`[{"type":"restoreCheckpoint","id":"<checkpointId>"}, ...additional new elements...]\`

The saved state (including any user edits made in fullscreen) is loaded from the client, and your new elements are appended on top. This saves tokens — you don't need to re-send the entire diagram.

## Deleting Elements

Remove elements by id using the \`delete\` pseudo-element:

\`{"type":"delete","ids":"b2,a1,t3"}\`

Works in two modes:
- **With restoreCheckpoint**: restore a saved state, then surgically remove specific elements before adding new ones
- **Inline (animation mode)**: draw elements, then delete and replace them later in the same array to create transformation effects

Place delete entries AFTER the elements you want to remove. The final render filters them out.

**IMPORTANT**: Every element id must be unique. Never reuse an id after deleting it — always assign a new id to replacement elements.

## Animation Mode — Transform in Place

Instead of building left-to-right and panning away, you can animate by DELETING elements and replacing them at the same position. Combined with slight camera moves, this creates smooth visual transformations during streaming.

Pattern:
1. Draw initial elements
2. cameraUpdate (shift/zoom slightly)
3. \`{"type":"delete","ids":"old1,old2"}\`
4. Draw replacements at same coordinates (different color/content)
5. Repeat

Example prompt: "Pixel snake eats apple"

Snake moves right by adding a head segment and deleting the tail. On eating the apple, tail is NOT deleted (snake grows). Camera nudges between frames add subtle motion.

\`\`\`json
[
  {"type":"cameraUpdate","width":400,"height":300,"x":0,"y":0},
  {"type":"ellipse","id":"ap","x":260,"y":78,"width":20,"height":20,"backgroundColor":"#d3455b","fillStyle":"solid","strokeColor":"#d3455b"},
  {"type":"rectangle","id":"s0","x":60,"y":130,"width":28,"height":28,"backgroundColor":"#4b5c6b","fillStyle":"solid","strokeColor":"transparent"},
  {"type":"rectangle","id":"s1","x":88,"y":130,"width":28,"height":28,"backgroundColor":"#4b5c6b","fillStyle":"solid","strokeColor":"transparent"},
  {"type":"rectangle","id":"s2","x":116,"y":130,"width":28,"height":28,"backgroundColor":"#4b5c6b","fillStyle":"solid","strokeColor":"transparent"},
  {"type":"rectangle","id":"s3","x":144,"y":130,"width":28,"height":28,"backgroundColor":"#4b5c6b","fillStyle":"solid","strokeColor":"transparent"},
  {"type":"cameraUpdate","width":400,"height":300,"x":1,"y":0},
  {"type":"rectangle","id":"s4","x":172,"y":130,"width":28,"height":28,"backgroundColor":"#4b5c6b","fillStyle":"solid","strokeColor":"transparent"},
  {"type":"delete","ids":"s0"},
  {"type":"cameraUpdate","width":400,"height":300,"x":0,"y":1},
  {"type":"rectangle","id":"s5","x":200,"y":130,"width":28,"height":28,"backgroundColor":"#4b5c6b","fillStyle":"solid","strokeColor":"transparent"},
  {"type":"delete","ids":"s1"},
  {"type":"cameraUpdate","width":400,"height":300,"x":1,"y":0},
  {"type":"rectangle","id":"s6","x":228,"y":130,"width":28,"height":28,"backgroundColor":"#4b5c6b","fillStyle":"solid","strokeColor":"transparent"},
  {"type":"delete","ids":"s2"},
  {"type":"cameraUpdate","width":400,"height":300,"x":0,"y":0},
  {"type":"rectangle","id":"s7","x":256,"y":130,"width":28,"height":28,"backgroundColor":"#4b5c6b","fillStyle":"solid","strokeColor":"transparent"},
  {"type":"delete","ids":"s3"},
  {"type":"cameraUpdate","width":400,"height":300,"x":1,"y":1},
  {"type":"rectangle","id":"s8","x":256,"y":102,"width":28,"height":28,"backgroundColor":"#4b5c6b","fillStyle":"solid","strokeColor":"transparent"},
  {"type":"delete","ids":"s4"},
  {"type":"cameraUpdate","width":400,"height":300,"x":0,"y":0},
  {"type":"rectangle","id":"s9","x":256,"y":74,"width":28,"height":28,"backgroundColor":"#4b5c6b","fillStyle":"solid","strokeColor":"transparent"},
  {"type":"delete","ids":"ap"},
  {"type":"cameraUpdate","width":400,"height":300,"x":1,"y":0},
  {"type":"rectangle","id":"s10","x":256,"y":46,"width":28,"height":28,"backgroundColor":"#4b5c6b","fillStyle":"solid","strokeColor":"transparent"},
  {"type":"delete","ids":"s5"}
]
\`\`\`

Key techniques:
- Add head + delete tail each frame = snake movement illusion
- On eat: delete apple instead of tail = snake grows by one
- Post-eat frame resumes normal add-head/delete-tail, proving the snake is now longer
- Camera nudges (0,0 → 1,0 → 0,1 → ...) add subtle motion between frames
- Always use NEW ids for added segments (s0→s4→s5→...); never reuse deleted ids

## Dark Mode

If the user asks for a dark theme/mode diagram, use a massive dark background rectangle as the FIRST element (before cameraUpdate). Make it 10x the camera size so it covers the entire viewport even when panning:

\`{"type":"rectangle","id":"darkbg","x":-4000,"y":-3000,"width":10000,"height":7500,"backgroundColor":"#1e1e1e","fillStyle":"solid","strokeColor":"transparent","strokeWidth":0}\`

Then use these colors on the dark background:

**Text colors (on dark):**
- White \`#ffffff\` for all text (primary and secondary)
- Avoid muted grays on dark — they become hard to read

**Shape fills (on dark) — use lighter variants:**
| Color | Background | Use |
|-------|------------|-----|
| Slate Light | \`#788896\` | Primary nodes |
| Blue Light | \`#5a9fd9\` | User / human |
| Green Light | \`#3a9a8a\` | Positive: deposit, reward, validation |
| Red Light | \`#d96075\` | Negative: removal, delete, error |
| Yellow Light | \`#f7c325\` | Pending, waiting |
| Orange Light | \`#e8833a\` | Caution, retry |
| White | \`#ffffff\` | Light chips/details |

**Stroke/arrow colors (on dark):**
- Use Slate \`#788896\` or White \`#ffffff\` for arrows
- Never use dark colors that blend into the background

## Tips
- Do NOT call read_me again — you already have everything you need
- Use the color palette consistently from the Visual Style Guide above
- **Text contrast is CRITICAL** — always use white text on dark fills, dark text on light fills. Never use colored text.
- **Prefer black/slate over colored fills** — unless color carries clear semantic meaning (see semantic mapping)
- Do NOT use emoji in text — they don't render in Excalidraw's font
- cameraUpdate is MAGICAL and users love it! please use it a lot to guide the user's attention as you draw. It makes a huge difference in readability and engagement.
`;

/**
 * Registers all Excalidraw tools and resources on the given McpServer.
 * Shared between local (main.ts) and Vercel (api/mcp.ts) entry points.
 */
export function registerTools(server: McpServer, distDir: string, store: CheckpointStore): void {
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
        plan: z.string().min(1).describe(
          "Required: 2-5 sentences or bullet points describing the diagram structure, what each part represents, and the narrative/camera flow. This plan is saved with the diagram and becomes a .plan.md file in Obsidian for traceability."
        ),
      }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri } },
    },
    async ({ elements, plan }): Promise<CallToolResult> => {
      if (elements.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Elements input exceeds ${MAX_INPUT_BYTES} byte limit. Reduce the number of elements or use checkpoints to build incrementally.` }],
          isError: true,
        };
      }
      let parsed: any[];
      try {
        parsed = JSON.parse(elements);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid JSON in elements: ${(e as Error).message}. Ensure no comments, no trailing commas, and proper quoting.` }],
          isError: true,
        };
      }

      // Resolve restoreCheckpoint references and save fully resolved state
      const restoreEl = parsed.find((el: any) => el.type === "restoreCheckpoint");
      let resolvedElements: any[];

      let planToSave = plan;
      if (restoreEl?.id) {
        const base = await store.load(restoreEl.id);
        if (!base) {
          return {
            content: [{ type: "text", text: `Checkpoint "${restoreEl.id}" not found — it may have expired or never existed. Please recreate the diagram from scratch.` }],
            isError: true,
          };
        }
        planToSave = plan ?? base.plan ?? "";

        const deleteIds = new Set<string>();
        for (const el of parsed) {
          if (el.type === "delete") {
            for (const id of String(el.ids ?? el.id).split(",")) deleteIds.add(id.trim());
          }
        }

        const baseFiltered = base.elements.filter((el: any) =>
          !deleteIds.has(el.id) && !deleteIds.has(el.containerId)
        );
        const newEls = parsed.filter((el: any) =>
          el.type !== "restoreCheckpoint" && el.type !== "delete"
        );
        resolvedElements = [...baseFiltered, ...newEls];
      } else {
        resolvedElements = parsed.filter((el: any) => el.type !== "delete");
      }

      // Check camera aspect ratios — nudge toward 4:3
      const cameras = parsed.filter((el: any) => el.type === "cameraUpdate");
      const badRatio = cameras.find((c: any) => {
        if (!c.width || !c.height) return false;
        const ratio = c.width / c.height;
        return Math.abs(ratio - 4 / 3) > 0.15;
      });
      const ratioHint = badRatio
        ? `\nTip: your cameraUpdate used ${badRatio.width}x${badRatio.height} — try to stick with 4:3 aspect ratio (e.g. 400x300, 800x600) in future.`
        : "";

      const checkpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
      await store.save(checkpointId, { elements: resolvedElements, plan: planToSave });
      return {
        content: [{ type: "text", text: `Diagram displayed! Checkpoint id: "${checkpointId}".
If user asks to create a new diagram - simply create a new one from scratch.
However, if the user wants to edit something on this diagram "${checkpointId}", take these steps:
1) read widget context (using read_widget_context tool) to check if user made any manual edits first
2) decide whether you want to make new diagram from scratch OR - use this one as starting checkpoint:
  simply start from the first element [{"type":"restoreCheckpoint","id":"${checkpointId}"}, ...your new elements...]
  this will use same diagram state as the user currently sees, including any manual edits they made in fullscreen, allowing you to add elements on top.
  To remove elements, use: {"type":"delete","ids":"<id1>,<id2>"}${ratioHint}` }],
        structuredContent: { checkpointId },
      };
    },
  );

  // ============================================================
  // Tool 3: export_to_excalidraw (server-side proxy for CORS)
  // Called by widget via app.callServerTool(), not by the model.
  // ============================================================
  registerAppTool(server,
    "export_to_excalidraw",
    {
      description: "Upload diagram to excalidraw.com and return shareable URL.",
      inputSchema: { json: z.string().describe("Serialized Excalidraw JSON") },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ json }): Promise<CallToolResult> => {
      if (json.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Export data exceeds ${MAX_INPUT_BYTES} byte limit.` }],
          isError: true,
        };
      }
      try {
        // --- Excalidraw v2 binary format ---
        const remappedJson = json;
        // concatBuffers: [version=1 (4B)] [len₁ (4B)] [data₁] [len₂ (4B)] [data₂] ...
        const concatBuffers = (...bufs: Uint8Array[]): Uint8Array => {
          let total = 4; // version header
          for (const b of bufs) total += 4 + b.length;
          const out = new Uint8Array(total);
          const dv = new DataView(out.buffer);
          dv.setUint32(0, 1); // CONCAT_BUFFERS_VERSION = 1
          let off = 4;
          for (const b of bufs) {
            dv.setUint32(off, b.length);
            off += 4;
            out.set(b, off);
            off += b.length;
          }
          return out;
        };
        const te = new TextEncoder();

        // 1. Inner payload: concatBuffers(fileMetadata, data)
        const fileMetadata = te.encode(JSON.stringify({}));
        const dataBytes = te.encode(remappedJson);
        const innerPayload = concatBuffers(fileMetadata, dataBytes);

        // 2. Compress inner payload with zlib deflate
        const compressed = deflateSync(Buffer.from(innerPayload));

        // 3. Generate AES-GCM 128-bit key + encrypt
        const cryptoKey = await globalThis.crypto.subtle.generateKey(
          { name: "AES-GCM", length: 128 },
          true,
          ["encrypt"],
        );
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          cryptoKey,
          compressed,
        );

        // 4. Encoding metadata (tells excalidraw.com how to decode)
        const encodingMeta = te.encode(JSON.stringify({
          version: 2,
          compression: "pako@1",
          encryption: "AES-GCM",
        }));

        // 5. Outer payload: concatBuffers(encodingMeta, iv, encryptedData)
        const payload = Buffer.from(concatBuffers(encodingMeta, iv, new Uint8Array(encrypted)));

        // 5. Upload to excalidraw backend
        const res = await fetch("https://json.excalidraw.com/api/v2/post/", {
          method: "POST",
          body: payload,
        });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const { id } = (await res.json()) as { id: string };

        // 6. Export key as base64url string
        const jwk = await globalThis.crypto.subtle.exportKey("jwk", cryptoKey);
        const url = `https://excalidraw.com/#json=${id},${jwk.k}`;

        return { content: [{ type: "text", text: url }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Export failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  // Tool 4: save_checkpoint (private — widget only, for user edits)
  // ============================================================
  registerAppTool(server,
    "save_checkpoint",
    {
      description: "Update checkpoint with user-edited state.",
      inputSchema: { id: z.string(), data: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id, data }): Promise<CallToolResult> => {
      if (data.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Checkpoint data exceeds ${MAX_INPUT_BYTES} byte limit.` }],
          isError: true,
        };
      }
      try {
        const parsed = JSON.parse(data) as { elements?: any[] };
        const existing = await store.load(id);
        const merged = existing
          ? { ...existing, elements: parsed.elements ?? existing.elements }
          : { elements: parsed.elements ?? [], plan: undefined as string | undefined };
        await store.save(id, merged);
        return { content: [{ type: "text", text: "ok" }] };
      } catch (err) {
        return { content: [{ type: "text", text: `save failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ============================================================
  // Tool 5: create_in_obsidian (private — widget only)
  // Creates a .excalidraw.md file in Obsidian vault (obsidian-excalidraw plugin format).
  // ============================================================
  registerAppTool(server,
    "create_in_obsidian",
    {
      description: "Create the current diagram as a .md file in the user's Obsidian vault (obsidian-excalidraw plugin format).",
      inputSchema: {
        json: z.string().describe("Full Excalidraw document JSON (type, version, elements, appState, files)."),
        title: z.string().optional().describe("Description/title for the diagram; used as filename base. Default: diagram. Resulting file: {title}.md"),
        checkpointId: z.string().optional().describe("Checkpoint ID to load plan from; when provided, creates {title}.plan.md and adds a link in the Excalidraw file."),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ json, title: titleArg, checkpointId }): Promise<CallToolResult> => {
      if (json.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Diagram data exceeds ${MAX_INPUT_BYTES} byte limit.` }],
          isError: true,
        };
      }
      const baseName = sanitizeFilenamePart(titleArg?.trim() || "diagram");
      const filename = `${baseName}.md`;
      const planFilename = `${baseName}.plan.md`;
      let plan: string | undefined;
      if (checkpointId) {
        const checkpoint = await store.load(checkpointId);
        plan = checkpoint?.plan;
      }
      const planLink = plan ? `[[${baseName}.plan]]` : undefined;
      const markdown = buildObsidianExcalidrawMarkdown(json, planLink);

      const vaultPath = process.env.OBSIDIAN_VAULT_PATH || process.env.EXCALIDRAW_MCP_OBSIDIAN_VAULT;

      if (vaultPath) {
        try {
          const dir = path.dirname(path.join(vaultPath, filename));
          await fs.mkdir(dir, { recursive: true });
          if (plan) {
            const planPath = path.join(vaultPath, planFilename);
            await fs.writeFile(planPath, buildPlanMarkdown(plan), "utf-8");
          }
          const fullPath = path.join(vaultPath, filename);
          await fs.writeFile(fullPath, markdown, "utf-8");
          const created = plan ? `${planFilename} and ${filename}` : filename;
          return { content: [{ type: "text", text: `Created ${created} in vault at ${vaultPath}.` }] };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Could not write to vault: ${(err as Error).message}. Check OBSIDIAN_VAULT_PATH.` }],
            isError: true,
          };
        }
      }

      const envCli = process.env.OBSIDIAN_CLI_PATH || process.env.EXCALIDRAW_MCP_OBSIDIAN_CLI;
      const defaultMacPath = "/Applications/Obsidian.app/Contents/MacOS/obsidian";
      const cliPath =
        envCli ||
        (platform() === "darwin" && existsSync(defaultMacPath) ? defaultMacPath : "obsidian");

      try {
        if (plan) {
          const planResult = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
            const proc = spawn(cliPath, ["create", planFilename, "--content", buildPlanMarkdown(plan)], {
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            proc.stdout?.on("data", (d) => { stdout += String(d); });
            proc.stderr?.on("data", (d) => { stderr += String(d); });
            proc.on("error", (err) => reject(err));
            proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? null }));
          });
          if (planResult.code !== 0) {
            return {
              content: [{ type: "text", text: `Obsidian CLI failed creating plan: ${planResult.stderr || planResult.stdout || "non-zero exit"}` }],
              isError: true,
            };
          }
        }
        const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
          const proc = spawn(cliPath, ["create", filename, "--content", markdown], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          proc.stdout?.on("data", (d) => { stdout += String(d); });
          proc.stderr?.on("data", (d) => { stderr += String(d); });
          proc.on("error", (err) => reject(err));
          proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? null }));
        });
        if (result.code !== 0) {
          return {
            content: [{ type: "text", text: `Obsidian CLI failed: ${result.stderr || result.stdout || "non-zero exit"}` }],
            isError: true,
          };
        }
        const created = plan ? `${planFilename} and ${filename}` : filename;
        return { content: [{ type: "text", text: `Created ${created} in Obsidian vault.` }] };
      } catch (err) {
        const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "Obsidian CLI not found. Set OBSIDIAN_CLI_PATH to the full path of the obsidian binary (e.g. from \"which obsidian\"), or set OBSIDIAN_VAULT_PATH to your vault folder to save directly."
          : `create_in_obsidian failed: ${(err as Error).message}`;
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ============================================================
  // Tool 6: read_checkpoint (private — widget only)
  // ============================================================
  registerAppTool(server,
    "read_checkpoint",
    {
      description: "Read checkpoint state for restore.",
      inputSchema: { id: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id }): Promise<CallToolResult> => {
      try {
        const data = await store.load(id);
        if (!data) return { content: [{ type: "text", text: "" }] };
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `read failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // CSP: allow Excalidraw to load fonts from esm.sh
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
      const html = await fs.readFile(path.join(distDir, "mcp-app.html"), "utf-8");
      return {
        contents: [{
          uri: resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              ...cspMeta.ui,
              prefersBorder: true,
              permissions: { clipboardWrite: {} },
            },
          },
        }],
      };
    },
  );
}

/**
 * Creates a new MCP server instance with Excalidraw drawing tools.
 * Used by local entry point (main.ts) and Docker deployments.
 */
export function createServer(store: CheckpointStore): McpServer {
  const server = new McpServer({
    name: "Excalidraw",
    version: "1.0.0",
  });
  registerTools(server, DIST_DIR, store);
  return server;
}
