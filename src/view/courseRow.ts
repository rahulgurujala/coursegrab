// The course row: its markup, and the Row component that updates an existing row's state/text/
// progress. This is the direct extraction of assets/js/ui.js's courseRow()/Row/copyState/
// formatSpeed/skeleton. The only file (besides courseDetails.ts, next) allowed to build this
// specific markup or poke at a row's DOM directly.
//
// translate() is taken as an explicit parameter rather than assumed as an ambient global, the
// same choice made for storeFromManifest back in phase 4: this module's only environmental
// dependencies should be nameable, not hidden. jQuery is imported directly (not read off a
// global): Node caches require("jquery") by resolved path, so this is the exact same singleton
// instance app.js's bootstrap script creates, not a second copy.
//
// Side effects that used to happen inline inside ui.Row.state()/progress() (telling the course
// details view its header changed, refreshing the Downloads badge, periodically saving the list
// to disk) are now events: this module does not know courseDetail or saveDownloads exist. The
// caller (still assets/js/ui.js itself, until app.ts exists) subscribes and reacts, the same
// event-instead-of-inline-call shape used by the store and the download orchestrator.

import $ from "jquery";
import { EventEmitter } from "events";
import { esc } from "./esc";
import type { CourseSummary } from "../shared/types";

export type RowState = "idle" | "preparing" | "downloading" | "paused" | "interrupted" | "done" | "error";

type Translate = (text: string) => string;

export function courseRowHtml(c: CourseSummary, state: RowState | undefined, translate: Translate): string {
  return `
<li class="course" data-state="${state || "idle"}" course-id="${esc(c.id)}" course-url="${esc(c.url)}">
  <img class="thumb" src="${esc(c.image)}" alt="" loading="lazy">
  <div class="course-body">
    <h3 class="coursename">${esc(c.title)}</h3>
    <p class="status-line" data-show="idle preparing downloading paused interrupted done error"><span class="status-text"></span></p>
    <div class="meter" data-show="preparing downloading paused interrupted" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="${esc(c.title)}">
      <span class="meter-track"><span class="meter-fill"></span></span><span class="meter-pct">0%</span>
    </div>
    <p class="now-line" data-show="downloading paused" data-only="downloads"></p>
  </div>
  <div class="course-actions">
    <button class="btn primary download-btn" type="button" data-show="idle">${translate("Download")}</button>
    <button class="btn primary download-btn" type="button" data-show="interrupted"><svg class="icon flip"><use href="#i-play"/></svg>${translate("Resume")}</button>
    <button class="btn ghost icon-only open-in-browser" type="button" data-show="idle" data-only="courses" title="${translate("Open on Udemy")}" aria-label="${translate("Open on Udemy")}"><svg class="icon flip"><use href="#i-external"/></svg></button>
    <button class="btn" type="button" disabled data-show="preparing"><span class="spinner"></span>${translate("Preparing")}</button>
    <button class="btn" type="button" data-goto="downloads" data-show="downloading paused" data-only="courses">${translate("View progress")}</button>
    <button class="btn pause-btn" type="button" data-show="downloading" data-only="downloads"><svg class="icon"><use href="#i-pause"/></svg>${translate("Pause")}</button>
    <button class="btn primary resume-btn" type="button" data-show="paused" data-only="downloads"><svg class="icon flip"><use href="#i-play"/></svg>${translate("Resume")}</button>
    <button class="btn ghost cancel-btn" type="button" data-show="preparing downloading paused" data-only="downloads">${translate("Cancel")}</button>
    <button class="btn folder-btn" type="button" data-show="done"><svg class="icon"><use href="#i-folder"/></svg>${translate("Open folder")}</button>
    <button class="btn update-btn" type="button" data-show="done" title="${translate("Download only what is new or changed")}"><svg class="icon"><use href="#i-retry"/></svg>${translate("Get updates")}</button>
    <button class="btn primary retry-btn" type="button" data-show="error"><svg class="icon"><use href="#i-retry"/></svg>${translate("Retry")}</button>
    <button class="btn ghost icon-only details-btn" type="button" data-show="preparing downloading paused interrupted done error" data-only="downloads" title="${translate("Details")}" aria-label="${translate("Details")}"><svg class="icon"><use href="#i-list"/></svg></button>
    <button class="btn ghost icon-only remove-btn" type="button" data-show="idle interrupted done error" data-only="downloads" title="${translate("Remove from list")}" aria-label="${translate("Remove from list")}"><svg class="icon"><use href="#i-trash"/></svg></button>
  </div>
</li>`;
}

