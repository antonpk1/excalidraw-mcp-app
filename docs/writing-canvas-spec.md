# Writing Canvas MCP App Tool — Technical Specification

## 1. Problem Statement

Claude's current artifacts are **read-only**. Users cannot edit generated content inline, leave targeted comments, or iterate collaboratively with the model on a living document. Every revision requires a full re-generation and a new artifact block in the chat.

The Writing Canvas solves this by providing an **editable markdown document** that persists across conversation turns, supports inline user comments and highlights, and feeds structured edit diffs back to the model without polluting the visible chat.

## 2. Design Principles

1. **Follow proven patterns.** The Excalidraw MCP App has validated the streaming-preview → interactive-editor architecture. Reuse the same SDK primitives (`ontoolinputpartial`, `ontoolinput`, `ontoolresult`, `updateModelContext`, `requestDisplayMode`, checkpoint/restore).
2. **Markdown-native.** Content is standard GitHub-Flavored Markdown. No proprietary format. Files can be copy-pasted to/from any markdown editor.
3. **Edits are invisible to chat.** Structured diffs and comments flow through `app.updateModelContext()`, not through the user's chat input. The user triggers a model turn via a prompt-suggestion button.
4. **Simplest viable multi-turn.** Each `write_canvas` call creates a new tool-call iframe, loading previous state via checkpoint-restore (same as Excalidraw). One iframe per turn, not a persistent iframe.
5. **Local-first.** All persistence via `localStorage`. Server-side encrypted storage (S3/R2) is a planned extension, not in v1.

---

## 3. Architecture Overview

```
server.ts              main.ts                 mcp-app.html (widget)
+-----------------+    +----------------+       +------------------------+
| MCP Server      |    | HTTP/stdio     |       | Canvas App (React)     |
|                 |    | transport      |       |                        |
| Tools:          |    |                |       | Modes:                 |
|  read_me        |    | /mcp endpoint  |       |  STREAMING (preview)   |
|  write_canvas   |<-->| or stdio pipe  |<----->|  INLINE (read + edit)  |
|  list_canvases  |    |                |       |  FULLSCREEN (editor)   |
|                 |    +----------------+       |                        |
| Resource:       |                             | Components:            |
|  ui://canvas/   |                             |  MarkdownPreview       |
|  mcp-app.html   |                             |  MarkdownEditor        |
+-----------------+                             |  CommentLayer          |
                                                |  StatusBadge           |
                                                |  PromptButton          |
                                                +------------------------+
```

### File Structure

```
src/
  server.ts              MCP server: tools + resource registration
  main.ts                Transport entry point (HTTP / stdio)
  canvas-app.tsx         Main React widget
  canvas-app.html        HTML shell (Vite input)
  editor/
    markdown-editor.tsx  CodeMirror 6 markdown editor component
    markdown-preview.tsx Markdown renderer (marked + highlight.js)
    toolbar.tsx          Editor toolbar (bold, italic, heading, etc.)
  comments/
    comment-layer.tsx    Highlight overlay + comment anchoring
    comment-modal.tsx    Popover for adding/viewing comments
    comment-types.ts     Comment and annotation type definitions
  diff/
    diff-engine.ts       Structured diff computation (original vs edited)
    context-builder.ts   Formats diffs + comments for updateModelContext
  state/
    canvas-store.ts      localStorage persistence + checkpoint system
    canvas-types.ts      Canvas, checkpoint, status type definitions
  global.css             Styles + animations
dist/
  canvas-app.html        Vite single-file build output
  server.js              Bundled server
  index.js               CLI entry point
```

---

## 4. Data Model

### 4.1 Canvas Document

```typescript
interface CanvasDocument {
  /** Short human-readable ID, e.g. "HN8B" */
  id: string;

  /** User-visible title (first H1, or "Untitled") */
  title: string;

  /** The markdown content */
  content: string;

  /** Lifecycle status */
  status: "draft" | "in_review" | "approved" | "archived";

  /** ISO timestamp of creation */
  createdAt: string;

  /** ISO timestamp of last modification */
  updatedAt: string;

  /** Version counter, incremented on each save */
  version: number;

  /** Who last modified: "claude" | "user" */
  lastEditor: "claude" | "user";
}
```

