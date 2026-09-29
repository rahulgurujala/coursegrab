// Ambient declarations for cross-file globals that app.ts (the app-shell glue file, loaded via
// <script src> the same way every renderer file always has been) reads from files not ported to
// real modules yet: the inline bootstrap script (translate/settings/appVersion), ui.js
// (courseRow.ts + shell.ts combined into the `ui` object), and engine.js/details.js's remaining
// plain functions. Everywhere else in this rewrite takes its dependencies as explicit parameters
// instead of assuming a global (translate into storeFromManifest, onLog into the orchestrator,
// translate again into courseRow.ts/courseDetails.ts); app.ts is the one file where that is not
// possible, since it sits at the top of the load order with no caller to inject from. This file
// names exactly what it actually reaches for, not a blanket "anything goes".

import type * as fsType from "fs";
import type { RowState, Row as RowComponent } from "../view/courseRow";
import type { CourseDetail } from "../view/courseDetails";
import type { CourseStoreEntry, CourseSummary, PrepareCourseData, SettingsData } from "../shared/types";

declare global {
  function translate(text: string): string;

  // Real Node requires, made globals by index.html's inline bootstrap script rather than
  // imported here, since app.ts is loaded as a classic <script>, not an ES module: a second
  // top-level `var fs`/`const homedir` from an import would collide with these (see app.ts).
  const fs: typeof fsType;
  const homedir: string;

  interface SettingsApiGlobal {
    get(key: string): unknown;
    getAll(): SettingsData;
    set(key: string, value: unknown): void;
  }
  const settings: SettingsApiGlobal;

  const appVersion: string;

  interface Ui {
    applyTranslations(): void;
    showView(name: string): void;
    toast(message: string, error?: boolean): void;
    confirm(title: string, text: string | undefined, okLabel: string, cb: (ok: boolean) => void): void;
    refreshDownloads(): void;
    courseRow(c: CourseSummary, state?: RowState): string;
    skeleton(n: number): string;
    Row: typeof RowComponent;
    copyState($from: JQuery, $to: JQuery): void;
    formatSpeed(kbps: number): string;
    scroll: Record<string, number>;
  }
  const ui: Ui;

  const courseStore: Record<string, CourseStoreEntry>;
  const courseDetail: CourseDetail;

  function prepareCourse(
    course: { id: string; title: string; url: string },
    prep: { cancelled: boolean; failed: boolean },
    onProgress?: (done: number, total: number) => void,
    retryOnly?: boolean
  ): Promise<PrepareCourseData | null>;

  function initDownload($course: JQuery, data: PrepareCourseData, subtitle?: string | false): Promise<void>;

  function checkCourse(course: { id: string; title: string; url: string }, onProgress: (done: number, total: number) => void): Promise<CourseStoreEntry>;

  function retryLecture(courseId: string, lectureId: string): Promise<boolean>;

  function courseDir(title: string): string;
}

export {};
