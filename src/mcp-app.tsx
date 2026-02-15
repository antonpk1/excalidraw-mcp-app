import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { Excalidraw, exportToSvg, convertToExcalidrawElements, restore, CaptureUpdateAction, FONT_FAMILY, serializeAsJSON } from "@excalidraw/excalidraw";
import morphdom from "morphdom";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initPencilAudio, playStroke } from "./pencil-audio";
import { captureInitialElements, onEditorChange, setStorageKey, loadPersistedElements, getLatestEditedElements, setCheckpointId } from "./edit-context";
import "./global.css";

// ============================================================
// Debug logging (routes through SDK → host log file)
// ============================================================

let _logFn: ((msg: string) => void) | null = null;
function fsLog(msg: string) {
  if (_logFn) _logFn(msg);
}

// ============================================================
// Shared helpers
// ============================================================

function parsePartialElements(str: string | undefined): any[] {
  if (!str?.trim().startsWith("[")) return [];
  try { return JSON.parse(str); } catch { /* partial */ }
  const last = str.lastIndexOf("}");
  if (last < 0) return [];
  try { return JSON.parse(str.substring(0, last + 1) + "]"); } catch { /* incomplete */ }
  return [];
}

function excludeIncompleteLastItem<T>(arr: T[]): T[] {
  if (!arr || arr.length === 0) return [];
  if (arr.length <= 1) return [];
  return arr.slice(0, -1);
}

interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Force cleaner style: roughness 0 (architect) on all drawable elements. */
function forceCleanStyle(elements: any[]): any[] {
  return elements.map((el: any) => ({ ...el, roughness: 0 }));
}

const PSEUDO_TYPES = new Set(["cameraUpdate", "delete", "restoreCheckpoint"]);
const CONTAINER_SHAPES = new Set(["rectangle", "diamond", "ellipse"]);
const HAS_BOUNDS = new Set(["rectangle", "diamond", "ellipse", "arrow", "text", "line"]);

function elementBounds(el: any): { x: number; y: number; right: number; bottom: number } | null {
  const w = el.width ?? 0;
  const h = el.height ?? 0;
  if (w <= 0 || h <= 0) return null;
  return { x: el.x, y: el.y, right: el.x + w, bottom: el.y + h };
}

function isFullyInside(inner: { x: number; y: number; right: number; bottom: number }, outer: { x: number; y: number; right: number; bottom: number }): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.right <= outer.right && inner.bottom <= outer.bottom;
}

const BINDABLE_SHAPES = new Set(["rectangle", "diamond", "ellipse"]);
const MAX_BINDING_DIST = 80;

function fixedPointForPoint(px: number, py: number, el: any): [number, number] {
  const ex = el.x;
  const ey = el.y;
  const er = el.x + (el.width ?? 0);
  const eb = el.y + (el.height ?? 0);
  const cx = (ex + er) / 2;
  const cy = (ey + eb) / 2;
  const dx = Math.abs(px - cx);
  const dy = Math.abs(py - cy);
  if (dx > dy) return px < cx ? [0, 0.5] : [1, 0.5];
  return py < cy ? [0.5, 0] : [0.5, 1];
}

