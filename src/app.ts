// The app shell: sign in, course list/search, download-button wiring, settings, the subtitle
// picker, logout. This is the direct TypeScript port of assets/js/app.js, kept as one file
// matching its role in the rewrite plan: the "glue" file wiring view <- store <- (api/download)
// together, loaded via <script src> in the same position app.js always was.
//
// translate/settings/appVersion/ui/courseStore/courseDetail/prepareCourse/initDownload/
// checkCourse/retryLecture/courseDir are still plain globals from files not ported yet (the
// inline bootstrap script, ui.js, engine.js, details.js); declared once in src/types/globals.d.ts
// rather than assumed ad hoc. fs/homedir and downloadControls/session/ensureDownloadRow are real
// imports: the former because they are simple, stateless requires this file happens to need too;
// the latter because they are genuinely shared mutable state with engine.js, which is why they
// moved out of this file into their own small modules (see the header comment in
// src/shared/session.ts for why session is an object with a property, not a bare export).

import $ from "jquery";
import { ipcRenderer, shell } from "electron";
import * as remote from "@electron/remote";
import { downloadControls } from "./shared/downloadControls";
import { session } from "./shared/session";
import { ensureDownloadRow } from "./view/courseRow";
import type { DownloadedCourseRecord, PrepareCourseData, UdemyCourseListItem, UdemyCourseListResponse } from "./shared/types";

// fs and homedir are NOT imported here: they are true classic-script globals from index.html's
// inline bootstrap script (see the comment there), and importing them again would compile to a
// second top-level `var fs`/`const homedir` in this same script scope, a SyntaxError (the same
// class of bug the ui.js `shell` collision was, caught then by launching the app, caught here by
// the same discipline before it shipped). fs/homedir are declared ambient in types/globals.d.ts.
const dialog = remote.dialog;
const BrowserWindow = remote.BrowserWindow;

const $subDomain = $("#subdomain");

let headers: Record<string, string> = {};

ipcRenderer.on("saveDownloads", () => {
  saveDownloads(true);
});

// ---------- shared helpers ----------
$(document).on("click", 'a[href^="http"]', function(e) {
  e.preventDefault();
  shell.openExternal((this as HTMLAnchorElement).href);
});

function showLoginError(message: string): void {
  $("#login-error").text(message).prop("hidden", false);
  ($("#login-error")[0] as HTMLElement).scrollIntoView({ block: "nearest" });
}

function hideLoginError(): void {
  $("#login-error").prop("hidden", true);
}

// ---------- sign in ----------
$("#business").on("change", function() {
  $("#business-field").prop("hidden", !(this as HTMLInputElement).checked);
  if ((this as HTMLInputElement).checked) $subDomain.trigger("focus");
});

$("#method-token").on("click", function() {
  const open = $("#token-panel").prop("hidden");
  $("#token-panel").prop("hidden", !open);
  this.setAttribute("aria-expanded", String(open));
  if (open) $("#token").trigger("focus");
});

$("#token-cancel").on("click", () => {
  $("#token-panel").prop("hidden", true);
  $("#token-error").prop("hidden", true);
  $("#token").val("");
  $("#method-token").attr("aria-expanded", "false");
});

$subDomain.on("keydown", (e) => {
  if (e.key == "Enter") loginWithUdemy();
});

$("#token").on("keydown", (e) => {
  if (e.key == "Enter") loginWithAccessToken();
});
$("#token-submit").on("click", loginWithAccessToken);
$("#login-udemy").on("click", loginWithUdemy);

// Returns the Udemy Business name, "" for personal accounts, or false if it is required but missing.
function businessName(): string | false {
  if (!$("#business").is(":checked")) return "";
  const name = String($subDomain.val() || "").trim();
  if (!name) {
    showLoginError(translate("Type Business Name"));
    $subDomain.trigger("focus");
    return false;
  }
  return name;
}

