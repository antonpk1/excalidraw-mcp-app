# Server-Side Snapshot Rendering (POC)

## Status: Working locally, not committed

Renders every diagram to a PNG file on the backend when `create_view` saves a checkpoint.

## Architecture

```
elements → .excalidraw JSON → SVG (excalirender/roughjs) → PNG (resvg WASM)
```

### Pipeline

1. **Label expansion** — converts `label` shorthand to separate bound text elements
2. **Element normalization** — fills default fields (seed, opacity, strokeStyle, etc.)
3. **SVG generation** — excalirender's pure-JS SVG export (roughjs paths, no native canvas)
4. **Font embedding** — excalirender embeds Excalifont/Virgil TTFs as base64 @font-face CSS in SVG
5. **PNG conversion** — resvg WASM renders SVG to PNG with TTF fonts loaded explicitly
6. **Output** — PNG saved to `/tmp/excalidraw-snapshots/{checkpointId}.png`

### Dependencies added

| Package | Version | Purpose | Size |
|---------|---------|---------|------|
| `excalirender` | github:JonRC/excalirender | SVG rendering (roughjs + perfect-freehand) | ~2MB |
| `@resvg/resvg-wasm` | 2.6.2 | SVG→PNG (WASM, no native bindings) | ~1.5MB |

### Files modified

| File | Changes |
|------|---------|
| `src/snapshot-renderer.ts` | **NEW** — isolated module (~120 lines) |
| `src/server.ts` | +3 lines (import, call, append path to response) |
| `node_modules/excalirender/src/fonts.ts` | Patched: lazy-load `canvas` → no-op (SVG-only mode) |
| `package.json` | +2 deps (excalirender, @resvg/resvg-wasm) |

### Fonts

Excalirender ships TTF fonts in `node_modules/excalirender/assets/fonts/`:
- `Excalifont.ttf` (62KB) — hand-drawn style (fontFamily 1)
- `Virgil.ttf` (163KB) — original Excalidraw font
- `Cascadia.ttf` (223KB) — monospace (fontFamily 3)
- `LiberationSans.ttf` (134KB) — sans-serif (fontFamily 4)

Loaded as buffers and passed to resvg explicitly (resvg doesn't support @font-face CSS in SVGs).

## Known issues

1. **Arrow label positioning** — approximate (midpoint of arrow path), not pixel-perfect like Excalidraw's DOM-based rendering. Improved but still slightly off for angled arrows.
2. **Text width estimation** — uses `text.length * fontSize * 0.55` heuristic. Works for Latin, may be off for other scripts or mixed content.
3. **canvas.node in build** — `bun build` tries to bundle excalirender's transitive `canvas` dependency. Need `--external canvas` flag.

## Shipping to Vercel

### Current state: local-only (stdio mode)

Works because Bun runs TypeScript directly, patched node_modules persist.

### Path to Vercel deployment

**Key insight**: `bun build` resolves Bun-specific `import ... with { type: "file" }` at build time. Font TTFs get extracted as assets in `dist/`. Built output is pure Node.js.

**Steps needed:**

1. **Add `--external canvas`** to `bun build` command in package.json to exclude native canvas module
2. **Handle multi-file output** — `bun build` outputs font assets alongside server.js. Vercel function needs to include them. May need `--asset-naming` flag or copy step.
3. **Return base64 PNG** in tool response instead of file path (paths are meaningless in serverless)
4. **Skip tsc** for excalirender sources (or add excalirender to tsconfig exclude)
5. **Test function bundle size** — fonts + WASM + server.js, target <10MB (Vercel limit: 50MB)

**Estimated effort**: ~half day

### Alternative: keep snapshot local-only

- Local stdio mode: write PNG to `/tmp/`, return path (current behavior)
- Vercel remote mode: skip snapshot, return checkpoint only (graceful degradation)

```typescript
// In snapshot-renderer.ts
const isVercel = !!process.env.VERCEL;
if (isVercel) return null; // skip on Vercel, render locally only
```

This is the simplest ship path — no Vercel changes needed.

## Testing

```bash
# Run dev server
cd ~/code/excalidraw-mcp-app-2
bun --watch src/main.ts

# Check snapshots
ls -la /tmp/excalidraw-snapshots/
open /tmp/excalidraw-snapshots/*.png

# Standalone test
bun -e "
const { renderSnapshot } = await import('./src/snapshot-renderer.ts');
const result = await renderSnapshot('test', [
  { type: 'rectangle', id: 'r1', x: 100, y: 100, width: 200, height: 100,
    backgroundColor: '#a5d8ff', fillStyle: 'solid', roundness: { type: 3 },
    label: { text: 'Hello', fontSize: 20 } },
]);
console.log(result);
"
```

## References

- [excalirender](https://github.com/JonRC/excalirender) — CLI/library for .excalidraw → PNG/SVG
- [@resvg/resvg-wasm](https://www.npmjs.com/package/@resvg/resvg-wasm) — WASM SVG renderer
- [roughjs](https://roughjs.com/) — hand-drawn style graphics
