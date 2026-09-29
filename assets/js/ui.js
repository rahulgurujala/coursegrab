// UI helpers: translations, views, toasts, dialogs and the course/download row.
// Rows are driven by a data-state attribute (idle, preparing, downloading,
// paused, done, error); CSS decides what each state shows.
//
// The row template, the Row component, and esc() itself now live in src/view/ (typed, no hidden
// globals). Row's old inline calls into courseDetail/ui.refreshDownloads/saveDownloads are events
// there; subscribed to right below, reproducing the exact same behavior in the exact same place.

const courseRowModule = require("./dist/view/courseRow.js");
const esc = require("./dist/view/esc.js").esc;

courseRowModule.rowEvents.on("state-changed", function(courseId) {
  if (typeof courseDetail != "undefined") courseDetail.headerChanged(courseId);
  ui.refreshDownloads();
});
courseRowModule.rowEvents.on("progress", function() {
  if (!$("#app").prop("hidden")) saveDownloads(false);
});

const ui = {
  // ---------- i18n ----------
  applyTranslations() {
    const lang = settings.get("general.language");
    if (lang && lang != "English") {
      $("[data-i18n]").each(function() {
        this.textContent = translate(this.textContent.trim());
      });
      $("[data-i18n-placeholder]").each(function() {
        this.placeholder = translate(this.getAttribute("data-i18n-placeholder"));
      });
      $("button[title], .nav-item[title]").each(function() {
        this.title = translate(this.title);
      });
      $("[data-i18n-aria]").each(function() {
        this.setAttribute("aria-label", translate(this.getAttribute("data-i18n-aria")));
      });
      try {
        const file = require("./locale/meta.json")[lang] || "";
        document.documentElement.lang = file.split(".")[0].split("_")[0];
        if (["ar.json", "fa.json"].includes(file)) {
          document.documentElement.dir = "rtl";
        }
      } catch (e) {}
    }
    $("#app-version").text(appVersion);
  },

  // ---------- views ----------
  scroll: {},
  showView(name) {
    const from = $(".view.active").attr("id");
    if (from) ui.scroll[from] = $("#main").scrollTop();
    $(".view").removeClass("active");
    $("#view-" + name).addClass("active");
    $(".nav-item").each(function() {
      const on = $(this).data("view") == (name == "course" ? "downloads" : name);
      on
        ? this.setAttribute("aria-current", "page")
        : this.removeAttribute("aria-current");
    });
    $("#main").scrollTop(ui.scroll["view-" + name] || 0);
    if (name == "downloads") loadDownloads();
    if (name == "settings") loadSettings();
  },

  // ---------- toasts & dialogs ----------
  toast(message, error) {
    $("#toasts").empty();
    const $t = $(
      `<div class="toast${error ? " error" : ""}"${error ? ' role="alert"' : ""}>${esc(message)}</div>`
    ).appendTo("#toasts");
    setTimeout(() => $t.fadeOut(200, () => $t.remove()), error ? 6000 : 2600);
  },

  confirm(title, text, okLabel, cb) {
    const dlg = document.getElementById("dlg-confirm");
    $("#dlg-confirm-title").text(title);
    $("#dlg-confirm-text").text(text || "").toggle(!!text);
    $("#dlg-confirm-ok").text(okLabel);
    dlg.returnValue = "";
    dlg.onclose = () => cb(dlg.returnValue == "ok");
    dlg.showModal();
  },

  // ---------- rows ----------
  // Template, Row component, copyState, formatSpeed, skeleton: src/view/courseRow.ts now.
  courseRow(c, state) {
    return courseRowModule.courseRowHtml(c, state, translate);
  },
  skeleton: courseRowModule.skeletonHtml,
  Row: courseRowModule.Row,
  copyState: courseRowModule.copyState,
  formatSpeed: courseRowModule.formatSpeed,

  // Badge, summary line, empty state and "clear finished" for the Downloads view.
  refreshDownloads() {
    const $rows = $("#downloads-list > .course");
    const count = s => $rows.filter(`[data-state="${s}"]`).length;
    const active =
      count("downloading") + count("paused") + count("preparing");
    const failed = count("error");
    const done = count("done");
    const interrupted = count("interrupted");
    const $badge = $("#downloads-badge");
    if (active || failed) {
      $badge
        .text(active || failed)
        .toggleClass("alert", !active && !!failed)
        .prop("hidden", false);
    } else {
      $badge.prop("hidden", true);
    }
    const parts = [];
    if (active) parts.push(`<bdi>${active}</bdi> ${esc(translate("active"))}`);
    if (done) parts.push(`<bdi>${done}</bdi> ${esc(translate("completed"))}`);
    if (failed) parts.push(`<bdi>${failed}</bdi> ${esc(translate("failed"))}`);
    if (interrupted) parts.push(`<bdi>${interrupted}</bdi> ${esc(translate("interrupted"))}`);
    $("#downloads-summary").html(parts.join(" · "));
    $('.nav-item[data-view="downloads"]').attr(
      "aria-label",
      translate("Downloads") +
        (active ? `, ${active} ${translate("active")}` : failed ? `, ${failed} ${translate("failed")}` : "")
    );
    $("#downloads-empty").prop("hidden", !!$rows.length);
    $("#clear-finished").prop("hidden", !done);
    // keep the list on disk, so an unexpected quit still leaves resumable rows behind
    clearTimeout(ui.saveTimer);
    ui.saveTimer = setTimeout(function() {
      if (!$("#app").prop("hidden")) saveDownloads(false);
    }, 1500);
  }
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