export function skeletonHtml(n: number): string {
  return Array(n)
    .fill('<li class="skeleton" aria-hidden="true"><i></i><i></i><i></i></li>')
    .join("");
}

export function formatSpeed(kbps: number): string {
  return kbps >= 1024 ? (kbps / 1024).toFixed(1) + " MB/s" : kbps + " KB/s";
}

interface RowEventMap {
  "state-changed": [courseId: string];
  progress: [courseId: string];
}

class RowEmitter extends EventEmitter {
  override on<E extends keyof RowEventMap>(event: E, listener: (...args: RowEventMap[E]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<E extends keyof RowEventMap>(event: E, ...args: RowEventMap[E]): boolean {
    return super.emit(event, ...args);
  }
}

// All rows of one course (the Courses list copy and the Downloads list copy) are updated
// together, so a Row call takes the whole jQuery set, exactly as before.
export const rowEvents = new RowEmitter();

let lastProgressEmit = 0;

export const Row = {
  state($c: JQuery, state: RowState): void {
    $c.attr("data-state", state);
    if (state == "preparing") $c.find(".meter").removeAttr("aria-valuenow");
    const courseId = $c.first().attr("course-id");
    if (courseId) rowEvents.emit("state-changed", courseId);
  },

  text($c: JQuery, text: string): void {
    $c.find(".status-text").text(text || "");
    $c.find(".meter").attr("aria-valuetext", text || "");
  },

  now($c: JQuery, text: string): void {
    $c.find(".now-line").text(text || "");
  },

  progress($c: JQuery, done: number, total: number): void {
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    $c.attr("data-pct", pct);
    $c.find(".meter-fill").css("--p", String(pct / 100));
    $c.find(".meter-pct").text(pct + "%");
    $c.find(".meter").attr("aria-valuenow", pct);
    // save the list now and then while downloading, so a crash keeps an accurate percentage:
    // throttled here (not by the subscriber) so every subscriber gets the same, already-debounced signal
    const courseId = $c.first().attr("course-id");
    if (courseId && Date.now() - lastProgressEmit > 5000) {
      lastProgressEmit = Date.now();
      rowEvents.emit("progress", courseId);
    }
  }
};

// Copy a running download's visible state onto a freshly built row of the same course.
export function copyState($from: JQuery, $to: JQuery): void {
  $to.attr({
    "data-state": $from.attr("data-state") || "",
    "data-pct": $from.attr("data-pct") || "",
    "data-path": $from.attr("data-path") || ""
  });
  Row.text($to, $from.find(".status-text").text());
  Row.now($to, $from.find(".now-line").text());
  Row.progress($to, parseInt($from.attr("data-pct") || "0", 10) || 0, 100);
}

// The Downloads list always holds a row for a course that is preparing or downloading. Row-shaped
// DOM setup, so it lives here rather than in app.ts/engine.js (both of which call it: app.ts when
// a download button is clicked, engine.js's initDownload when a course-level Retry resumes one).
export function ensureDownloadRow($course: JQuery): void {
  const id = $course.attr("course-id");
  if (!$('#downloads-list .course[course-id="' + id + '"]').length) {
    $("#downloads-list").prepend($course.clone());
  }
}
