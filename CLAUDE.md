# Excalidraw MCP App Server

Standalone MCP server that streams Excalidraw diagrams as SVG with hand-drawn animations.

## Architecture

```
server.ts          → 2 tools (read_me, create_view) + resource + cheat sheet
main.ts            → HTTP (Streamable) + stdio transports
src/mcp-app.tsx    → ExcalidrawAppCore (widget logic) + ExcalidrawApp (useApp wrapper)
src/mcp-entry.tsx  → Production entry point: createRoot + ExcalidrawApp
src/global.css     → Animations (stroke draw-on, fade-in) + auto-resize
src/dev.tsx        → Dev entry point: mock app + sample elements + control panel
src/dev-mock.ts    → Mock MCP App with event simulation (sendToolInput, streamElements, etc.)
index-dev.html     → Dev HTML entry (served by vite dev server)
vite.config.dev.ts → Dev-only vite config (resolves from node_modules, no esm.sh externals)
```

## Tools

### `read_me` (text tool, no UI)
Returns a cheat sheet with element format, color palettes, coordinate tips, and examples. The model should call this before `create_view`.

### `create_view` (UI tool)
Takes `elements` — a JSON string of standard Excalidraw elements. The widget parses partial JSON during streaming and renders via `exportToSvg` + morphdom diffing. No Excalidraw React canvas component — pure SVG rendering.

**Screenshot as model context:** After final render, the SVG is captured as a 512px-max PNG and sent via `app.updateModelContext()` so the model can see the diagram and iterate on user feedback.

## Key Design Decisions

### Skeleton API via convertToExcalidrawElements
Input uses Excalidraw's skeleton format, processed by `convertToExcalidrawElements` on every render.
Supported skeleton shortcuts:
- `label` on shapes (auto-centred text, auto-resize container)
- `start`/`end` on arrows (binding metadata + position resolution by target element ID)
- Standalone text and manually-positioned arrows with x/y/points still work

**Important:** `convertToExcalidrawElements` creates binding metadata but does NOT compute arrow coordinates. `resolveArrowPositions` (in `mcp-app.tsx`) post-processes the output to compute x/y/points from bound shape edges. Without this step, bound arrows render at (0,0).

**Trade-off:** Elements must be ordered so target shapes appear before arrows that reference them.

### SVG-only rendering (no Excalidraw React canvas)
The widget uses `exportToSvg` for ALL rendering — no `<Excalidraw>` React component.

**Why:**
- Eliminates blink on final render (no component swap from SVG preview to canvas)
- Loads Virgil hand-drawn font from the start (no `skipInliningFonts`)
- morphdom works on SVG DOM — smooth diffing between streaming updates

### Auto-sizing
The container has no fixed height. SVG gets `width: 100%` + `height: auto` with the `width` attribute removed. The SVG's `viewBox` preserves aspect ratio, so height scales proportionally to content.

### CSP: `esm.sh` allowed
Excalidraw loads the Virgil font from `esm.sh` at runtime. The resource's `_meta.ui.csp.resourceDomains` includes `https://esm.sh`.

### `prefersBorder: true`
Set on the resource content's `_meta.ui` so the host renders a border/background around the widget.

### Fullscreen mode
Supports `app.requestDisplayMode({ mode: "fullscreen" })`. Button appears on hover (top-right), hidden in fullscreen (host provides exit UI). Escape key exits fullscreen.

## Checkpoint System

Two-tier storage for diagram state persistence:

### Architecture
1. **Server-side store** (primary): `CheckpointStore` interface with 3 implementations:
   - `FileCheckpointStore` — local dev, writes JSON to `$TMPDIR/excalidraw-mcp-checkpoints/`
   - `MemoryCheckpointStore` — Vercel fallback (in-memory Map, lost on cold start)
   - `RedisCheckpointStore` — Vercel with Upstash KV (persistent, 30-day TTL)
   - Factory: `createVercelStore()` picks Redis if env vars exist, else Memory

2. **localStorage** (widget-side cache): Fast local cache keyed by `excalidraw:<checkpointId>` for persisting user edits across page reloads within the same session.

### Flow
- `create_view` resolves `restoreCheckpoint` references server-side, saves fully resolved state, returns `checkpointId`
- Widget reads checkpoints via `read_checkpoint` server tool (private, app-only visibility)
- User edits in fullscreen sync back to server via `save_checkpoint` server tool (debounced)
- `cameraUpdate` elements are stored as part of checkpoint data (not a separate viewport field)

### Key Design Decisions
- Server resolves checkpoints so the model never needs to re-send full element arrays
- `containerId` filtering ensures bound text elements are deleted with their containers
- Camera aspect ratio check nudges model toward 4:3 ratios
- `checkpointId` uses `crypto.randomUUID()` truncated to 18 chars (collision-resistant, URL-safe)

