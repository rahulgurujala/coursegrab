const electron = require("electron");
const remote = require("@electron/remote");
const dialog = remote.dialog;
const BrowserWindow = remote.BrowserWindow;
const fs = require("fs");
const homedir = require("os").homedir();
const sanitize = require("sanitize-filename");
const vtt2srt = require("node-vtt-to-srt");
// Our own multi-connection downloader (assets/js/rangeDownloader.js), not mt-files-downloader:
// that library could report a lecture as failed *after* it had already finished writing the
// complete file to disk in the background (see the comment at the top of rangeDownloader.js).
var Downloader = require("./assets/js/rangeDownloader.js");
var shell = electron.shell;
var https = require("https");

const $subDomain = $("#subdomain");

var headers = {};
var downloadControls = {}; // course id -> { pause, resume, cancel } of the running download

// The Downloads list always holds a row for a course that is preparing or downloading.
function ensureDownloadRow($course) {
  var id = $course.attr("course-id");
  if (!$('#downloads-list .course[course-id="' + id + '"]').length) {
    $("#downloads-list").prepend($course.clone());
  }
}
var subDomain = settings.get("subdomain") || "www";

electron.ipcRenderer.on("saveDownloads", function() {
  saveDownloads(true);
});

// ---------- shared helpers ----------
$(document).on("click", 'a[href^="http"]', function(e) {
  e.preventDefault();
  shell.openExternal(this.href);
});

function showLoginError(message) {
  $("#login-error").text(message).prop("hidden", false);
  $("#login-error")[0].scrollIntoView({ block: "nearest" });
}

function hideLoginError() {
  $("#login-error").prop("hidden", true);
}

// ---------- sign in ----------
$("#business").change(function() {
  $("#business-field").prop("hidden", !this.checked);
  if (this.checked) $subDomain.focus();
});

$("#method-token").click(function() {
  var open = $("#token-panel").prop("hidden");
  $("#token-panel").prop("hidden", !open);
  this.setAttribute("aria-expanded", open);
  if (open) $("#token").focus();
});

$("#token-cancel").click(function() {
  $("#token-panel").prop("hidden", true);
  $("#token-error").prop("hidden", true);
  $("#token").val("");
  $("#method-token").attr("aria-expanded", false);
});

$subDomain.keydown(function(e) {
  if (e.key == "Enter") loginWithUdemy();
});

$("#token").keydown(function(e) {
  if (e.key == "Enter") loginWithAccessToken();
});
$("#token-submit").click(loginWithAccessToken);
$("#login-udemy").click(loginWithUdemy);

// Returns the Udemy Business name, "" for personal accounts, or false if it is required but missing.
function businessName() {
  if (!$("#business").is(":checked")) return "";
  var name = $subDomain.val().trim();
  if (!name) {
    showLoginError(translate("Type Business Name"));
    $subDomain.focus();
    return false;
  }
  return name;
}

// A token only counts once Udemy accepts it; this also filters out anonymous visitor tokens.
function verifyToken(token, sub) {
  return new Promise(function(resolve) {
    $.ajax({
      type: "GET",
      url: `https://${sub}.udemy.com/api-2.0/users/me/subscribed-courses?page_size=1`,
      headers: { Authorization: `Bearer ${token}` },
      success: function() {
        resolve({ ok: true });
      },
      error: function(xhr) {
        resolve({ ok: false, status: xhr.status });
      }
    });
  });
}

function completeLogin(token, sub) {
  settings.set("access_token", token);
  settings.set("subdomain", sub);
  checkLogin();
}

function tokenErrorText(status) {
  return status == 401 || status == 403
    ? translate("Udemy rejected this token. Copy a fresh access_token cookie while you are signed in, then try again.")
    : translate("Could not reach Udemy. Check your connection and try again.");
}

