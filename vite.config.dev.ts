import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev-only vite config — serves the widget standalone (no MCP host).
 * Resolves all deps from node_modules (no esm.sh externals, no singlefile).
 * Entry: index-dev.html (not the default index.html).
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: "/index-dev.html" },
  build: {
    rollupOptions: {
      input: path.resolve(__dirname, "index-dev.html"),
    },
  },
});
