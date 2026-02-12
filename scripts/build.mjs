import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

function run(cmd, env) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
}

rmSync("dist", { recursive: true, force: true });

// 1. Type-check
run("tsc --noEmit");

// 2. Vite build (singlefile HTML widget)
run("vite build");

// 4. Compile server TypeScript
run("tsc -p tsconfig.server.json");

// 5. Bundle server + entry point
run("bun build src/server.ts --outdir dist --target node");
run(
  'bun build src/main.ts --outfile dist/index.js --target node --banner "#!/usr/bin/env node"',
);