### 4.2 Comments

```typescript
interface CanvasComment {
  /** Unique comment ID */
  id: string;

  /** Anchor: character offset range in the markdown source */
  anchor: {
    /** Stable anchor text (substring of content at time of comment) */
    quotedText: string;
    /** Byte offset at time of creation (best-effort, re-resolved via quotedText) */
    offset: number;
    /** Length of highlighted range */
    length: number;
  };

  /** The comment text */
  body: string;

  /** Who authored: "user" | "claude" */
  author: "user" | "claude";

  /** ISO timestamp */
  createdAt: string;

  /** Whether this comment has been addressed */
  resolved: boolean;
}
```

**Anchor resolution strategy:** Comments store the `quotedText` they were attached to. When the document is edited (by user or Claude), re-anchor by searching for `quotedText` in the new content. If the quoted text was deleted or heavily modified, mark the comment as **orphaned** (still visible in a sidebar, but no longer anchored inline). This is the same strategy GitHub uses for PR review comments on changed lines.

### 4.3 Checkpoint (localStorage)

```typescript
interface CanvasCheckpoint {
  /** The canvas document */
  document: CanvasDocument;

  /** Active comments */
  comments: CanvasComment[];

  /** The content as Claude last wrote it (for diffing against user edits) */
  claudeContent: string;
}

// localStorage key format:
//   "canvas:doc:<id>"         -> CanvasDocument
//   "canvas:checkpoint:<id>"  -> CanvasCheckpoint
//   "canvas:index"            -> CanvasDocument[] (lightweight index for list_canvases)
```

### 4.4 Short ID Generation

```typescript
function generateShortId(): string {
  // 4-character alphanumeric, uppercase, no ambiguous chars (0/O, 1/I/L)
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 30 chars
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id; // e.g. "HN8B", "X4KR"
}
// 30^4 = 810,000 possible IDs — sufficient for local storage
```

---

## 5. MCP Tools

### 5.1 `read_me` (text tool, no UI)

Identical pattern to Excalidraw. Returns a cheat sheet teaching the model:
- The `write_canvas` input format
- How to use `restoreCheckpoint` for multi-turn editing
- How to read and respond to user comments
- How to add Claude comments back
- Status transitions
- Progressive content ordering for streaming

```typescript
server.registerTool("read_me", {
  description: "Returns the Writing Canvas format reference. Call before first write_canvas use.",
  annotations: { readOnlyHint: true },
}, async (): Promise<CallToolResult> => {
  return { content: [{ type: "text", text: CANVAS_CHEAT_SHEET }] };
});
```

### 5.2 `write_canvas` (UI App Tool)

The primary tool. Creates or updates a canvas document.

```typescript
registerAppTool(server, "write_canvas", {
  title: "Writing Canvas",
  description: `Creates or updates an editable markdown document.
Content streams in with live preview. User can edit after completion.
Call read_me first for format reference.`,
  inputSchema: z.object({
    content: z.string().describe(
      "The markdown content to write. For updates, this is the FULL new content."
    ),
    title: z.string().optional().describe(
      "Document title. Defaults to first H1 or 'Untitled'."
    ),
    canvas_id: z.string().optional().describe(
      "ID of existing canvas to update. Omit to create new."
    ),
    comments: z.string().optional().describe(
      "JSON array of CanvasComment objects to add (Claude responding to user)."
    ),
    status: z.enum(["draft", "in_review", "approved", "archived"]).optional()
      .describe("Set document status. Defaults to 'draft' for new documents."),
  }),
  annotations: { readOnlyHint: true },
  _meta: { ui: { resourceUri } },
}, async ({ content, title, canvas_id, comments, status }): Promise<CallToolResult> => {

  // Validate any JSON in comments field
  if (comments) {
    try { JSON.parse(comments); }
    catch (e) { return { content: [{ type: "text", text: `Invalid comments JSON` }], isError: true }; }
  }

  const id = canvas_id || generateShortId();
  const checkpointId = id; // Canvas ID doubles as checkpoint ID

  return {
    content: [{ type: "text", text:
      `Canvas "${title || 'Untitled'}" displayed (ID: ${id}).
