# Excalidraw MCP App Server

MCP server that streams hand-drawn Excalidraw diagrams with smooth viewport camera control and interactive fullscreen editing.

![Demo](demo.gif)

## Features

- Streaming SVG rendering with draw-on animations
- Viewport camera control with smooth pan/zoom
- Label binding (text auto-centered inside shapes)
- Interactive Excalidraw editor in fullscreen mode
- Screenshot context sent back to Claude for iterative feedback

## Install

In [claude.ai](https://claude.ai):

1. Go to **Settings** → **Connectors** → **Add custom connector**
2. Server URL: `https://excalidraw-mcp-app.vercel.app/mcp`
3. Done — start using Excalidraw in your conversations

### Alternative: Local Server

**Option A: Download Extension**

1. Download `excalidraw-mcp-app.mcpb` from [Releases](https://github.com/antonpk1/excalidraw-mcp-app/releases)
2. Double-click to install in Claude Desktop

**Option B: Build from Source**

```bash
git clone https://github.com/antonpk1/excalidraw-mcp-app.git
cd excalidraw-mcp-app
npm install && npm run build
```

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["/path/to/excalidraw-mcp-app/dist/index.js", "--stdio"]
    }
  }
}
```

Restart Claude Desktop.

## Usage

Example prompts:
- "Draw a cute cat using excalidraw"
- "Draw an architecture diagram showing a user connecting to an API server which talks to a database"

## Releasing a New Version

```bash
# 1. Make changes, commit, push
git add -A && git commit -m "..." && git push

# 2. Bump version in manifest.json and package.json

# 3. Rebuild
npm run build

# 4. Pack the .mcpb bundle
mcpb pack .

# 5. Create GitHub release with bundle attached
gh release create v0.2.0 excalidraw-mcp-app.mcpb --title "v0.2.0" --notes "What changed"
```

## Credits

Built with [Excalidraw](https://github.com/excalidraw/excalidraw) — a virtual whiteboard for sketching hand-drawn like diagrams.

## License

MIT