function distToRect(px: number, py: number, el: any): number {
  const ex = el.x;
  const ey = el.y;
  const er = el.x + (el.width ?? 0);
  const eb = el.y + (el.height ?? 0);
  const dx = Math.max(ex - px, 0, px - er);
  const dy = Math.max(ey - py, 0, py - eb);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Ensure arrows have startBinding/endBinding to closest bindable shapes.
 *  Also updates boundElements on target shapes so Excalidraw treats bindings correctly. */
function ensureArrowBindings(elements: any[]): any[] {
  const bindable = elements.filter((el: any) => BINDABLE_SHAPES.has(el.type));
  const boundUpdates = new Map<string, { type: "arrow"; id: string }[]>();

  const result = elements.map((el: any) => {
    if (el.type !== "arrow" && el.type !== "line") return el;
    const pts = el.points ?? [[0, 0], [el.width ?? 0, el.height ?? 0]];
    const start = { x: el.x + pts[0][0], y: el.y + pts[0][1] };
    const end = { x: el.x + pts[pts.length - 1][0], y: el.y + pts[pts.length - 1][1] };

    let startBinding = el.startBinding;
    let endBinding = el.endBinding;
    if (!startBinding && bindable.length > 0) {
      const best = bindable
        .filter((b: any) => b.id !== el.id)
        .map((b: any) => ({ el: b, d: distToRect(start.x, start.y, b) }))
        .sort((a, b) => a.d - b.d)[0];
      if (best && best.d <= MAX_BINDING_DIST) {
        startBinding = { elementId: best.el.id, fixedPoint: fixedPointForPoint(start.x, start.y, best.el) };
      }
    }
    if (!endBinding && bindable.length > 0) {
      const best = bindable
        .filter((b: any) => b.id !== el.id && b.id !== startBinding?.elementId)
        .map((b: any) => ({ el: b, d: distToRect(end.x, end.y, b) }))
        .sort((a, b) => a.d - b.d)[0];
      if (best && best.d <= MAX_BINDING_DIST) {
        endBinding = { elementId: best.el.id, fixedPoint: fixedPointForPoint(end.x, end.y, best.el) };
      }
    }
    const arrowRef = { type: "arrow" as const, id: el.id };
    if (startBinding) {
      const cur = boundUpdates.get(startBinding.elementId) ?? [];
      if (!cur.some((b) => b.id === el.id)) boundUpdates.set(startBinding.elementId, [...cur, arrowRef]);
    }
    if (endBinding && endBinding.elementId !== startBinding?.elementId) {
      const cur = boundUpdates.get(endBinding.elementId) ?? [];
      if (!cur.some((b) => b.id === el.id)) boundUpdates.set(endBinding.elementId, [...cur, arrowRef]);
    }
    return { ...el, startBinding: startBinding ?? el.startBinding, endBinding: endBinding ?? el.endBinding };
  });

  return result.map((el: any) => {
    const add = boundUpdates.get(el.id);
    if (!add) return el;
    const existing = el.boundElements ?? [];
    const merged = [...existing];
    for (const ref of add) {
      if (!merged.some((b: any) => b.id === ref.id)) merged.push(ref);
    }
    return { ...el, boundElements: merged };
  });
}

/** Force triangle arrowhead on all arrows that have arrowheads. */
function forceTriangleArrowhead(elements: any[]): any[] {
  return elements.map((el: any) => {
    if (el.type !== "arrow" && el.type !== "line") return el;
    const start = el.startArrowhead != null && el.startArrowhead !== "none" ? "triangle" : el.startArrowhead;
    const end = el.endArrowhead != null && el.endArrowhead !== "none" ? "triangle" : el.endArrowhead;
    return { ...el, startArrowhead: start, endArrowhead: end };
  });
}

/** Reorder elements: group containers (back) → arrows → nested shapes (front). */
function reorderElementsForArrows(elements: any[]): any[] {
  const drawable = elements.filter((el: any) => !PSEUDO_TYPES.has(el.type));
  const containers = drawable.filter((el: any) => CONTAINER_SHAPES.has(el.type));
  const arrows = drawable.filter((el: any) => el.type === "arrow" || el.type === "line");
  const byArea = [...containers].sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const containerIds = new Set<string>();
  const nestedIds = new Set<string>();
  for (const p of byArea) {
    const pb = elementBounds(p);
    if (!pb) continue;
    const children = drawable.filter((c: any) => c.id !== p.id && CONTAINER_SHAPES.has(c.type) && HAS_BOUNDS.has(c.type));
    const inside = children.filter((c: any) => {
      const cb = elementBounds(c);
      return cb && isFullyInside(cb, pb);
    });
    if (inside.length === 0) continue;
    containerIds.add(p.id);
    inside.forEach((c: any) => nestedIds.add(c.id));
  }
  const arrowIds = new Set(arrows.map((a: any) => a.id));

  const back = elements.filter((el: any) => containerIds.has(el.id));
  const mid = elements.filter((el: any) => arrowIds.has(el.id));
  const front = elements.filter((el: any) => nestedIds.has(el.id));
  const other = elements.filter((el: any) => !containerIds.has(el.id) && !nestedIds.has(el.id) && !arrowIds.has(el.id));
  return [...back, ...mid, ...front, ...other];
}

/** Assign groupIds so nested shapes form Excalidraw groups — click parent to select and move all. */
function assignGroupIdsForNestedShapes(elements: any[]): any[] {
  const drawable = elements.filter((el: any) => !PSEUDO_TYPES.has(el.type));
  const containers = drawable.filter((el: any) => CONTAINER_SHAPES.has(el.type));
  const withBounds = drawable.filter((el: any) => HAS_BOUNDS.has(el.type));
  if (containers.length < 1 || withBounds.length < 2) return elements;

  const byArea = [...containers].sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const elById = new Map<string, any>();
  for (const el of elements) elById.set(el.id, el);

  const result = elements.map((el) => ({ ...el, groupIds: [...(el.groupIds ?? [])] }));
  const resultById = new Map<string, { el: any; idx: number }>();
  result.forEach((el, i) => resultById.set(el.id, { el, idx: i }));

  for (const parent of byArea) {
    const pb = elementBounds(parent);
    if (!pb) continue;
    const children = withBounds.filter((c: any) => {
      if (c.id === parent.id) return false;
      const cb = elementBounds(c);
      return cb && isFullyInside(cb, pb);
    });
    if (children.length === 0) continue;

    const groupId = crypto.randomUUID();
    const toGroup = [parent, ...children];
    for (const el of toGroup) {
      const r = resultById.get(el.id);
      if (!r) continue;
      const idx = r.idx;
      const existing = result[idx].groupIds ?? [];
      if (existing.includes(groupId)) continue;
      result[idx] = { ...result[idx], groupIds: [...existing, groupId] };
    }
  }

  return result;
}

const LABELABLE_SHAPES = new Set(["rectangle", "diamond", "ellipse"]);
/** Max pixels the text can be above the shape's top edge. */
const MAX_GROUP_TITLE_GAP_ABOVE = 80;
/** Max pixels the text bottom can extend below the shape's top (overlap or inside top of shape). */
const MAX_GROUP_TITLE_OVERLAP_BELOW = 60;

/** Merge standalone "group title" text into the label of the shape below or at top.
 *  Avoids floating text that gets truncated; always use shape labels for group/section titles. */
function mergeGroupTitleTextIntoShapes(elements: any[]): any[] {
  const shapes = elements.filter((el: any) => LABELABLE_SHAPES.has(el.type));
  const texts = elements.filter((el: any) => el.type === "text");
  const mergedInto = new Map<string, string>(); // shapeId -> textId
  const textIdsToRemove = new Set<string>();

  for (const T of texts) {
    const tH = T.height ?? 20;
    const tW = T.width ?? Math.max(20, (String(T.text ?? "").length * (T.fontSize ?? 20) * 0.5));
    const tBottom = T.y + tH;
    let best: { shape: any; gap: number; area: number } | null = null;

    for (const S of shapes) {
      if (S.label) continue; // shape already has a label (e.g. inner box)
      const gap = S.y - tBottom; // positive = text above shape top, negative = text overlaps into shape
      if (gap > MAX_GROUP_TITLE_GAP_ABOVE || gap < -MAX_GROUP_TITLE_OVERLAP_BELOW) continue;
      const tRight = T.x + tW;
      if (tRight < S.x || T.x > S.x + S.width) continue;
      const area = S.width * S.height;
      // Prefer largest shape (zone/group container) then smallest gap (closest to top)
      if (!best || area > best.area || (area === best.area && gap < best.gap)) {
        best = { shape: S, gap, area };
      }
    }
    if (best) {
      mergedInto.set(best.shape.id, T.id);
      textIdsToRemove.add(T.id);
    }
  }

  const shapeLabels = new Map<string, any>();
  for (const [shapeId, textId] of mergedInto) {
    const text = texts.find((t: any) => t.id === textId);
    if (text) {
      shapeLabels.set(shapeId, {
        text: text.text,
        fontSize: text.fontSize ?? 20,
        textAlign: "center",
        verticalAlign: "top", // group/section title at top of shape, not middle
      });
    }
  }

  return elements
    .filter((el: any) => !textIdsToRemove.has(el.id))
    .map((el: any) => {
      const label = shapeLabels.get(el.id);
      return label ? { ...el, label } : el;
    });
}

/** Min area for a shape to be treated as a group container (label at top). Smaller = inner box (label centered). */
const GROUP_LABEL_AREA_THRESHOLD = 25000;

/** Convert raw shorthand elements → Excalidraw format (labels → bound text, font fix).
 *  Preserves pseudo-elements like cameraUpdate (not valid Excalidraw types).
 *  Uses Helvetica (never hand-drawn) and roughness 0 (cleaner). */
function convertRawElements(els: any[]): any[] {
  const pseudoTypes = new Set(["cameraUpdate", "delete", "restoreCheckpoint"]);
  const pseudos = els.filter((el: any) => pseudoTypes.has(el.type));
  const real = els.filter((el: any) => !pseudoTypes.has(el.type));
  const withDefaults = real.map((el: any) => {
    if (!el.label) return el;
    const area = (el.width ?? 0) * (el.height ?? 0);
    const verticalAlign = LABELABLE_SHAPES.has(el.type) && area >= GROUP_LABEL_AREA_THRESHOLD ? "top" : "middle";
    return { ...el, label: { textAlign: "center", ...el.label, verticalAlign } };
  });
  const converted = convertToExcalidrawElements(withDefaults, { regenerateIds: false })
    .map((el: any) => {
      const base = el.type === "text" ? { ...el, fontFamily: (FONT_FAMILY as any).Helvetica } : el;
      return { ...base, roughness: 0 };
    });
  return [...converted, ...pseudos];
}

/** Fix SVG viewBox to 4:3 by expanding the smaller dimension and centering. */
function fixViewBox4x3(svg: SVGSVGElement): void {
  const vb = svg.getAttribute("viewBox")?.split(" ").map(Number);
  if (!vb || vb.length !== 4) return;
  const [vx, vy, vw, vh] = vb;
  const r = vw / vh;
  if (Math.abs(r - 4 / 3) < 0.01) return;
  if (r > 4 / 3) {
    const h2 = Math.round(vw * 3 / 4);
    svg.setAttribute("viewBox", `${vx} ${vy - Math.round((h2 - vh) / 2)} ${vw} ${h2}`);
  } else {
    const w2 = Math.round(vh * 4 / 3);
    svg.setAttribute("viewBox", `${vx - Math.round((w2 - vw) / 2)} ${vy} ${w2} ${vh}`);
  }
}

function extractViewportAndElements(elements: any[]): {
  viewport: ViewportRect | null;
  drawElements: any[];
  restoreId: string | null;
  deleteIds: Set<string>;
} {
  let viewport: ViewportRect | null = null;
  let restoreId: string | null = null;
  const deleteIds = new Set<string>();
  const drawElements: any[] = [];

  for (const el of elements) {
    if (el.type === "cameraUpdate") {
      viewport = { x: el.x, y: el.y, width: el.width, height: el.height };
    } else if (el.type === "restoreCheckpoint") {
      restoreId = el.id;
    } else if (el.type === "delete") {
      for (const id of String(el.ids ?? el.id).split(",")) deleteIds.add(id.trim());
    } else {
      drawElements.push(el);
    }
  }

  // Hide deleted elements via near-zero opacity instead of removing — preserves SVG
  // group count/order so morphdom matches by position correctly (no cascade re-animations).
  // Using 1 (not 0) because Excalidraw treats opacity:0 as "unset" → defaults to 100.
  const processedDraw = deleteIds.size > 0
    ? drawElements.map((el: any) => (deleteIds.has(el.id) || deleteIds.has(el.containerId)) ? { ...el, opacity: 1 } : el)
    : drawElements;

  return { viewport, drawElements: processedDraw, restoreId, deleteIds };
}

const ExpandIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8.5 1.5H12.5V5.5" />
    <path d="M5.5 12.5H1.5V8.5" />
    <path d="M12.5 1.5L8 6" />
    <path d="M1.5 12.5L6 8" />
  </svg>
);

const ExternalLinkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 8.667V12.667C12 13.035 11.702 13.333 11.333 13.333H3.333C2.965 13.333 2.667 13.035 2.667 12.667V4.667C2.667 4.298 2.965 4 3.333 4H7.333" />
    <path d="M10 2.667H13.333V6" />
    <path d="M6.667 9.333L13.333 2.667" />
  </svg>
);

async function shareToExcalidraw(api: any, app: App) {
  try {
    const elements = api.getSceneElements();
    const appState = api.getAppState();
    const files = api.getFiles();
    if (!elements?.length) return;

    // Serialize to Excalidraw JSON
    const json = serializeAsJSON(elements, appState, files, "database");

    // Proxy through server tool (avoids CORS on json.excalidraw.com)
    const result = await app.callServerTool({
      name: "export_to_excalidraw",
      arguments: { json },
    });

    if (result.isError) {
      fsLog(`export failed: ${JSON.stringify(result.content)}`);
      return;
    }

    const url = (result.content[0] as any).text;
    await app.openLink({ url });
  } catch (err) {
    fsLog(`shareToExcalidraw error: ${err}`);
  }
}

/** Derive a suggested diagram title from element text (e.g. "Intuition - Intuition-rs repo Architecture"). */
function deriveTitleFromElements(elements: any[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const add = (s: string) => {
    const t = (s ?? "").replace(/\n/g, " ").trim().slice(0, 60);
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      parts.push(t);
    }
  };
  for (const el of elements) {
    if (!el || el.isDeleted) continue;
    if (el.type === "text") add(el.text ?? el.rawText ?? "");
    else if (el.label?.text) add(el.label.text);
  }
  const joined = parts.slice(0, 3).join(" - ").trim();
  return joined || "diagram";
}

