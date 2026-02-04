import type { App } from "@modelcontextprotocol/ext-apps";

const DEBOUNCE_MS = 2000;
let timer: ReturnType<typeof setTimeout> | null = null;
let initialSnapshot: string | null = null;
let initialElementsById: Map<string, any> = new Map();
let storageKey: string | null = null;

/**
 * Set the localStorage key for this widget instance (use viewUUID or tool-call-derived ID).
 */
export function setStorageKey(key: string) {
  storageKey = `excalidraw:${key}`;
}

/**
 * Call once after final render to capture the baseline element state.
 */
export function captureInitialElements(elements: readonly any[]) {
  initialSnapshot = JSON.stringify(elements.map((el: any) => el.id + ":" + (el.version ?? 0)));
  initialElementsById = new Map(elements.map((el: any) => [el.id, el]));
}

/** Compute a compact diff between initial and current elements. */
function computeDiff(current: any[]): string {
  const added: string[] = [];
  const removed: string[] = [];
  const moved: string[] = [];
  const currentIds = new Set<string>();

  for (const el of current) {
    currentIds.add(el.id);
    const orig = initialElementsById.get(el.id);
    if (!orig) {
      // New element — include type, position, and text if any
      const desc = `${el.type} "${el.text ?? el.label?.text ?? ""}" at (${Math.round(el.x)},${Math.round(el.y)})`;
      added.push(desc);
    } else if (Math.round(orig.x) !== Math.round(el.x) || Math.round(orig.y) !== Math.round(el.y) ||
               Math.round(orig.width) !== Math.round(el.width) || Math.round(orig.height) !== Math.round(el.height)) {
      moved.push(`${el.id} → (${Math.round(el.x)},${Math.round(el.y)}) ${Math.round(el.width)}x${Math.round(el.height)}`);
    }
  }

  for (const id of initialElementsById.keys()) {
    if (!currentIds.has(id)) removed.push(id);
  }

  const parts: string[] = [];
  if (added.length) parts.push(`Added: ${added.join("; ")}`);
  if (removed.length) parts.push(`Removed: ${removed.join(", ")}`);
  if (moved.length) parts.push(`Moved/resized: ${moved.join("; ")}`);
  if (!parts.length) return "";
  return `User edited diagram. ${parts.join(". ")}`;
}

/**
 * Load persisted elements from localStorage (if any).
 */
export function loadPersistedElements(): any[] | null {
  if (!storageKey) return null;
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return null;
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

/** Latest edited elements (kept in sync without triggering React re-renders). */
let latestEditedElements: any[] | null = null;

/**
 * Get the latest user-edited elements (or null if no edits were made).
 * Call this when exiting fullscreen to sync edits back to React state.
 */
export function getLatestEditedElements(): any[] | null {
  return latestEditedElements;
}

/**
 * Excalidraw onChange handler. Persists to localStorage and sends updated
 * elements JSON to model context — only when user actually changed something
 * (debounced). Does NOT call setState to avoid infinite re-render loops.
 */
export function onEditorChange(app: App, elements: readonly any[]) {
  const currentSnapshot = JSON.stringify(elements.map((el: any) => el.id + ":" + (el.version ?? 0)));
  if (currentSnapshot === initialSnapshot) return;

  const live = [...elements].filter((el: any) => !el.isDeleted);
  latestEditedElements = live;

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(live));
      } catch {}

    }
    const diff = computeDiff(live);
    if (diff) {
      app.updateModelContext({
        content: [{ type: "text", text: diff }],
      }).catch(() => {});
    }
  }, DEBOUNCE_MS);
}
