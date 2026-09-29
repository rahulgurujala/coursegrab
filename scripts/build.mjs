// One-off production build of the renderer bundle, used by `bun run build:renderer` and as the
// first step of packaging (see package.json's "build" script).
import * as esbuild from "esbuild";
import { buildOptions, srcBuildOptions } from "./build-config.mjs";

await esbuild.build(buildOptions);
await esbuild.build(srcBuildOptions);