To edit this canvas on the next turn, use canvas_id: "${id}" and provide the full updated content.
The user may edit the document or leave comments. Check widget context before your next edit.` }],
    structuredContent: { canvasId: id, checkpointId },
  };
});
```

### 5.3 `list_canvases` (text tool, no UI)

```typescript
server.registerTool("list_canvases", {
  description: "Lists saved canvas documents. Supports filtering by status.",
  inputSchema: z.object({
    status: z.enum(["draft", "in_review", "approved", "archived", "all"])
      .optional()
      .describe("Filter by status. Defaults to 'all'."),
  }),
  annotations: { readOnlyHint: true },
}, async ({ status }): Promise<CallToolResult> => {
  // This tool returns instructions for the widget to populate via updateModelContext.
  // The actual data lives in the widget's localStorage.
  // The model should read widget context to get the list.
  return {
    content: [{ type: "text", text:
      `To list canvases, read the widget context — the canvas index is stored client-side.
Ask the user to open a canvas by ID if needed.` }],
  };
});
```

> **Note:** Since canvas data lives in `localStorage` (client-side), the server cannot enumerate documents directly. The widget maintains an index and pushes it to model context on request. A future server-side storage extension would make `list_canvases` a true server-side query.

**Alternative approach for v1:** The widget can proactively send the canvas index via `updateModelContext()` on mount, so the model always has an up-to-date list without needing a separate tool.

---

## 6. Widget Architecture

### 6.1 Component Tree

```
<CanvasApp>                          // Root, manages SDK callbacks
  |
  +-- [STREAMING / INLINE read-only]
  |     <MarkdownPreview>            // Rendered markdown (read-only)
  |       content streamed via ontoolinputpartial
  |
  +-- [INLINE after final]
  |     <MarkdownPreview>            // Rendered markdown
  |     <StatusBadge>                // "DRAFT" / "IN REVIEW" / etc.
  |     <Toolbar>                    // [Edit] [Fullscreen] [Status v]
  |
  +-- [FULLSCREEN]
        <EditorPane>                 // Split or tabbed view
        | +-- <MarkdownEditor>       // CodeMirror 6 with markdown mode
        | +-- <MarkdownPreview>      // Live preview pane
        |
        <CommentLayer>               // Overlay on preview pane
        | +-- <CommentHighlight>     // Yellow highlight spans
        | +-- <CommentPopover>       // Click to view/add comment
        |
        <StatusBadge>
        <PromptButton>               // "Send edits to Claude" button
        <Toolbar>                    // [Preview/Edit toggle] [Status]
```

### 6.2 Display Modes and State Machine

