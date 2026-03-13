#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const tsconfigPath = resolve(projectRoot, "tsconfig.json");
const cliEntry = resolve(here, "../src/cli/index.ts");

const child = spawn(
  process.execPath,
  [tsxCliPath, "--tsconfig", tsconfigPath, cliEntry, ...process.argv.slice(2)],
  {
    cwd: projectRoot,
    stdio: "inherit",
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
