import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/**
 * Registers all Excalidraw tools and resources on the given McpServer.
 * Shared between local (main.ts) and Vercel (api/mcp.ts) entry points.
 */
export declare function registerTools(server: McpServer, distDir: string): void;
/**
 * Creates a new MCP server instance with Excalidraw drawing tools.
 * Used by local entry point (main.ts) and Docker deployments.
 */
export declare function createServer(): McpServer;