```
                          +------------------+
                          |   CONNECTING     |
                          |  useApp() init   |
                          +--------+---------+
                                   |
                              app created
                                   |
                                   v
             +--------------------------------------------+
             |              IDLE (inline)                  |
             |  No content yet. Empty container.           |
             +------+-----------------------------+-------+
                    |                             |
         ontoolinputpartial                  ontoolinput
                    |                        (no streaming)
                    v                             |
  +----------------------------------+            |
  |          STREAMING               |            |
  |                                  |            |
  |  MarkdownPreview (read-only)     |            |
  |  Content appended progressively  |            |
  |  Cursor blink animation at end   |            |
  |  No edit controls visible        |            |
  +---------------+------------------+            |
                  |                               |
             ontoolinput                          |
                  |                               |
                  v                               v
  +------------------------------------------+
  |           FINAL (inline)                 |
  |                                          |
  |  MarkdownPreview (read-only)             |
  |  StatusBadge visible                     |
  |  [Edit] [Fullscreen] buttons appear      |
  |  Checkpoint saved to localStorage        |
  +---+----------------------------------+---+
      |                                  |
  click [Edit]                     click [Fullscreen]
  (inline edit)                          |
      |                                  v
      |                   +-------------------------------+
      |                   |   FULLSCREEN TRANSITION       |
      |                   |                               |
      |                   |  requestDisplayMode(fullscr)  |
      |                   |  Load fonts                   |
      |                   |  Mount CodeMirror (hidden)    |
      |                   |  editorSettled -> reveal      |
      |                   +---------------+---------------+
      |                                   |
      v                                   v
  +-----------------------------------------------+
  |            EDITING (inline or fullscreen)      |
  |                                               |
  |  MarkdownEditor (CodeMirror 6)                |
  |  Live preview pane (fullscreen: side-by-side) |
  |  CommentLayer active                          |
  |  StatusBadge + status dropdown                |
  |  [Send to Claude] button                      |
  |                                               |
  |  On every edit:                               |
  |    debounce 2s -> compute diff                |
  |    save to localStorage                       |
  |    update checkpoint                          |
  |                                               |
  |  On comment added:                            |
  |    save to checkpoint                         |
  |    (diff sent on next updateModelContext)     |
  +---+-------------------------------------------+
      |
  [Send to Claude] clicked
      |
      v
  +-----------------------------------------------+
  |  CONTEXT UPDATE                               |
  |                                               |
  |  1. computeDiff(claudeContent, userContent)   |
  |  2. collect unresolved comments               |
  |  3. app.updateModelContext({                  |
  |       content: [{ type: "text", text: ... }]  |
  |     })                                        |
  |  4. Populate chat input with prompt like:     |
  |     "Review my edits on canvas HN8B"          |
  +-----------------------------------------------+
```

### 6.3 SDK Callback Wiring

```typescript
function CanvasApp() {
  const { app, error } = useApp({
    appInfo: { name: "WritingCanvas", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      appRef.current = app;

      // ── STREAMING ────────────────────────────────
      app.ontoolinputpartial = async (input) => {
        const args = (input as any)?.arguments || input;
        setIsFinal(false);
        setToolInput(args);
        // Widget renders markdown preview progressively
      };

      // ── FINAL ────────────────────────────────────
      app.ontoolinput = async (input) => {
        const args = (input as any)?.arguments || input;
        const toolCallId = String(app.getHostContext()?.toolInfo?.id ?? "default");

        // Load any persisted user edits from previous session
        const persisted = loadCanvas(args.canvas_id);
        if (persisted) {
          setDocument(persisted.document);
          setComments(persisted.comments);
        }

        setIsFinal(true);
        setToolInput(args);
      };

      // ── TOOL RESULT ──────────────────────────────
      app.ontoolresult = (result: any) => {
        const { canvasId } = result.structuredContent || {};
        if (canvasId) {
          // Save checkpoint: Claude's content + metadata
          saveCheckpoint(canvasId, {
            document: currentDocument,
            comments: currentComments,
            claudeContent: currentDocument.content, // baseline for diffing
          });
          // Update canvas index
          updateCanvasIndex(canvasId, currentDocument);
        }
      };

      // ── HOST CONTEXT (display mode changes) ──────
      app.onhostcontextchanged = (ctx: any) => {
        if (ctx.displayMode) {
          if (ctx.displayMode === "inline") syncEditsBeforeExit();
          setDisplayMode(ctx.displayMode);
        }
      };

      app.onteardown = async () => ({});
      app.onerror = (err) => console.error("[Canvas] Error:", err);
    },
  });
}
```

---

## 7. Streaming Rendering Pipeline

```
  MODEL generates markdown tokens
         |
         v
  ontoolinputpartial({ content: "# My Art..." })
         |
         v
  +------------------+
  | Append to buffer |  Content grows token by token
  +--------+---------+
           |
           v
  +------------------+
  | Render markdown  |  marked.parse(buffer)
  | to HTML          |  (sanitized, no raw HTML pass-through)
  +--------+---------+
           |
           v
  +------------------+
  | morphdom()       |  Diff new HTML against existing DOM
  |                  |  Preserves already-rendered paragraphs
  +--------+---------+  New paragraphs get fade-in animation
           |
           v
  +------------------+
  | Typing cursor    |  CSS blinking cursor after last element
  | animation        |  Removed on ontoolinput (final)
  +------------------+
```

