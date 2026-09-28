const electron = require("electron");
const remote = require("@electron/remote");
const dialog = remote.dialog;
const BrowserWindow = remote.BrowserWindow;
const fs = require("fs");
const mkdirp = require("mkdirp");
const homedir = require("os").homedir();
const sanitize = require("sanitize-filename");
const vtt2srt = require("node-vtt-to-srt");
var Downloader = require("mt-files-downloader");
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
      var interrupted = ["preparing", "downloading", "paused"].includes(state);
      downloadedCourses.push({
        id: $elem.attr("course-id"),
        url: $elem.attr("course-url"),
        title: $elem.find(".coursename").text(),
        image: $elem.find(".thumb").attr("src"),
        state: interrupted ? "idle" : state,
        text: interrupted
          ? translate("Interrupted when the app was closed. Press Download to continue.")
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
    $("#downloads-list").append($row);
  });
  ui.refreshDownloads();
}

$("#app").on(
  "click",
  ".download-btn, .retry-btn",
  function(e) {
    e.stopImmediatePropagation();
    var $course = $(this).closest(".course");
    var courseid = $course.attr("course-id");
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
    function prepFail(status) {
      if (prep.cancelled || prep.failed) return;
      prep.failed = true;
      delete downloadControls[courseid];
      ui.Row.state($all, "error");
      ui.Row.text(
        $all,
        status == 403
          ? translate("You do not have permission to access this course")
          : translate("Could not load this course. Check your connection and retry.")
      );
    }
    ui.Row.state($all, "preparing");
    ui.Row.text($all, translate("Preparing course") + "…");
    ui.Row.progress($all, 0, 0);
    var settingsCached = settings.getAll();
    var skipAttachments = settingsCached.download.skipAttachments;
    var skipSubtitles = settingsCached.download.skipSubtitles;
    $.ajax({
      type: "GET",
      url: `https://${subDomain}.udemy.com/api-2.0/courses/${courseid}/cached-subscriber-curriculum-items?page_size=100000`,
      headers: headers,
      success: function(response) {
        if (prep.cancelled) return;
        if (!response.results || !response.results.length) {
          prepFail(0);
          return;
        }
        var coursedata = [];
        coursedata["prep"] = prep;
        coursedata["chapters"] = [];
        coursedata["name"] = $course.find(".coursename").text();
        var chapterindex = -1;
        var lectureindex = -1;
        var remaining = response.count;
        coursedata["totallectures"] = 0;
        var availableSubs = [];

        if (response.results[0]._class == "lecture") {
          chapterindex++;
          lectureindex = 0;
          coursedata["chapters"][chapterindex] = [];
          coursedata["chapters"][chapterindex]["name"] = "Chapter 1";
          coursedata["chapters"][chapterindex]["lectures"] = [];
          remaining--;
        }

        $.each(response.results, function(i, v) {
          if (v._class == "chapter") {
            chapterindex++;
            lectureindex = 0;
            coursedata["chapters"][chapterindex] = [];
            coursedata["chapters"][chapterindex]["name"] = v.title;
            coursedata["chapters"][chapterindex]["lectures"] = [];
            remaining--;
          } else if (
            v._class == "lecture" &&
            (v.asset.asset_type == "Video" ||
              v.asset.asset_type == "Article" ||
              v.asset.asset_type == "File" ||
              v.asset.asset_type == "E-Book")
          ) {
            if (v.asset.asset_type != "Video" && skipAttachments) {
              remaining--;
              if (!remaining) {
                if (Object.keys(availableSubs).length) {
                  askforSubtile(
                    availableSubs,
                    initDownload,
                    $course,
                    coursedata
                  );
                } else {
                  initDownload($course, coursedata);
                }
              }
              return;
            }
            function getLecture(lecturename, chapterindex, lectureindex) {
              $.ajax({
                type: "GET",
                url: `https://${subDomain}.udemy.com/api-2.0/users/me/subscribed-courses/${courseid}/lectures/${v.id}?fields[asset]=stream_urls,download_urls,captions,title,filename,data,body&fields[lecture]=asset,supplementary_assets`,
                headers: headers,
                error: function(error) {
                  prepFail(error.status);
                },
                success: function(response) {
                  if (v.asset.asset_type == "Article") {
                    if (response.asset.data) {
                      var src = response.asset.data.body;
                    } else {
                      var src = response.asset.body;
                    }
                    var videoQuality = v.asset.asset_type;
                    var type = "Article";
                  } else if (
                    v.asset.asset_type == "File" ||
                    v.asset.asset_type == "E-Book"
                  ) {
                    var src =
                      response.asset.download_urls[v.asset.asset_type][0].file;
                    var videoQuality = v.asset.asset_type;
                    var type = "File";
                  } else {
                    var type = "Video";
                    var lecture = response.asset.stream_urls;
                    var qualities = [];
                    var qualitySrcMap = {};
                    lecture.Video.forEach(function(val) {
                      if (val.label == "Auto") return;
                      qualities.push(val.label);
                      qualitySrcMap[val.label] = val.file;
                    });
                    var lowest = Math.min(...qualities);
                    var highest = Math.max(...qualities);
                    var videoQuality = settingsCached.download.videoQuality;
                    if (!videoQuality || videoQuality == "Auto") {
                      var src = lecture.Video[0].file;
                      videoQuality = lecture.Video[0].label;
                    } else {
                      switch (videoQuality) {
                        case "Highest":
                          var src = qualitySrcMap[highest];
                          videoQuality = highest;
                          break;
                        case "Lowest":
                          var src = qualitySrcMap[lowest];
                          videoQuality = lowest;
                          break;
                        default:
                          videoQuality = videoQuality.slice(0, -1);
                          if (qualitySrcMap[videoQuality]) {
                            var src = qualitySrcMap[videoQuality];
                          } else {
                            var src = lecture.Video[0].file;
                            videoQuality = lecture.Video[0].label;
                          }
                      }
                    }
                  }
                  coursedata["chapters"][chapterindex]["lectures"][
                    lectureindex
                  ] = {
                    src: src,
                    name: lecturename,
                    quality: videoQuality,
                    type: type
                  };
                  if (!skipSubtitles && response.asset.captions.length) {
                    coursedata["chapters"][chapterindex]["lectures"][
                      lectureindex
                    ].caption = [];
                    response.asset.captions.forEach(function(caption) {
                      caption.video_label in availableSubs
                        ? (availableSubs[caption.video_label] =
                            availableSubs[caption.video_label] + 1)
                        : (availableSubs[caption.video_label] = 1);
                      coursedata["chapters"][chapterindex]["lectures"][
                        lectureindex
                      ].caption[caption.video_label] = caption.url;
                    });
                  }
                  if (
                    response.supplementary_assets.length &&
                    !skipAttachments
                  ) {
                    coursedata["chapters"][chapterindex]["lectures"][
                      lectureindex
                    ]["supplementary_assets"] = [];
                    var supplementary_assets_remaining =
                      response.supplementary_assets.length;
                    $.each(response.supplementary_assets, function(a, b) {
                      $.ajax({
                        type: "GET",
                        url: `https://${subDomain}.udemy.com/api-2.0/users/me/subscribed-courses/${courseid}/lectures/${v.id}/supplementary-assets/${b.id}?fields[asset]=download_urls,external_url,asset_type`,
                        headers: headers,
                        error: function(error) {
                          prepFail(error.status);
                        },
                        success: function(response) {
                          if (response.download_urls) {
                            coursedata["chapters"][chapterindex]["lectures"][
                              lectureindex
                            ]["supplementary_assets"].push({
                              src:
                                response.download_urls[response.asset_type][0]
                                  .file,
                              name: b.title,
                              quality: "Attachment",
                              type: "File"
                            });
                          } else {
                            coursedata["chapters"][chapterindex]["lectures"][
                              lectureindex
                            ]["supplementary_assets"].push({
                              src: `<script type="text/javascript">window.location = "${response.external_url}";</script>`,
                              name: b.title,
                              quality: "Attachment",
                              type: "Url"
                            });
                          }
                          supplementary_assets_remaining--;
                          if (!supplementary_assets_remaining) {
                            remaining--;
                            coursedata["totallectures"] += 1;
                            if (!remaining) {
                              if (Object.keys(availableSubs).length) {
                                askforSubtile(
                                  availableSubs,
                                  initDownload,
                                  $course,
                                  coursedata
                                );
                              } else {
                                initDownload($course, coursedata);
                              }
                            }
                          }
                        }
                      });
                    });
                  } else {
                    remaining--;
                    coursedata["totallectures"] += 1;
                    if (!remaining) {
                      if (Object.keys(availableSubs).length) {
                        askforSubtile(
                          availableSubs,
                          initDownload,
                          $course,
                          coursedata
                        );
                      } else {
                        initDownload($course, coursedata);
                      }
                    }
                  }
                }
              });
            }
            getLecture(v.title, chapterindex, lectureindex);
            lectureindex++;
          } else if (!skipAttachments) {
            coursedata["chapters"][chapterindex]["lectures"][lectureindex] = {
              src: `<script type="text/javascript">window.location = "https://${subDomain}.udemy.com${$course.attr(
                "course-url"
              )}t/${v._class}/${v.id}";</script>`,
              name: v.title,
              quality: "Attachment",
              type: "Url"
            };
            remaining--;
            coursedata["totallectures"] += 1;
            if (!remaining) {
              if (Object.keys(availableSubs).length) {
                askforSubtile(availableSubs, initDownload, $course, coursedata);
              } else {
                initDownload($course, coursedata);
              }
            }
            lectureindex++;
          } else {
            remaining--;
            if (!remaining) {
              if (Object.keys(availableSubs).length) {
                askforSubtile(availableSubs, initDownload, $course, coursedata);
              } else {
                initDownload($course, coursedata);
              }
            }
          }
        });
      },
      error: function(error) {
        prepFail(error.status);
      }
    });
  }
);

