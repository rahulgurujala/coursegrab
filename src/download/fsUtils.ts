import * as fs from "fs";

export function removeQuietly(...paths: string[]): void {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch {
      // already gone, or never existed: exactly what "quietly" means here
    }
  }
}
