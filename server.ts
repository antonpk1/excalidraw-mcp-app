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

Thanks for calling read_me! Do NOT call it again in this conversation — you will not see anything new. Now use create_view to draw.

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
  { "type": "cameraUpdate", "width": 800, "height": 600, "x": 50, "y": 50 },
  { "type": "rectangle", "id": "b1", "x": 100, "y": 100, "width": 200, "height": 100, "roundness": { "type": 3 }, "backgroundColor": "#a5d8ff", "fillStyle": "solid", "label": { "text": "Start", "fontSize": 20 } },
  { "type": "rectangle", "id": "b2", "x": 450, "y": 100, "width": 200, "height": 100, "roundness": { "type": 3 }, "backgroundColor": "#b2f2bb", "fillStyle": "solid", "label": { "text": "End", "fontSize": 20 } },
  { "type": "arrow", "id": "a1", "x": 300, "y": 150, "width": 150, "height": 0, "points": [[0,0],[150,0]], "endArrowhead": "arrow", "startBinding": { "elementId": "b1", "fixedPoint": [1, 0.5] }, "endBinding": { "elementId": "b2", "fixedPoint": [0, 0.5] } }
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

ALWAYS start with a \`cameraUpdate\` as the FIRST element:
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
- **Camera 2** (800x600): Zoom out — draw the leaf zone, process flow (Light Reactions → Calvin Cycle), inputs (Sunlight, Water, CO2), outputs (O2, Glucose), and finally a cute 8-ray sun

\`\`\`json
[
  {"type":"cameraUpdate","width":400,"height":300,"x":200,"y":-20},
  {"type":"text","id":"ti","x":280,"y":10,"text":"Photosynthesis","fontSize":28,"strokeColor":"#1e1e1e"},
  {"type":"text","id":"fo","x":245,"y":48,"text":"6CO2 + 6H2O --> C6H12O6 + 6O2","fontSize":16,"strokeColor":"#b0b0b0"},
  {"type":"cameraUpdate","width":800,"height":600,"x":0,"y":-20},
  {"type":"rectangle","id":"lf","x":150,"y":90,"width":520,"height":380,"backgroundColor":"#d3f9d8","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#22c55e","strokeWidth":1,"opacity":35},
  {"type":"text","id":"lfl","x":170,"y":96,"text":"Inside the Leaf","fontSize":16,"strokeColor":"#22c55e"},
  {"type":"rectangle","id":"lr","x":190,"y":190,"width":160,"height":70,"backgroundColor":"#fff3bf","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#f59e0b","label":{"text":"Light Reactions","fontSize":16}},
  {"type":"arrow","id":"a1","x":350,"y":225,"width":120,"height":0,"points":[[0,0],[120,0]],"strokeColor":"#1e1e1e","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"ATP","fontSize":14}},
  {"type":"rectangle","id":"cc","x":470,"y":190,"width":160,"height":70,"backgroundColor":"#d0bfff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#8b5cf6","label":{"text":"Calvin Cycle","fontSize":16}},
  {"type":"rectangle","id":"sl","x":10,"y":200,"width":120,"height":50,"backgroundColor":"#fff3bf","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#f59e0b","label":{"text":"Sunlight","fontSize":16}},
  {"type":"arrow","id":"a2","x":130,"y":225,"width":60,"height":0,"points":[[0,0],[60,0]],"strokeColor":"#f59e0b","strokeWidth":2,"endArrowhead":"arrow"},
  {"type":"rectangle","id":"wa","x":200,"y":360,"width":140,"height":50,"backgroundColor":"#a5d8ff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#4a9eed","label":{"text":"Water (H2O)","fontSize":16}},
  {"type":"arrow","id":"a3","x":270,"y":360,"width":0,"height":-100,"points":[[0,0],[0,-100]],"strokeColor":"#4a9eed","strokeWidth":2,"endArrowhead":"arrow"},
  {"type":"rectangle","id":"co","x":480,"y":360,"width":130,"height":50,"backgroundColor":"#ffd8a8","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#f59e0b","label":{"text":"CO2","fontSize":16}},
  {"type":"arrow","id":"a4","x":545,"y":360,"width":0,"height":-100,"points":[[0,0],[0,-100]],"strokeColor":"#f59e0b","strokeWidth":2,"endArrowhead":"arrow"},
  {"type":"rectangle","id":"ox","x":540,"y":100,"width":100,"height":40,"backgroundColor":"#ffc9c9","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#ef4444","label":{"text":"O2","fontSize":16}},
  {"type":"arrow","id":"a5","x":310,"y":190,"width":230,"height":-50,"points":[[0,0],[230,-50]],"strokeColor":"#ef4444","strokeWidth":2,"endArrowhead":"arrow"},
  {"type":"rectangle","id":"gl","x":690,"y":195,"width":120,"height":60,"backgroundColor":"#c3fae8","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#22c55e","label":{"text":"Glucose","fontSize":18}},
  {"type":"arrow","id":"a6","x":630,"y":225,"width":60,"height":0,"points":[[0,0],[60,0]],"strokeColor":"#22c55e","strokeWidth":2,"endArrowhead":"arrow"},
  {"type":"ellipse","id":"sun","x":30,"y":110,"width":50,"height":50,"backgroundColor":"#fff3bf","fillStyle":"solid","strokeColor":"#f59e0b","strokeWidth":2},
  {"type":"arrow","id":"r1","x":55,"y":108,"width":0,"height":-14,"points":[[0,0],[0,-14]],"strokeColor":"#f59e0b","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r2","x":55,"y":162,"width":0,"height":14,"points":[[0,0],[0,14]],"strokeColor":"#f59e0b","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r3","x":28,"y":135,"width":-14,"height":0,"points":[[0,0],[-14,0]],"strokeColor":"#f59e0b","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r4","x":82,"y":135,"width":14,"height":0,"points":[[0,0],[14,0]],"strokeColor":"#f59e0b","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r5","x":73,"y":117,"width":10,"height":-10,"points":[[0,0],[10,-10]],"strokeColor":"#f59e0b","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r6","x":37,"y":117,"width":-10,"height":-10,"points":[[0,0],[-10,-10]],"strokeColor":"#f59e0b","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r7","x":73,"y":153,"width":10,"height":10,"points":[[0,0],[10,10]],"strokeColor":"#f59e0b","strokeWidth":2,"endArrowhead":null,"startArrowhead":null},
  {"type":"arrow","id":"r8","x":37,"y":153,"width":-10,"height":10,"points":[[0,0],[-10,10]],"strokeColor":"#f59e0b","strokeWidth":2,"endArrowhead":null,"startArrowhead":null}
]
\`\`\`

Common mistakes to avoid:
- **Camera size must match content with padding** — if your content is 500px tall, use 800x600 camera, not 500px. No padding = truncated edges
- **Center titles relative to the diagram below** — estimate the diagram's total width and center the title text over it, not over the canvas
- **Arrow labels need space** — long labels like "ATP + NADPH" overflow short arrows. Keep labels short or make arrows wider
- **Elements overlap when y-coordinates are close** — always check that text, boxes, and labels don't stack on top of each other (e.g., an output box overlapping a zone label)
- **Draw art/illustrations LAST** — cute decorations (sun, stars, icons) should appear as the final drawing step so they don't distract from the main content being built

## Advanced Example — Storyboard

Example prompt: "Create awesome storyboard excalidraw animation explaining how to install Excalidraw connector to claude.ai"

This demonstrates camera panning across a large canvas to tell a story. Two browser windows are laid out side-by-side, and 6 cameraUpdates guide the viewer through the narrative:

- **Camera 1** (800x600): Wide shot of the Claude.ai chat window — draw the empty browser chrome, title bar, tabs, logo, and "Claude.ai" text
- **Camera 2** (600x450): Pull back to mid-view — draw the textarea with placeholder, + button, model selector, send button. Logo is now above the frame
- **Camera 3** (400x300): Zoom into the + button area — draw the highlighted + button and dropdown menu with "Manage connectors" active
- Draw the curved arrow connecting to Settings window (while still on Camera 3)
- **Camera 4** (800x600): Pan right to Settings window — draw the full settings page with sidebar, connector list (Figma, GitHub, Slack), and "+ Add custom connector" button with arrow
- **Camera 5** (600x450): Zoom into modal — draw the modal overlay with "excalidraw" name and server URL filled in, ending with arrows pointing to URL and Add button

\`\`\`json
[
  {"type":"cameraUpdate","width":800,"height":600,"x":-30,"y":0},
  {"type":"rectangle","id":"wf1","x":20,"y":40,"width":700,"height":500,"backgroundColor":"#fafaf7","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1},
  {"type":"rectangle","id":"tb1","x":20,"y":40,"width":700,"height":38,"backgroundColor":"#ededed","fillStyle":"solid","strokeColor":"#d4d4d0","strokeWidth":1},
  {"type":"ellipse","id":"dr1","x":42,"y":50,"width":12,"height":12,"backgroundColor":"#ff5f57","fillStyle":"solid","strokeColor":"#ff5f57","strokeWidth":1},
  {"type":"ellipse","id":"dy1","x":60,"y":50,"width":12,"height":12,"backgroundColor":"#febc2e","fillStyle":"solid","strokeColor":"#febc2e","strokeWidth":1},
  {"type":"ellipse","id":"dg1","x":78,"y":50,"width":12,"height":12,"backgroundColor":"#28c840","fillStyle":"solid","strokeColor":"#28c840","strokeWidth":1},
  {"type":"rectangle","id":"chtab","x":310,"y":48,"width":56,"height":24,"backgroundColor":"#ffffff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1,"label":{"text":"Chat","fontSize":14}},
  {"type":"rectangle","id":"cwtab","x":370,"y":48,"width":70,"height":24,"roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1,"label":{"text":"Cowork","fontSize":14}},
  {"type":"text","id":"logo","x":345,"y":155,"text":"*","fontSize":64,"strokeColor":"#D77655"},
  {"type":"text","id":"brnd","x":290,"y":225,"text":"Claude.ai","fontSize":28,"strokeColor":"#1e1e1e"},
  {"type":"cameraUpdate","width":600,"height":450,"x":70,"y":145},
  {"type":"rectangle","id":"ta","x":110,"y":340,"width":520,"height":100,"backgroundColor":"#ffffff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1},
  {"type":"text","id":"ph","x":130,"y":355,"text":"How can I help you today?","fontSize":18,"strokeColor":"#b0b0b0"},
  {"type":"rectangle","id":"plus","x":125,"y":408,"width":32,"height":32,"roundness":{"type":3},"strokeColor":"#b0b0b0","strokeWidth":1,"label":{"text":"+","fontSize":18}},
  {"type":"text","id":"mdl","x":510,"y":416,"text":"Opus 4.6","fontSize":14,"strokeColor":"#b0b0b0"},
  {"type":"ellipse","id":"sendb","x":596,"y":410,"width":28,"height":28,"backgroundColor":"#c4795b","fillStyle":"solid","strokeColor":"#c4795b","strokeWidth":1},
  {"type":"cameraUpdate","width":400,"height":300,"x":40,"y":290},
  {"type":"text","id":"plushl","x":131,"y":406,"text":"+","fontSize":30,"strokeColor":"#4a9eed"},
  {"type":"rectangle","id":"dd","x":115,"y":448,"width":250,"height":92,"backgroundColor":"#ffffff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1},
  {"type":"text","id":"dd1","x":130,"y":455,"text":"@ Add files and photos","fontSize":16,"strokeColor":"#555555"},
  {"type":"text","id":"dd2","x":130,"y":480,"text":"~ Research","fontSize":16,"strokeColor":"#555555"},
  {"type":"rectangle","id":"dd3h","x":119,"y":502,"width":242,"height":28,"backgroundColor":"#f5f0e8","fillStyle":"solid","roundness":{"type":3},"strokeColor":"transparent"},
  {"type":"text","id":"dd3","x":130,"y":506,"text":"# Manage connectors","fontSize":16,"strokeColor":"#1e1e1e"},
  {"type":"rectangle","id":"dd3a","x":119,"y":502,"width":242,"height":28,"backgroundColor":"#c4795b","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#c4795b","opacity":15},
  {"type":"arrow","id":"crv","x":365,"y":515,"width":460,"height":-180,"points":[[0,0],[180,-60],[460,-180]],"strokeColor":"#c4795b","strokeWidth":2,"strokeStyle":"dashed","endArrowhead":"arrow","startArrowhead":null},
  {"type":"cameraUpdate","width":800,"height":600,"x":760,"y":0},
  {"type":"rectangle","id":"sw","x":820,"y":40,"width":680,"height":500,"backgroundColor":"#fafaf7","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1},
  {"type":"rectangle","id":"stb","x":820,"y":40,"width":680,"height":38,"backgroundColor":"#ededed","fillStyle":"solid","strokeColor":"#d4d4d0","strokeWidth":1},
  {"type":"ellipse","id":"dr2","x":842,"y":50,"width":12,"height":12,"backgroundColor":"#ff5f57","fillStyle":"solid","strokeColor":"#ff5f57","strokeWidth":1},
  {"type":"ellipse","id":"dy2","x":860,"y":50,"width":12,"height":12,"backgroundColor":"#febc2e","fillStyle":"solid","strokeColor":"#febc2e","strokeWidth":1},
  {"type":"ellipse","id":"dg2","x":878,"y":50,"width":12,"height":12,"backgroundColor":"#28c840","fillStyle":"solid","strokeColor":"#28c840","strokeWidth":1},
  {"type":"text","id":"sttl","x":845,"y":92,"text":"Settings","fontSize":28,"strokeColor":"#1e1e1e"},
  {"type":"text","id":"sb1","x":845,"y":138,"text":"General","fontSize":16,"strokeColor":"#555555"},
  {"type":"text","id":"sb2","x":845,"y":163,"text":"Account","fontSize":16,"strokeColor":"#555555"},
  {"type":"text","id":"sb3","x":845,"y":188,"text":"Usage","fontSize":16,"strokeColor":"#555555"},
  {"type":"text","id":"sb4","x":845,"y":213,"text":"Capabilities","fontSize":16,"strokeColor":"#555555"},
  {"type":"rectangle","id":"sbhi","x":840,"y":237,"width":130,"height":28,"backgroundColor":"#f5f0e8","fillStyle":"solid","roundness":{"type":3},"strokeColor":"transparent"},
  {"type":"text","id":"sb5","x":845,"y":239,"text":"Connectors","fontSize":16,"strokeColor":"#c4795b"},
  {"type":"text","id":"sb6","x":845,"y":272,"text":"Claude Code","fontSize":16,"strokeColor":"#555555"},
  {"type":"arrow","id":"div","x":975,"y":92,"width":0,"height":425,"points":[[0,0],[0,425]],"strokeColor":"#e8e8e8","strokeWidth":1,"endArrowhead":null,"startArrowhead":null},
  {"type":"text","id":"cnh","x":1000,"y":92,"text":"Connectors","fontSize":24,"strokeColor":"#1e1e1e"},
  {"type":"text","id":"cns","x":1000,"y":120,"text":"Allow Claude to reference apps and services.","fontSize":14,"strokeColor":"#b0b0b0"},
  {"type":"rectangle","id":"bcb","x":1330,"y":92,"width":150,"height":32,"roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1,"label":{"text":"Browse connectors","fontSize":14}},
  {"type":"ellipse","id":"ci1","x":1005,"y":157,"width":28,"height":28,"backgroundColor":"#dbe4ff","fillStyle":"solid","strokeColor":"#d4d4d0","strokeWidth":1},
  {"type":"text","id":"cn1","x":1045,"y":161,"text":"Figma","fontSize":16,"strokeColor":"#1e1e1e"},
  {"type":"rectangle","id":"cb1","x":1380,"y":157,"width":90,"height":28,"roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1,"label":{"text":"Connect","fontSize":14}},
  {"type":"ellipse","id":"ci2","x":1005,"y":198,"width":28,"height":28,"backgroundColor":"#e8e8e8","fillStyle":"solid","strokeColor":"#d4d4d0","strokeWidth":1},
  {"type":"text","id":"cn2","x":1045,"y":203,"text":"GitHub","fontSize":16,"strokeColor":"#1e1e1e"},
  {"type":"rectangle","id":"cb2","x":1380,"y":198,"width":90,"height":28,"roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1,"label":{"text":"Connect","fontSize":14}},
  {"type":"ellipse","id":"ci3","x":1005,"y":240,"width":28,"height":28,"backgroundColor":"#d3f9d8","fillStyle":"solid","strokeColor":"#d4d4d0","strokeWidth":1},
  {"type":"text","id":"cn3","x":1045,"y":244,"text":"Slack","fontSize":16,"strokeColor":"#1e1e1e"},
  {"type":"rectangle","id":"cb3","x":1380,"y":240,"width":90,"height":28,"roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1,"label":{"text":"Connect","fontSize":14}},
  {"type":"arrow","id":"sep","x":1000,"y":282,"width":470,"height":0,"points":[[0,0],[470,0]],"strokeColor":"#e8e8e8","strokeWidth":1,"endArrowhead":null,"startArrowhead":null},
  {"type":"rectangle","id":"acb","x":1000,"y":298,"width":220,"height":36,"backgroundColor":"#f5f0e8","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#c4795b","strokeWidth":1,"label":{"text":"+ Add custom connector","fontSize":14}},
  {"type":"cameraUpdate","width":600,"height":450,"x":850,"y":65},
  {"type":"arrow","id":"cur","x":1250,"y":340,"width":-20,"height":-10,"points":[[0,0],[-20,-10]],"strokeColor":"#c4795b","strokeWidth":2,"endArrowhead":"arrow","startArrowhead":null},
  {"type":"rectangle","id":"ov","x":820,"y":78,"width":680,"height":462,"backgroundColor":"#888888","fillStyle":"solid","strokeColor":"transparent","opacity":30},
  {"type":"rectangle","id":"md","x":940,"y":150,"width":420,"height":280,"backgroundColor":"#ffffff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1},
  {"type":"text","id":"mdt","x":960,"y":168,"text":"Add custom connector","fontSize":22,"strokeColor":"#1e1e1e"},
  {"type":"text","id":"nl","x":960,"y":210,"text":"Name","fontSize":16,"strokeColor":"#555555"},
  {"type":"rectangle","id":"ni","x":960,"y":232,"width":380,"height":34,"backgroundColor":"#ffffff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1},
  {"type":"text","id":"nv","x":972,"y":238,"text":"Excalidraw","fontSize":18,"strokeColor":"#1e1e1e"},
  {"type":"text","id":"ul","x":960,"y":278,"text":"Server URL","fontSize":16,"strokeColor":"#555555"},
  {"type":"rectangle","id":"urli","x":960,"y":300,"width":380,"height":34,"backgroundColor":"#ffffff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#d4d4d0","strokeWidth":1},
  {"type":"text","id":"uv","x":968,"y":306,"text":"https://excalidraw-mcp-app.vercel.app/mcp","fontSize":18,"strokeColor":"#1e1e1e"},
  {"type":"text","id":"can","x":1220,"y":388,"text":"Cancel","fontSize":16,"strokeColor":"#999999"},
  {"type":"rectangle","id":"addb","x":1260,"y":380,"width":100,"height":36,"backgroundColor":"#c4795b","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#c4795b","strokeWidth":1},
  {"type":"text","id":"addt","x":1288,"y":388,"text":"Add","fontSize":16,"strokeColor":"#ffffff"},
  {"type":"arrow","id":"aurl","x":920,"y":317,"width":40,"height":0,"points":[[0,0],[40,0]],"strokeColor":"#4a9eed","strokeWidth":2,"endArrowhead":"arrow","startArrowhead":null},
  {"type":"arrow","id":"ptr","x":1400,"y":420,"width":-60,"height":-20,"points":[[0,0],[-60,-20]],"strokeColor":"#4a9eed","strokeWidth":2,"endArrowhead":"arrow","startArrowhead":null},
  {"type":"text","id":"enj","x":1080,"y":455,"text":"Enjoy!","fontSize":36,"strokeColor":"#4a9eed"},
  {"type":"ellipse","id":"st1","x":1070,"y":465,"width":10,"height":10,"backgroundColor":"#f59e0b","fillStyle":"solid","strokeColor":"#f59e0b","strokeWidth":1},
  {"type":"ellipse","id":"st2","x":1195,"y":460,"width":10,"height":10,"backgroundColor":"#22c55e","fillStyle":"solid","strokeColor":"#22c55e","strokeWidth":1},
  {"type":"ellipse","id":"st3","x":1210,"y":475,"width":8,"height":8,"backgroundColor":"#8b5cf6","fillStyle":"solid","strokeColor":"#8b5cf6","strokeWidth":1},
  {"type":"ellipse","id":"st4","x":1060,"y":480,"width":8,"height":8,"backgroundColor":"#ec4899","fillStyle":"solid","strokeColor":"#ec4899","strokeWidth":1}
]
\`\`\`

## Checkpoints (restoring previous state)

Every create_view call returns a \`checkpointId\` in its response. To continue from a previous diagram state, start your elements array with a restoreCheckpoint element:

\`[{"type":"restoreCheckpoint","id":"<checkpointId>"}, ...additional new elements...]\`

The saved state (including any user edits made in fullscreen) is loaded from the client, and your new elements are appended on top. This saves tokens — you don't need to re-send the entire diagram.

## Tips
- Do NOT call read_me again — you already have everything you need
- Use the color palette consistently
- Make sure text is readable (never use same text color as background color) 
- Do NOT use emoji in text — they don't render in Excalidraw's font
- cameraUpdate is MAGICAL and users love it! please use it a lot to guide the user's attention as you draw. It makes a huge difference in readability and engagement.
`;

/**
 * Registers all Excalidraw tools and resources on the given McpServer.
 * Shared between local (main.ts) and Vercel (api/mcp.ts) entry points.
 */
export function registerTools(server: McpServer, distDir: string): void {
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
      const checkpointId = Math.random().toString(36).slice(2, 8);
      return {
        content: [{ type: "text", text: `Diagram displayed! Checkpoint id: "${checkpointId}".
If user asks to create a new diagram - simply create a new one from scratch.
However, if the user wants to edit something on this diagram "${checkpointId}", take these steps:
1) read widget context (using read_widget_context tool) to check if user made any manual edits first
2) decide whether you want to make new diagram from scratch OR - use this one as starting checkpoint:
  simply start from the first element [{"type":"restoreCheckpoint","id":"${checkpointId}"}, ...your new elements...]
  this will use same diagram state as the user currently sees, including any manual edits they made in fullscreen, allowing you to add elements on top.
  To remove elements from the restored state, use: {"type":"deleteElement","id":"<elementId>"}` }],
        structuredContent: { checkpointId },
      };
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
export function createServer(): McpServer {
  const server = new McpServer({
    name: "Excalidraw",
    version: "1.0.0",
  });
  registerTools(server, DIST_DIR);
  return server;
}