function initDownload($course, coursedata, subtitle = false) {
  var courseId = $course.attr("course-id");
  if (coursedata.prep && coursedata.prep.cancelled) return;
  ensureDownloadRow($course);
  // Every UI update goes to all rows of this course (Courses and Downloads lists).
  var rows = function() {
    return $('.course[course-id="' + courseId + '"]');
  };
  var timer;
  var downloader = new Downloader();
  var cancelled = false;
  var paused = false;
  var view = { quality: "", speed: 0, name: "", filePct: 0 };
  var canPause = false;
  var lectureChaperMap = {};
  var currentLecture = 0;
  coursedata["chapters"].forEach(function(lecture, chapterindex) {
    lecture["lectures"].forEach(function(x, lectureindex) {
      currentLecture++;
      lectureChaperMap[currentLecture] = {
        chapterindex: chapterindex,
        lectureindex: lectureindex
      };
    });
  });

  var course_name = sanitize(coursedata["name"]);
  var totalchapters = coursedata["chapters"].length;
  var totallectures = coursedata["totallectures"];
  var settingsCached = settings.getAll();
  var download_directory =
    settingsCached.download.path || homedir + "/Downloads";
  var downloaded = 0;
  var downloadStart = settingsCached.download.downloadStart;
  var downloadEnd = settingsCached.download.downloadEnd;
  var enableDownloadStartEnd = settingsCached.download.enableDownloadStartEnd;
  var autoRetry = settingsCached.download.autoRetry;
  ui.Row.state(rows(), "downloading");
  ui.Row.now(rows(), "");

  function paint() {
    var n = Math.min(downloaded + 1, toDownload);
    var parts = [translate("Lecture") + " " + n + "/" + toDownload];
    if (view.quality) parts.push(view.quality);
    if (!paused && view.speed) parts.push(ui.formatSpeed(view.speed));
    ui.Row.progress(rows(), downloaded + (view.filePct || 0) / 100, toDownload);
    ui.Row.text(rows(), (paused ? translate("Paused") + " · " : "") + parts.join(" · "));
    ui.Row.now(
      rows(),
      view.name + (view.filePct ? " · " + view.filePct + "%" : "")
    );
  }

  downloadControls[courseId] = {
    pause: function() {
      if (!canPause || cancelled) return;
      try {
        downloader._downloads[downloader._downloads.length - 1].stop();
      } catch (e) {}
      paused = true;
      view.speed = 0;
      ui.Row.state(rows(), "paused");
      paint();
    },
    resume: function() {
      try {
        downloader._downloads[downloader._downloads.length - 1].resume();
      } catch (e) {}
      paused = false;
      ui.Row.state(rows(), "downloading");
      paint();
    },
    cancel: function() {
      cancelled = true;
      clearInterval(timer);
      try {
        downloader._downloads.forEach(function(d) {
          d.stop();
        });
      } catch (e) {}
      ui.Row.state(rows(), "idle");
      ui.Row.text(rows(), translate("Canceled"));
      ui.Row.now(rows(), "");
      ui.Row.progress(rows(), 0, 0);
      delete downloadControls[courseId];
    }
  };

  if (enableDownloadStartEnd) {
    if (downloadStart > downloadEnd) {
      downloadStart = downloadEnd;
    }

    if (downloadStart < 1) {
      downloadStart = 1;
    } else if (downloadStart > totallectures) {
      downloadStart = totallectures;
    }

    if (downloadEnd < 1 || downloadEnd > totallectures) {
      downloadEnd = totallectures;
    }

    var toDownload = downloadEnd - downloadStart + 1;
    downloadChapter(
      lectureChaperMap[downloadStart].chapterindex,
      lectureChaperMap[downloadStart].lectureindex
    );
  } else {
    var toDownload = totallectures;
    downloadChapter(0, 0);
  }

  ui.Row.progress(rows(), 0, toDownload);
  paint();

  function downloadChapter(chapterindex, lectureindex) {
    if (cancelled) return;
    var num_lectures = coursedata["chapters"][chapterindex]["lectures"].length;
    var chapter_name = sanitize(
      chapterindex + 1 + ". " + coursedata["chapters"][chapterindex]["name"]
    );
    mkdirp(
      download_directory + "/" + course_name + "/" + chapter_name,
      function() {
        downloadLecture(chapterindex, lectureindex, num_lectures, chapter_name);
      }
    );
  }

  function downloadLecture(
    chapterindex,
    lectureindex,
    num_lectures,
    chapter_name
  ) {
    if (cancelled) return;
    if (downloaded == toDownload) {
      finish("done");
      return;
    } else if (lectureindex == num_lectures) {
      downloadChapter(++chapterindex, 0);
      return;
    }

    function dlStart(dl, callback) {
      // Change retry options to something more forgiving and threads to keep udemy from getting upset
      dl.setRetryOptions({
        retryInterval: 5000
      });

      dl.setOptions({
        threadsCount: 5
      });

      dl.start();
      // To track time and restarts
      let notStarted = 0;
      let reStarted = 0;

      timer = setInterval(function() {
        switch (dl.status) {
          case 0:
            // Wait a reasonable amount of time for the download to start and if it doesn't then start another one.
            // once one of them starts the errors from the others will be ignored and we still get the file.
            if (reStarted <= 5) {
              notStarted++;
              if (notStarted >= 15) {
                dl.start();
                notStarted = 0;
                reStarted++;
              }
            }
            view.speed = 0;
            paint();
            break;
          case 1:
            var stats = dl.getStats();
            view.speed = parseInt(stats.present.speed / 1000) || 0;
            view.filePct = Math.round(stats.total.completed) || 0;
            paint();
            break;
          case 2:
            break;
          case -1:
            var stats = dl.getStats();
            view.speed = parseInt(stats.present.speed / 1000) || 0;
            view.filePct = Math.round(stats.total.completed) || 0;
            paint();
            if (
              dl.stats.total.size == 0 &&
              dl.status == -1 &&
              fs.existsSync(dl.filePath)
            ) {
              dl.emit("end");
              clearInterval(timer);
              break;
            } else {
              $.ajax({
                type: "HEAD",
                url: dl.url,
                error: function(error) {
                  if (error.status == 401 || error.status == 403) {
                    try {
                      fs.unlinkSync(dl.filePath);
                    } catch (e) {}
                  }
                  finish("error", errorReason(error.status));
                },
                success: function() {
                  finish("error", errorReason(0));
                }
              });
              clearInterval(timer);
              break;
            }
          default:
            view.speed = 0;
            paint();
        }
      }, 1000);

      dl.on("error", function(dl) {
        // Prevent throwing uncaught error
      });

      dl.on("start", function() {
        canPause = true;
      });

      dl.on("end", function() {
        callback();
      });
    }

    function downloadAttachments(index, total_assets) {
      view.filePct = 0;
      var lectureQuality =
        coursedata["chapters"][chapterindex]["lectures"][lectureindex][
          "supplementary_assets"
        ][index]["quality"];
      view.quality = lectureQuality;
      paint();

      if (
        coursedata["chapters"][chapterindex]["lectures"][lectureindex][
          "supplementary_assets"
        ][index]["type"] == "Article" ||
        coursedata["chapters"][chapterindex]["lectures"][lectureindex][
          "supplementary_assets"
        ][index]["type"] == "Url"
      ) {
        fs.writeFile(
          download_directory +
            "/" +
            course_name +
            "/" +
            chapter_name +
            "/" +
            sanitize(
              lectureindex +
                1 +
                "." +
                (index + 1) +
                " " +
                coursedata["chapters"][chapterindex]["lectures"][lectureindex][
                  "supplementary_assets"
                ][index]["name"].trim() +
                ".html"
            ),
          coursedata["chapters"][chapterindex]["lectures"][lectureindex][
            "supplementary_assets"
          ][index]["src"],
          function() {
            index++;
            if (index == total_assets) {
              ui.Row.progress(rows(), downloaded + 1, toDownload);
              downloaded++;
              downloadLecture(
                chapterindex,
                ++lectureindex,
                num_lectures,
                chapter_name
              );
            } else {
              downloadAttachments(index, total_assets);
            }
          }
        );
      } else {
        var lecture_name = sanitize(
          lectureindex +
            1 +
            "." +
            (index + 1) +
            " " +
            coursedata["chapters"][chapterindex]["lectures"][lectureindex][
              "supplementary_assets"
            ][index]["name"].trim() +
            (coursedata["chapters"][chapterindex]["lectures"][lectureindex][
              "supplementary_assets"
            ][index]["name"]
              .split(".")
              .pop() ==
            coursedata["chapters"][chapterindex]["lectures"][lectureindex][
              "supplementary_assets"
            ][index]["src"]
              .split("/")
              .pop()
              .split(".")
              .pop()
              .split("?")
              .shift()
              ? ""
              : "." +
                coursedata["chapters"][chapterindex]["lectures"][lectureindex][
                  "supplementary_assets"
                ][index]["src"]
                  .split("/")
                  .pop()
                  .split(".")
                  .pop()
                  .split("?")
                  .shift())
        );
        if (
          fs.existsSync(
            download_directory +
              "/" +
              course_name +
              "/" +
              chapter_name +
              "/" +
              lecture_name +
              ".mtd"
          )
        ) {
          var dl = downloader.resumeDownload(
            download_directory +
              "/" +
              course_name +
              "/" +
              chapter_name +
              "/" +
              lecture_name
          );
          if (
            !fs.statSync(
              download_directory +
                "/" +
                course_name +
                "/" +
                chapter_name +
                "/" +
                lecture_name +
                ".mtd"
            ).size
          ) {
            dl = downloader.download(
              coursedata["chapters"][chapterindex]["lectures"][lectureindex][
                "supplementary_assets"
              ][index]["src"],
              download_directory +
                "/" +
                course_name +
                "/" +
                chapter_name +
                "/" +
                lecture_name
            );
          }
        } else if (
          fs.existsSync(
            download_directory +
              "/" +
              course_name +
              "/" +
              chapter_name +
              "/" +
              lecture_name
          )
        ) {
          endDownload();
          return;
        } else {
          var dl = downloader.download(
            coursedata["chapters"][chapterindex]["lectures"][lectureindex][
              "supplementary_assets"
            ][index]["src"],
            download_directory +
              "/" +
              course_name +
              "/" +
              chapter_name +
              "/" +
              lecture_name
          );
        }

        dlStart(dl, endDownload);

        function endDownload() {
          index++;
          canPause = false;
          clearInterval(timer);
          if (index == total_assets) {
            ui.Row.progress(rows(), downloaded + 1, toDownload);
            downloaded++;
            downloadLecture(
              chapterindex,
              ++lectureindex,
              num_lectures,
              chapter_name
            );
          } else {
            downloadAttachments(index, total_assets);
          }
        }
      }
    }

    function checkAttachment() {
      view.filePct = 0;
      if (
        coursedata["chapters"][chapterindex]["lectures"][lectureindex][
          "supplementary_assets"
        ]
      ) {
        var total_assets =
          coursedata["chapters"][chapterindex]["lectures"][lectureindex][
            "supplementary_assets"
          ].length;
        var index = 0;
        downloadAttachments(index, total_assets);
      } else {
        ui.Row.progress(rows(), downloaded + 1, toDownload);
        downloaded++;
        downloadLecture(
          chapterindex,
          ++lectureindex,
          num_lectures,
          chapter_name
        );
      }
    }

    function downloadSubtitle() {
      view.filePct = 0;
      view.quality = "Subtitle";
      paint();
      view.speed = 0;
            paint();
      var lecture_name = sanitize(
        lectureindex +
          1 +
          ". " +
          coursedata["chapters"][chapterindex]["lectures"][lectureindex][
            "name"
          ].trim() +
          ".vtt"
      );
      if (
        fs.existsSync(
          download_directory +
            "/" +
            course_name +
            "/" +
            chapter_name +
            "/" +
            lecture_name.replace(".vtt", ".srt")
        )
      ) {
        checkAttachment();
        return;
      }
      var file = fs
        .createWriteStream(
          download_directory +
            "/" +
            course_name +
            "/" +
            chapter_name +
            "/" +
            lecture_name
        )
        .on("finish", function() {
          var finalSrt = fs
            .createWriteStream(
              download_directory +
                "/" +
                course_name +
                "/" +
                chapter_name +
                "/" +
                lecture_name.replace(".vtt", ".srt")
            )
            .on("finish", function() {
              fs.unlinkSync(
                download_directory +
                  "/" +
                  course_name +
                  "/" +
                  chapter_name +
                  "/" +
                  lecture_name
              );
              checkAttachment();
            });
          fs.createReadStream(
            download_directory +
              "/" +
              course_name +
              "/" +
              chapter_name +
              "/" +
              lecture_name
          )
            .pipe(vtt2srt())
            .pipe(finalSrt);
        });

      var request = https.get(
        coursedata["chapters"][chapterindex]["lectures"][lectureindex][
          "caption"
        ][subtitle]
          ? coursedata["chapters"][chapterindex]["lectures"][lectureindex][
              "caption"
            ][subtitle]
          : coursedata["chapters"][chapterindex]["lectures"][lectureindex][
              "caption"
            ][
              Object.keys(
                coursedata["chapters"][chapterindex]["lectures"][lectureindex][
                  "caption"
                ]
              )[0]
            ],
        function(response) {
          response.pipe(file);
        }
      );
    }

    view.filePct = 0;

    var lectureQuality =
      coursedata["chapters"][chapterindex]["lectures"][lectureindex]["quality"];
    view.name =
      coursedata["chapters"][chapterindex]["lectures"][lectureindex]["name"];
    view.quality = lectureQuality +
          (coursedata["chapters"][chapterindex]["lectures"][lectureindex][
            "type"
          ] == "Video"
            ? "p"
            : "");
      paint();

    if (
      coursedata["chapters"][chapterindex]["lectures"][lectureindex]["type"] ==
        "Article" ||
      coursedata["chapters"][chapterindex]["lectures"][lectureindex]["type"] ==
        "Url"
    ) {
      fs.writeFile(
        download_directory +
          "/" +
          course_name +
          "/" +
          chapter_name +
          "/" +
          sanitize(
            lectureindex +
              1 +
              ". " +
              coursedata["chapters"][chapterindex]["lectures"][lectureindex][
                "name"
              ].trim() +
              ".html"
          ),
        coursedata["chapters"][chapterindex]["lectures"][lectureindex]["src"],
        function() {
          if (
            coursedata["chapters"][chapterindex]["lectures"][lectureindex][
              "supplementary_assets"
            ]
          ) {
            var total_assets =
              coursedata["chapters"][chapterindex]["lectures"][lectureindex][
                "supplementary_assets"
              ].length;
            var index = 0;
            downloadAttachments(index, total_assets);
          } else {
            ui.Row.progress(rows(), downloaded + 1, toDownload);
            downloaded++;
            downloadLecture(
              chapterindex,
              ++lectureindex,
              num_lectures,
              chapter_name
            );
          }
        }
      );
    } else {
      var lecture_name = sanitize(
        lectureindex +
          1 +
          ". " +
          coursedata["chapters"][chapterindex]["lectures"][lectureindex][
            "name"
          ].trim() +
          "." +
          (coursedata["chapters"][chapterindex]["lectures"][lectureindex][
            "type"
          ] == "File"
            ? "pdf"
            : "mp4")
      );
      if (
        fs.existsSync(
          download_directory +
            "/" +
            course_name +
            "/" +
            chapter_name +
            "/" +
            lecture_name +
            ".mtd"
        )
      ) {
        var dl = downloader.resumeDownload(
          download_directory +
            "/" +
            course_name +
            "/" +
            chapter_name +
            "/" +
            lecture_name
        );
        if (
          !fs.statSync(
            download_directory +
              "/" +
              course_name +
              "/" +
              chapter_name +
              "/" +
              lecture_name +
              ".mtd"
          ).size
        ) {
          dl = downloader.download(
            coursedata["chapters"][chapterindex]["lectures"][lectureindex][
              "src"
            ],
            download_directory +
              "/" +
              course_name +
              "/" +
              chapter_name +
              "/" +
              lecture_name
          );
        }
      } else if (
        fs.existsSync(
          download_directory +
            "/" +
            course_name +
            "/" +
            chapter_name +
            "/" +
            lecture_name
        )
      ) {
        endDownload();
        return;
      } else {
        var dl = downloader.download(
          coursedata["chapters"][chapterindex]["lectures"][lectureindex]["src"],
          download_directory +
            "/" +
            course_name +
            "/" +
            chapter_name +
            "/" +
            lecture_name
        );
      }

      dlStart(dl, endDownload);

      function endDownload() {
        canPause = false;
        clearInterval(timer);
        if (
          coursedata["chapters"][chapterindex]["lectures"][lectureindex].caption
        ) {
          downloadSubtitle();
        } else {
          checkAttachment();
        }
      }
    }
  }

  function errorReason(status) {
    var base =
      status == 401 || status == 403
        ? translate("Access was denied. Your session may have expired: sign in again, then retry.")
        : translate("The connection was interrupted.");
    return (view.name ? "\u201c" + view.name + "\u201d: " : "") + base;
  }

  function finish(kind, reason) {
    if (cancelled) return;
    if (kind == "error" && autoRetry) {
      initDownload(
        rows()
          .filter("#downloads-list .course")
          .first(),
        coursedata,
        subtitle
      );
      return;
    }
    clearInterval(timer);
    delete downloadControls[courseId];
    rows().attr("data-path", download_directory + "/" + course_name);
    if (kind == "done") {
      ui.Row.progress(rows(), toDownload, toDownload);
      ui.Row.state(rows(), "done");
      ui.Row.text(
        rows(),
        translate("Completed") +
          " · " +
          new Date().toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          })
      );
    } else {
      ui.Row.state(rows(), "error");
      ui.Row.text(rows(), reason);
    }
    ui.Row.now(rows(), "");
  }
}

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

// ---------- about / updates ----------
$("#check-updates").click(function() {
  var $btn = $(this);
  var $status = $("#update-status");
  $btn.prop("disabled", true);
  $status.text(translate("Checking for Updates") + "…");
  $.getJSON("https://api.github.com/repos/rahulgurujala/coursegrab/releases/latest")
    .done(function(response) {
      if (response.tag_name != `v${appVersion}`) {
        $status.html(
          `${esc(translate("New Update Available"))}: ${esc(response.tag_name)} · <a href="https://github.com/rahulgurujala/coursegrab/releases/latest">${esc(translate("Download"))}</a>`
        );
      } else {
        $status.text(translate("No updates available"));
      }
    })
    .fail(function(xhr) {
      $status.text(
        xhr.status == 404
          ? translate("No updates available")
          : translate("Could not check for updates.")
      );
    })
    .always(function() {
      $btn.prop("disabled", false);
    });
});

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
