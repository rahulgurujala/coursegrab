// What the course details view shows: per course, every lecture and its state. No DOM code here;
// the UI layer subscribes to storeEvents and reads courseStore itself. See the header comment on
// courseStore below for why it stays a plain mutable record instead of a class.

import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { readManifest } from "./manifest";
import type {
  Chapter,
  ChapterGroup,
  CoursePhase,
  CourseStoreEntry,
  LectureStoreEntry,
  PrepareCourseData
} from "../shared/types";

// The single shared table every open course's details view reads from. Kept as a plain mutable
// record, not wrapped behind getters, so it stays a drop-in replacement for the previous global
// `var courseStore = {}` in engine.js: assets/js/details.js (not yet ported) reads
// courseStore[id]/courseStore[id].byId[lectureId] directly all over the place, and must keep
// working unchanged until it is ported too.
export const courseStore: Record<string, CourseStoreEntry> = {};

// Fires whenever an entry changes, so the UI layer can re-render. No UI import here: this module
// does not know what "touched" means to anything, it only announces that it happened.
export const storeEvents = new EventEmitter();

export function touch(courseId: string, lectureId?: string): void {
  storeEvents.emit("touch", courseId, lectureId);
}

// Builds the store from a prepared course and its plan.
export function buildStore(
  courseId: string,
  title: string,
  dir: string,
  data: PrepareCourseData,
  phase: CoursePhase,
  showBadges: boolean
): CourseStoreEntry {
  const store: CourseStoreEntry = { id: courseId, title, dir, phase, chapters: [], byId: {}, note: "" };
  data.chapters.forEach((chapter: Chapter) => {
    const group: ChapterGroup = { name: chapter.name, lectures: [] };
    chapter.lectures.forEach((lecture, li) => {
      const entry: LectureStoreEntry = {
        id: lecture.id,
        num: li + 1,
        name: lecture.name,
        state: "queued",
        badge: null,
        reason: "",
        pct: 0,
        size: null,
        note: ""
      };
      if (lecture.type == "Skipped") {
        entry.state = "skipped";
        entry.reason = lecture.reason || "";
      } else if (lecture.status == "outside") {
        entry.state = "outside";
      } else if (lecture.skip) {
        entry.state = "unchanged";
      } else {
        // "new" on a first download is just noise; badges matter when comparing with an earlier download
        entry.badge = showBadges ? (lecture.status as LectureStoreEntry["badge"]) || null : null;
      }
      group.lectures.push(entry);
      store.byId[String(entry.id)] = entry;
    });
    store.chapters.push(group);
  });
  courseStore[courseId] = store;
  return store;
}

// After a restart there is no live data: rebuild what is saved from the course folder's record.
// `translate` is passed in rather than assumed global: this module has no UI/i18n dependency of
// its own, only this one fallback chapter name needs it (see the `|| translate(...)` below).
export function storeFromManifest(
  courseId: string,
  title: string,
  dir: string,
  translate: (text: string) => string
): CourseStoreEntry {
  const manifest = readManifest(dir);
  const store: CourseStoreEntry = { id: courseId, title, dir, phase: "saved", chapters: [], byId: {}, note: "" };
  courseStore[courseId] = store;
  if (!manifest) return store;

  const groups: Record<string, { order: number; name: string; lectures: LectureStoreEntry[] }> = {};
  Object.keys(manifest.lectures).forEach((id) => {
    const m = manifest.lectures[id];
    if (!m) return; // came from Object.keys(manifest.lectures) itself, but noUncheckedIndexedAccess can't know that
    const primary = m.primary || "";
    const parts = primary.split(path.sep);
    const chapter = parts.length > 1 ? parts[0]! : "";
    const file = parts[parts.length - 1] || m.title;
    const num = parseInt(file, 10) || 0;
    const chapterNum = parseInt(chapter, 10) || 0;
    const key = chapterNum + "|" + chapter;
    const group = (groups[key] ||= { order: chapterNum, name: chapter.replace(/^\d+\.\s*/, "") || translate("Lectures"), lectures: [] });
    let size: number | null = null;
    try {
      size = fs.statSync(path.join(dir, primary)).size;
    } catch {
      // file missing (moved, deleted outside the app, ...): show no size rather than fail
    }
    const entry: LectureStoreEntry = {
      id,
      num,
      name: m.title,
      state: "saved",
      badge: null,
      reason: "",
      pct: 100,
      size,
      note: m.quality ? (/^\d+$/.test(String(m.quality)) ? m.quality + "p" : String(m.quality)) : ""
    };
    group.lectures.push(entry);
    store.byId[id] = entry;
  });

  Object.values(groups)
    .sort((a, b) => a.order - b.order)
    .forEach((g) => {
      g.lectures.sort((a, b) => a.num - b.num);
      store.chapters.push(g);
    });

  courseStore[courseId] = store;
  return store;
}
