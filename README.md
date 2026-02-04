# Excalidraw MCP App Server

MCP server that streams hand-drawn Excalidraw diagrams with smooth viewport camera control and interactive fullscreen editing.

## Features

- Streaming SVG rendering with draw-on animations
- Viewport camera control with smooth pan/zoom
- Label binding (text auto-centered inside shapes)
- Interactive Excalidraw editor in fullscreen mode
- Screenshot context sent back to Claude for iterative feedback

## Install

```bash
git clone <repo-url>
cd excalidraw-mcp
npm install
npm run build
```

## Configuration

### Claude Desktop

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

## Usage

1. Ask Claude to call `read_me` first (loads the element format reference)
2. Then ask Claude to draw a diagram using `create_view`

Example prompt: "Draw an architecture diagram showing a user connecting to an API server which talks to a database"

## License

MIT
