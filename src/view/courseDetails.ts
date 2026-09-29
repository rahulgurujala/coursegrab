// Course detail view: every lecture of a course and what is happening to it, plus the debug
// console panel. The direct extraction of assets/js/details.js's courseDetail IIFE.
//
// courseStore and devlog are real, already-ported modules, imported directly. checkCourse/
// courseDir/prepError are still plain functions in assets/js/engine.js and app.js (not ported
// yet), so they are taken as explicit dependencies, the same choice made throughout this rewrite
// for anything not yet a real module (translate in phase 4, onLog in phase 5, translate again in
// courseRow.ts). $/electron's shell/fs are imported directly: the same singletons every other
// require()'d module in this app already shares, not a second copy.

import $ from "jquery";
import * as fs from "fs";
import { shell } from "electron";
import { esc } from "./esc";
import { courseStore } from "../store/courseStore";
import * as devlog from "../shared/devlog";
import type { CourseStoreEntry, LectureStoreEntry, LogEntry } from "../shared/types";

type Translate = (text: string) => string;

export interface CourseSummaryForCheck {
  id: string;
  title: string;
  url: string;
}

export interface CourseDetailDeps {
  translate: Translate;
  formatSpeed: (kbps: number) => string;
  showView: (name: string) => void;
  toast: (message: string, error?: boolean) => void;
  checkCourse: (course: CourseSummaryForCheck, onProgress: (done: number, total: number) => void) => Promise<unknown>;
  courseDir: (title: string) => string;
  prepError: (status: unknown) => string;
  storeFromManifest: (courseId: string, title: string, dir: string) => CourseStoreEntry;
}

type Filter = "all" | "active" | "changes" | "skipped" | "failed";
const FILTERS: Filter[] = ["all", "active", "changes", "skipped", "failed"];

export interface CourseDetail {
  open(id: string | number): void;
  touch(courseId: string | number, lectureId?: string | number): void;
  headerChanged(courseId: string | number): void;
  prepProgress(courseId: string | number, text: string): void;
  currentCourseId(): string | null;
}

