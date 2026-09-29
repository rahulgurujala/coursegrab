// UI helpers: translations, views, toasts, dialogs and the course/download row.
// Rows are driven by a data-state attribute (idle, preparing, downloading,
// paused, done, error); CSS decides what each state shows.
//
// Everything here now lives in src/view/ (typed, no hidden globals): the row template and Row
// component in courseRow.ts, everything else (view switching, toasts, the confirm dialog, the
// Downloads badge/summary) in shell.ts. This file combines both into the same `ui` object shape
// every other file already calls into, and keeps the click/keydown wiring that reaches into
// courseDetail/loadDownloads/saveDownloads (not yet real modules, and courseDetail specifically
// does not exist yet at this point in script load order) exactly where it was.

const courseRowModule = require("./dist/view/courseRow.js");
const esc = require("./dist/view/esc.js").esc;
const shellModule = require("./dist/view/shell.js");

courseRowModule.rowEvents.on("state-changed", function(courseId) {
  if (typeof courseDetail != "undefined") courseDetail.headerChanged(courseId);
  ui.refreshDownloads();
});
courseRowModule.rowEvents.on("progress", function() {
  if (!$("#app").prop("hidden")) saveDownloads(false);
});

// Named uiShell, not shell: app.js already declares `var shell = electron.shell` in the same
// shared classic-script scope (confirmed the hard way: `const shell` here crashed app.js's load
// with "Identifier 'shell' has already been declared", which cascaded into every function app.js
// defines being missing everywhere else, a genuinely confusing failure to debug from symptoms
// alone; caught immediately by actually launching the app, not by typecheck, since these are
// still plain .js files).
const uiShell = shellModule.createShell({
  translate: translate,
  appVersion: appVersion,
  settings: settings,
  loadDownloads: function() { loadDownloads(); },
  loadSettings: function() { loadSettings(); },
  saveDownloads: function(immediate) { saveDownloads(immediate); }
});

const ui = {
  applyTranslations: uiShell.applyTranslations,
  scroll: uiShell.scroll,
  showView: uiShell.showView,
  toast: uiShell.toast,
  confirm: uiShell.confirm,
  refreshDownloads: uiShell.refreshDownloads,

  courseRow(c, state) {
    return courseRowModule.courseRowHtml(c, state, translate);
  },
  skeleton: courseRowModule.skeletonHtml,
  Row: courseRowModule.Row,
  copyState: courseRowModule.copyState,
  formatSpeed: courseRowModule.formatSpeed
};

// ---------- wiring ----------
$(document).on("click", ".nav-item", function() {
  ui.showView($(this).data("view"));
});

$(document).on("click", "[data-goto]", function() {
  ui.showView($(this).data("goto"));
});

// A click on a course in Downloads (outside its buttons) opens the lecture list.
$(document).on("click", "#downloads-list .course", function(e) {
  if ($(e.target).closest("button, a").length) return;
  courseDetail.open($(this).attr("course-id"));
});

$(document).on("click", "#downloads-list .details-btn", function() {
  courseDetail.open($(this).closest(".course").attr("course-id"));
});

$(document).on("keydown", e => {
  if (document.querySelector("dialog[open]")) return;
  if (e.key == "Escape" && $("#view-course").hasClass("active")) {
    ui.showView("downloads");
    return;
  }
  if (e.target.matches("input, select, textarea")) {
    if (e.key == "Escape" && e.target.id == "search-input") {
      $("#search-clear").click();
    }
    return;
  }
  if (e.key == "/" && $("#app").is(":visible")) {
    e.preventDefault();
    ui.showView("courses");
    $("#search-input").focus();
  }
  if ((e.metaKey || e.ctrlKey) && /^[1-4]$/.test(e.key) && $("#app").is(":visible")) {
    e.preventDefault();
    ui.showView(["courses", "downloads", "settings", "about"][e.key - 1]);
  }
});

ui.applyTranslations();