interface TokenResult {
  ok: boolean;
  status?: number;
}

// A token only counts once Udemy accepts it; this also filters out anonymous visitor tokens.
function verifyToken(token: string, sub: string): Promise<TokenResult> {
  return new Promise((resolve) => {
    $.ajax({
      type: "GET",
      url: `https://${sub}.udemy.com/api-2.0/users/me/subscribed-courses?page_size=1`,
      headers: { Authorization: `Bearer ${token}` },
      success: () => resolve({ ok: true }),
      error: (xhr) => resolve({ ok: false, status: xhr.status })
    });
  });
}

function completeLogin(token: string, sub: string): void {
  settings.set("access_token", token);
  settings.set("subdomain", sub);
  checkLogin();
}

function tokenErrorText(status: number | undefined): string {
  return status == 401 || status == 403
    ? translate("Udemy rejected this token. Copy a fresh access_token cookie while you are signed in, then try again.")
    : translate("Could not reach Udemy. Check your connection and try again.");
}

// Udemy's website no longer sends an Authorization header, so the sign-in window is watched for the
// access_token cookie instead. Each new cookie value is verified before it is accepted.
function loginWithUdemy(): void {
  hideLoginError();
  const business = businessName();
  if (business === false) return;
  const sub = business || "www";
  const ses = remote.session.defaultSession;
  const parent = remote.getCurrentWindow();
  const dimensions = parent.getSize();
  const loginWindow = new BrowserWindow({
    width: dimensions[0]! - 100,
    height: dimensions[1]! - 100,
    parent,
    modal: true
  });
  let finished = false;
  const rejected: Record<string, boolean> = {};
  let timer: ReturnType<typeof setInterval> | null = null;

  function stop(): void {
    finished = true;
    if (timer) clearInterval(timer);
  }

  loginWindow.on("closed", stop);

  async function check(): Promise<void> {
    if (finished) return;
    const cookies = await ses.cookies.get({ name: "access_token" });
    for (const c of cookies) {
      if (finished) return;
      const domain = (c.domain || "").replace(/^\./, "");
      if (!c.value || rejected[c.value] || !domain.endsWith("udemy.com")) continue;
      rejected[c.value] = true;
      const result = await verifyToken(c.value, sub);
      if (finished) return;
      if (result.ok) {
        stop();
        if (!loginWindow.isDestroyed()) loginWindow.destroy();
        await ses.clearStorageData({ storages: ["cookies"] });
        completeLogin(c.value, sub);
        return;
      }
      // a network hiccup should not blacklist a good token
      if (result.status != 401 && result.status != 403) delete rejected[c.value];
    }
  }

  // start from a clean session so the sign-in form is shown, then watch for the cookie
  ses
    .clearStorageData({ storages: ["cookies"] })
    .then(() => {
      timer = setInterval(check, 1000);
      return loginWindow.loadURL(business ? `https://${business}.udemy.com` : "https://www.udemy.com/join/login-popup");
    })
    .catch(() => {});
}

function setTokenBusy(busy: boolean): void {
  $("#token-submit").prop("disabled", busy);
  $("#token-submit .spinner").remove();
  if (busy) $("#token-submit").prepend('<span class="spinner"></span>');
}

