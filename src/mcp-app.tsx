import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { Excalidraw, exportToSvg, convertToExcalidrawElements, restore, CaptureUpdateAction, FONT_FAMILY, serializeAsJSON } from "@excalidraw/excalidraw";
import morphdom from "morphdom";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initPencilAudio, playStroke } from "./pencil-audio";
import { captureInitialElements, onEditorChange, setStorageKey, loadPersistedElements, getLatestEditedElements, setCheckpointId, setCheckpointViewport } from "./edit-context";
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
    if (el.type === "cameraUpdate" || el.type === "viewportUpdate") {
      viewport = { x: el.x, y: el.y, width: el.width, height: el.height };
    } else if (el.type === "restoreCheckpoint") {
      restoreId = el.id;
    } else if (el.type === "deleteElement") {
      deleteIds.add(el.id);
    } else {
      drawElements.push(el);
    }
  }

  return { viewport, drawElements, restoreId, deleteIds };
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

const EditIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11.333 2A1.886 1.886 0 0 1 14 4.667L5.333 13.333 2 14l.667-3.333L11.333 2z" />
  </svg>
);

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.333 4L6 11.333 2.667 8" />
  </svg>
);

/**
 * Export elements to excalidraw.com — works with either the Excalidraw API
 * (from the editor) or raw converted elements (from inline SVG preview).
 */
async function exportElements(app: App, elements: any[], appState?: any, files?: any) {
  try {
    if (!elements?.length) return;
    const json = serializeAsJSON(
      elements,
      appState ?? { viewBackgroundColor: "#ffffff", exportBackground: true },
      files ?? {},
      "database",
    );
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
    fsLog(`exportElements error: ${err}`);
  }
}

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

