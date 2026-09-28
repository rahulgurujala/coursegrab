// Course detail view: every lecture of a course and what is happening to it.
// Reads courseStore (kept up to date by engine.js) and shows it grouped by chapter.

var courseDetail = (function() {
  var openId = null;
  var filter = "all";
  var timer = null;
  var pending = {};
  var checking = false;

  var FILTERS = ["all", "active", "changes", "skipped", "failed"];

  function store() {
    return courseStore[openId];
  }

  function entries() {
    var out = [];
    var st = store();
    if (st) st.chapters.forEach(function(c) { out = out.concat(c.lectures); });
    return out;
  }

  function formatSize(bytes) {
    if (bytes == null) return "";
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }

  function stateLabel(e) {
    return {
      queued: translate("Queued"),
      downloading: translate("Downloading"),
      done: translate("Done"),
      unchanged: translate("Unchanged"),
      skipped: translate("Skipped"),
      failed: translate("Failed"),
      outside: translate("Not in range"),
      saved: translate("Saved")
    }[e.state];
  }

  function badgeLabel(e) {
    return e.badge ? { new: translate("New"), updated: translate("Updated"), missing: translate("Missing") }[e.badge] : "";
  }

  function metaText(e) {
    switch (e.state) {
      case "downloading":
        return [e.pct + "%", e.note, e.speed ? ui.formatSpeed(e.speed) : ""].filter(Boolean).join(" · ");
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

  function lectureHtml(e) {
    var badge = badgeLabel(e);
    return (
      '<li class="lecture" data-lid="' + esc(e.id) + '" data-state="' + e.state + '"' + (e.badge ? ' data-badge="' + e.badge + '"' : "") + ">" +
      '<span class="lnum">' + esc(e.num) + "</span>" +
      '<span class="lbody"><span class="lname">' + esc(e.name) + '</span><span class="lmeta">' + esc(metaText(e)) + "</span></span>" +
      '<span class="lstatus">' + (badge ? '<span class="pill badge-' + e.badge + '">' + esc(badge) + "</span>" : "") +
      '<span class="pill state-' + e.state + '">' + esc(stateLabel(e)) + "</span></span>" +
      '<span class="lbar" aria-hidden="true"><span class="lfill" style="--p:' + (e.state == "downloading" ? e.pct / 100 : 0) + '"></span></span>' +
      "</li>"
    );
  }

  function matches(e) {
    switch (filter) {
      case "active": return e.state == "queued" || e.state == "downloading";
      case "changes": return !!e.badge;
      case "skipped": return e.state == "skipped";
      case "failed": return e.state == "failed";
      default: return true;
    }
  }

  function counts() {
    var c = { all: 0, active: 0, changes: 0, skipped: 0, failed: 0, done: 0, unchanged: 0 };
    entries().forEach(function(e) {
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

  function rowState() {
    return $('#downloads-list .course[course-id="' + openId + '"]').attr("data-state") || "idle";
  }

  function renderActions() {
    var state = rowState();
    var html = "";
    var btn = function(act, label, cls) {
      return '<button class="btn ' + (cls || "") + '" type="button" data-act="' + act + '">' + label + "</button>";
    };
    if (state == "downloading") html = btn("pause", translate("Pause")) + btn("cancel", translate("Cancel"), "ghost");
    else if (state == "paused") html = btn("resume", translate("Resume"), "primary") + btn("cancel", translate("Cancel"), "ghost");
    else if (state == "preparing") html = btn("cancel", translate("Cancel"), "ghost");
    else {
      var st = store();
      var changes = st && st.phase == "checked" ? counts().changes : 0;
      var label = state == "interrupted" ? translate("Resume") : state == "error" ? translate("Retry") : state == "idle" ? translate("Download") : changes ? translate("Download changes") : translate("Get updates");
      html =
        btn("folder", translate("Open folder")) +
        btn("check", checking ? '<span class="spinner"></span>' + translate("Checking") + "…" : translate("Check for changes")) +
        btn("go", label, "primary");
    }
    $("#course-actions").html(html);
    $("#course-actions [data-act=check]").prop("disabled", checking);
  }

  function renderSummary() {
    var st = store();
    var c = counts();
    var parts = [];
    if (c.all) parts.push(c.all + " " + translate("lectures"));
    if (c.done) parts.push(c.done + " " + translate("saved"));
    if (c.active) parts.push(c.active + " " + translate("waiting"));
    if (c.unchanged) parts.push(c.unchanged + " " + translate("unchanged"));
    if (c.skipped) parts.push(c.skipped + " " + translate("skipped"));
    if (c.failed) parts.push(c.failed + " " + translate("failed"));
    $("#course-summary").text(parts.join(" · "));

    var notice = "";
    var state = rowState();
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

    FILTERS.forEach(function(f) {
      var $chip = $('#course-filters [data-filter="' + f + '"]');
      $chip.find(".n").text(c[f]);
      $chip.prop("hidden", f != "all" && f != filter && !c[f]).attr("aria-pressed", f == filter);
    });
  }

  function applyFilter() {
    $("#course-lectures .lecture").each(function() {
      var e = store() && store().byId[$(this).attr("data-lid")];
      $(this).prop("hidden", !!e && !matches(e));
    });
    $("#course-lectures .chapter").each(function() {
      $(this).prop("hidden", !$(this).find(".lecture:not([hidden])").length);
    });
    $("#course-empty").prop("hidden", !!$("#course-lectures .lecture:not([hidden])").length || !entries().length);
  }

  function renderAll() {
    var st = store();
    $("#h-course").text(st ? st.title : "");
    renderActions();
    renderSummary();
    var html = "";
    if (st) {
      st.chapters.forEach(function(ch) {
        if (!ch.lectures.length) return;
        html += '<section class="chapter"><h2 class="chapter-title"><span>' + esc(ch.name) + '</span><span class="count">' + ch.lectures.length + '</span></h2><ul class="list lectures">' +
          ch.lectures.map(lectureHtml).join("") + "</ul></section>";
      });
    }
    $("#course-lectures").html(html);
    applyFilter();
  }

  function flush() {
    timer = null;
    if (!openId) return;
    var ids = Object.keys(pending);
    var all = pending["*"];
    pending = {};
    var st = store();
    if (!st) return;
    if (all || (st.chapters.length && !$("#course-lectures .lecture").length)) {
      renderAll();
      return;
    }
    ids.forEach(function(id) {
      var e = st.byId[id];
      var $li = $('#course-lectures .lecture[data-lid="' + id + '"]');
      if (!e || !$li.length) return;
      var $new = $(lectureHtml(e));
      $li.attr("data-state", e.state).attr("data-badge", e.badge || "");
      $li.html($new.html());
      $li.prop("hidden", !matches(e));
    });
    applyFilter();
    renderSummary();
    renderActions();
  }

  function schedule(id) {
    pending[id || "*"] = true;
    if (!timer) timer = setTimeout(flush, 250);
  }

  async function check() {
    var $row = $('#downloads-list .course[course-id="' + openId + '"]');
    var id = openId;
    checking = true;
    renderActions();
    try {
      await checkCourse(
        { id: id, title: $row.find(".coursename").text(), url: $row.attr("course-url") },
        function(done, total) { $("#course-notice").text(translate("Reading the course from Udemy") + "… " + done + "/" + total).prop("hidden", false); }
      );
      if (openId == id) renderAll();
    } catch (err) {
      ui.toast(prepError(err.status), true);
      if (openId == id) renderAll();
    }
    checking = false;
    if (openId == id) renderActions();
  }

  $(document).on("click", "#course-actions [data-act]", function() {
    var act = $(this).attr("data-act");
    var $row = $('#downloads-list .course[course-id="' + openId + '"]');
    if (act == "pause") $row.find(".pause-btn").click();
    else if (act == "resume") $row.find(".resume-btn").click();
    else if (act == "cancel") $row.find(".cancel-btn").click();
    else if (act == "go") $row.find(".update-btn").click();
    else if (act == "check") check();
    else if (act == "folder") {
      var dir = store() && store().dir;
      if (dir && fs.existsSync(dir)) shell.openPath(dir);
      else ui.toast(translate("Folder not found"), true);
    }
  });

  $(document).on("click", "#course-filters [data-filter]", function() {
    filter = $(this).attr("data-filter");
    renderSummary();
    applyFilter();
  });

  $(document).on("click", "#course-back", function() {
    ui.showView("downloads");
  });

  return {
    open: function(id) {
      var $row = $('#downloads-list .course[course-id="' + id + '"]');
      openId = String(id);
      filter = "all";
      if (!courseStore[openId]) {
        var dir = $row.attr("data-path") || courseDir($row.find(".coursename").text());
        storeFromManifest(openId, $row.find(".coursename").text(), dir);
      }
      renderAll();
      ui.showView("course");
    },
    // the engine calls this whenever a lecture (or the whole course) changes
    touch: function(courseId, lectureId) {
      if (String(courseId) == openId && $("#view-course").hasClass("active")) schedule(lectureId);
    },
    headerChanged: function(courseId) {
      if (String(courseId) == openId && $("#view-course").hasClass("active")) {
        renderActions();
        renderSummary();
      }
    }
  };
})();