/** Build full Excalidraw document JSON for .excalidraw file (obsidian-excalidraw plugin). */
function buildExcalidrawDocumentJson(elements: any[], appState?: any, files?: Record<string, any>): string {
  const appStateSafe = appState ?? {
    viewBackgroundColor: "#ffffff",
    currentItemFontFamily: 1,
    exportBackground: false,
    exportScale: 1,
    exportWithDarkMode: false,
    gridSize: null,
    name: "Untitled",
    previousSelectedElementIds: {},
    scrollX: 0,
    scrollY: 0,
    selectedElementIds: {},
    shouldAddWatermark: false,
    showStats: false,
    theme: "light",
    viewState: {},
    zoom: { value: 1 },
  };
  const filesSafe = files ?? {};
  const doc = {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: elements.filter((el: any) => el && !el.isDeleted),
    appState: appStateSafe,
    files: filesSafe,
  };
  return JSON.stringify(doc);
}

function CreateInObsidianButton({
  app,
  elements,
  excalidrawApi,
  checkpointIdRef,
}: {
  app: App;
  elements: any[];
  excalidrawApi: any;
  checkpointIdRef: React.MutableRefObject<string | null>;
}) {
  const [state, setState] = useState<"idle" | "confirm" | "creating" | "success" | "error">("idle");
  const [titleDraft, setTitleDraft] = useState("diagram");
  const [errorMsg, setErrorMsg] = useState<string>("");

  const openModal = useCallback(() => {
    setTitleDraft(deriveTitleFromElements(elements));
    setState("confirm");
  }, [elements]);

  const doCreate = useCallback(async (title: string) => {
    if (elements.length === 0) return;
    setState("creating");
    setErrorMsg("");
    try {
      let json: string;
      if (excalidrawApi) {
        const els = excalidrawApi.getSceneElements();
        const appState = excalidrawApi.getAppState();
        const files = excalidrawApi.getFiles();
        json = serializeAsJSON(els ?? elements, appState ?? {}, files ?? {}, "database");
      } else {
        json = buildExcalidrawDocumentJson(elements);
      }
      const args: { json: string; title: string; checkpointId?: string } = {
        json,
        title: title.trim() || "diagram",
      };
      const cpId = checkpointIdRef.current;
      if (cpId) args.checkpointId = cpId;
      const result = await app.callServerTool({
        name: "create_in_obsidian",
        arguments: args,
      });
      if (result.isError) {
        const text = (result.content[0] as any)?.text ?? "Unknown error";
        setErrorMsg(text);
        setState("error");
      } else {
        setState("success");
        setTimeout(() => setState("idle"), 2000);
      }
    } catch (err) {
      setErrorMsg((err as Error).message);
      setState("error");
    }
  }, [app, elements, excalidrawApi, checkpointIdRef]);

  const label =
    state === "creating" ? "Creating…" :
    state === "success" ? "Created in Obsidian" :
    state === "error" ? "Failed" : "Create in Obsidian";

  return (
    <div className="create-in-obsidian-wrap" style={{ pointerEvents: "auto" }}>
      <button
        className="standalone"
        type="button"
        title="Save diagram as .md file in Obsidian vault"
        disabled={state === "creating"}
        onClick={openModal}
        style={{ display: "flex", alignItems: "center", gap: 5, width: "auto", padding: "0 10px", fontSize: "0.75rem", fontWeight: 400 }}
      >
        <span>{label}</span>
      </button>
      {state === "confirm" && (
        <div className="export-modal-overlay" onClick={() => setState("idle")}>
          <div className="Island export-modal export-modal-create-obsidian" onClick={(e) => e.stopPropagation()}>
            <h3 className="export-modal-title">Create in Obsidian</h3>
            <p className="export-modal-text">
              File will be saved as <strong>{titleDraft.trim() || "diagram"}.md</strong> in your vault.
            </p>
            <label style={{ display: "block", marginBottom: 8, fontSize: "0.85rem" }}>
              Diagram title (filename):
            </label>
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setState("creating");
                  doCreate(titleDraft);
                }
              }}
              placeholder="diagram"
              className="standalone"
              style={{ width: "100%", padding: "6px 10px", marginBottom: 12, boxSizing: "border-box" }}
              autoFocus
            />
            <div className="export-modal-actions">
              <button type="button" className="standalone" onClick={() => setState("idle")}>
                Cancel
              </button>
              <button
                type="button"
                className="standalone export-modal-confirm"
                onClick={() => { setState("creating"); doCreate(titleDraft); }}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
      {state === "error" && errorMsg && (
        <span className="create-in-obsidian-error" style={{ fontSize: "0.7rem", color: "var(--color-danger, #c92a2a)", marginLeft: 8 }} title={errorMsg}>
          {errorMsg.length > 40 ? `${errorMsg.slice(0, 40)}…` : errorMsg}
        </span>
      )}
    </div>
  );
}