function DiagramView({ toolInput, isFinal, displayMode, onElements, editedElements, onViewport }: { toolInput: any; isFinal: boolean; displayMode: string; onElements?: (els: any[]) => void; editedElements?: any[]; onViewport?: (vp: ViewportRect) => void }) {
  const svgRef = useRef<HTMLDivElement | null>(null);
  const latestRef = useRef<any[]>([]);
  const restoredRef = useRef<{ id: string; elements: any[]; viewport: ViewportRect | null } | null>(null);
  const [, setCount] = useState(0);

  // Init pencil audio on first mount
  useEffect(() => { initPencilAudio(); }, []);

  // Set container height: 4:3 in inline, full viewport in fullscreen
  useEffect(() => {
    if (!svgRef.current) return;
    if (displayMode === "fullscreen") {
      svgRef.current.style.height = "100vh";
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

  // Font preloading — ensure Virgil is loaded before first export
  const fontsReady = useRef<Promise<void> | null>(null);
  const ensureFontsLoaded = useCallback(() => {
    if (!fontsReady.current) {
      fontsReady.current = document.fonts.load('20px Excalifont').then(() => {});
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
    const vb = sceneToSvgViewBox(animatedVP.current, minX, minY);
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
      // Wait for Virgil font to load before computing text metrics
      await ensureFontsLoaded();

      // Convert new elements (raw → Excalidraw format)
      const withLabelDefaults = els.map((el: any) =>
        el.label ? { ...el, label: { textAlign: "center", verticalAlign: "middle", ...el.label } } : el
      );
      const convertedNew = convertToExcalidrawElements(withLabelDefaults, { regenerateIds: false })
        .map((el: any) => el.type === "text" ? { ...el, fontFamily: (FONT_FAMILY as any).Excalifont ?? 1 } : el);

      // Merge with checkpoint base (already converted — skip re-conversion to avoid corruption)
      const excalidrawEls = baseElements ? [...baseElements, ...convertedNew] : convertedNew;

      // Update scene bounds from all elements
      sceneBoundsRef.current = computeSceneBounds(excalidrawEls);

      const svg = await exportToSvg({
        elements: excalidrawEls as any,
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
      const { viewport, drawElements, restoreId, deleteIds } = extractViewportAndElements(parsed);

      // Load checkpoint base if restoring
      let base: any[] | undefined;
      let savedViewport: ViewportRect | null = null;
      if (restoreId) {
        const saved = localStorage.getItem(`checkpoint:${restoreId}`);
        if (saved) try {
          const parsed = JSON.parse(saved);
          // Handle both old format (array) and new format ({ elements, viewport })
          base = Array.isArray(parsed) ? parsed : parsed.elements;
          savedViewport = Array.isArray(parsed) ? null : parsed.viewport ?? null;
        } catch {}
        if (base && deleteIds.size > 0) {
          base = base.filter((el: any) => !deleteIds.has(el.id));
        }
      }

      // Use saved viewport as fallback if no cameraUpdate in new elements
      const effectiveViewport = viewport ?? savedViewport;

      latestRef.current = drawElements;
      // Convert new elements for fullscreen editor
      const withDefaults = drawElements.map((el: any) =>
        el.label ? { ...el, label: { textAlign: "center", verticalAlign: "middle", ...el.label } } : el
      );
      const convertedNew = convertToExcalidrawElements(withDefaults, { regenerateIds: false })
        .map((el: any) => el.type === "text" ? { ...el, fontFamily: (FONT_FAMILY as any).Excalifont ?? 1 } : el);

      // Merge base (already converted) + new converted
      const allConverted = base ? [...base, ...convertedNew] : convertedNew;
      captureInitialElements(allConverted);
      // Only set elements if user hasn't edited yet (editedElements means user edits exist)
      if (!editedElements) onElements?.(allConverted);
      renderSvgPreview(drawElements, effectiveViewport, base);
      return;
    }

    // Partial input — drop last (potentially incomplete) element
    const parsed = parsePartialElements(str);

    // Extract restoreCheckpoint and deleteElement before dropping last (they're small, won't be incomplete)
    let streamRestoreId: string | null = null;
    const streamDeleteIds = new Set<string>();
    for (const el of parsed) {
      if (el.type === "restoreCheckpoint") streamRestoreId = el.id;
      else if (el.type === "deleteElement") streamDeleteIds.add(el.id);
    }

    const safe = excludeIncompleteLastItem(parsed);
    const { viewport, drawElements } = extractViewportAndElements(safe);

    // Load checkpoint base (once per restoreId)
    let base: any[] | undefined;
    let savedViewport: ViewportRect | null = null;
    if (streamRestoreId) {
      if (!restoredRef.current || restoredRef.current.id !== streamRestoreId) {
        const saved = localStorage.getItem(`checkpoint:${streamRestoreId}`);
        if (saved) try {
          const parsed = JSON.parse(saved);
          const els = Array.isArray(parsed) ? parsed : parsed.elements;
          const vp = Array.isArray(parsed) ? null : parsed.viewport ?? null;
          restoredRef.current = { id: streamRestoreId, elements: els, viewport: vp };
        } catch {}
      }
      base = restoredRef.current?.elements;
      savedViewport = restoredRef.current?.viewport ?? null;
      if (base && streamDeleteIds.size > 0) {
        base = base.filter((el: any) => !streamDeleteIds.has(el.id));
      }
    }

    // Use saved viewport as fallback if no cameraUpdate in new elements
    const effectiveViewport = viewport ?? savedViewport;

    if (drawElements.length > 0 && drawElements.length !== latestRef.current.length) {
      // Play pencil sound for each new element
      const prevCount = latestRef.current.length;
      for (let i = prevCount; i < drawElements.length; i++) {
        playStroke(drawElements[i].type ?? "rectangle");
      }
      latestRef.current = drawElements;
      setCount(drawElements.length);
      const jittered = drawElements.map((el: any) => ({ ...el, seed: Math.floor(Math.random() * 1e9) }));
      renderSvgPreview(jittered, effectiveViewport, base);
    } else if (base && base.length > 0 && latestRef.current.length === 0) {
      // First render: show restored base before new elements stream in
      renderSvgPreview([], effectiveViewport, base);
    }
  }, [toolInput, isFinal, renderSvgPreview]);

  // Render already-converted elements directly (skip convertToExcalidrawElements)
  useEffect(() => {
    if (!editedElements || editedElements.length === 0 || !svgRef.current) return;
    (async () => {
      try {
        await ensureFontsLoaded();
        const svg = await exportToSvg({
          elements: editedElements as any,
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
      } catch {}
    })();
  }, [editedElements]);

  return (
    <div
      ref={svgRef}
      className="excalidraw-container"
      style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
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
  const [editorReady, setEditorReady] = useState(false);
  const [excalidrawApi, setExcalidrawApi] = useState<any>(null);
  const [editorSettled, setEditorSettled] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false); // default false, enabled when host reports fullscreen support
  const [inlineEditing, setInlineEditing] = useState(false);
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

  const toggleInlineEdit = useCallback(() => {
    if (inlineEditing) {
      // Leaving edit mode — sync edits back
      const edited = getLatestEditedElements();
      if (edited) {
        setElements(edited);
        setUserEdits(edited);
      }
    }
    setInlineEditing((prev) => !prev);
  }, [inlineEditing]);

  const isInlineEdit = displayMode === "inline" && inlineEditing;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && displayMode === "fullscreen") toggleFullscreen();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [displayMode, toggleFullscreen]);

  // Preload ALL Excalidraw fonts on first mount (inline mode) so they're
  // cached before fullscreen. Without this, Excalidraw's component init
  // downloads Assistant fonts, triggering a font recalc that corrupts
  // text dimensions measured with not-yet-loaded Excalifont.
  useEffect(() => {
    Promise.all([
      document.fonts.load('20px Excalifont'),
      document.fonts.load('400 16px Assistant'),
      document.fonts.load('500 16px Assistant'),
      document.fonts.load('700 16px Assistant'),
    ]).catch(() => {});
  }, []);

  // Mount editor when entering fullscreen or inline editing
  useEffect(() => {
    if (displayMode !== "fullscreen" && !inlineEditing) {
      setEditorReady(false);
      setExcalidrawApi(null);
      setEditorSettled(false);
      return;
    }
    (async () => {
      await document.fonts.ready;
      setTimeout(() => setEditorReady(true), 200);
    })();
  }, [displayMode, inlineEditing]);

  // After editor mounts: refresh text dimensions, then reveal
  const mountEditor = (displayMode === "fullscreen" || inlineEditing) && inputIsFinal && elements.length > 0 && editorReady;
  useEffect(() => {
    if (!mountEditor || !excalidrawApi) return;
    if (editorSettled) return; // already revealed, don't redo
    const api = excalidrawApi;

    const settle = async () => {
      try { await document.fonts.load('20px Excalifont'); } catch {}
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
      _logFn = (msg) => app.sendLog({ level: "info", logger: "FS", data: msg });
      fsLog("app created, logger ready");

      app.onhostcontextchanged = (ctx: any) => {
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
        // Detect whether fullscreen is available on this host
        if (ctx.availableDisplayModes) {
          setCanFullscreen(ctx.availableDisplayModes.includes("fullscreen"));
        } else {
          // Host doesn't report available modes — assume only current mode is supported
          setCanFullscreen(false);
        }
      };

      app.ontoolinputpartial = async (input) => {
        const args = (input as any)?.arguments || input;
        setInputIsFinal(false);
        setToolInput(args);
      };

      app.ontoolinput = async (input) => {
        const args = (input as any)?.arguments || input;
        // Use the JSON-RPC tool call ID as localStorage key (stable across reloads)
        const toolCallId = String(app.getHostContext()?.toolInfo?.id ?? "");
        if (toolCallId) {
          setStorageKey(toolCallId);
          // Check for persisted edits from a previous session
          const persisted = loadPersistedElements();
          if (persisted && persisted.length > 0) {
            elementsRef.current = persisted;
            setElements(persisted);
            setUserEdits(persisted);
          }
        }
        setInputIsFinal(true);
        setToolInput(args);
      };

      app.ontoolresult = (result: any) => {
        const cpId = (result.structuredContent as { checkpointId?: string })?.checkpointId;
        if (cpId) {
          checkpointIdRef.current = cpId;
          setCheckpointId(cpId);
          setCheckpointViewport(svgViewportRef.current);
          // Save current elements + viewport to checkpoint
          const els = elementsRef.current;
          if (els.length > 0) {
            try {
              localStorage.setItem(`checkpoint:${cpId}`, JSON.stringify({
                elements: els,
                viewport: svgViewportRef.current,
              }));
            } catch {}
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
    <main className={`main${displayMode === "fullscreen" ? " fullscreen" : ""}${isInlineEdit ? " inline-editing" : ""}`}>
      {displayMode === "inline" && (
        <div className="toolbar">
          {inputIsFinal && elements.length > 0 && (
            <button
              className="toolbar-btn"
              onClick={() => exportElements(app, elementsRef.current)}
              title="Export to Excalidraw"
            >
              <ExternalLinkIcon />
            </button>
          )}
          {!canFullscreen && inputIsFinal && elements.length > 0 && (
            <button
              className="toolbar-btn"
              onClick={toggleInlineEdit}
              title={inlineEditing ? "Done editing" : "Edit diagram"}
            >
              {inlineEditing ? <CheckIcon /> : <EditIcon />}
            </button>
          )}
          {canFullscreen && (
            <button
              className="toolbar-btn"
              onClick={toggleFullscreen}
              title="Enter fullscreen"
            >
              <ExpandIcon />
            </button>
          )}
        </div>
      )}
      {/* Editor: mount hidden when ready, reveal after viewport is set */}
      {mountEditor && (
        <div style={{
          width: "100%",
          height: displayMode === "fullscreen" ? "100vh" : undefined,
          visibility: editorSettled ? "visible" : "hidden",
          ...(isInlineEdit && editorSettled ? { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 } : !editorSettled ? { position: "absolute" as const, inset: 0 } : {}),
        }} className={isInlineEdit ? "inline-editor-container" : undefined}>
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
      {/* SVG: always rendered for layout height; hidden visually when editor is active */}
      {(!editorSettled || isInlineEdit) && (
        <div
          onClick={undefined}
          style={isInlineEdit && editorSettled ? { visibility: "hidden" as const } : undefined}
        >
          <DiagramView toolInput={toolInput} isFinal={inputIsFinal} displayMode={displayMode} onElements={(els) => { elementsRef.current = els; setElements(els); }} editedElements={userEdits ?? undefined} onViewport={(vp) => { svgViewportRef.current = vp; }} />
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<ExcalidrawApp />);
