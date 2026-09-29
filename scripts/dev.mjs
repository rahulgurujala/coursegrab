// `bun start`: builds the renderer once, watches it, and launches Electron against the result.
// Both esbuild and Electron are torn down together on exit (Ctrl+C or the window closing).
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import electronPath from "electron";
import { buildOptions, srcBuildOptions } from "./build-config.mjs";

const [rendererCtx, srcCtx] = await Promise.all([esbuild.context(buildOptions), esbuild.context(srcBuildOptions)]);
await Promise.all([rendererCtx.rebuild(), srcCtx.rebuild()]);
await Promise.all([rendererCtx.watch(), srcCtx.watch()]);
console.log("[dev] esbuild watching assets/js -> dist/renderer, src -> dist");

// Extra flags (e.g. `bun start -- --remote-debugging-port=9222`) pass straight through to Electron.
const extraArgs = process.argv.slice(2);
const child = spawn(electronPath, [".", ...extraArgs], { stdio: "inherit", env: process.env });

async function shutdown(code) {
  await Promise.all([rendererCtx.dispose(), srcCtx.dispose()]);
  process.exit(code ?? 0);
}

child.on("exit", (code) => shutdown(code));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
