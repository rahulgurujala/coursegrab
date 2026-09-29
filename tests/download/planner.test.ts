import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { planUpdates } from "../../src/download/planner";
import { writeManifest } from "../../src/store/manifest";
import type { Chapter, Lecture, Manifest, PrepareCourseData } from "../../src/shared/types";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-planner-test-"));
});

function lecture(overrides: Partial<Lecture> = {}): Lecture {
  return { id: 1, name: "Lecture One", type: "Video", assetId: 100, assetCreated: "2024-01-01", ...overrides };
}

function courseData(lectures: Lecture[]): PrepareCourseData {
  const chapter: Chapter = { name: "Chapter", lectures };
  return { id: 1, name: "Course", chapters: [chapter], skipped: [], subs: {}, prep: { cancelled: false, failed: false } };
}

function inScopeAll(data: PrepareCourseData): Record<string, boolean> {
  const scope: Record<string, boolean> = {};
  data.chapters.forEach((c) => c.lectures.forEach((l) => (scope[String(l.id)] = true)));
  return scope;
}

const OPTIONS = { skipSubtitles: false, skipAttachments: false };

describe("planUpdates", () => {
  it("marks a lecture new when there is no manifest yet", () => {
    const data = courseData([lecture()]);
    const plan = planUpdates(data, dir, OPTIONS, inScopeAll(data));
    expect(data.chapters[0]!.lectures[0]!.status).toBe("new");
    expect(plan.counts.new).toBe(1);
    expect(plan.hadManifest).toBe(false);
  });

  it("marks a lecture unchanged when the saved file exists and nothing changed", () => {
    const data = courseData([lecture()]);
    const plan0 = planUpdates(data, dir, OPTIONS, inScopeAll(data), true);
    const primary = data.chapters[0]!.lectures[0]!.primary!;
    fs.mkdirSync(path.dirname(path.join(dir, primary)), { recursive: true });
    fs.writeFileSync(path.join(dir, primary), "video bytes");
    const manifest: Manifest = {
      version: 1,
      courseId: 1,
      title: "Course",
      lectures: { "1": { assetId: 100, created: "2024-01-01", title: "Lecture One", primary, quality: "720", subs: true, attach: true, done: true, at: new Date().toISOString() } }
    };
    writeManifest(dir, manifest);

    const data2 = courseData([lecture()]);
    const plan = planUpdates(data2, dir, OPTIONS, inScopeAll(data2));
    expect(data2.chapters[0]!.lectures[0]!.status).toBe("unchanged");
    expect(data2.chapters[0]!.lectures[0]!.skip).toBe(true);
    expect(plan.counts.unchanged).toBe(1);
    expect(plan0.hadManifest).toBe(false); // sanity: the first call really had no manifest yet
  });

  it("marks a lecture missing when the manifest knows it but the file is gone", () => {
    const data = courseData([lecture()]);
    const primary = path.join("1. Chapter", "1. Lecture One.mp4");
    const manifest: Manifest = {
      version: 1,
      courseId: 1,
      title: "Course",
      lectures: { "1": { assetId: 100, created: "2024-01-01", title: "Lecture One", primary, quality: "720", subs: true, attach: true, done: true, at: new Date().toISOString() } }
    };
    writeManifest(dir, manifest);
    // deliberately never write the actual file at `primary`

    const plan = planUpdates(data, dir, OPTIONS, inScopeAll(data));
    expect(data.chapters[0]!.lectures[0]!.status).toBe("missing");
    expect(plan.counts.missing).toBe(1);
  });

  it("marks a lecture updated and cleans up the old file when the asset was replaced", () => {
    const oldPrimary = path.join("1. Chapter", "1. Lecture One.mp4");
    fs.mkdirSync(path.dirname(path.join(dir, oldPrimary)), { recursive: true });
    fs.writeFileSync(path.join(dir, oldPrimary), "old video bytes");
    const manifest: Manifest = {
      version: 1,
      courseId: 1,
      title: "Course",
      lectures: { "1": { assetId: 100, created: "2024-01-01", title: "Lecture One", primary: oldPrimary, quality: "720", subs: true, attach: true, done: true, at: new Date().toISOString() } }
    };
    writeManifest(dir, manifest);

    const data = courseData([lecture({ assetId: 999, assetCreated: "2024-06-01" })]); // instructor replaced the video
    const plan = planUpdates(data, dir, OPTIONS, inScopeAll(data));
    expect(data.chapters[0]!.lectures[0]!.status).toBe("updated");
    expect(plan.counts.updated).toBe(1);
    expect(fs.existsSync(path.join(dir, oldPrimary))).toBe(false); // old file cleaned up
  });

  it("marks a lecture outside the chosen range and leaves it alone", () => {
    const data = courseData([lecture()]);
    const plan = planUpdates(data, dir, OPTIONS, {}); // empty inScope: nothing is in range
    expect(data.chapters[0]!.lectures[0]!.status).toBe("outside");
    expect(data.chapters[0]!.lectures[0]!.skip).toBe(true);
    expect(plan.counts.new + plan.counts.updated + plan.counts.missing + plan.counts.unchanged).toBe(0);
  });

  it("trusts an already-downloaded lecture during a retry without re-checking it", () => {
    const data = courseData([lecture({ _trusted: true })]);
    const plan = planUpdates(data, dir, OPTIONS, inScopeAll(data));
    expect(data.chapters[0]!.lectures[0]!.status).toBe("unchanged");
    expect(data.chapters[0]!.lectures[0]!.skip).toBe(true);
    expect(plan.counts.unchanged).toBe(1);
  });

  it("follows a rename: moves the file instead of re-downloading when the lecture reordered", () => {
    const oldPrimary = path.join("1. Chapter", "2. Lecture One.mp4");
    fs.mkdirSync(path.dirname(path.join(dir, oldPrimary)), { recursive: true });
    fs.writeFileSync(path.join(dir, oldPrimary), "video bytes");
    const manifest: Manifest = {
      version: 1,
      courseId: 1,
      title: "Course",
      lectures: { "1": { assetId: 100, created: "2024-01-01", title: "Lecture One", primary: oldPrimary, quality: "720", subs: false, attach: false, done: true, at: new Date().toISOString() } }
    };
    writeManifest(dir, manifest);

    // same lecture, now at position 1 instead of 2 (li=0 -> "1. Lecture One.mp4")
    const data = courseData([lecture()]);
    const plan = planUpdates(data, dir, { skipSubtitles: true, skipAttachments: true }, inScopeAll(data));
    const newPrimary = data.chapters[0]!.lectures[0]!.primary!;
    expect(newPrimary).not.toBe(oldPrimary);
    expect(fs.existsSync(path.join(dir, newPrimary))).toBe(true); // moved to the new name
    expect(fs.existsSync(path.join(dir, oldPrimary))).toBe(false); // not left behind at the old name
    expect(data.chapters[0]!.lectures[0]!.status).toBe("unchanged");
    expect(plan.counts.unchanged).toBe(1);
  });
});
