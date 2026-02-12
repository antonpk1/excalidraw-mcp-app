/**
 * Server-side diagram snapshot renderer (POC).
 * Uses excalirender's pure-JS SVG export (roughjs, no native canvas),
 * then converts SVG→PNG via resvg (WASM, no native bindings).
 * Isolated module — no coupling to MCP server logic.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { exportToSvg } from "excalirender/src/export-svg/export.js";
import type { ExportOptions } from "excalirender/src/types.js";

const TMP_DIR = "/tmp/excalidraw-snapshots";

// Resolve excalirender's bundled font directory
const FONTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("excalirender/src/fonts.js"))),
  "..",
  "assets",
  "fonts",
);

// Load font buffers once
let fontBuffers: Uint8Array[] | null = null;
function getFontBuffers(): Uint8Array[] {
  if (!fontBuffers) {
    const fontFiles = ["Excalifont.ttf", "Virgil.ttf", "Cascadia.ttf", "LiberationSans.ttf"];
    fontBuffers = fontFiles.map((f) => new Uint8Array(fs.readFileSync(path.join(FONTS_DIR, f))));
  }
  return fontBuffers;
}

// Initialize resvg WASM once
let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    const wasmPath = path.join(
      path.dirname(fileURLToPath(import.meta.resolve("@resvg/resvg-wasm"))),
      "index_bg.wasm",
    );
    wasmReady = initWasm(fs.readFileSync(wasmPath));
  }
  return wasmReady;
}

/**
 * Fill in default fields that excalirender expects on every element.
 */
function normalizeElement(el: any): any {
  return {
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeStyle: "solid",
    strokeWidth: 2,
    roughness: 1,
    opacity: 100,
    seed: Math.floor(Math.random() * 100000),
    angle: 0,
    ...el,
  };
}

/**
 * Estimate text width in scene units (rough approximation).
 */
function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.55;
}

/**
 * Expand label shorthand into separate bound text elements.
 * Centers text within the parent shape using width estimation.
 */
function expandLabels(elements: any[]): any[] {
  const result: any[] = [];
  for (const el of elements) {
    if (el.label?.text && el.type !== "arrow") {
      const { label, ...shape } = el;
      const fontSize = label.fontSize || 20;
      const textWidth = estimateTextWidth(label.text, fontSize);
      const textHeight = fontSize * 1.2;

      result.push(normalizeElement(shape));
      result.push(normalizeElement({
        type: "text",
        id: `${el.id}_label`,
        x: el.x + (el.width || 0) / 2 - textWidth / 2,
        y: el.y + (el.height || 0) / 2 - textHeight / 2,
        width: textWidth,
        height: textHeight,
        text: label.text,
        fontSize,
        fontFamily: label.fontFamily || 1,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: el.id,
        strokeColor: label.strokeColor || el.strokeColor || "#1e1e1e",
        backgroundColor: "transparent",
        strokeWidth: 0,
        roughness: 0,
      }));
    } else if (el.label?.text && el.type === "arrow") {
      const { label, ...arrow } = el;
      const fontSize = label.fontSize || 16;
      const textWidth = estimateTextWidth(label.text, fontSize);
      const textHeight = fontSize * 1.2;

      // Arrow midpoint from points array
      const pts = el.points || [[0, 0], [el.width || 0, el.height || 0]];
      const lastPt = pts[pts.length - 1];
      const midX = el.x + lastPt[0] / 2;
      const midY = el.y + lastPt[1] / 2;

      result.push(normalizeElement(arrow));
      result.push(normalizeElement({
        type: "text",
        id: `${el.id}_label`,
        x: midX - textWidth / 2,
        y: midY - textHeight - 4,
        width: textWidth,
        height: textHeight,
        text: label.text,
        fontSize,
        fontFamily: label.fontFamily || 1,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: el.id,
        strokeColor: label.strokeColor || el.strokeColor || "#1e1e1e",
        backgroundColor: "transparent",
        strokeWidth: 0,
        roughness: 0,
      }));
    } else {
      result.push(normalizeElement(el));
    }
  }
  return result;
}

export interface SnapshotResult {
  pngPath: string;
  excalidrawPath: string;
}

/**
 * Render Excalidraw elements to PNG + .excalidraw files in /tmp.
 * Pipeline: elements → .excalidraw JSON → SVG (excalirender) → PNG (resvg).
 */
export async function renderSnapshot(
  checkpointId: string,
  elements: any[],
): Promise<SnapshotResult | null> {
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });

    const basePath = path.join(TMP_DIR, checkpointId);
    const inputPath = `${basePath}.excalidraw`;
    const svgPath = `${basePath}.svg`;
    const pngPath = `${basePath}.png`;

    // Filter pseudo-elements, expand labels, normalize
    const drawableElements = elements.filter(
      (el) => el.type !== "cameraUpdate" && el.type !== "delete" && el.type !== "restoreCheckpoint",
    );
    const expandedElements = expandLabels(drawableElements);

    // Write .excalidraw JSON
    const excalidrawFile = {
      type: "excalidraw",
      version: 2,
      source: "excalidraw-mcp-app",
      elements: expandedElements,
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
    fs.writeFileSync(inputPath, JSON.stringify(excalidrawFile));

    // Render SVG via excalirender (pure JS, roughjs)
    const svgOptions: ExportOptions = {
      outputPath: svgPath,
      scale: 2, // 2x for crisp PNG
      background: null,
      darkMode: false,
    };
    await exportToSvg(inputPath, svgOptions);

    // Convert SVG → PNG via resvg (WASM)
    await ensureWasm();
    const svgData = fs.readFileSync(svgPath, "utf-8");
    const resvg = new Resvg(svgData, {
      font: {
        fontBuffers: getFontBuffers(),
        defaultFontFamily: "Excalifont",
      },
    });
    const pngData = resvg.render();
    fs.writeFileSync(pngPath, pngData.asPng());

    // Clean up intermediate SVG (keep .excalidraw + .png)
    fs.unlinkSync(svgPath);

    return { pngPath, excalidrawPath: inputPath };
  } catch (err) {
    console.error(`Snapshot render failed: ${(err as Error).message}`);
    return null;
  }
}
