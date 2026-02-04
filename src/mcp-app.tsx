import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { Excalidraw, exportToSvg, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import morphdom from "morphdom";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initPencilAudio, playStroke } from "./pencil-audio";
// @ts-ignore — CSS import bypasses package exports
import "../node_modules/@excalidraw/excalidraw/dist/prod/index.css";
import { captureInitialElements, onEditorChange, setStorageKey, loadPersistedElements, getLatestEditedElements } from "./edit-context";
import "./global.css";

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
} {
  let viewport: ViewportRect | null = null;
  const drawElements: any[] = [];

  for (const el of elements) {
    if (el.type === "viewportUpdate") {
      viewport = { x: el.x, y: el.y, width: el.width, height: el.height };
    } else {
      drawElements.push(el);
    }
  }

  return { viewport, drawElements };
}

const ExpandIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" />
  </svg>
);

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

function DiagramView({ toolInput, isFinal, displayMode, onElements, editedElements }: { toolInput: any; isFinal: boolean; displayMode: string; onElements?: (els: any[]) => void; editedElements?: any[] }) {
  const svgRef = useRef<HTMLDivElement | null>(null);
  const latestRef = useRef<any[]>([]);
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
      fontsReady.current = document.fonts.load('20px Virgil').then(() => {});
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

  const renderSvgPreview = useCallback(async (els: any[], viewport: ViewportRect | null) => {
    if (els.length === 0 || !svgRef.current) return;
    try {
      // Update scene bounds (used by applyViewBox for coordinate conversion)
      sceneBoundsRef.current = computeSceneBounds(els);

      // Wait for Virgil font to load before computing text metrics
      await ensureFontsLoaded();

      // Convert skeleton elements to proper Excalidraw elements
      // (handles label→boundText bindings, computes dimensions)
      const withLabelDefaults = els.map((el: any) =>
        el.label ? { ...el, label: { textAlign: "center", verticalAlign: "middle", ...el.label } } : el
      );
      const excalidrawEls = convertToExcalidrawElements(withLabelDefaults, { regenerateIds: false })
        // Force Virgil (fontFamily: 1) on all text — including label-generated ones
        .map((el: any) => el.type === "text" ? { ...el, fontFamily: 1 } : el);

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
      const { viewport, drawElements } = extractViewportAndElements(parsed);
      latestRef.current = drawElements;
      // Pass converted elements for fullscreen editor
      const withDefaults = drawElements.map((el: any) =>
        el.label ? { ...el, label: { textAlign: "center", verticalAlign: "middle", ...el.label } } : el
      );
      const converted = convertToExcalidrawElements(withDefaults, { regenerateIds: false })
        .map((el: any) => el.type === "text" ? { ...el, fontFamily: 1 } : el);
      captureInitialElements(converted);
      // Only set elements if user hasn't edited yet (editedElements means user edits exist)
      if (!editedElements) onElements?.(converted);
      renderSvgPreview(drawElements, viewport);
      return;
    }

    // Partial input — drop last (potentially incomplete) element
    const parsed = parsePartialElements(str);
    const safe = excludeIncompleteLastItem(parsed);
    const { viewport, drawElements } = extractViewportAndElements(safe);
    if (drawElements.length > 0 && drawElements.length !== latestRef.current.length) {
      // Play pencil sound for each new element
      const prevCount = latestRef.current.length;
      for (let i = prevCount; i < drawElements.length; i++) {
        playStroke(drawElements[i].type ?? "rectangle");
      }
      latestRef.current = drawElements;
      setCount(drawElements.length);
      const jittered = drawElements.map((el: any) => ({ ...el, seed: Math.floor(Math.random() * 1e9) }));
      renderSvgPreview(jittered, viewport);
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
  const appRef = useRef<App | null>(null);

  const toggleFullscreen = useCallback(async () => {
    if (!appRef.current) return;
    const newMode = displayMode === "fullscreen" ? "inline" : "fullscreen";
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
      setDisplayMode(result.mode as "inline" | "fullscreen");
    } catch (err) {
      console.error("Failed to change display mode:", err);
    }
  }, [displayMode]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && displayMode === "fullscreen") toggleFullscreen();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [displayMode, toggleFullscreen]);

  const { app, error } = useApp({
    appInfo: { name: "Excalidraw", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      appRef.current = app;

      app.onhostcontextchanged = (ctx: any) => {
        if (ctx.displayMode) {
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
        // Use the JSON-RPC tool call ID as localStorage key (stable across reloads)
        const toolCallId = String(app.getHostContext()?.toolInfo?.id ?? "default");
        setStorageKey(toolCallId);
        // Check for persisted edits from a previous fullscreen session
        const persisted = loadPersistedElements();
        if (persisted && persisted.length > 0) {
          setElements(persisted);
          setUserEdits(persisted);
        }
        setInputIsFinal(true);
        setToolInput(args);
      };

      app.onteardown = async () => ({});
      app.onerror = (err) => console.error("[Excalidraw] Error:", err);
    },
  });

  if (error) return <div className="error">ERROR: {error.message}</div>;
  if (!app) return <div className="loading">Connecting...</div>;

  // Show interactive Excalidraw editor only in fullscreen AFTER streaming is done
  const showEditor = displayMode === "fullscreen" && inputIsFinal && elements.length > 0;
  return (
    <main className={`main${displayMode === "fullscreen" ? " fullscreen" : ""}`}>
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
      {showEditor ? (
        <div style={{ width: "100%", height: "100vh" }}>
          <Excalidraw
            initialData={{ elements: elements as any, scrollToContent: true }}
            theme="light"
            onChange={(els) => onEditorChange(app, els)}
          />
        </div>
      ) : (
        <DiagramView toolInput={toolInput} isFinal={inputIsFinal} displayMode={displayMode} onElements={setElements} editedElements={userEdits ?? undefined} />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<ExcalidrawApp />);