// Udemy's website no longer sends an Authorization header, so the sign-in window is watched for the
// access_token cookie instead. Each new cookie value is verified before it is accepted.
function loginWithUdemy() {
  hideLoginError();
  var business = businessName();
  if (business === false) return;
  var sub = business || "www";
  var ses = remote.session.defaultSession;
  var parent = remote.getCurrentWindow();
  var dimensions = parent.getSize();
  var loginWindow = new BrowserWindow({
    width: dimensions[0] - 100,
    height: dimensions[1] - 100,
    parent,
    modal: true
  });
  var finished = false;
  var rejected = {};
  var timer = null;

  function stop() {
    finished = true;
    clearInterval(timer);
  }

  loginWindow.on("closed", stop);

  async function check() {
    if (finished) return;
    var cookies = await ses.cookies.get({ name: "access_token" });
    for (var c of cookies) {
      if (finished) return;
      var domain = (c.domain || "").replace(/^\./, "");
      if (!c.value || rejected[c.value] || !domain.endsWith("udemy.com")) continue;
      rejected[c.value] = true;
      var result = await verifyToken(c.value, sub);
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
    .then(function() {
      timer = setInterval(check, 1000);
      return loginWindow.loadURL(
        business
          ? `https://${business}.udemy.com`
          : "https://www.udemy.com/join/login-popup"
      );
    })
    .catch(function() {});
}

function setTokenBusy(busy) {
  $("#token-submit").prop("disabled", busy);
  $("#token-submit .spinner").remove();
  if (busy) $("#token-submit").prepend('<span class="spinner"></span>');
}

function loginWithAccessToken() {
  hideLoginError();
  $("#token-error").prop("hidden", true);
  var business = businessName();
  if (business === false) return;
  var token = $("#token")
    .val()
    .trim()
    .replace(/^bearer\s+/i, "")
    .replace(/^["']|["']$/g, "");
  if (!token) {
    $("#token").focus();
    return;
  }
  var sub = business || "www";
  setTokenBusy(true);
  verifyToken(token, sub).then(function(result) {
    setTokenBusy(false);
    if (result.ok) {
      $("#token").val("");
      $("#token-panel").prop("hidden", true);
      $("#method-token").attr("aria-expanded", false);
      completeLogin(token, sub);
    } else {
      $("#token-error").text(tokenErrorText(result.status)).prop("hidden", false);
      $("#token").focus();
    }
  });
}

function showApp() {
  $("#login").prop("hidden", true);
  $("#app").prop("hidden", false);
  $("#account-name").text(subDomain + ".udemy.com");
}

function resetToLogin(message) {
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

function checkLogin() {
  if (settings.get("access_token")) {
    subDomain = settings.get("subdomain") || "www";
    headers = { Authorization: `Bearer ${settings.get("access_token")}` };
    showApp();
    loadDownloads();
    loadCourses();
  }
}

// ---------- courses ----------
function loadCourses() {
  $.ajax({
    type: "GET",
    url: `https://${subDomain}.udemy.com/api-2.0/users/me/subscribed-courses?page_size=50`,
    beforeSend: showSkeleton,
    headers: headers,
    success: function(response) {
      handleResponse(response);
    },
    error: courseListError
  });
}

// 401/403 means the session is gone; anything else is shown in place with a Retry.
function courseListError(response) {
  if (response.status == 401 || response.status == 403) {
    settings.set("access_token", false);
    resetToLogin(translate("Your session expired. Sign in again."));
    return;
  }
  $("#courses-list").empty();
  $("#courses-empty, #load-more").prop("hidden", true);
  $("#courses-error").prop("hidden", false);
}

$("#courses-retry").click(function() {
  var keyword = $("#search-input").val().trim();
  keyword ? $("#search-form").submit() : loadCourses();
});

function showSkeleton() {
  $("#courses-empty, #courses-error, #load-more").prop("hidden", true);
  $("#courses-list").html(ui.skeleton(6));
}

function addCourses(results) {
  results.forEach(function(course) {
    var $row = $(
      ui.courseRow({
        id: course.id,
        url: course.url,
        title: course.title,
        image: course.image_240x135
      })
    );
    // A course that is already downloading shows its live state in this list too.
    var $existing = $('#downloads-list .course[course-id="' + course.id + '"]');
    if ($existing.length) ui.copyState($existing, $row);
    $("#courses-list").append($row);
  });
}

function handleResponse(response) {
  $("#courses-list").empty();
  addCourses(response.results);
  $("#courses-empty").prop("hidden", !!response.results.length);
  $("#load-more")
    .prop("hidden", !response.next)
    .data("url", response.next || "");
}

$("#load-more-btn").click(function() {
  var $btn = $(this);
  var url = $("#load-more").data("url");
  if (!url) return;
  $btn.prop("disabled", true).prepend('<span class="spinner"></span>');
  $.ajax({
    type: "GET",
    url: url,
    headers: headers,
    success: function(response) {
      addCourses(response.results);
      $("#load-more")
        .prop("hidden", !response.next)
        .data("url", response.next || "");
    },
    complete: function() {
      $btn.prop("disabled", false).find(".spinner").remove();
    }
  });
});

function validURL(value) {
  var expression = /[-a-zA-Z0-9@:%_\+.~#?&//=]{2,256}\.[a-z]{2,4}\b(\/[-a-zA-Z0-9@:%_\+.~#?&//=]*)?/gi;
  var regexp = new RegExp(expression);
  return regexp.test(value);
}

function noCourses() {
  $("#courses-list").empty();
  $("#courses-error").prop("hidden", true);
  $("#load-more").prop("hidden", true);
  $("#courses-empty").prop("hidden", false);
}

function search(keyword, headers) {
  $.ajax({
    type: "GET",
    url: `https://${subDomain}.udemy.com/api-2.0/users/me/subscribed-courses?page_size=50&page=1&fields[user]=job_title&search=${encodeURIComponent(keyword)}`,
    beforeSend: showSkeleton,
    headers: headers,
    success: function(response) {
      handleResponse(response);
    },
    error: courseListError
  });
}

$("#search-input").on("input", function() {
  $("#search-clear").prop("hidden", !this.value);
});

$("#search-clear").click(function() {
  $("#search-input").val("").focus();
  $(this).prop("hidden", true);
  loadCourses();
});

$("#search-form").submit(function(e) {
  e.preventDefault();
  var keyword = $("#search-input").val().trim();
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
      headers: headers,
      success: function(response) {
        var title = $(".main-content h1.clp-lead__title", response)
          .text()
          .trim();
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
  shell.openExternal(
    `https://${subDomain}.udemy.com${$(this).closest(".course").attr("course-url")}`
  );
});

// ---------- download controls ----------
function controlFor(button) {
  return downloadControls[$(button).closest(".course").attr("course-id")];
}

$("#downloads-list").on("click", ".pause-btn", function() {
  var c = controlFor(this);
  if (c) c.pause();
});
$("#downloads-list").on("click", ".resume-btn", function() {
  var c = controlFor(this);
  if (c) c.resume();
});
$("#downloads-list").on("click", ".cancel-btn", function() {
  var c = controlFor(this);
  if (c) c.cancel();
});

$("#app").on("click", ".folder-btn", function() {
  var dir = $(this).closest(".course").attr("data-path");
  if (!dir || !fs.existsSync(dir)) {
    ui.toast(translate("Folder not found"), true);
    return;
  }
  shell.openPath(dir);
});

$("#downloads-list").on("click", ".remove-btn", function() {
  var id = $(this).closest(".course").attr("course-id");
  $('#downloads-list .course[course-id="' + id + '"]').remove();
  var $mine = $('#courses-list .course[course-id="' + id + '"]');
  ui.Row.state($mine, "idle");
  ui.Row.text($mine, "");
  ui.refreshDownloads();
});

$("#clear-finished").click(function() {
  $('#downloads-list .course[data-state="done"]').each(function() {
    var id = $(this).attr("course-id");
    var $mine = $('#courses-list .course[course-id="' + id + '"]');
    ui.Row.state($mine, "idle");
    ui.Row.text($mine, "");
    $(this).remove();
  });
  ui.refreshDownloads();
});

// ---------- persistence of the Downloads list ----------
function saveDownloads(quit) {
  var downloadedCourses = [];
  $("#downloads-list > .course")
    .slice(0, 100)
    .each(function(index, elem) {
      var $elem = $(elem);
      var state = $elem.attr("data-state");
      var interrupted = ["preparing", "downloading", "paused", "interrupted"].includes(state);
      downloadedCourses.push({
        id: $elem.attr("course-id"),
        url: $elem.attr("course-url"),
        title: $elem.find(".coursename").text(),
        image: $elem.find(".thumb").attr("src"),
        state: interrupted ? "interrupted" : state,
        pct: +$elem.attr("data-pct") || 0,
        text: interrupted
          ? translate("Interrupted when the app was closed. Press Resume to continue where it stopped.")
          : $elem.find(".status-text").text(),
        path: $elem.attr("data-path") || ""
      });
    });
  settings.set("downloadedCourses", downloadedCourses);
  if (quit) {
    electron.ipcRenderer.send("quitApp");
  }
}

function loadDownloads() {
  if ($("#downloads-list > .course").length) return;
  var saved = settings.get("downloadedCourses");
  if (!saved) return;
  saved.forEach(function(course) {
    var $row = $(
      ui.courseRow(
        { id: course.id, url: course.url, title: course.title, image: course.image },
        course.state || (course.completed ? "done" : "idle")
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
function prepError(status) {
  if (status == 403 || status == 401) return translate("You do not have permission to access this course");
  if (status == 404) return translate("This course is not available for download. It may be a draft or it may have been removed.");
  if (status == "empty") return translate("This course has no lectures.");
  return translate("Could not load this course. Check your connection and retry.");
}

// Download, Resume, Retry and Check for updates all start the same flow. The engine works out
// what is new or changed by comparing the course with what an earlier download saved.
$("#app").on("click", ".download-btn, .retry-btn, .update-btn", async function(e) {
  e.stopImmediatePropagation();
  var $course = $(this).closest(".course");
  var courseid = $course.attr("course-id");
  if (downloadControls[courseid]) return; // already preparing or downloading
  // a course in the error state is retrying (finish what failed), not checking for updates,
  // whichever of the three buttons actually triggered it
  var isRetry = $course.attr("data-state") == "error";
  ensureDownloadRow($course);
  var $all = $('.course[course-id="' + courseid + '"]');
  var prep = { cancelled: false, failed: false };
  downloadControls[courseid] = {
    pause: function() {},
    resume: function() {},
    cancel: function() {
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
    var data = await prepareCourse(
      { id: courseid, title: $course.find(".coursename").text(), url: $course.attr("course-url") },
      prep,
      function(done, total) {
        var text = translate("Preparing course") + "… " + done + "/" + total;
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
    ui.Row.text($all, prepError(err.status));
  }
});

// After a course finishes with some lectures failed, "done"/"total"/"failed" is recomputed
// from courseStore and reflected on the row: this is what lets a single retried lecture flip
// the whole course row back to Completed once nothing is left failing.
function refreshCourseRowFromStore(courseId) {
  var store = courseStore[courseId];
  if (!store) return;
  var entries = [];
  store.chapters.forEach(function(c) {
    entries = entries.concat(c.lectures);
  });
  var failed = entries.filter(function(e) {
    return e.state == "failed";
  }).length;
  var done = entries.filter(function(e) {
    return e.state == "done" || e.state == "saved" || e.state == "unchanged";
  }).length;
  var total = entries.length;
  var $row = $('.course[course-id="' + courseId + '"]');
  if (!$row.length || $row.attr("data-state") == "downloading" || $row.attr("data-state") == "paused") return;
  if (!failed) {
    ui.Row.state($row, "done");
    ui.Row.text($row, translate("Completed"));
    ui.Row.progress($row, total, total);
  } else {
    ui.Row.state($row, "error");
    ui.Row.text(
      $row,
      translate("Downloaded") + " " + done + "/" + total + " · " + failed + " " + translate(failed == 1 ? "lecture failed" : "lectures failed")
    );
  }
}

$(document).on("click", ".lretry", async function(e) {
  e.stopPropagation();
  var $btn = $(this).prop("disabled", true);
  var courseId = courseDetail.currentCourseId();
  var lectureId = $(this).closest(".lecture").attr("data-lid");
  if (!courseId || !lectureId) {
    $btn.prop("disabled", false);
    return;
  }
  var ok = await retryLecture(courseId, lectureId);
  $btn.prop("disabled", false);
  if (ok) refreshCourseRowFromStore(courseId);
  else ui.toast(translate("That lecture could not be downloaded. Check your connection and try again."), true);
});

// ---------- logout ----------
$("#logout").click(function() {
  var busy = $(
    '#downloads-list .course[data-state="downloading"], #downloads-list .course[data-state="paused"], #downloads-list .course[data-state="preparing"]'
  ).length;
  ui.confirm(
    translate("Confirm Log Out?"),
    busy ? translate("Downloads in progress will be stopped.") : "",
    translate("Logout"),
    function(ok) {
      if (!ok) return;
      $("#downloads-list .cancel-btn").click();
      saveDownloads(false);
      settings.set("access_token", false);
      resetToLogin();
    }
  );
});

// ---------- settings ----------
function loadDefaults() {
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

var languagesLoaded = false;

function loadSettings() {
  var s = settings.getAll();
  if (!languagesLoaded) {
    languagesLoaded = true;
    $.getJSON("locale/meta.json", function(data) {
      Object.keys(data).forEach(function(name) {
        $("#set-language").append($("<option>").val(name).text(name));
      });
      $("#set-language").val(s.general.language || "");
    });
  }
  $("#set-path-text").text(s.download.path || homedir + "/Downloads");
  $("#set-quality").val(s.download.videoQuality || "");
  $("#set-subs").prop("checked", !s.download.skipSubtitles);
  $("#set-attachments").prop("checked", !s.download.skipAttachments);
  $("#set-range").prop("checked", !!s.download.enableDownloadStartEnd);
  $("#range-fields").prop("hidden", !s.download.enableDownloadStartEnd);
  $("#set-start").val(s.download.downloadStart || "");
  $("#set-end").val(s.download.downloadEnd || "");
  $("#set-retry").prop("checked", !!s.download.autoRetry);
  $("#set-language").val(s.general.language || "");
}

function saveSettings(message) {
  var range = $("#set-range").is(":checked");
  settings.set("download", {
    enableDownloadStartEnd: range,
    skipAttachments: !$("#set-attachments").is(":checked"),
    skipSubtitles: !$("#set-subs").is(":checked"),
    autoRetry: $("#set-retry").is(":checked"),
    downloadStart: parseInt($("#set-start").val()) || false,
    downloadEnd: parseInt($("#set-end").val()) || false,
    videoQuality: $("#set-quality").val() || false,
    path: $("#set-path-text").data("path") || settings.get("download.path") || false
  });
  settings.set("general", {
    language: $("#set-language").val() || false
  });
  ui.toast(message || translate("Settings Saved"));
}

$("#view-settings").on("change", "select, input", function() {
  if (this.id == "set-range") $("#range-fields").prop("hidden", !this.checked);
  saveSettings(
    this.id == "set-language"
      ? translate("Language changes apply the next time the app starts.")
      : ""
  );
});

$("#set-choose").click(function() {
  var chosen = dialog.showOpenDialogSync({ properties: ["openDirectory"] });
  if (chosen && chosen[0]) {
    fs.access(chosen[0], fs.constants.R_OK | fs.constants.W_OK, function(err) {
      if (err) {
        ui.toast(translate("Cannot select this folder"), true);
      } else {
        $("#set-path-text").text(chosen[0]).data("path", chosen[0]);
        saveSettings();
      }
    });
  }
});

// Update checking and the About page's status line live in updater.js.

// ---------- subtitle picker ----------
// One shared dialog; requests from several courses wait their turn.
var subtitleQueue = [];

function askforSubtile(availableSubs, initDownload, $course, coursedata) {
  if (coursedata.prep && coursedata.prep.cancelled) return;
  subtitleQueue.push({ subs: availableSubs, start: initDownload, $course: $course, coursedata: coursedata });
  if (!document.getElementById("dlg-subtitle").open) nextSubtitleRequest();
}

function nextSubtitleRequest() {
  var req = subtitleQueue.shift();
  if (!req) return;
  var dlg = document.getElementById("dlg-subtitle");
  var id = req.$course.attr("course-id");
  var $select = $("#subtitle-select").empty();
  for (var key in req.subs) {
    $select.append(
      $("<option>").val(key).text(`${key} (${req.subs[key]} ${translate("Lectures")})`)
    );
  }
  if (req.subs["English"]) $select.val("English");
  $("#dlg-subtitle-title").text(
    translate("Select Subtitle") + " · " + req.$course.find(".coursename").text()
  );
  dlg.returnValue = "";
  dlg.onclose = function() {
    if (dlg.returnValue == "ok") {
      req.start(req.$course, req.coursedata, $select.val());
    } else {
      var $all = $('.course[course-id="' + id + '"]');
      delete downloadControls[id];
      ui.Row.state($all, "idle");
      ui.Row.text($all, "");
    }
    nextSubtitleRequest();
  };
  dlg.showModal();
}

checkLogin();
