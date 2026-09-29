// Runs a course download: sequencing, retry, pause/resume/cancel. No DOM, no i18n, no jQuery.
// Everything the UI needs to paint is emitted as a typed event carrying raw data (numbers,
// lecture references, HTTP-style status codes); building the actual sentence a person reads
// (translate(), ui.Row.*) is the subscriber's job, same as api/udemy.ts logs raw reasons and lets
// the caller decide how to present them. This is the direct extraction of what was previously
// initDownload() in assets/js/engine.js, with its control flow unchanged.

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { EventEmitter } from "events";
import sanitize from "sanitize-filename";
import vtt2srt from "node-vtt-to-srt";
import { Downloader, type Download, type DownloadStats } from "./rangeDownloader";
import { chapterFolder, primaryName, attachmentName } from "./naming";
import { removeQuietly } from "./fsUtils";
import { writeManifest } from "../store/manifest";
import type { PlanCounts, PlanResult } from "./planner";
import type { DownloadSettings, Lecture, Manifest, PrepareCourseData, SkippedEntry } from "../shared/types";

export interface DownloadItem {
  ci: number;
  li: number;
  lecture: Lecture;
}

export interface OrchestratorView {
  name: string;
  quality: string;
  speed: number;
  filePct: number;
}

export interface FailedEntry {
  chapter: string;
  name: string;
  status: number;
}

// "partial-failure": the download loop ran to completion but some lectures individually failed
// (the subscriber shows "Downloaded D/T, N failed"). "unexpected-error": something outside the
// per-lecture handling threw (a bug, a filesystem problem) and autoRetry gave up or is off; the
// subscriber shows a plain connection/access-denied style message for `status`, not a summary,
// since there is no reliable done/total/failed breakdown for a failure that happened mid-setup.
export type FinishReason = "no-downloadable" | "up-to-date" | "completed" | "partial-failure" | "unexpected-error";

export interface FinishedInfo {
  kind: "done" | "error";
  reason: FinishReason;
  status?: number; // set only for "unexpected-error"
  lectureName?: string; // set only for "unexpected-error", when it happened mid-lecture
  done: number;
  total: number;
  failed: FailedEntry[];
  hadManifest: boolean;
  counts: PlanCounts;
  skippedCount: number;
}

export type StatusKey = "checking-updates" | "connection-retry";

interface CourseDownloadEventMap {
  started: [{ dir: string }];
  planned: [{ hadManifest: boolean }];
  status: [key: StatusKey];
  "lecture-start": [item: DownloadItem];
  progress: [{ done: number; total: number; view: OrchestratorView; paused: boolean; currentItem: DownloadItem | null }];
  "lecture-done": [{ item: DownloadItem; size: number | null }];
  "lecture-failed": [{ item: DownloadItem; status: number }];
  "row-progress": [{ done: number; total: number }];
  paused: [];
  resumed: [];
  cancelled: [{ lectureId: string | null }];
  retrying: [{ attempt: number }];
  finished: [FinishedInfo];
}

export type LogLevel = "info" | "warn" | "error";
export type OnLog = (courseId: string, level: LogLevel, text: string) => void;

export interface OrchestratorOptions {
  courseId: string;
  data: PrepareCourseData;
  dir: string;
  options: DownloadSettings;
  subtitle: string | false;
  plan: (inScope: Record<string, boolean>) => PlanResult; // planUpdates, bound to this course's data/dir/options
  onLog?: OnLog;
}

const SKIPPED_FILE = "Skipped lectures.txt";

export class CourseDownload extends EventEmitter {
  private readonly courseId: string;
  private readonly data: PrepareCourseData;
  private readonly dir: string;
  private readonly options: DownloadSettings;
  private readonly subtitle: string | false;
  private readonly plan: (inScope: Record<string, boolean>) => PlanResult;
  private readonly onLog: OnLog | undefined;

  private cancelled = false;
  private paused = false;
  private canPause = false;
  private current: { dl: Download; abort: () => void } | null = null;
  private downloader = new Downloader();
  private done = 0;
  private total = 0;
  private currentItem: DownloadItem | null = null;
  private view: OrchestratorView = { quality: "", speed: 0, name: "", filePct: 0 };

