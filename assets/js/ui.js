// UI helpers: translations, views, toasts, dialogs and the course/download row.
// Rows are driven by a data-state attribute (idle, preparing, downloading,
// paused, done, error); CSS decides what each state shows.

const esc = s =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

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
      const on = $(this).data("view") == name;
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
  courseRow(c, state) {
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
    <button class="btn ghost icon-only remove-btn" type="button" data-show="idle interrupted done error" data-only="downloads" title="${translate("Remove from list")}" aria-label="${translate("Remove from list")}"><svg class="icon"><use href="#i-trash"/></svg></button>
  </div>
</li>`;
  },

  skeleton(n) {
    return Array(n)
      .fill('<li class="skeleton" aria-hidden="true"><i></i><i></i><i></i></li>')
      .join("");
  },

  // All rows of one course (Courses list copy and Downloads list copy) are
  // updated together, so a Row call takes the whole jQuery set.
  Row: {
    state($c, state) {
      $c.attr("data-state", state);
      if (state == "preparing") $c.find(".meter").removeAttr("aria-valuenow");
      ui.refreshDownloads();
    },
    text($c, text) {
      $c.find(".status-text").text(text || "");
      $c.find(".meter").attr("aria-valuetext", text || "");
    },
    now($c, text) {
      $c.find(".now-line").text(text || "");
    },
    progress($c, done, total) {
      const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
      $c.attr("data-pct", pct);
      $c.find(".meter-fill").css("--p", pct / 100);
      $c.find(".meter-pct").text(pct + "%");
      $c.find(".meter").attr("aria-valuenow", pct);
      // save the list now and then while downloading, so a crash keeps an accurate percentage
      if (Date.now() - (ui.lastSave || 0) > 5000 && !$("#app").prop("hidden")) {
        ui.lastSave = Date.now();
        saveDownloads(false);
      }
    }
  },

  // Copy a running download's visible state onto a freshly built row of the same course.
  copyState($from, $to) {
    $to.attr({
      "data-state": $from.attr("data-state"),
      "data-pct": $from.attr("data-pct"),
      "data-path": $from.attr("data-path") || ""
    });
    ui.Row.text($to, $from.find(".status-text").text());
    ui.Row.now($to, $from.find(".now-line").text());
    ui.Row.progress($to, +$from.attr("data-pct") || 0, 100);
  },

  formatSpeed(kbps) {
    return kbps >= 1024
      ? (kbps / 1024).toFixed(1) + " MB/s"
      : kbps + " KB/s";
  },

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

$(document).on("keydown", e => {
  if (document.querySelector("dialog[open]")) return;
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
