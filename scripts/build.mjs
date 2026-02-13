#!/usr/bin/env node
import { execSync } from "child_process";
import { renameSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function run(cmd, env = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

rmSync(join(root, "dist"), { recursive: true, force: true });

// 1. Type-check
run("tsc --noEmit");

// 2. Vite build (singlefile HTML)
run("vite build");

// 3. Move the HTML output to dist root (cross-platform)
renameSync(
  join(root, "dist", "src", "mcp-app.html"),
  join(root, "dist", "mcp-app.html"),
);
rmSync(join(root, "dist", "src"), { recursive: true, force: true });

// 4. Build server types
run("tsc -p tsconfig.server.json");

// 5. Bundle server + index
run('bun build "src/server.ts" --outdir dist --target node');
run(
  'bun build "src/main.ts" --outfile "dist/index.js" --target node --banner "#!/usr/bin/env node"',
);