  constructor(opts: OrchestratorOptions) {
    super();
    this.courseId = opts.courseId;
    this.data = opts.data;
    this.dir = opts.dir;
    this.options = opts.options;
    this.subtitle = opts.subtitle;
    this.plan = opts.plan;
    this.onLog = opts.onLog;
  }

  override on<E extends keyof CourseDownloadEventMap>(event: E, listener: (...args: CourseDownloadEventMap[E]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<E extends keyof CourseDownloadEventMap>(event: E, ...args: CourseDownloadEventMap[E]): boolean {
    return super.emit(event, ...args);
  }

  private log(level: LogLevel, text: string): void {
    this.onLog?.(this.courseId, level, text);
  }

  pause(): void {
    if (!this.canPause || this.cancelled || !this.current) return;
    try {
      this.current.dl.stop();
    } catch {}
    this.paused = true;
    this.view.speed = 0;
    this.emit("paused");
    this.paint();
  }

  resume(): void {
    try {
      this.current?.dl.resume();
    } catch {}
    this.paused = false;
    this.emit("resumed");
    this.paint();
  }

  cancel(): void {
    this.cancelled = true;
    if (this.current) {
      try {
        this.current.dl.stop();
      } catch {}
      this.current.abort();
    }
    this.emit("cancelled", { lectureId: this.currentItem ? String(this.currentItem.lecture.id) : null });
  }

  private paint(): void {
    this.emit("progress", { done: this.done, total: this.total, view: this.view, paused: this.paused, currentItem: this.currentItem });
  }

  // Downloads one file. Partly downloaded files continue where they stopped and complete files
  // are kept. rangeDownloader.ts owns retrying each byte range internally and only ever reports
  // "end" once the file has actually been renamed to its final, complete name, so there is no
  // separate watchdog here racing its own stop() against the download finishing anyway: what this
  // promise settles with always matches what is really on disk.
  private fetchFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let dl: Download;
      if (fs.existsSync(dest + ".mtd")) {
        dl = this.downloader.resumeDownload(dest);
        if (!fs.statSync(dest + ".mtd").size) dl = this.downloader.download(url, dest);
      } else if (fs.existsSync(dest)) {
        resolve();
        return;
      } else {
        dl = this.downloader.download(url, dest);
      }

      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.canPause = false;
        this.current = null;
        err ? reject(err) : resolve();
      };
      this.current = { dl, abort: () => settle(new Error("cancelled")) };
      dl.setRetryOptions({ maxRetries: 2, retryInterval: 1500 });
      dl.setOptions({ threadsCount: 5, timeout: 20000 });
      dl.on("start", () => {
        this.canPause = true;
      });
      dl.on("progress", (stats: DownloadStats) => {
        this.view.speed = parseInt(String(stats.present.speed / 1000)) || 0;
        this.view.filePct = Math.round(stats.total.completed) || 0;
        this.paint();
      });
      dl.on("log", (e) => {
        this.log(e.level === "error" ? "error" : "warn", this.view.name + ": " + e.text);
      });
      dl.on("end", () => settle());
      dl.on("error", () => {
        const status = dl.error?.status || 0;
        this.log("error", this.view.name + ": failed (" + (status || "connection") + ")");
        if (status == 401 || status == 403) removeQuietly(dl.filePath, dl.filePath + ".mtd", dl.filePath + ".mtd.meta.json");
        settle(Object.assign(new Error("HTTP " + status), { status }));
      });
      dl.start();
    });
  }

  // A dropped connection is retried a few times, continuing from the data already saved.
  private async fetchFileWithRetry(url: string, dest: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.fetchFile(url, dest);
      } catch (err) {
        const status = (err as { status?: number }).status;
        const denied = status == 401 || status == 403;
        if (this.cancelled || denied || attempt >= 2) throw err;
        this.log("warn", this.view.name + ": lecture-level retry " + attempt + " after " + (status || "connection error"));
        this.emit("status", "connection-retry");
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        if (this.cancelled) throw err;
      }
    }
  }

  private fetchSubtitle(url: string, dir: string, lectureIndex: number, lecture: Lecture): Promise<void> {
    return fetchSubtitleFile(url, dir, lectureIndex, lecture);
  }

  private async saveLecture(item: DownloadItem, manifest: Manifest): Promise<void> {
    const lecture = item.lecture;
    manifest.lectures[String(lecture.id)] = {
      assetId: lecture.assetId ?? null,
      created: lecture.assetCreated ?? null,
      title: lecture.name,
      primary: lecture.primary,
      quality: lecture.quality,
      subs: !this.options.skipSubtitles,
      attach: !this.options.skipAttachments,
      done: true,
      at: new Date().toISOString()
    };
    manifest.title = this.data.name;
    manifest.updatedAt = new Date().toISOString();
    writeManifest(this.dir, manifest);
  }

  private async downloadLecture(item: DownloadItem): Promise<void> {
    const lecture = item.lecture;
    const folder = path.join(this.dir, chapterFolder(item.ci, this.data.chapters[item.ci]!));
    await fs.promises.mkdir(folder, { recursive: true });
    this.view.name = lecture.name;
    this.view.filePct = 0;
    this.view.quality = /^\d+$/.test(lecture.quality || "") && lecture.type == "Video" ? lecture.quality + "p" : lecture.quality || "";
    this.paint();

    const target = path.join(folder, primaryName(item.li, lecture));
    if (lecture.type == "Article" || lecture.type == "Url") {
      await fs.promises.writeFile(target, lecture.src || "");
    } else {
      await this.fetchFileWithRetry(lecture.src!, target);
    }
    if (this.cancelled) return;

    if (lecture.caption && this.subtitle) {
      this.view.filePct = 0;
      this.view.quality = "Subtitle";
      this.view.speed = 0;
      this.paint();
      const lang = lecture.caption[this.subtitle] ? this.subtitle : Object.keys(lecture.caption)[0]!;
      await this.fetchSubtitle(lecture.caption[lang]!, folder, item.li, lecture);
    }

    if (lecture.supplementary) {
      for (let ai = 0; ai < lecture.supplementary.length; ai++) {
        if (this.cancelled) return;
        const asset = lecture.supplementary[ai]!;
        this.view.filePct = 0;
        this.view.quality = asset.quality;
        this.paint();
        const file = path.join(folder, attachmentName(item.li, ai, asset));
        if (asset.type == "Url" || asset.type == "Article") await fs.promises.writeFile(file, asset.src);
        else await this.fetchFileWithRetry(asset.src, file);
      }
    }
  }

  // One full attempt at the course. Thrown errors here are unexpected (a bug, a filesystem
  // problem) - normal per-lecture failures are caught inside the loop and never reach here.
  private async runOnce(): Promise<void> {
    const all: DownloadItem[] = [];
    this.data.chapters.forEach((chapter, ci) => {
      chapter.lectures.forEach((lecture, li) => {
        if (lecture.type != "Skipped") all.push({ ci, li, lecture });
      });
    });
    this.emit("status", "checking-updates");

    let selected = all;
    if (this.options.enableDownloadStartEnd && all.length) {
      let start = Math.max(1, Math.min(this.options.downloadStart || 1, all.length));
      let end = this.options.downloadEnd;
      if (!end || end < 1 || end > all.length) end = all.length;
      if (start > end) start = end;
      selected = all.slice(start - 1, end);
    }
    const inScope: Record<string, boolean> = {};
    selected.forEach((item) => {
      inScope[String(item.lecture.id)] = true;
    });
    const plan = this.plan(inScope);
    const work = selected.filter((item) => !item.lecture.skip);
    this.total = work.length;
    // emitted unconditionally, even on the no-downloadable/up-to-date paths below: the course
    // details view needs the store built either way, to show "nothing downloadable" or "already
    // up to date" against the full curriculum, not just when there is real work to do
    this.emit("planned", { hadManifest: plan.hadManifest });

    const skippedCount = this.data.skipped.length;
    if (skippedCount) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(
          path.join(this.dir, SKIPPED_FILE),
          "These lectures were not downloaded because they are protected or unavailable.\n\n" +
            this.data.skipped.map((s: SkippedEntry) => s.chapter + ": " + s.name + " (" + s.reason + ")").join("\n") +
            "\n"
        );
      } catch {}
    }

    if (!all.length) {
      this.emit("finished", {
        kind: "error",
        reason: "no-downloadable",
        done: 0,
        total: 0,
        failed: [],
        hadManifest: plan.hadManifest,
        counts: plan.counts,
        skippedCount
      });
      return;
    }

    const manifest: Manifest = plan.manifest || { version: 1, courseId: this.courseId, title: this.data.name, lectures: {} };

    if (!work.length) {
      writeManifest(this.dir, manifest);
      this.emit("finished", { kind: "done", reason: "up-to-date", done: 0, total: 0, failed: [], hadManifest: plan.hadManifest, counts: plan.counts, skippedCount });
      return;
    }

    const failed: FailedEntry[] = [];
    for (const item of work) {
      if (this.cancelled) return;
      this.currentItem = item;
      this.emit("lecture-start", item);
      try {
        await this.downloadLecture(item);
      } catch (err) {
        if (this.cancelled) return;
        const status = (err as { status?: number }).status || 0;
        this.emit("lecture-failed", { item, status });
        failed.push({ chapter: this.data.chapters[item.ci]!.name, name: item.lecture.name, status });
        this.currentItem = null;
        continue; // one lecture failing must not stop the rest of the course
      }
      if (this.cancelled) return;
      let savedSize: number | null = null;
      try {
        savedSize = fs.statSync(path.join(this.dir, item.lecture.primary!)).size;
      } catch {}
      this.emit("lecture-done", { item, size: savedSize });
      this.currentItem = null;
      this.done++;
      this.view.filePct = 0;
      await this.saveLecture(item, manifest);
      this.emit("row-progress", { done: this.done, total: this.total });
    }
    // lectures that were left alone keep their entry; make sure the file exists after a first run
    writeManifest(this.dir, manifest);

    this.emit("finished", {
      kind: failed.length ? "error" : "done",
      reason: failed.length ? "partial-failure" : "completed",
      done: this.done,
      total: this.total,
      failed,
      hadManifest: plan.hadManifest,
      counts: plan.counts,
      skippedCount
    });
  }

  // Runs the course, retrying the whole thing with backoff on an unexpected error (a bug, a
  // filesystem problem - not a normal per-lecture failure, those are handled inside runOnce and
  // never throw here) when autoRetry is on, up to 5 attempts.
  async run(): Promise<void> {
    this.emit("started", { dir: this.dir });
    let retries = 0;
    for (;;) {
      try {
        await this.runOnce();
        return;
      } catch (err) {
        if (this.cancelled) return;
        const status = (err as { status?: number }).status || 0;
        if (this.currentItem) {
          this.emit("lecture-failed", { item: this.currentItem, status });
        }
        if (this.options.autoRetry && retries < 5) {
          retries++;
          this.emit("retrying", { attempt: retries });
          await new Promise((r) => setTimeout(r, 5000 * retries));
          if (this.cancelled) return;
          continue;
        }
        this.emit("finished", {
          kind: "error",
          reason: "unexpected-error",
          status,
          ...(this.currentItem ? { lectureName: this.currentItem.lecture.name } : {}),
          done: this.done,
          total: this.total,
          failed: [],
          hadManifest: false,
          counts: { new: 0, updated: 0, missing: 0, unchanged: 0 },
          skippedCount: this.data.skipped.length
        });
        return;
      }
    }
  }
}

// Shared with retryLecture's standalone subtitle fetch in engine.js (not moved yet, still uses
// its own copy there until that function is ported too).
function fetchSubtitleFile(url: string, dir: string, lectureIndex: number, lecture: Lecture): Promise<void> {
  const vttName = sanitize(lectureIndex + 1 + ". " + lecture.name.trim() + ".vtt");
  const vtt = path.join(dir, vttName);
  const srt = vtt.replace(/\.vtt$/, ".srt");
  if (fs.existsSync(srt)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(vtt);
    out.on("finish", resolve);
    out.on("error", reject);
    https.get(url, (response) => response.pipe(out)).on("error", reject);
  })
    .then(() => {
      return new Promise<void>((resolve, reject) => {
        const final = fs.createWriteStream(srt);
        final.on("finish", resolve);
        final.on("error", reject);
        fs.createReadStream(vtt).pipe(vtt2srt()).pipe(final);
      });
    })
    .then(() => {
      removeQuietly(vtt);
    });
}
