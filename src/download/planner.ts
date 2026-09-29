// Compares a freshly-read course against what an earlier download already saved (the manifest),
// deciding per lecture whether it is new, updated, unchanged, missing, or outside the chosen
// range. Mutates the Lecture objects it is given (sets .primary/.status/.skip) rather than
// returning a copy: this matches how the rest of the download pipeline already works, the same
// Lecture objects flow through prepareCourse -> loadLecture -> here -> the orchestrator. It also
// touches the filesystem directly when a lecture was renamed/reordered/replaced and dryRun is
// not set (following the rename, or clearing stale files for a replaced asset) - no DOM, no
// network, same as everywhere else under download/.

import * as path from "path";
import * as fs from "fs";
import { readManifest } from "../store/manifest";
import { removeQuietly } from "./fsUtils";
import { chapterFolder, primaryName } from "./naming";
import type { ChangeBadge, DownloadSettings, Manifest, PrepareCourseData } from "../shared/types";

export interface PlanCounts {
  new: number;
  updated: number;
  missing: number;
  unchanged: number;
}

export interface PlanResult {
  manifest: Manifest | null;
  counts: PlanCounts;
  removed: number;
  hadManifest: boolean;
}

// Compares the course with the manifest saved in its folder by an earlier download.
export function planUpdates(
  data: PrepareCourseData,
  dir: string,
  options: Pick<DownloadSettings, "skipSubtitles" | "skipAttachments">,
  inScope: Record<string, boolean>,
  dryRun?: boolean
): PlanResult {
  const manifest = readManifest(dir);
  const known = manifest ? manifest.lectures : {};
  const counts: PlanCounts = { new: 0, updated: 0, missing: 0, unchanged: 0 };
  const seen: Record<string, boolean> = {};

  data.chapters.forEach((chapter, ci) => {
    chapter.lectures.forEach((lecture, li) => {
      if (lecture.type == "Skipped") return;
      const id = String(lecture.id);
      const entry = known[id];
      const primary = path.join(chapterFolder(ci, chapter), primaryName(li, lecture));
      const target = path.join(dir, primary);
      seen[id] = true;
      lecture.primary = primary;

      if (!inScope[id]) {
        // outside the chosen lecture range: leave files and records alone
        lecture.status = "outside";
        lecture.skip = true;
        return;
      }

      if (lecture._trusted) {
        // retrying the course: already downloaded successfully before, take it as is without
        // re-checking Udemy for this lecture (that is what Get updates is for)
        lecture.status = "unchanged";
        lecture.skip = true;
        counts.unchanged++;
        return;
      }

      let status: ChangeBadge | "unchanged";
      if (!entry) {
        status = "new";
      } else if (
        (entry.assetId != null && lecture.assetId != null && entry.assetId != lecture.assetId) ||
        (entry.created && lecture.assetCreated && entry.created != lecture.assetCreated)
      ) {
        // the instructor replaced this video: fetch the new one
        status = "updated";
        const old = path.join(dir, entry.primary || primary);
        if (!dryRun) removeQuietly(old, old + ".mtd", old + ".mtd.meta.json", old.replace(/\.[^.]+$/, ".srt"), target, target + ".mtd", target + ".mtd.meta.json");
      } else {
        // same content; follow a rename or reorder by moving the file instead of downloading again
        const oldPath = entry.primary ? path.join(dir, entry.primary) : target;
        const moved = oldPath != target && fs.existsSync(oldPath) && !fs.existsSync(target);
        if (moved && !dryRun) {
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(oldPath, target);
            const oldSub = oldPath.replace(/\.[^.]+$/, ".srt");
            if (fs.existsSync(oldSub)) fs.renameSync(oldSub, target.replace(/\.[^.]+$/, ".srt"));
          } catch {
            // best-effort follow; worst case it downloads again under the new name
          }
        }
        const wantsSubs = !options.skipSubtitles && !!lecture.caption;
        const wantsFiles = !options.skipAttachments && !!(lecture.supplementary && lecture.supplementary.length);
        const complete =
          (fs.existsSync(target) || (!!dryRun && moved)) &&
          !fs.existsSync(target + ".mtd") &&
          entry.done !== false &&
          (!wantsSubs || entry.subs) &&
          (!wantsFiles || entry.attach);
        status = complete ? "unchanged" : "missing";
      }
      lecture.status = status;
      counts[status]++;
      lecture.skip = status == "unchanged";
    });
  });

  const removed = Object.keys(known).filter((id) => !seen[id]).length;
  return { manifest, counts, removed, hadManifest: !!manifest };
}