**Key difference from Excalidraw:** Markdown streaming doesn't need the "drop last element" strategy. Markdown is line-oriented — we can render everything received so far. Incomplete last line may show partial text, but that's natural for a "typing" effect and visually correct.

**Rendering optimization:** Only re-render when content length increases by more than a threshold (e.g., 50 characters or a newline), to avoid excessive DOM diffing on every token.

---

## 8. Diff Engine

### 8.1 Diff Computation

When the user edits the document, we need a structured diff between Claude's last version (`claudeContent`) and the user's current version.

```typescript
// diff-engine.ts

interface DiffHunk {
  /** What happened */
  type: "added" | "removed" | "modified";

  /** Line range in Claude's original */
  originalRange?: { start: number; end: number };

  /** Line range in user's version */
  modifiedRange?: { start: number; end: number };

  /** The original lines (for "removed" and "modified") */
  original?: string;

  /** The new lines (for "added" and "modified") */
  modified?: string;
}

function computeDiff(claudeContent: string, userContent: string): DiffHunk[] {
  // Use a line-level diff algorithm (Myers or patience diff)
  // Group consecutive changes into hunks
  // Return structured hunks with context
}
```

### 8.2 Context Builder

Formats diffs + comments into a text payload for `updateModelContext()`:

```typescript
// context-builder.ts

function buildModelContext(
  canvasId: string,
  document: CanvasDocument,
  claudeContent: string,
  comments: CanvasComment[],
): string {
  const diff = computeDiff(claudeContent, document.content);
  const unresolvedComments = comments.filter(c => !c.resolved && c.author === "user");

  let context = `## Canvas "${document.title}" (${canvasId}) — v${document.version}\n`;
  context += `Status: ${document.status}\n\n`;

  if (diff.length > 0) {
    context += `### User Edits\n`;
    for (const hunk of diff) {
      if (hunk.type === "modified") {
        context += `Changed (lines ${hunk.originalRange!.start}-${hunk.originalRange!.end}):\n`;
        context += `  - Was: ${hunk.original}\n`;
        context += `  + Now: ${hunk.modified}\n\n`;
      } else if (hunk.type === "added") {
        context += `Added at line ${hunk.modifiedRange!.start}:\n`;
        context += `  + ${hunk.modified}\n\n`;
      } else if (hunk.type === "removed") {
        context += `Removed (was lines ${hunk.originalRange!.start}-${hunk.originalRange!.end}):\n`;
        context += `  - ${hunk.original}\n\n`;
      }
    }
  }

  if (unresolvedComments.length > 0) {
    context += `### User Comments\n`;
    for (const c of unresolvedComments) {
      context += `- On "${c.anchor.quotedText}": "${c.body}"\n`;
    }
  }

  return context;
}
```

### 8.3 Example Model Context Output

```
## Canvas "API Design Doc" (HN8B) — v3
Status: draft

### User Edits
Changed (lines 12-14):
  - Was: The API uses REST endpoints with JSON payloads.
  + Now: The API uses GraphQL with typed queries.

Added at line 28:
  + ## Error Handling
  + All errors return structured JSON with `code` and `message` fields.

Removed (was lines 45-48):
  - This section is TBD and will be filled in later.

### User Comments
- On "rate limiting strategy": "Can we use token bucket instead of fixed window?"
- On "authentication": "We need to support OAuth2 in addition to API keys"
```

---

## 9. Comment System

### 9.1 User Adds a Comment

```
  PREVIEW PANE (rendered markdown)
  +------------------------------------------+
  |  ## Authentication                       |
  |                                          |
  |  The API uses [====API keys====] for     |  <-- user selects text
  |  authentication.                         |
  |                                          |
  |        +-------------------------+       |
  |        | Add comment...          |       |  <-- popover appears
  |        |                         |       |
  |        | [We also need OAuth2]   |       |
  |        |                         |       |
  |        | [Cancel]  [Comment]     |       |
  |        +-------------------------+       |
  +------------------------------------------+
