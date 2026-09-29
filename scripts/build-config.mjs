// Shared esbuild options for both the one-off production build (scripts/build.mjs) and the
// watch-mode dev runner (scripts/dev.mjs), so the two never drift apart.
//
// bundle: false is deliberate for now: none of these files use import/export yet (they rely on
// <script> tag load order to share globals, e.g. `var ui = ...` in ui.js used by later files).
// esbuild in this mode transforms each file independently and leaves require() calls untouched,
// which is exactly a passthrough for plain JS with no module syntax. As files are ported to real
// modules (later phases of the rewrite), this flips to bundle: true per entry group.
export const RENDERER_ENTRIES = [
  "assets/js/ui.js",
  "assets/js/devlog.js",
  "assets/js/app.js",
  "assets/js/engine.js",
  "assets/js/details.js",
  "assets/js/updater.js"
];

export const buildOptions = {
  entryPoints: RENDERER_ENTRIES,
  outdir: "dist/renderer",
  bundle: false,
  platform: "node", // preserves require("electron")/require("fs")/etc. as real runtime requires
  format: "cjs",
  target: "esnext", // matches Electron 44's bundled V8, no syntax down-leveling needed
  sourcemap: true,
  logLevel: "info"
};

// The new src/ tree (TypeScript, real modules): compiled to CJS and require()'d from the plain-JS
// renderer files, the same way assets/js/rangeDownloader.js already is, until those files
// themselves move into src/ later in the rewrite. outbase mirrors src/'s own structure under
// dist/ (src/api/udemy.ts -> dist/api/udemy.js), matching the target layout in the rewrite plan.
export const srcEntries = ["src/api/udemy.ts"];

export const srcBuildOptions = {
  entryPoints: srcEntries,
  outdir: "dist",
  outbase: "src",
  bundle: false,
  platform: "node",
  format: "cjs",
  target: "esnext",
  sourcemap: true,
  logLevel: "info"
};