export function createCourseDetail(deps: CourseDetailDeps): CourseDetail {
  const { translate, formatSpeed, showView, toast, checkCourse, courseDir, prepError, storeFromManifest } = deps;

  let openId: string | null = null;
  let filter: Filter = "all";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Record<string, boolean> = {};
  let checking = false;
  let consoleOpen = false;

  function levelIcon(level: LogEntry["level"]): string {
    return level == "error" ? "✕" : level == "warn" ? "!" : "›";
  }

  function consoleRowHtml(e: LogEntry): string {
    const time = new Date(e.at).toLocaleTimeString([], { hour12: false });
    return '<div class="console-row lvl-' + e.level + '"><span class="ct">' + time + '</span><span class="ci">' + levelIcon(e.level) + '</span><span class="cx">' + esc(e.text) + "</span></div>";
  }

  function renderConsole(): void {
    if (!consoleOpen || !openId) return;
    const entries = devlog.forCourse(openId);
    $("#console-count").text(String(entries.length));
    const $body = $("#console-body");
    const el = $body[0];
    const atBottom = el ? el.scrollTop + el.clientHeight >= el.scrollHeight - 20 : true;
    $body.html(entries.map(consoleRowHtml).join("") || '<div class="console-empty">' + esc(translate("Nothing logged yet for this course.")) + "</div>");
    if (atBottom && el) $body.scrollTop(el.scrollHeight);
  }

  function setConsole(open: boolean): void {
    consoleOpen = open;
    $("#course-console").prop("hidden", !open);
    if (open) renderConsole();
  }

  function store(): CourseStoreEntry | undefined {
    return openId ? courseStore[openId] : undefined;
  }

  function entries(): LectureStoreEntry[] {
    let out: LectureStoreEntry[] = [];
    const st = store();
    if (st) st.chapters.forEach((c) => (out = out.concat(c.lectures)));
    return out;
  }

  function formatSize(bytes: number | null): string {
    if (bytes == null) return "";
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }

  function stateLabel(e: LectureStoreEntry): string {
    const labels: Record<LectureStoreEntry["state"], string> = {
      queued: translate("Queued"),
      downloading: translate("Downloading"),
      done: translate("Done"),
      unchanged: translate("Unchanged"),
      skipped: translate("Skipped"),
      failed: translate("Failed"),
      outside: translate("Not in range"),
      saved: translate("Saved")
    };
    return labels[e.state];
  }

  function badgeLabel(e: LectureStoreEntry): string {
    if (!e.badge) return "";
    const labels = { new: translate("New"), updated: translate("Updated"), missing: translate("Missing") };
    return labels[e.badge];
  }

  function metaText(e: LectureStoreEntry): string {
    switch (e.state) {
      case "downloading":
        return [e.pct + "%", e.note, e.speed ? formatSpeed(e.speed) : ""].filter(Boolean).join(" · ");
      case "done":
      case "saved":
        return [formatSize(e.size), e.note].filter(Boolean).join(" · ");
      case "unchanged":
        return translate("Already saved, left alone");
      case "skipped":
        return e.reason == "denied" ? translate("Access denied") : translate("Protected or unavailable");
      case "failed":
        return e.reason;
      case "outside":
        return translate("Outside the chosen lecture range");
      default:
        return badgeLabel(e) ? translate("Will be downloaded") : "";
    }
  }

  function lectureHtml(e: LectureStoreEntry): string {
    const badge = badgeLabel(e);
    const retry = e.state == "failed" ? '<button class="btn ghost lretry" type="button" title="' + esc(translate("Retry this lecture")) + '">' + esc(translate("Retry")) + "</button>" : "";
    return (
      '<li class="lecture" data-lid="' + esc(e.id) + '" data-state="' + e.state + '"' + (e.badge ? ' data-badge="' + e.badge + '"' : "") + ">" +
      '<span class="lnum">' + esc(e.num) + "</span>" +
      '<span class="lbody"><span class="lname">' + esc(e.name) + '</span><span class="lmeta">' + esc(metaText(e)) + "</span></span>" +
      '<span class="lstatus">' + (badge ? '<span class="pill badge-' + e.badge + '">' + esc(badge) + "</span>" : "") +
      '<span class="pill state-' + e.state + '">' + esc(stateLabel(e)) + "</span>" + retry + "</span>" +
      '<span class="lbar" aria-hidden="true"><span class="lfill" style="--p:' + (e.state == "downloading" ? e.pct / 100 : 0) + '"></span></span>' +
      "</li>"
    );
  }

  function matches(e: LectureStoreEntry): boolean {
    switch (filter) {
      case "active":
        return e.state == "queued" || e.state == "downloading";
      case "changes":
        return !!e.badge;
      case "skipped":
        return e.state == "skipped";
      case "failed":
        return e.state == "failed";
      default:
        return true;
    }
  }

  function counts(): Record<Filter | "done" | "unchanged", number> {
    const c = { all: 0, active: 0, changes: 0, skipped: 0, failed: 0, done: 0, unchanged: 0 };
    entries().forEach((e) => {
      c.all++;
      if (e.state == "queued" || e.state == "downloading") c.active++;
      if (e.badge) c.changes++;
      if (e.state == "skipped") c.skipped++;
      if (e.state == "failed") c.failed++;
      if (e.state == "done" || e.state == "saved") c.done++;
      if (e.state == "unchanged") c.unchanged++;
    });
    return c;
  }

  function rowState(): string {
    return $('#downloads-list .course[course-id="' + openId + '"]').attr("data-state") || "idle";
  }

  function renderActions(): void {
    const state = rowState();
    let html = "";
    const btn = (act: string, label: string, cls?: string) => '<button class="btn ' + (cls || "") + '" type="button" data-act="' + act + '">' + label + "</button>";
    // Open folder and the debug console are useful in every state, including mid-download, not
    // just once a course is idle: that is exactly when "what is actually happening right now" matters.
    const common = btn("folder", translate("Open folder")) + btn("console", translate("Console"));
    if (state == "downloading") html = common + btn("pause", translate("Pause")) + btn("cancel", translate("Cancel"), "ghost");
    else if (state == "paused") html = common + btn("resume", translate("Resume"), "primary") + btn("cancel", translate("Cancel"), "ghost");
    else if (state == "preparing") html = common + btn("cancel", translate("Cancel"), "ghost");
    else {
      const st = store();
      const changes = st && st.phase == "checked" ? counts().changes : 0;
      const label =
        state == "interrupted" ? translate("Resume") : state == "error" ? translate("Retry") : state == "idle" ? translate("Download") : changes ? translate("Download changes") : translate("Get updates");
      html = common + btn("check", checking ? '<span class="spinner"></span>' + translate("Checking") + "…" : translate("Check for changes")) + btn("go", label, "primary");
    }
    $("#course-actions").html(html);
    $("#course-actions [data-act=check]").prop("disabled", checking);
    $("#course-actions [data-act=console]").attr("aria-pressed", String(consoleOpen)).toggleClass("active", consoleOpen);
  }

  function renderSummary(): void {
    const st = store();
    const c = counts();
    const parts: string[] = [];
    if (c.all) parts.push(c.all + " " + translate("lectures"));
    if (c.done) parts.push(c.done + " " + translate("saved"));
    if (c.active) parts.push(c.active + " " + translate("waiting"));
    if (c.unchanged) parts.push(c.unchanged + " " + translate("unchanged"));
    if (c.skipped) parts.push(c.skipped + " " + translate("skipped"));
    if (c.failed) parts.push(c.failed + " " + translate("failed"));
    $("#course-summary").text(parts.join(" · "));

    let notice = "";
    const state = rowState();
    if (!st || !c.all) {
      notice = state == "preparing" ? translate("Reading the course from Udemy") + "…" : translate("Nothing is listed for this course yet. Press Check for changes to see what it contains.");
    } else if (st.phase == "saved") {
      notice = translate("This is what is saved in the course folder. Press Check for changes to compare it with Udemy.");
    } else if (st.phase == "checked") {
      notice = c.changes
        ? translate("Compared with Udemy") + ": " + c.changes + " " + translate("to download") + ". " + translate("Press Download changes to fetch them.")
        : translate("Compared with Udemy") + ": " + translate("everything is up to date") + ".";
    }
    $("#course-notice").text(notice).prop("hidden", !notice);

    FILTERS.forEach((f) => {
      const $chip = $('#course-filters [data-filter="' + f + '"]');
      $chip.find(".n").text(String(c[f]));
      $chip.prop("hidden", f != "all" && f != filter && !c[f]).attr("aria-pressed", String(f == filter));
    });
  }

  function applyFilter(): void {
    $("#course-lectures .lecture").each(function() {
      const e = store()?.byId[$(this).attr("data-lid") || ""];
      $(this).prop("hidden", !!e && !matches(e));
    });
    $("#course-lectures .chapter").each(function() {
      $(this).prop("hidden", !$(this).find(".lecture:not([hidden])").length);
    });
    $("#course-empty").prop("hidden", !!$("#course-lectures .lecture:not([hidden])").length || !entries().length);
  }

  function renderAll(): void {
    const st = store();
    $("#h-course").text(st ? st.title : "");
    renderActions();
    renderSummary();
    let html = "";
    if (st) {
      st.chapters.forEach((ch) => {
        if (!ch.lectures.length) return;
        html += '<section class="chapter"><h2 class="chapter-title"><span>' + esc(ch.name) + '</span><span class="count">' + ch.lectures.length + '</span></h2><ul class="list lectures">' + ch.lectures.map(lectureHtml).join("") + "</ul></section>";
      });
    }
    $("#course-lectures").html(html);
    applyFilter();
  }

  function flush(): void {
    timer = null;
    if (!openId) return;
    const ids = Object.keys(pending);
    const all = pending["*"];
    pending = {};
    const st = store();
    if (!st) return;
    if (all || (st.chapters.length && !$("#course-lectures .lecture").length)) {
      renderAll();
      return;
    }
    ids.forEach((id) => {
      const e = st.byId[id];
      const $li = $('#course-lectures .lecture[data-lid="' + id + '"]');
      if (!e || !$li.length) return;
      const $new = $(lectureHtml(e));
      $li.attr("data-state", e.state).attr("data-badge", e.badge || "");
      $li.html($new.html());
      $li.prop("hidden", !matches(e));
    });
    applyFilter();
    renderSummary();
    renderActions();
  }

  function schedule(id?: string | number): void {
    pending[id != null ? String(id) : "*"] = true;
    if (!timer) timer = setTimeout(flush, 250);
  }

  async function check(): Promise<void> {
    const $row = $('#downloads-list .course[course-id="' + openId + '"]');
    const id = openId;
    checking = true;
    renderActions();
    try {
      await checkCourse({ id: id!, title: $row.find(".coursename").text(), url: $row.attr("course-url") || "" }, (done, total) => {
        $("#course-notice").text(translate("Reading the course from Udemy") + "… " + done + "/" + total).prop("hidden", false);
      });
      if (openId == id) renderAll();
    } catch (err) {
      toast(prepError((err as { status?: unknown }).status), true);
      if (openId == id) renderAll();
    }
    checking = false;
    if (openId == id) renderActions();
  }

  $(document).on("click", "#course-actions [data-act]", function() {
    const act = $(this).attr("data-act");
    const $row = $('#downloads-list .course[course-id="' + openId + '"]');
    if (act == "pause") $row.find(".pause-btn").trigger("click");
    else if (act == "resume") $row.find(".resume-btn").trigger("click");
    else if (act == "cancel") $row.find(".cancel-btn").trigger("click");
    else if (act == "go") $row.find(".update-btn").trigger("click");
    else if (act == "check") check();
    else if (act == "folder") {
      const dir = store()?.dir;
      if (dir && fs.existsSync(dir)) shell.openPath(dir);
      else toast(translate("Folder not found"), true);
    } else if (act == "console") {
      setConsole(!consoleOpen);
      renderActions();
    }
  });

  $(document).on("click", "#console-close", () => {
    setConsole(false);
    renderActions();
  });

  $(document).on("click", "#console-clear", () => {
    if (openId) devlog.clear(openId);
    renderConsole();
  });

  devlog.devlogEvents.on("add", (entry) => {
    if (consoleOpen && entry.courseId == openId) renderConsole();
  });

  (function() {
    const savedHeight = parseInt(localStorage.getItem("cg-console-height") || "", 10);
    if (savedHeight) $("#course-console").css("height", Math.min(600, Math.max(120, savedHeight)) + "px");
    let dragging = false;
    let startY = 0;
    let startHeight = 0;
    $(document).on("mousedown", "#console-handle", (e) => {
      dragging = true;
      startY = e.clientY;
      startHeight = $("#course-console").height() || 0;
      $("body").css("user-select", "none");
      e.preventDefault();
    });
    $(document).on("mousemove", (e) => {
      if (!dragging) return;
      const h = Math.min(600, Math.max(120, startHeight - (e.clientY - startY)));
      $("#course-console").css("height", h + "px");
    });
    $(document).on("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      $("body").css("user-select", "");
      localStorage.setItem("cg-console-height", String($("#course-console").height()));
    });
  })();

  $(document).on("click", "#course-filters [data-filter]", function() {
    filter = ($(this).attr("data-filter") as Filter) || "all";
    renderSummary();
    applyFilter();
  });

  $(document).on("click", "#course-back", () => {
    showView("downloads");
  });

  return {
    open(id) {
      const $row = $('#downloads-list .course[course-id="' + id + '"]');
      openId = String(id);
      filter = "all";
      setConsole(false);
      if (!courseStore[openId]) {
        const dir = $row.attr("data-path") || courseDir($row.find(".coursename").text());
        storeFromManifest(openId, $row.find(".coursename").text(), dir);
      }
      renderAll();
      showView("course");
    },
    // the engine calls this whenever a lecture (or the whole course) changes
    touch(courseId, lectureId) {
      if (String(courseId) == openId && $("#view-course").hasClass("active")) schedule(lectureId);
    },
    headerChanged(courseId) {
      if (String(courseId) == openId && $("#view-course").hasClass("active")) {
        renderActions();
        renderSummary();
      }
    },
    // the "preparing" phase has no per-lecture data yet; show progress as plain text instead
    prepProgress(courseId, text) {
      if (String(courseId) == openId && $("#view-course").hasClass("active")) {
        $("#course-notice").text(text).prop("hidden", false);
      }
    },
    currentCourseId() {
      return openId;
    }
  };
}