```

**Flow:**

```
  User selects text in preview
         |
         v
  getSelection() -> extract selected text
         |
         v
  Map rendered HTML position back to markdown source offset
  (use data attributes on rendered elements to track source lines)
         |
         v
  Show CommentPopover at selection position
         |
         v
  User types comment, clicks [Comment]
         |
         v
  Create CanvasComment {
    id: randomId(),
    anchor: { quotedText: "API keys", offset: 342, length: 8 },
    body: "We also need OAuth2",
    author: "user",
    createdAt: now(),
    resolved: false
  }
         |
         v
  Save to checkpoint, render highlight in preview
```

### 9.2 Claude Responds to Comments

When the model calls `write_canvas` with the `comments` field:

```json
{
  "content": "...updated markdown...",
  "canvas_id": "HN8B",
  "comments": "[{\"anchor\":{\"quotedText\":\"rate limiting\"},\"body\":\"Good point — switched to token bucket.\",\"author\":\"claude\",\"resolved\":false}]"
}
```

The widget:
1. Parses Claude's comments
2. Adds them to the comment list
3. Renders them with a different color (blue for Claude, yellow for user)
4. May auto-resolve user comments that Claude addressed (if Claude's new content no longer contains the quoted text)

### 9.3 Comment Rendering

```
  PREVIEW (inline mode)              PREVIEW (fullscreen, with gutter)
  +---------------------------+      +---+---------------------------+----+
  |  The API uses [API keys]  |      |   |  The API uses [API keys]  | C1 |
  |  ~~~~~~~~~~~~~~~~~ (1)    |      | 1 |  ~~~~~~~~~~~~~~~~~        |    |
  |  for authentication.      |      |   |  for authentication.      |    |
  +---------------------------+      +---+---------------------------+----+
                                                                     |
                                         Comment gutter: click to   |
                                         expand comment popover  <--+
```

Inline mode: highlights only (hover to see comment).
Fullscreen mode: gutter markers + expandable popovers.

---

## 10. Multi-Turn Editing Flow

```
  TURN 1: Claude creates canvas
  =============================

  User: "Write me an API design doc"
  Model: calls write_canvas({ content: "# API Design\n...", title: "API Design Doc" })

  Widget receives streaming -> preview -> final
  Server returns: { canvasId: "HN8B", checkpointId: "HN8B" }
  Widget saves: localStorage["canvas:checkpoint:HN8B"] = {
    document: { id: "HN8B", content: "...", status: "draft", version: 1 },
    comments: [],
    claudeContent: "# API Design\n..."
  }


  USER EDITS (between turns)
  ==========================

  User clicks [Edit] or [Fullscreen]
  User modifies paragraphs, adds 2 comments
  Widget saves edits to localStorage continuously (debounced)
  Canvas version incremented to 2, lastEditor: "user"
  Checkpoint updated with new content + comments


  TURN 2: User clicks [Send to Claude]
  =====================================

  Widget: app.updateModelContext({
    content: [{ type: "text", text: buildModelContext("HN8B", doc, claudeContent, comments) }]
  })

  Prompt suggestion populated: "Review my edits on canvas HN8B"
  User sends the message

  Model: reads context, sees diff + comments
  Model: calls write_canvas({
    canvas_id: "HN8B",
    content: "# API Design\n...updated with user feedback...",
    comments: "[{...Claude's reply comments...}]"
  })

  Widget: loads checkpoint for HN8B, renders Claude's new content
  Server returns new checkpointId (same canvas ID)
  Widget: updates checkpoint with Claude's new content as new baseline
  claudeContent reset to Claude's latest version (for next diff cycle)
  Version incremented to 3, lastEditor: "claude"
  User comments that were addressed: auto-resolved