function ShareButton({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "confirm" | "uploading">("idle");

  const handleConfirm = async () => {
    setState("uploading");
    try {
      await onConfirm();
    } finally {
      setState("idle");
    }
  };

  return (
    <>
      <button
        className="standalone"
        style={{ display: "flex", alignItems: "center", gap: 5, width: "auto", padding: "0 10px", marginRight: -8 }}
        title="Export to Excalidraw"
        disabled={state === "uploading"}
        onClick={() => setState("confirm")}
      >
        <ExternalLinkIcon />
        <span style={{ fontSize: "0.75rem", fontWeight: 400 }}>{state === "uploading" ? "Exporting…" : "Export"}</span>
      </button>

      {state === "confirm" && (
        <div className="export-modal-overlay" onClick={() => setState("idle")}>
          <div className="Island export-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="export-modal-title">Export to Excalidraw</h3>
            <p className="export-modal-text">
              This will upload your diagram to excalidraw.com and open it in a new tab.
            </p>
            <div className="export-modal-actions">
              <button className="standalone" onClick={() => setState("idle")}>
                Cancel
              </button>
              <button className="standalone export-modal-confirm" onClick={handleConfirm}>
                Export
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ============================================================
// Diagram component (Excalidraw SVG)
// ============================================================

const LERP_SPEED = 0.03; // 0–1, higher = faster snap
const EXPORT_PADDING = 20;

/**
 * Compute the min x/y of all draw elements in scene coordinates.
 * This matches the offset Excalidraw's exportToSvg applies internally:
 *   SVG_x = scene_x - sceneMinX + exportPadding
 */
function computeSceneBounds(elements: any[]): { minX: number; minY: number } {
  let minX = Infinity;
  let minY = Infinity;
  for (const el of elements) {
    if (el.x != null) {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      // Arrow points are offsets from el.x/y
      if (el.points && Array.isArray(el.points)) {
        for (const pt of el.points) {
          minX = Math.min(minX, el.x + pt[0]);
          minY = Math.min(minY, el.y + pt[1]);
        }
      }
    }
  }
  return { minX: isFinite(minX) ? minX : 0, minY: isFinite(minY) ? minY : 0 };
}

/**
 * Convert a scene-space viewport rect to an SVG-space viewBox.
 */
function sceneToSvgViewBox(
  vp: ViewportRect,
  sceneMinX: number,
  sceneMinY: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: vp.x - sceneMinX + EXPORT_PADDING,
    y: vp.y - sceneMinY + EXPORT_PADDING,
    w: vp.width,
    h: vp.height,
  };
}

function DiagramView({ toolInput, isFinal, displayMode, onElements, editedElements, onViewport, loadCheckpoint }: { toolInput: any; isFinal: boolean; displayMode: string; onElements?: (els: any[]) => void; editedElements?: any[]; onViewport?: (vp: ViewportRect) => void; loadCheckpoint?: (id: string) => Promise<{ elements: any[] } | null> }) {
  const svgRef = useRef<HTMLDivElement | null>(null);
  const latestRef = useRef<any[]>([]);
  const restoredRef = useRef<{ id: string; elements: any[] } | null>(null);
  const [, setCount] = useState(0);

  // Init pencil audio on first mount
  useEffect(() => { initPencilAudio(); }, []);

  // Set container height: 4:3 in inline, full viewport in fullscreen
  useEffect(() => {
    if (!svgRef.current) return;
    if (displayMode === "fullscreen") {
      svgRef.current.style.height = "100%";
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0 && svgRef.current) {
        svgRef.current.style.height = `${Math.round(w * 3 / 4)}px`;
      }
    });
    observer.observe(svgRef.current);
    return () => observer.disconnect();
  }, [displayMode]);

  // Font preloading — ensure Helvetica (clean, non-hand-drawn) is loaded before first export
  const fontsReady = useRef<Promise<void> | null>(null);
  const ensureFontsLoaded = useCallback(() => {
    if (!fontsReady.current) {
      fontsReady.current = document.fonts.load('20px Helvetica').then(() => {});
    }
    return fontsReady.current;
  }, []);

  // Animated viewport in SCENE coordinates (stable across re-exports)
  const animatedVP = useRef<ViewportRect | null>(null);
  const targetVP = useRef<ViewportRect | null>(null);
  const sceneBoundsRef = useRef<{ minX: number; minY: number }>({ minX: 0, minY: 0 });
  const animFrameRef = useRef<number>(0);

  /** Apply current animated scene-space viewport to the SVG. */
  const applyViewBox = useCallback(() => {
    if (!animatedVP.current || !svgRef.current) return;
    const svg = svgRef.current.querySelector("svg");
    if (!svg) return;
    const { minX, minY } = sceneBoundsRef.current;
    // Auto-correct to 4:3 at render time (expand smaller dimension)
    const { x, y, width: w, height: h } = animatedVP.current;
    const ratio = w / h;
    const vp4x3: ViewportRect = Math.abs(ratio - 4 / 3) < 0.01 ? animatedVP.current
      : ratio > 4 / 3 ? { x, y, width: w, height: Math.round(w * 3 / 4) }
      : { x, y, width: Math.round(h * 4 / 3), height: h };
    const vb = sceneToSvgViewBox(vp4x3, minX, minY);
    svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  }, []);

  /** Lerp scene-space viewport toward target each frame. */
  const animateViewBox = useCallback(() => {
    if (!animatedVP.current || !targetVP.current) return;
    const a = animatedVP.current;
    const t = targetVP.current;
    a.x += (t.x - a.x) * LERP_SPEED;
    a.y += (t.y - a.y) * LERP_SPEED;
    a.width += (t.width - a.width) * LERP_SPEED;
    a.height += (t.height - a.height) * LERP_SPEED;
    applyViewBox();
    const delta = Math.abs(t.x - a.x) + Math.abs(t.y - a.y)
      + Math.abs(t.width - a.width) + Math.abs(t.height - a.height);
    if (delta > 0.5) {
      animFrameRef.current = requestAnimationFrame(animateViewBox);
    }
  }, [applyViewBox]);

  // Cleanup animation on unmount
  useEffect(() => {
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, []);

  const renderSvgPreview = useCallback(async (els: any[], viewport: ViewportRect | null, baseElements?: any[]) => {
    if ((els.length === 0 && !baseElements?.length) || !svgRef.current) return;
    try {
      // Wait for Helvetica font to load before computing text metrics
      await ensureFontsLoaded();

      // Convert new elements (raw → Excalidraw format)
      const convertedNew = convertRawElements(els);
      const baseReal = baseElements?.filter((el: any) => el.type !== "cameraUpdate") ?? [];
      const excalidrawEls = [...baseReal, ...convertedNew];

      // Update scene bounds from all elements
      sceneBoundsRef.current = computeSceneBounds(excalidrawEls);

      let processedEls = forceCleanStyle(excalidrawEls);
      processedEls = ensureArrowBindings(processedEls);
      processedEls = forceTriangleArrowhead(processedEls);
      processedEls = assignGroupIdsForNestedShapes(processedEls);
      processedEls = reorderElementsForArrows(processedEls);
      const svg = await exportToSvg({
        elements: processedEls as any,
        appState: { viewBackgroundColor: "transparent", exportBackground: false } as any,
        files: null,
        exportPadding: EXPORT_PADDING,
        skipInliningFonts: true,
      });
      if (!svgRef.current) return;

      let wrapper = svgRef.current.querySelector(".svg-wrapper") as HTMLDivElement | null;
      if (!wrapper) {
        wrapper = document.createElement("div");
        wrapper.className = "svg-wrapper";
        svgRef.current.appendChild(wrapper);
      }

      // Fill the container (height set by ResizeObserver to maintain 4:3)
      svg.style.width = "100%";
      svg.style.height = "100%";
      svg.removeAttribute("width");
      svg.removeAttribute("height");

      const existing = wrapper.querySelector("svg");
      if (existing) {
        morphdom(existing, svg, { childrenOnly: false });
      } else {
        wrapper.appendChild(svg);
      }

      // Always fix SVG viewBox to 4:3
      const renderedSvg = wrapper.querySelector("svg");
      if (renderedSvg) fixViewBox4x3(renderedSvg as SVGSVGElement);

      // Animate viewport in scene space, convert to SVG space at apply time
      if (viewport) {
        targetVP.current = { ...viewport };
        onViewport?.(viewport);
        if (!animatedVP.current) {
          // First viewport — snap immediately
          animatedVP.current = { ...viewport };
        }
        // Re-apply immediately after morphdom to prevent flicker
        applyViewBox();
        // Start/restart animation toward new target
        if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = requestAnimationFrame(animateViewBox);
      } else {
        // No explicit viewport — use default
        const defaultVP: ViewportRect = { x: 0, y: 0, width: 1024, height: 768 };
        onViewport?.(defaultVP);
        targetVP.current = defaultVP;
        if (!animatedVP.current) {
          animatedVP.current = { ...defaultVP };
        }
        applyViewBox();
        if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = requestAnimationFrame(animateViewBox);
        targetVP.current = null;
        if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      }
    } catch {
      // export can fail on partial/malformed elements
    }
  }, [applyViewBox, animateViewBox]);

  useEffect(() => {
    if (!toolInput) return;
    const raw = toolInput.elements;
    if (!raw) return;

    // Parse elements from string or array
    const str = typeof raw === "string" ? raw : JSON.stringify(raw);

    if (isFinal) {
      // Final input — parse complete JSON, render ALL elements
      const parsed = parsePartialElements(str);
      let { viewport, drawElements, restoreId, deleteIds } = extractViewportAndElements(parsed);
      drawElements = mergeGroupTitleTextIntoShapes(drawElements);

      // Load checkpoint base if restoring (async — from server)
      let base: any[] | undefined;
      const doFinal = async () => {
        if (restoreId && loadCheckpoint) {
          const saved = await loadCheckpoint(restoreId);
          if (saved) {
            base = saved.elements;
            // Extract camera from base as fallback
            if (!viewport) {
              const cam = base.find((el: any) => el.type === "cameraUpdate");
              if (cam) viewport = { x: cam.x, y: cam.y, width: cam.width, height: cam.height };
            }
            // Convert base with convertRawElements (handles both raw and already-converted)
            base = convertRawElements(base);
          }
          if (base && deleteIds.size > 0) {
            base = base.filter((el: any) => !deleteIds.has(el.id) && !deleteIds.has(el.containerId));
          }
        }

        latestRef.current = drawElements;
        // Convert new elements for fullscreen editor
        const convertedNew = convertRawElements(drawElements);

        // Merge base (converted) + new converted, then apply arrow fixes + auto-group
        let allConverted = base ? [...base, ...convertedNew] : convertedNew;
        allConverted = ensureArrowBindings(allConverted);
        allConverted = forceTriangleArrowhead(allConverted);
        allConverted = assignGroupIdsForNestedShapes(allConverted);
        allConverted = reorderElementsForArrows(allConverted);
        captureInitialElements(allConverted);
        // Only set elements if user hasn't edited yet (editedElements means user edits exist)
        if (!editedElements) onElements?.(allConverted);
        if (!editedElements) renderSvgPreview(drawElements, viewport, base);
      };
      doFinal();
      return;
    }

    // Partial input — drop last (potentially incomplete) element
    const parsed = parsePartialElements(str);

    // Extract restoreCheckpoint and delete before dropping last (they're small, won't be incomplete)
    let streamRestoreId: string | null = null;
    const streamDeleteIds = new Set<string>();
    for (const el of parsed) {
      if (el.type === "restoreCheckpoint") streamRestoreId = el.id;
      else if (el.type === "delete") {
        for (const id of String(el.ids ?? el.id).split(",")) streamDeleteIds.add(id.trim());
      }
    }

    const safe = excludeIncompleteLastItem(parsed);
    let { viewport, drawElements } = extractViewportAndElements(safe);
    drawElements = mergeGroupTitleTextIntoShapes(drawElements);

    const doStream = async () => {
      // Load checkpoint base (once per restoreId) — from server via callServerTool
      let base: any[] | undefined;
      if (streamRestoreId) {
        if (!restoredRef.current || restoredRef.current.id !== streamRestoreId) {
          if (loadCheckpoint) {
            const saved = await loadCheckpoint(streamRestoreId);
            if (saved) {
              const converted = convertRawElements(saved.elements);
              restoredRef.current = { id: streamRestoreId, elements: converted };
            }
          }
        }
        base = restoredRef.current?.elements;
        // Extract camera from base as fallback
        if (!viewport && base) {
          const cam = base.find((el: any) => el.type === "cameraUpdate");
          if (cam) viewport = { x: cam.x, y: cam.y, width: cam.width, height: cam.height };
        }
        if (base && streamDeleteIds.size > 0) {
          base = base.filter((el: any) => !streamDeleteIds.has(el.id) && !streamDeleteIds.has(el.containerId));
        }
      }

      if (drawElements.length > 0 && drawElements.length !== latestRef.current.length) {
        // Play pencil sound for each new element
        const prevCount = latestRef.current.length;
        for (let i = prevCount; i < drawElements.length; i++) {
          playStroke(drawElements[i].type ?? "rectangle");
        }
        latestRef.current = drawElements;
        setCount(drawElements.length);
        const jittered = drawElements.map((el: any) => ({ ...el, seed: Math.floor(Math.random() * 1e9) }));
        renderSvgPreview(jittered, viewport, base);
      } else if (base && base.length > 0 && latestRef.current.length === 0) {
        // First render: show restored base before new elements stream in
        renderSvgPreview([], viewport, base);
      }
    };
    doStream();
  }, [toolInput, isFinal, renderSvgPreview]);

  // Render already-converted elements directly (skip convertToExcalidrawElements)
  useEffect(() => {
    if (!editedElements || editedElements.length === 0 || !svgRef.current) return;
    (async () => {
      try {
        await ensureFontsLoaded();
        const cleanEls = forceCleanStyle(editedElements);
        const svg = await exportToSvg({
          elements: cleanEls as any,
          appState: { viewBackgroundColor: "transparent", exportBackground: false } as any,
          files: null,
          exportPadding: EXPORT_PADDING,
          skipInliningFonts: true,
        });
        if (!svgRef.current) return;
        let wrapper = svgRef.current.querySelector(".svg-wrapper") as HTMLDivElement | null;
        if (!wrapper) {
          wrapper = document.createElement("div");
          wrapper.className = "svg-wrapper";
          svgRef.current.appendChild(wrapper);
        }
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        const existing = wrapper.querySelector("svg");
        if (existing) {
          morphdom(existing, svg, { childrenOnly: false });
        } else {
          wrapper.appendChild(svg);
        }
        const final = wrapper.querySelector("svg");
        if (final) fixViewBox4x3(final as SVGSVGElement);
      } catch {}
    })();
  }, [editedElements]);

  return (
    <div
      ref={svgRef}
      className="excalidraw-container"
      style={{ display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}
    />
  );
}

// ============================================================
// Main app — Excalidraw only
// ============================================================

function ExcalidrawApp() {
  const [toolInput, setToolInput] = useState<any>(null);
  const [inputIsFinal, setInputIsFinal] = useState(false);
  const [displayMode, setDisplayMode] = useState<"inline" | "fullscreen">("inline");
  const [elements, setElements] = useState<any[]>([]);
  const [userEdits, setUserEdits] = useState<any[] | null>(null);
  const [containerHeight, setContainerHeight] = useState<number | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [excalidrawApi, setExcalidrawApi] = useState<any>(null);
  const [editorSettled, setEditorSettled] = useState(false);
  const appRef = useRef<App | null>(null);
  const svgViewportRef = useRef<ViewportRect | null>(null);
  const elementsRef = useRef<any[]>([]);
  const checkpointIdRef = useRef<string | null>(null);

  const toggleFullscreen = useCallback(async () => {
    if (!appRef.current) return;
    const newMode = displayMode === "fullscreen" ? "inline" : "fullscreen";
    fsLog(`toggle: ${displayMode}→${newMode}`);
    // Sync edited elements before leaving fullscreen
    if (newMode === "inline") {
      const edited = getLatestEditedElements();
      if (edited) {
            setElements(edited);
        setUserEdits(edited);
      }
    }
    try {
      const result = await appRef.current.requestDisplayMode({ mode: newMode });
      fsLog(`requestDisplayMode result: ${result.mode}`);
      setDisplayMode(result.mode as "inline" | "fullscreen");
    } catch (err) {
      fsLog(`requestDisplayMode FAILED: ${err}`);
    }
  }, [displayMode, elements.length, inputIsFinal]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && displayMode === "fullscreen") toggleFullscreen();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [displayMode, toggleFullscreen]);

  // Preload fonts on first mount so they're cached before fullscreen.
  // Helvetica (clean) for diagram text; Assistant for Excalidraw UI.
  useEffect(() => {
    Promise.all([
      document.fonts.load('20px Helvetica'),
      document.fonts.load('400 16px Assistant'),
      document.fonts.load('500 16px Assistant'),
      document.fonts.load('700 16px Assistant'),
    ]).catch(() => {});
  }, []);

  // Set explicit height on html/body in fullscreen (position:fixed doesn't give body height in iframes)
  useEffect(() => {
    if (displayMode === "fullscreen" && containerHeight) {
      const h = `${containerHeight}px`;
      document.documentElement.style.height = h;
      document.body.style.height = h;
    } else {
      document.documentElement.style.height = "";
      document.body.style.height = "";
    }
  }, [displayMode, containerHeight]);

  // Mount editor when entering fullscreen
  useEffect(() => {
    if (displayMode !== "fullscreen") {
      setEditorReady(false);
      setExcalidrawApi(null);
      setEditorSettled(false);
      return;
    }
    (async () => {
      await document.fonts.ready;
      setTimeout(() => setEditorReady(true), 200);
    })();
  }, [displayMode]);

  // After editor mounts: refresh text dimensions, then reveal
  const mountEditor = displayMode === "fullscreen" && inputIsFinal && elements.length > 0 && editorReady;
  useEffect(() => {
    if (!mountEditor || !excalidrawApi) return;
    if (editorSettled) return; // already revealed, don't redo
    const api = excalidrawApi;

    const settle = async () => {
      try { await document.fonts.load('20px Helvetica'); } catch {}
      await document.fonts.ready;

      const sceneElements = api.getSceneElements();
      if (sceneElements?.length) {
        const { elements: fixed } = restore(
          { elements: sceneElements },
          null, null,
          { refreshDimensions: true }
        );
        api.updateScene({
          elements: fixed,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      requestAnimationFrame(() => setEditorSettled(true));
    };

    const timer = setTimeout(settle, 200);
    return () => clearTimeout(timer);
  }, [mountEditor, excalidrawApi, editorSettled]);

  // Keep elementsRef in sync for ontoolresult handler (which captures closure once)
  useEffect(() => { elementsRef.current = elements; }, [elements]);

  const { app, error } = useApp({
    appInfo: { name: "Excalidraw", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      appRef.current = app;
      _logFn = (msg) => { try { app.sendLog({ level: "info", logger: "FS", data: msg }); } catch {} };

      // Capture initial container dimensions
      const initDims = app.getHostContext()?.containerDimensions as any;
      if (initDims?.height) setContainerHeight(initDims.height);

      app.onhostcontextchanged = (ctx: any) => {
        if (ctx.containerDimensions?.height) {
          setContainerHeight(ctx.containerDimensions.height);
        }
        if (ctx.displayMode) {
          fsLog(`hostContextChanged: displayMode=${ctx.displayMode}`);
          // Sync edited elements when host exits fullscreen
          if (ctx.displayMode === "inline") {
            const edited = getLatestEditedElements();
            if (edited) {
              setElements(edited);
              setUserEdits(edited);
            }
          }
          setDisplayMode(ctx.displayMode as "inline" | "fullscreen");
        }
      };

      app.ontoolinputpartial = async (input) => {
        const args = (input as any)?.arguments || input;
        setInputIsFinal(false);
        setToolInput(args);
      };

      app.ontoolinput = async (input) => {
        const args = (input as any)?.arguments || input;
        setInputIsFinal(true);
        setToolInput(args);
      };

      app.ontoolresult = (result: any) => {
        const cpId = (result.structuredContent as { checkpointId?: string })?.checkpointId;
        if (cpId) {
          checkpointIdRef.current = cpId;
          setCheckpointId(cpId);
          // Use checkpointId as localStorage key for persisting user edits
          setStorageKey(cpId);
          // Check for persisted edits from a previous fullscreen session
          const persisted = loadPersistedElements();
          if (persisted && persisted.length > 0) {
            elementsRef.current = persisted;
            setElements(persisted);
            setUserEdits(persisted);
          }
        }
      };

      app.onteardown = async () => ({});
      app.onerror = (err) => console.error("[Excalidraw] Error:", err);
    },
  });

  if (error) return <div className="error">ERROR: {error.message}</div>;
  if (!app) return <div className="loading">Connecting...</div>;

  return (
    <main className={`main${displayMode === "fullscreen" ? " fullscreen" : ""}`} style={displayMode === "fullscreen" && containerHeight ? { height: containerHeight } : undefined}>
      {displayMode === "inline" && (
        <div className="toolbar">
          <button
            className="fullscreen-btn"
            onClick={toggleFullscreen}
            title="Enter fullscreen"
          >
            <ExpandIcon />
          </button>
        </div>
      )}
      {/* Editor: mount hidden when ready, reveal after viewport is set */}
      {mountEditor && (
        <div style={{
          width: "100%",
          height: "100%",
          visibility: editorSettled ? "visible" : "hidden",
          position: editorSettled ? undefined : "absolute",
          inset: editorSettled ? undefined : 0,
        }}>
          <Excalidraw
            excalidrawAPI={(api) => { setExcalidrawApi(api); fsLog(`excalidrawAPI set`); }}
            initialData={{ elements: elements as any, scrollToContent: true }}
            theme="light"
            onChange={(els) => onEditorChange(app, els)}
            renderTopRightUI={() => (
              <ShareButton
                onConfirm={async () => {
                  if (excalidrawApi) await shareToExcalidraw(excalidrawApi, app);
                }}
              />
            )}
          />
        </div>
      )}
      {/* SVG: stays visible until editor is fully settled */}
      {!editorSettled && (
        <div
          onClick={undefined}
          style={undefined}
        >
          <DiagramView toolInput={toolInput} isFinal={inputIsFinal} displayMode={displayMode} onElements={(els) => { elementsRef.current = els; setElements(els); }} editedElements={userEdits ?? undefined} onViewport={(vp) => { svgViewportRef.current = vp; }} loadCheckpoint={async (id) => {
            if (!appRef.current) return null;
            try {
              const result = await appRef.current.callServerTool({ name: "read_checkpoint", arguments: { id } });
              const text = (result.content[0] as any)?.text;
              if (!text) return null;
              return JSON.parse(text);
            } catch { return null; }
          }} />
        </div>
      )}
      {/* Footer: Create in Obsidian — visible when there is a diagram */}
      {inputIsFinal && elements.length > 0 && app && (
        <div className="canvas-footer">
          <CreateInObsidianButton app={app} elements={elements} excalidrawApi={excalidrawApi} checkpointIdRef={checkpointIdRef} />
        </div>
      )}
    </main>
  );
}

createRoot(document.body).render(<ExcalidrawApp />);
