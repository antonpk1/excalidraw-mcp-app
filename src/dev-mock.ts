/**
 * Mock MCP App for standalone UI development.
 *
 * Implements the subset of the App interface used by ExcalidrawAppCore,
 * and exposes methods to simulate MCP events (tool input, streaming, etc.).
 */
import type { App } from "@modelcontextprotocol/ext-apps";

export interface MockAppControls {
  /** Pass this to <ExcalidrawAppCore app={mock.app} /> */
  app: App;
  /** Simulate final tool input (ontoolinput) — as if the model finished generating. */
  sendToolInput(elements: any[]): void;
  /** Simulate partial/streaming tool input (ontoolinputpartial). */
  sendToolInputPartial(elements: any[]): void;
  /** Simulate tool result (ontoolresult) with optional checkpointId. */
  sendToolResult(checkpointId?: string): void;
  /**
   * Stream elements one-by-one with a delay, then finalize.
   * Useful for testing the streaming SVG preview pipeline.
   */
  streamElements(elements: any[], intervalMs?: number): void;
}

export function createMockApp(): MockAppControls {
  // Mutable handler slots — ExcalidrawAppCore assigns these via useEffect
  let _ontoolinput: ((input: any) => Promise<void>) | null = null;
  let _ontoolinputpartial: ((input: any) => Promise<void>) | null = null;
  let _ontoolresult: ((result: any) => void) | null = null;
  let _onhostcontextchanged: ((ctx: any) => void) | null = null;

  const app = {
    // --- Handler setters (ExcalidrawAppCore assigns these) ---
    set ontoolinput(fn: any) { _ontoolinput = fn; },
    get ontoolinput() { return _ontoolinput; },
    set ontoolinputpartial(fn: any) { _ontoolinputpartial = fn; },
    get ontoolinputpartial() { return _ontoolinputpartial; },
    set ontoolresult(fn: any) { _ontoolresult = fn; },
    get ontoolresult() { return _ontoolresult; },
    set onhostcontextchanged(fn: any) { _onhostcontextchanged = fn; },
    get onhostcontextchanged() { return _onhostcontextchanged; },
    set onteardown(_fn: any) { /* noop */ },
    set onerror(_fn: any) { /* noop */ },

    // --- Methods ---
    sendLog({ logger, data }: { level: string; logger: string; data: string }) {
      console.log(`[${logger}] ${data}`);
    },

    async requestDisplayMode({ mode }: { mode: string }) {
      // Simulate host responding with the requested mode
      if (_onhostcontextchanged) {
        _onhostcontextchanged({
          displayMode: mode,
          containerDimensions: { height: window.innerHeight },
        });
      }
      return { mode };
    },

    async callServerTool({ name, arguments: args }: { name: string; arguments: any }) {
      console.log(`[mock] callServerTool: ${name}`, args);
      if (name === "read_checkpoint") {
        return { content: [{ type: "text", text: "null" }], isError: false };
      }
      if (name === "save_checkpoint") {
        return { content: [], isError: false };
      }
      if (name === "export_to_excalidraw") {
        // Return a mock URL
        return { content: [{ type: "text", text: "https://excalidraw.com/#mock-dev" }], isError: false };
      }
      return { content: [], isError: false };
    },

    getHostContext() {
      return { containerDimensions: { height: 600 } };
    },

    async openLink({ url }: { url: string }) {
      console.log(`[mock] openLink: ${url}`);
      window.open(url, "_blank");
    },

    async updateModelContext(opts: any) {
      console.log("[mock] updateModelContext", opts);
    },
  } as unknown as App;

  return {
    app,

    sendToolInput(elements: any[]) {
      _ontoolinput?.({ elements: JSON.stringify(elements) });
    },

    sendToolInputPartial(elements: any[]) {
      _ontoolinputpartial?.({ elements: JSON.stringify(elements) });
    },

    sendToolResult(checkpointId = "dev-checkpoint") {
      _ontoolresult?.({ structuredContent: { checkpointId } });
    },

    streamElements(elements: any[], intervalMs = 120) {
      let i = 0;
      const tick = () => {
        if (i < elements.length) {
          i++;
          _ontoolinputpartial?.({ elements: JSON.stringify(elements.slice(0, i)) });
          setTimeout(tick, intervalMs);
        } else {
          // Finalize
          _ontoolinput?.({ elements: JSON.stringify(elements) });
        }
      };
      tick();
    },
  };
}