```

### Checkpoint Data Flow Diagram

```
  TURN 1                    BETWEEN TURNS               TURN 2
  (Claude writes)           (User edits)                (Claude revises)

  write_canvas()            User types in               write_canvas(
    content: "v1"           editor, adds                  canvas_id: "HN8B"
    |                       comments                      content: "v3")
    v                         |                             |
  checkpoint:HN8B            v                             v
  {                         checkpoint:HN8B              checkpoint:HN8B
    doc: {v:1,              {                            {
      content:"v1"},          doc: {v:2,                   doc: {v:3,
    claudeContent:"v1",        content:"v2(user)"},          content:"v3"},
    comments: []               claudeContent: "v1",        claudeContent: "v3",
  }                            comments: [c1, c2]          comments: [c1(resolved),
                             }                               c2(resolved), c3(claude)]
                               |                           }
                               v
                             updateModelContext():
                             "Changed lines 12-14..."
                             "Comment on 'API keys':..."
```

---

## 11. Status Management

### 11.1 Status Badge Component

```
  +------+
  | DRAFT|  <- colored badge, click to open dropdown
  +------+
      |
      v
  +------------------+
  | * Draft          |  <- current (checkmark)
  |   In Review      |
  |   Approved       |
  |   Archived       |
  +------------------+
```

### 11.2 Status Transition Rules (v1 — user-only)

```
  +-------+      +----------+      +----------+      +----------+
  | Draft |----->| In Review|----->| Approved |----->| Archived |
  +-------+      +----------+      +----------+      +----------+
      ^               |                 |
      |               |  (reopen)       |  (reopen)
      +---------------+-----------------+
```

Any transition is allowed by the user. Status is stored in `CanvasDocument.status` and persisted in the checkpoint. The model sees the status in the context and can adapt behavior (e.g., more careful edits for "in_review" documents).

---

## 12. UI Layout

### 12.1 Inline Mode (in chat)

```
  +----------------------------------------------------+
  |  [DRAFT]                          [Edit] [Expand]  |
  |----------------------------------------------------|
  |                                                    |
  |  # API Design Document                            |
  |                                                    |
  |  ## Overview                                       |
  |  The API uses GraphQL with typed queries...        |
  |                                                    |
  |  ## Authentication                                 |
  |  The API uses [API keys] for authentication.       |
  |                 ^^^^^^^^^^                         |
  |                 (1 comment)                        |
  |                                                    |
  +----------------------------------------------------+
```

### 12.2 Fullscreen Mode

```
  +--------------------------------------------------------------------+
  |  Canvas: API Design Doc (HN8B)    [DRAFT v]   [Send to Claude]    |
  |====================================================================|
  |  EDIT                    |  PREVIEW                          | C   |
  |  ~~~~~~~~~~~~~~~~~~~~~~~~|  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~     | O   |
  |  # API Design Document  |  # API Design Document            | M   |
  |                          |                                   | M   |
  |  ## Overview             |  ## Overview                      | E   |
  |  The API uses GraphQL    |  The API uses GraphQL             | N   |
  |  with typed queries...   |  with typed queries...            | T   |
  |                          |                                   | S   |
  |  ## Authentication       |  ## Authentication                |     |
  |  The API uses API keys   |  The API uses [API keys]          | (1) |
  |  for authentication.     |  for authentication.              |     |
  |                          |                                   |     |
  +--------------------------------------------------------------------+

  Left: CodeMirror editor (markdown source)
  Center: Live preview (rendered markdown)
  Right: Comment gutter (collapsed, expand on click)
```

---

## 13. CSS Animations

```css
/* Streaming: typing cursor at end of content */
.canvas-preview.streaming::after {
  content: "";
  display: inline-block;
  width: 2px;
  height: 1.2em;
  background: var(--text-color);
  animation: blink 0.8s step-end infinite;
  vertical-align: text-bottom;
  margin-left: 2px;
}

@keyframes blink {
  50% { opacity: 0; }
}

