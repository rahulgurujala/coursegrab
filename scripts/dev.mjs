// `bun start`: builds the renderer once, watches it, and launches Electron against the result.
// Both esbuild and Electron are torn down together on exit (Ctrl+C or the window closing).
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import electronPath from "electron";
import { buildOptions } from "./build-config.mjs";

const ctx = await esbuild.context(buildOptions);
await ctx.rebuild();
await ctx.watch();
console.log("[dev] esbuild watching assets/js -> dist/renderer");

// Extra flags (e.g. `bun start -- --remote-debugging-port=9222`) pass straight through to Electron.
const extraArgs = process.argv.slice(2);
const child = spawn(electronPath, [".", ...extraArgs], { stdio: "inherit", env: process.env });

async function shutdown(code) {
  await ctx.dispose();
  process.exit(code ?? 0);
}

child.on("exit", (code) => shutdown(code));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