## Build

```bash
npm install
npm run build
```

Build pipeline: `tsc --noEmit` → `vite build` (singlefile HTML) → `tsc -p tsconfig.server.json` → `bun build` (server + index).

## Running

```bash
# HTTP (Streamable) — default, stateless per-request
npm run serve          # or: bun --watch main.ts
# Starts on http://localhost:3001/mcp

# stdio — for Claude Desktop
node dist/index.js --stdio

# Dev mode (watch + serve) — full MCP flow
npm run dev

# Dev mode (standalone UI) — no MCP server needed
npm run dev:ui
# Opens http://localhost:5173/index-dev.html with mock app + sample diagram
```

## Claude Desktop config

```json
{
  "excalidraw": {
    "command": "node",
    "args": ["<path>/dist/index.js", "--stdio"]
  }
}
```

## Rendering Pipeline

### Streaming (`ontoolinputpartial`)
1. `parsePartialElements` tries `JSON.parse`, falls back to closing array after last `}`
2. `excludeIncompleteLastItem` drops the last element (may be incomplete)
3. Only re-renders when element **count** changes (not on every partial update)
4. Seeds are **randomized** per render — hand-drawn style animates naturally
5. `exportToSvg` generates SVG → **morphdom** diffs against existing DOM
6. morphdom preserves existing elements (no re-animation), only new elements trigger CSS animations

### Final render (`ontoolinput`)
1. Parses complete JSON, renders with **original seeds** (stable final look)
2. Same `exportToSvg` + morphdom path — seamless transition, no blink
3. Sends PNG screenshot to model context (debounced 1.5s)

### CSS Animations (3 layers)
- **Shapes** (`g, rect, circle, ellipse, text, image`): opacity fade-in 0.5s
- **Lines** (`path, line, polyline, polygon`): stroke-dashoffset draw-on effect 0.6s
- **Existing elements**: smooth `transition` on fill/stroke/opacity changes

### Key Libraries
- **morphdom**: DOM diffing for SVG — preserves existing nodes, only new nodes get animations
- **exportToSvg**: Excalidraw's SVG export (with fonts inlined by default)

## Cheat Sheet: Progressive Element Ordering

The `server.ts` cheat sheet instructs the model to emit elements progressively:
- BAD: all rectangles → all texts → all arrows (blank boxes stream, then labels appear late)
- GOOD: background shapes first, then per node: shape → label → arrows → next node
- This way each node appears complete with its label during streaming

## Debugging

### Dev workflow
1. Edit source files
2. `npm run build` (or `npm run dev` for watch mode)
3. Restart the server process (module cache means hot reload doesn't pick up `server.ts` changes for tool definitions)
4. In Claude Desktop: restart the MCP server connection

### Widget logging — NEVER use console.log

Use the SDK logger — it routes through the host to the log file:

```typescript
app.sendLog({ level: "info", logger: "Excalidraw", data: "my message" });
```

**Log file**: `~/Library/Logs/Claude/claude.ai-web.log`

```bash
# Fullscreen transition logs (logger: "FS")
grep "FS" ~/Library/Logs/Claude/claude.ai-web.log | tail -40

# General widget logs (logger: "Excalidraw")
grep "Excalidraw" ~/Library/Logs/Claude/claude.ai-web.log | tail -20

# Clear logs before repro for clean output
> ~/Library/Logs/Claude/claude.ai-web.log
```

### Widget debugging
- The widget runs in an iframe
- Check that `exportToSvg` isn't throwing (catches are silent)
- morphdom issues: compare old vs new SVG structure in Elements panel

### Common issues
- **No diagram appears:** Check that `ontoolinputpartial` is firing — the `elements` field might be nested differently (`params.arguments.elements` vs `params.elements`)
- **All elements re-animate on each update:** morphdom not working — check that SVG structure is similar enough for diffing (different root SVG attributes can cause full replacement)
- **Font is default (not hand-drawn):** `skipInliningFonts` was set to `true` — must be removed/false
- **Elements in wrong positions during animation:** Don't use CSS `transform: scale()` on SVG child elements — conflicts with Excalidraw's own transform attributes. Use opacity-only animations.

## Gotchas

- `ExcalidrawElement` type is at `@excalidraw/excalidraw/element/types`, not re-exported from main
- `ExcalidrawImperativeAPI` type is at `@excalidraw/excalidraw/types`
- Excalidraw's `containerId` on text elements does NOT auto-position text — that only works via `convertToExcalidrawElements` skeleton API
- The `.SVGLayer` div is not used for rendering but takes layout space — safe to `display: none`
- morphdom is essential — without it, replacing innerHTML re-triggers all animations on every update
- `ReactDOM.render()` per update remounts the tree and kills animations — use `createRoot()` once + `useState` if adding React components