/* New paragraph fade-in during streaming */
.canvas-preview p,
.canvas-preview h1,
.canvas-preview h2,
.canvas-preview h3,
.canvas-preview li,
.canvas-preview pre {
  animation: paragraphFadeIn 0.3s ease-out;
}

@keyframes paragraphFadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Comment highlight */
.comment-highlight {
  background: rgba(255, 212, 0, 0.25);
  border-bottom: 2px solid rgba(255, 180, 0, 0.6);
  cursor: pointer;
  transition: background 0.2s;
}

.comment-highlight:hover {
  background: rgba(255, 212, 0, 0.45);
}

/* Claude comment highlight (different color) */
.comment-highlight.claude {
  background: rgba(74, 158, 237, 0.15);
  border-bottom-color: rgba(74, 158, 237, 0.5);
}
```

---

## 14. Key Dependencies

| Library | Purpose | Load Strategy |
|---------|---------|---------------|
| `@modelcontextprotocol/ext-apps` | SDK: useApp, callbacks, updateModelContext | npm bundle |
| `@modelcontextprotocol/sdk` | MCP server, transports | npm bundle |
| `morphdom` | DOM diffing for streaming preview | esm.sh CDN |
| `marked` | Markdown -> HTML rendering | esm.sh CDN |
| `highlight.js` | Code block syntax highlighting | esm.sh CDN |
| `@codemirror/view` + `@codemirror/lang-markdown` | Markdown editor | esm.sh CDN |
| `diff` (npm `diff` package) | Line-level diffing for edit tracking | esm.sh CDN |
| `react`, `react-dom` | UI framework | esm.sh CDN |

Build strategy matches Excalidraw: externalize heavy deps to esm.sh, inline app code via `vite-plugin-singlefile`.

---

## 15. Build Pipeline

```bash
# Same pattern as Excalidraw
tsc --noEmit                                          # Type check
cross-env INPUT=src/canvas-app.html vite build        # Widget -> single HTML
mv dist/src/canvas-app.html dist/canvas-app.html
tsc -p tsconfig.server.json                           # Server declarations
bun build src/server.ts --outdir dist --target node   # Server bundle
bun build src/main.ts --outfile dist/index.js \
  --target node --banner "#!/usr/bin/env node"        # CLI entry
```

---

## 16. Future Extensions (Not in v1)

| Feature | Notes |
|---------|-------|
| **Server-side storage (S3/R2)** | Client-side AES-GCM encryption (key derived from user passphrase or stored in widget). Server stores opaque blobs. `list_canvases` becomes a true server query. |
| **Multi-user locking** | Optimistic locking with version numbers. Server rejects writes where `version != expected`. Conflict resolution UI. |
| **Kanban board widget** | Separate resource/tool (`canvas_board`) rendering a kanban view of canvases grouped by status. Drag-and-drop status transitions. |
| **Export** | PDF export, `.md` file download, copy-to-clipboard. |
| **Collaborative editing** | WebSocket-based CRDT (Yjs) for real-time multi-cursor editing. Significant architecture change. |
| **Version history** | Store previous versions in localStorage/server. Diff viewer between versions. Time-travel slider. |

---

## 17. Summary of SDK Integration Points

| SDK Primitive | Usage in Writing Canvas |
|---|---|
| `registerAppTool()` | Register `write_canvas` as UI tool linked to resource |
| `registerAppResource()` | Serve `canvas-app.html` widget |
| `_meta.ui.resourceUri` | Link tool to widget HTML resource |
| `ontoolinputpartial` | Stream markdown content for live preview |
| `ontoolinput` | Final content delivery, switch to editable mode |
| `ontoolresult` | Receive `canvasId`/`checkpointId`, save checkpoint |
| `updateModelContext()` | Push edit diffs + comments to model (invisible to user) |
| `requestDisplayMode()` | Toggle fullscreen for full editor experience |
| `onhostcontextchanged` | React to host-initiated display changes |
| `sendLog()` | Debug logging routed through host |
| `structuredContent` | Return canvas ID to model for multi-turn reference |
