// Reads and writes .coursegrab.json, the per-course-folder record of what was already downloaded
// (used to detect new/updated/unchanged/missing lectures on a repeat download without re-fetching
// everything from Udemy). No DOM, no network: filesystem only.

import * as fs from "fs";
import * as path from "path";
import type { Manifest } from "../shared/types";

const MANIFEST_FILE = ".coursegrab.json";

export function readManifest(dir: string): Manifest | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8")) as Manifest;
    return manifest && manifest.lectures ? manifest : null;
  } catch {
    return null;
  }
}

export function writeManifest(dir: string, manifest: Manifest): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 1));
  } catch {
    // the manifest only speeds up later updates; never fail a download over it
  }
}
