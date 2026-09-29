// Pure filename/path-segment logic: no filesystem I/O, no network, no DOM. Shared by the plan
// comparison (planner.ts) and the actual download orchestration (orchestrator.ts), since both
// need to agree on exactly the same on-disk path for a given lecture or attachment.

import sanitize from "sanitize-filename";
import type { Chapter, Lecture, SupplementaryAsset } from "../shared/types";

// A single path segment must stay well under the filesystem's NAME_MAX (255 bytes on every
// platform this app targets). This is also the backstop against a malformed URL ever producing
// a name the OS refuses to open (see guessExtension's comment for a real case of exactly that).
export function capName(name: string, maxLen = 150): string {
  if (name.length <= maxLen) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > -1 && name.length - dot <= 12 ? name.slice(dot) : "";
  return name.slice(0, maxLen - ext.length) + ext;
}

export function chapterFolder(chapterIndex: number, chapter: Pick<Chapter, "name">): string {
  return capName(sanitize(chapterIndex + 1 + ". " + chapter.name));
}

// Same file names as earlier versions, so folders from older downloads are recognised.
export function primaryName(lectureIndex: number, lecture: Pick<Lecture, "name" | "type">): string {
  const base = lectureIndex + 1 + ". " + lecture.name.trim();
  if (lecture.type == "Article" || lecture.type == "Url") {
    return capName(sanitize(base + ".html"));
  }
  return capName(sanitize(base + "." + (lecture.type == "File" ? "pdf" : "mp4")));
}

// Best-effort file extension from a download URL. Some of Udemy's supplementary-asset URLs are
// missing the "?" that should separate the path from the query string: a real failure had
// "Expires=...&Signature=..." glued directly onto the filename with no "?" at all, which broke
// the previous "everything after the last dot" guess and produced an ENAMETOOLONG-length name.
// Split on either separator, and only trust a result that actually looks like an extension.
export function guessExtension(url: string | undefined): string {
  const path = (url || "").split(/[?&]/)[0]!;
  const last = path.split("/").pop() || "";
  const dot = last.lastIndexOf(".");
  const ext = dot == -1 ? "" : last.slice(dot + 1);
  return /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext : "";
}

export function attachmentName(lectureIndex: number, index: number, asset: SupplementaryAsset): string {
  const base = lectureIndex + 1 + "." + (index + 1) + " " + asset.name.trim();
  if (asset.type == "Url" || asset.type == "Article") return capName(sanitize(base + ".html"));
  const nameExt = asset.name.indexOf(".") > -1 ? asset.name.split(".").pop()! : "";
  const ext = guessExtension(asset.src) || nameExt || "bin";
  return capName(sanitize(base + (nameExt == ext ? "" : "." + ext)));
}