function loginWithAccessToken(): void {
  hideLoginError();
  $("#token-error").prop("hidden", true);
  const business = businessName();
  if (business === false) return;
  const token = String($("#token").val() || "")
    .trim()
    .replace(/^bearer\s+/i, "")
    .replace(/^["']|["']$/g, "");
  if (!token) {
    $("#token").trigger("focus");
    return;
  }
  const sub = business || "www";
  setTokenBusy(true);
  verifyToken(token, sub).then((result) => {
    setTokenBusy(false);
    if (result.ok) {
      $("#token").val("");
      $("#token-panel").prop("hidden", true);
      $("#method-token").attr("aria-expanded", "false");
      completeLogin(token, sub);
    } else {
      $("#token-error").text(tokenErrorText(result.status)).prop("hidden", false);
      $("#token").trigger("focus");
    }
  });
}

function showApp(): void {
  $("#login").prop("hidden", true);
  $("#app").prop("hidden", false);
  $("#account-name").text(session.subDomain + ".udemy.com");
}

function resetToLogin(message?: string): void {
  $("#courses-list, #downloads-list").empty();
  $("#load-more, #courses-empty").prop("hidden", true);
  ui.refreshDownloads();
  ui.showView("courses");
  $("#search-input").val("");
  $("#search-clear").prop("hidden", true);
  $("#app").prop("hidden", true);
  $("#login").prop("hidden", false);
  if (message) showLoginError(message);
}

function checkLogin(): void {
  if (settings.get("access_token")) {
    session.subDomain = (settings.get("subdomain") as string) || "www";
    headers = { Authorization: `Bearer ${settings.get("access_token")}` };
    showApp();
    loadDownloads();
    loadCourses();
  }
}

// ---------- courses ----------
function loadCourses(): void {
  $.ajax({
    type: "GET",
    url: `https://${session.subDomain}.udemy.com/api-2.0/users/me/subscribed-courses?page_size=50`,
    beforeSend: showSkeleton,
    headers,
    success: (response: UdemyCourseListResponse) => handleResponse(response),
    error: courseListError
  });
}

// 401/403 means the session is gone; anything else is shown in place with a Retry.
function courseListError(response: JQuery.jqXHR): void {
  if (response.status == 401 || response.status == 403) {
    settings.set("access_token", false);
    resetToLogin(translate("Your session expired. Sign in again."));
    return;
  }
  $("#courses-list").empty();
  $("#courses-empty, #load-more").prop("hidden", true);
  $("#courses-error").prop("hidden", false);
}

$("#courses-retry").on("click", () => {
  const keyword = String($("#search-input").val() || "").trim();
  keyword ? $("#search-form").trigger("submit") : loadCourses();
});

function showSkeleton(): void {
  $("#courses-empty, #courses-error, #load-more").prop("hidden", true);
  $("#courses-list").html(ui.skeleton(6));
}

function addCourses(results: UdemyCourseListItem[]): void {
  results.forEach((course) => {
    const $row = $(
      ui.courseRow({
        id: course.id,
        url: course.url,
        title: course.title,
        ...(course.image_240x135 !== undefined ? { image: course.image_240x135 } : {})
      })
    );
    // A course that is already downloading shows its live state in this list too.
    const $existing = $('#downloads-list .course[course-id="' + course.id + '"]');
    if ($existing.length) ui.copyState($existing, $row);
    $("#courses-list").append($row);
  });
}

function handleResponse(response: UdemyCourseListResponse): void {
  $("#courses-list").empty();
  addCourses(response.results);
  $("#courses-empty").prop("hidden", !!response.results.length);
  $("#load-more")
    .prop("hidden", !response.next)
    .data("url", response.next || "");
}

$("#load-more-btn").on("click", function() {
  const $btn = $(this);
  const url = $("#load-more").data("url") as string;
  if (!url) return;
  $btn.prop("disabled", true).prepend('<span class="spinner"></span>');
  $.ajax({
    type: "GET",
    url,
    headers,
    success: (response: UdemyCourseListResponse) => {
      addCourses(response.results);
      $("#load-more")
        .prop("hidden", !response.next)
        .data("url", response.next || "");
    },
    complete: () => {
      $btn.prop("disabled", false).find(".spinner").remove();
    }
  });
});

function validURL(value: string): boolean {
  const expression = /[-a-zA-Z0-9@:%_\+.~#?&//=]{2,256}\.[a-z]{2,4}\b(\/[-a-zA-Z0-9@:%_\+.~#?&//=]*)?/gi;
  return new RegExp(expression).test(value);
}

function noCourses(): void {
  $("#courses-list").empty();
  $("#courses-error").prop("hidden", true);
  $("#load-more").prop("hidden", true);
  $("#courses-empty").prop("hidden", false);
}

function search(keyword: string, hdrs: Record<string, string>): void {
  $.ajax({
    type: "GET",
    url: `https://${session.subDomain}.udemy.com/api-2.0/users/me/subscribed-courses?page_size=50&page=1&fields[user]=job_title&search=${encodeURIComponent(keyword)}`,
    beforeSend: showSkeleton,
    headers: hdrs,
    success: (response: UdemyCourseListResponse) => handleResponse(response),
    error: courseListError
  });
}

$("#search-input").on("input", function() {
  $("#search-clear").prop("hidden", !(this as HTMLInputElement).value);
});

$("#search-clear").on("click", () => {
  $("#search-input").val("").trigger("focus");
  $("#search-clear").prop("hidden", true);
  loadCourses();
});

$("#search-form").on("submit", (e) => {
  e.preventDefault();
  let keyword = String($("#search-input").val() || "").trim();
  if (!keyword) {
    loadCourses();
    return;
  }
  if (validURL(keyword)) {
    if (keyword.search(new RegExp("^(http|https)"))) {
      keyword = "http://" + keyword;
    }
    $.ajax({
      type: "GET",
      url: keyword,
      beforeSend: showSkeleton,
      headers,
      success: (response: string) => {
        const title = $(".main-content h1.clp-lead__title", response).text().trim();
        if (title) {
          search(title, headers);
        } else {
          noCourses();
        }
      },
      error: noCourses
    });
  } else {
    search(keyword, headers);
  }
});

$("#courses-list, #downloads-list").on("click", ".open-in-browser", function() {
  shell.openExternal(`https://${session.subDomain}.udemy.com${$(this).closest(".course").attr("course-url")}`);
});

// ---------- download controls ----------
function controlFor(button: HTMLElement) {
  return downloadControls[$(button).closest(".course").attr("course-id") || ""];
}

$("#downloads-list").on("click", ".pause-btn", function() {
  controlFor(this)?.pause();
});
$("#downloads-list").on("click", ".resume-btn", function() {
  controlFor(this)?.resume();
});
$("#downloads-list").on("click", ".cancel-btn", function() {
  controlFor(this)?.cancel();
});

$("#app").on("click", ".folder-btn", function() {
  const dir = $(this).closest(".course").attr("data-path");
  if (!dir || !fs.existsSync(dir)) {
    ui.toast(translate("Folder not found"), true);
    return;
  }
  shell.openPath(dir);
});

$("#downloads-list").on("click", ".remove-btn", function() {
  const id = $(this).closest(".course").attr("course-id");
  $('#downloads-list .course[course-id="' + id + '"]').remove();
  const $mine = $('#courses-list .course[course-id="' + id + '"]');
  ui.Row.state($mine, "idle");
  ui.Row.text($mine, "");
  ui.refreshDownloads();
});

$("#clear-finished").on("click", () => {
  $('#downloads-list .course[data-state="done"]').each(function() {
    const id = $(this).attr("course-id");
    const $mine = $('#courses-list .course[course-id="' + id + '"]');
    ui.Row.state($mine, "idle");
    ui.Row.text($mine, "");
    $(this).remove();
  });
  ui.refreshDownloads();
});

// ---------- persistence of the Downloads list ----------
function saveDownloads(quit: boolean): void {
  const downloadedCourses: DownloadedCourseRecord[] = [];
  $("#downloads-list > .course")
    .slice(0, 100)
    .each((_index, elem) => {
      const $elem = $(elem);
      const state = $elem.attr("data-state") || "idle";
      const interrupted = ["preparing", "downloading", "paused", "interrupted"].includes(state);
      const image = $elem.find(".thumb").attr("src");
      downloadedCourses.push({
        id: $elem.attr("course-id") || "",
        url: $elem.attr("course-url") || "",
        title: $elem.find(".coursename").text(),
        ...(image !== undefined ? { image } : {}),
        state: interrupted ? "interrupted" : state,
        pct: parseInt($elem.attr("data-pct") || "0", 10) || 0,
        text: interrupted ? translate("Interrupted when the app was closed. Press Resume to continue where it stopped.") : $elem.find(".status-text").text(),
        path: $elem.attr("data-path") || ""
      });
    });
  settings.set("downloadedCourses", downloadedCourses);
  if (quit) {
    ipcRenderer.send("quitApp");
  }
}

function loadDownloads(): void {
  if ($("#downloads-list > .course").length) return;
  const saved = settings.get("downloadedCourses") as DownloadedCourseRecord[] | undefined;
  if (!saved) return;
  saved.forEach((course) => {
    const $row = $(
      ui.courseRow(
        { id: course.id, url: course.url, title: course.title, ...(course.image !== undefined ? { image: course.image } : {}) },
        (course.state as never) || "idle"
      )
    );
    if (course.text) ui.Row.text($row, course.text);
    if (course.path) $row.attr("data-path", course.path);
    if (course.state == "done") ui.Row.progress($row, 1, 1);
    else if (course.state == "interrupted") ui.Row.progress($row, course.pct || 0, 100);
    $("#downloads-list").append($row);
  });
  ui.refreshDownloads();
}

// Course preparation problems, in plain words.
function prepError(status: unknown): string {
  if (status == 403 || status == 401) return translate("You do not have permission to access this course");
  if (status == 404) return translate("This course is not available for download. It may be a draft or it may have been removed.");
  if (status == "empty") return translate("This course has no lectures.");
  return translate("Could not load this course. Check your connection and retry.");
}

// Download, Resume, Retry and Check for updates all start the same flow. The engine works out
// what is new or changed by comparing the course with what an earlier download saved.
$("#app").on("click", ".download-btn, .retry-btn, .update-btn", async function(e) {
  e.stopImmediatePropagation();
  const $course = $(this).closest(".course");
  const courseid = $course.attr("course-id") || "";
  if (downloadControls[courseid]) return; // already preparing or downloading
  // a course in the error state is retrying (finish what failed), not checking for updates,
  // whichever of the three buttons actually triggered it
  const isRetry = $course.attr("data-state") == "error";
  ensureDownloadRow($course);
  const $all = $('.course[course-id="' + courseid + '"]');
  const prep = { cancelled: false, failed: false };
  downloadControls[courseid] = {
    pause() {},
    resume() {},
    cancel() {
      prep.cancelled = true;
      delete downloadControls[courseid];
      ui.Row.state($all, "idle");
      ui.Row.text($all, translate("Canceled"));
    }
  };
  ui.Row.state($all, "preparing");
  ui.Row.text($all, translate("Preparing course") + "…");
  ui.Row.progress($all, 0, 0);
  try {
    const data = await prepareCourse(
      { id: courseid, title: $course.find(".coursename").text(), url: $course.attr("course-url") || "" },
      prep,
      (done, total) => {
        const text = translate("Preparing course") + "… " + done + "/" + total;
        ui.Row.text($all, text);
        if (typeof courseDetail != "undefined") courseDetail.prepProgress(courseid, text);
      },
      isRetry
    );
    if (!data || prep.cancelled) return;
    if (Object.keys(data.subs).length) {
      askforSubtile(data.subs, initDownload, $course, data);
    } else {
      initDownload($course, data);
    }
  } catch (err) {
    if (prep.cancelled) return;
    delete downloadControls[courseid];
    ui.Row.state($all, "error");
    ui.Row.text($all, prepError((err as { status?: unknown }).status));
  }
});

// After a course finishes with some lectures failed, "done"/"total"/"failed" is recomputed
// from courseStore and reflected on the row: this is what lets a single retried lecture flip
// the whole course row back to Completed once nothing is left failing.
function refreshCourseRowFromStore(courseId: string): void {
  const store = courseStore[courseId];
  if (!store) return;
  let entries: { state: string }[] = [];
  store.chapters.forEach((c) => {
    entries = entries.concat(c.lectures);
  });
  const failed = entries.filter((e) => e.state == "failed").length;
  const done = entries.filter((e) => e.state == "done" || e.state == "saved" || e.state == "unchanged").length;
  const total = entries.length;
  const $row = $('.course[course-id="' + courseId + '"]');
  if (!$row.length || $row.attr("data-state") == "downloading" || $row.attr("data-state") == "paused") return;
  if (!failed) {
    ui.Row.state($row, "done");
    ui.Row.text($row, translate("Completed"));
    ui.Row.progress($row, total, total);
  } else {
    ui.Row.state($row, "error");
    ui.Row.text($row, translate("Downloaded") + " " + done + "/" + total + " · " + failed + " " + translate(failed == 1 ? "lecture failed" : "lectures failed"));
  }
}

$(document).on("click", ".lretry", async function(e) {
  e.stopPropagation();
  const $btn = $(this).prop("disabled", true);
  const courseId = courseDetail.currentCourseId();
  const lectureId = $(this).closest(".lecture").attr("data-lid");
  if (!courseId || !lectureId) {
    $btn.prop("disabled", false);
    return;
  }
  const ok = await retryLecture(courseId, lectureId);
  $btn.prop("disabled", false);
  if (ok) refreshCourseRowFromStore(courseId);
  else ui.toast(translate("That lecture could not be downloaded. Check your connection and try again."), true);
});

// ---------- logout ----------
$("#logout").on("click", () => {
  const busy = $('#downloads-list .course[data-state="downloading"], #downloads-list .course[data-state="paused"], #downloads-list .course[data-state="preparing"]').length;
  ui.confirm(translate("Confirm Log Out?"), busy ? translate("Downloads in progress will be stopped.") : "", translate("Logout"), (ok) => {
    if (!ok) return;
    $("#downloads-list .cancel-btn").trigger("click");
    saveDownloads(false);
    settings.set("access_token", false);
    resetToLogin();
  });
});

// ---------- settings ----------
function loadDefaults(): void {
  settings.set("download", {
    enableDownloadStartEnd: false,
    skipAttachments: false,
    skipSubtitles: false,
    autoRetry: false,
    downloadStart: false,
    downloadEnd: false,
    videoQuality: false,
    path: false
  });

  settings.set("general", {
    language: false
  });
}

if (!settings.get("general")) {
  loadDefaults();
}

let languagesLoaded = false;

function loadSettings(): void {
  const s = settings.getAll();
  if (!languagesLoaded) {
    languagesLoaded = true;
    $.getJSON("locale/meta.json", (data: Record<string, string>) => {
      Object.keys(data).forEach((name) => {
        $("#set-language").append($("<option>").val(name).text(name));
      });
      $("#set-language").val(s.general?.language || "");
    });
  }
  $("#set-path-text").text(s.download?.path || homedir + "/Downloads");
  $("#set-quality").val(s.download?.videoQuality || "");
  $("#set-subs").prop("checked", !s.download?.skipSubtitles);
  $("#set-attachments").prop("checked", !s.download?.skipAttachments);
  $("#set-range").prop("checked", !!s.download?.enableDownloadStartEnd);
  $("#range-fields").prop("hidden", !s.download?.enableDownloadStartEnd);
  $("#set-start").val(s.download?.downloadStart || "");
  $("#set-end").val(s.download?.downloadEnd || "");
  $("#set-retry").prop("checked", !!s.download?.autoRetry);
  $("#set-language").val(s.general?.language || "");
}

function saveSettings(message?: string): void {
  const range = $("#set-range").is(":checked");
  settings.set("download", {
    enableDownloadStartEnd: range,
    skipAttachments: !$("#set-attachments").is(":checked"),
    skipSubtitles: !$("#set-subs").is(":checked"),
    autoRetry: $("#set-retry").is(":checked"),
    downloadStart: parseInt(String($("#set-start").val())) || false,
    downloadEnd: parseInt(String($("#set-end").val())) || false,
    videoQuality: $("#set-quality").val() || false,
    path: $("#set-path-text").data("path") || settings.get("download.path") || false
  });
  settings.set("general", {
    language: $("#set-language").val() || false
  });
  ui.toast(message || translate("Settings Saved"));
}

$("#view-settings").on("change", "select, input", function() {
  if (this.id == "set-range") $("#range-fields").prop("hidden", !(this as HTMLInputElement).checked);
  saveSettings(this.id == "set-language" ? translate("Language changes apply the next time the app starts.") : "");
});

$("#set-choose").on("click", () => {
  const chosen = dialog.showOpenDialogSync({ properties: ["openDirectory"] });
  const dir = chosen?.[0];
  if (dir) {
    fs.access(dir, fs.constants.R_OK | fs.constants.W_OK, (err) => {
      if (err) {
        ui.toast(translate("Cannot select this folder"), true);
      } else {
        $("#set-path-text").text(dir).data("path", dir);
        saveSettings();
      }
    });
  }
});

// Update checking and the About page's status line live in updater.js.

// ---------- subtitle picker ----------
// One shared dialog; requests from several courses wait their turn.
interface SubtitleRequest {
  subs: Record<string, number>;
  start: (course: JQuery, data: PrepareCourseData, subtitle?: string | false) => void;
  $course: JQuery;
  coursedata: PrepareCourseData;
}

const subtitleQueue: SubtitleRequest[] = [];

function askforSubtile(availableSubs: Record<string, number>, start: SubtitleRequest["start"], $course: JQuery, coursedata: PrepareCourseData): void {
  if (coursedata.prep && coursedata.prep.cancelled) return;
  subtitleQueue.push({ subs: availableSubs, start, $course, coursedata });
  if (!(document.getElementById("dlg-subtitle") as HTMLDialogElement).open) nextSubtitleRequest();
}

function nextSubtitleRequest(): void {
  const req = subtitleQueue.shift();
  if (!req) return;
  const dlg = document.getElementById("dlg-subtitle") as HTMLDialogElement;
  const id = req.$course.attr("course-id");
  const $select = $("#subtitle-select").empty();
  for (const key in req.subs) {
    $select.append($("<option>").val(key).text(`${key} (${req.subs[key]} ${translate("Lectures")})`));
  }
  if (req.subs["English"]) $select.val("English");
  $("#dlg-subtitle-title").text(translate("Select Subtitle") + " · " + req.$course.find(".coursename").text());
  dlg.returnValue = "";
  dlg.onclose = () => {
    if (dlg.returnValue == "ok") {
      req.start(req.$course, req.coursedata, $select.val() as string);
    } else {
      const $all = $('.course[course-id="' + id + '"]');
      delete downloadControls[id || ""];
      ui.Row.state($all, "idle");
      ui.Row.text($all, "");
    }
    nextSubtitleRequest();
  };
  dlg.showModal();
}

checkLogin();

// ui.js and details.js still reference these four functions as bare globals, exactly as they
// always could when app.js was a classic script itself. This file is now require()'d rather than
// loaded via <script src> (so its own internal requires resolve correctly against its own
// location, see index.html), which means its top-level declarations no longer leak to window on
// their own; the specific ones still consumed elsewhere are made global explicitly, once, here,
// the same sanctioned exception documented in src/types/globals.d.ts.
Object.assign(globalThis, { prepError, saveDownloads, loadDownloads, loadSettings });
