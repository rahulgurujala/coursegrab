// Course download engine: reads a course from Udemy, decides what needs downloading
// (new, updated or missing lectures only) and saves it to disk.
//
// Loaded after the inline bootstrap script in index.html, which provides: $, settings, translate,
// fs, homedir, sanitize, vtt2srt, https, Downloader. ui comes from ui.js.
// Udemy API calls live in src/api/udemy.ts, course state in src/store/*.ts, both compiled to
// dist/ and required below, the same as downloadControls/session/ensureDownloadRow: these used to
// be plain globals app.js provided as a classic script; app.js is now app.ts, a real module that
// cannot leak globals to its siblings the same way, so anything it used to hand engine.js this
// way is now an explicit require of the same real module app.ts itself imports.

const path = require("path");
const udemyApi = require("./dist/api/udemy.js");
const manifestStore = require("./dist/store/manifest.js");
const courseStoreModule = require("./dist/store/courseStore.js");
const naming = require("./dist/download/naming.js");
const fsUtils = require("./dist/download/fsUtils.js");
const planner = require("./dist/download/planner.js");
const orchestratorModule = require("./dist/download/orchestrator.js");
const devlogModule = require("./dist/shared/devlog.js");
const downloadControls = require("./dist/shared/downloadControls.js").downloadControls;
const session = require("./dist/shared/session.js").session;
const ensureDownloadRow = require("./dist/view/courseRow.js").ensureDownloadRow;

const SKIPPED_FILE = "Skipped lectures.txt";

// Same devlog[level](courseId, text) shape every existing call site already uses; sourced from
// the real module now (src/shared/devlog.ts) instead of the old global script, so this is the
// same ring buffer view/courseDetails.ts reads from once details.js is wired to it too.
var devlog = { info: devlogModule.info, warn: devlogModule.warn, error: devlogModule.error };

// courseStore is the SAME object courseStoreModule exports, not a copy: assets/js/details.js
// still reads the global `courseStore` directly (courseStore[id], courseStore[id].byId[...]),
// and will keep doing so unchanged until it is ported too.
var courseStore = courseStoreModule.courseStore;
var readManifest = manifestStore.readManifest;
var writeManifest = manifestStore.writeManifest;
var buildStore = courseStoreModule.buildStore;
var capName = naming.capName;
var chapterFolder = naming.chapterFolder;
var primaryName = naming.primaryName;
var guessExtension = naming.guessExtension;
var attachmentName = naming.attachmentName;
var removeQuietly = fsUtils.removeQuietly;
var planUpdates = planner.planUpdates;

function storeFromManifest(courseId, title, dir) {
  return courseStoreModule.storeFromManifest(courseId, title, dir, translate);
}

function touchStore(courseId, lectureId) {
  courseStoreModule.touch(courseId, lectureId);
}
// The one place that decides what "touched" means: the course details view, same behavior as
// before (courseDetail.touch), just wired through the store's event instead of called inline.
courseStoreModule.storeEvents.on("touch", function(courseId, lectureId) {
  if (typeof courseDetail != "undefined") courseDetail.touch(courseId, lectureId);
});

// Reads the course and compares it with what is saved, without downloading or changing any file.
async function checkCourse(course, onProgress) {
  var prep = { cancelled: false, failed: false };
  var data = await prepareCourse(course, prep, onProgress);
  var options = settings.getAll().download;
  var dir = courseDir(course.title);
  var inScope = {};
  data.chapters.forEach(function(chapter) {
    chapter.lectures.forEach(function(lecture) {
      inScope[lecture.id] = true;
    });
  });
  var plan = planUpdates(data, dir, options, inScope, true);
  var store = buildStore(course.id, course.title, dir, data, "checked", plan.hadManifest);
  return store;
}

// ---------- helpers ----------
// Every actual Udemy request lives in src/api/udemy.ts (typed, no side effects beyond the
// network call itself), compiled to dist/api/udemy.js and required below. This just supplies
// the auth/logging context it needs.
function apiContext() {
  return {
    subDomain: session.subDomain,
    accessToken: settings.get("access_token"),
    onLog: function(courseId, level, text) {
      devlog[level](courseId, text);
    }
  };
}

async function pool(items, limit, worker) {
  var next = 0;
  var runners = [];
  for (var i = 0; i < Math.min(limit, items.length); i++) {
    runners.push(
      (async function() {
        while (next < items.length) {
          var index = next++;
          await worker(items[index], index);
        }
      })()
    );
  }
  await Promise.all(runners);
}

function downloadRoot() {
  return settings.get("download.path") || homedir + "/Downloads";
}

function courseDir(title) {
  return path.join(downloadRoot(), sanitize(title));
}

function httpError(status) {
  var err = new Error("HTTP " + status);
  err.status = status;
  return err;
}

function describeError(status, name) {
  var base =
    status == 401 || status == 403
      ? translate("Access was denied. Your session may have expired: sign in again, then retry.")
      : translate("The connection was interrupted.");
  return (name ? "“" + name + "”: " : "") + base;
}

// ---------- reading a course ----------
// Picks a downloadable mp4. Streams that are only served as HLS or DASH (which is how
// protected videos are delivered) are not downloadable, so they return null.
function pickVideo(streamUrls, wanted) {
  var list = streamUrls && Array.isArray(streamUrls.Video) ? streamUrls.Video : [];
  var playable = list.filter(function(v) {
    return v && v.file && !/mpegurl|dash/i.test(v.type || "");
  });
  if (!playable.length) return null;
  var byQuality = {};
  var numbers = [];
  playable.forEach(function(v) {
    var n = parseInt(v.label, 10);
    if (v.label != "Auto" && !isNaN(n)) {
      byQuality[n] = v;
      numbers.push(n);
    }
  });
  var pick = playable[0];
  if (wanted && wanted != "Auto" && numbers.length) {
    if (wanted == "Highest") pick = byQuality[Math.max.apply(null, numbers)];
    else if (wanted == "Lowest") pick = byQuality[Math.min.apply(null, numbers)];
    else if (byQuality[parseInt(wanted, 10)]) pick = byQuality[parseInt(wanted, 10)];
  }
  return { src: pick.file, quality: String(pick.label) };
}

function skipLecture(data, chapter, lecture, reason) {
  lecture.type = "Skipped";
  lecture.reason = reason;
  data.skipped.push({ chapter: chapter.name, name: lecture.name, reason: reason });
}

async function loadLecture(lecture, chapter, course, options, data) {
  var response = await udemyApi.getLectureDetail(course.id, lecture.id, apiContext());
  var asset = response.asset || {};

  if (lecture.type == "Article") {
    lecture.src = asset.data ? asset.data.body : asset.body;
    lecture.quality = "Article";
    if (lecture.src == null) return skipLecture(data, chapter, lecture, "unavailable");
  } else if (lecture.type == "File") {
    var links = asset.download_urls && asset.download_urls[lecture.assetType];
    if (!links || !links[0] || !links[0].file) {
      return skipLecture(data, chapter, lecture, "unavailable");
    }
    lecture.src = links[0].file;
    lecture.quality = lecture.assetType;
  } else {
    var video = pickVideo(asset.stream_urls, options.videoQuality);
    if (!video) return skipLecture(data, chapter, lecture, "protected");
    lecture.src = video.src;
    lecture.quality = video.quality;
  }

  if (!options.skipSubtitles && asset.captions && asset.captions.length) {
    lecture.caption = {};
    asset.captions.forEach(function(caption) {
      data.subs[caption.video_label] = (data.subs[caption.video_label] || 0) + 1;
      lecture.caption[caption.video_label] = caption.url;
    });
  }

  if (!options.skipAttachments && response.supplementary_assets && response.supplementary_assets.length) {
    lecture.supplementary = [];
    for (var b of response.supplementary_assets) {
      try {
        var detail = await udemyApi.getSupplementaryAssetDetail(course.id, lecture.id, b.id, apiContext());
        if (detail.download_urls) {
          var found = detail.download_urls[detail.asset_type];
          if (found && found[0]) {
            lecture.supplementary.push({ src: found[0].file, name: b.title, quality: "Attachment", type: "File" });
          }
        } else {
          lecture.supplementary.push({
            src: `<script type="text/javascript">window.location = "${detail.external_url}";</script>`,
            name: b.title,
            quality: "Attachment",
            type: "Url"
          });
        }
      } catch (e) {
        // one broken attachment must not fail the whole lecture
      }
    }
  }
}

// Reads the curriculum and every lecture. Lectures without a downloadable file stay in place as
// "Skipped" entries so numbering matches the course, and are listed in data.skipped.
async function prepareCourse(course, prep, onProgress, retryOnly) {
  var options = settings.getAll().download;
  var curriculum = await udemyApi.getCurriculum(course.id, apiContext());
  var items = curriculum.results || [];
  if (!items.length) {
    var empty = new Error("empty course");
    empty.status = "empty";
    throw empty;
  }

  var data = { id: course.id, name: course.title, chapters: [], skipped: [], subs: {}, prep: prep };
  var chapter = null;
  var tasks = [];
  function newChapter(name) {
    chapter = { name: name, lectures: [] };
    data.chapters.push(chapter);
  }

  items.forEach(function(v) {
    if (v._class == "chapter") {
      newChapter(v.title);
      return;
    }
    if (!chapter) newChapter("Chapter 1");
    var assetType = v.asset && v.asset.asset_type;
    if (v._class == "lecture" && ["Video", "Article", "File", "E-Book"].includes(assetType)) {
      if (assetType != "Video" && options.skipAttachments) return;
      var lecture = {
        id: v.id,
        assetId: v.asset.id,
        assetCreated: v.asset.created || v.created || null,
        name: v.title,
        type: assetType == "E-Book" ? "File" : assetType,
        assetType: assetType
      };
      chapter.lectures.push(lecture);
      tasks.push({ lecture: lecture, chapter: chapter });
    } else if (!options.skipAttachments) {
      chapter.lectures.push({
        id: v.id,
        assetId: null,
        name: v.title,
        type: "Url",
        quality: "Attachment",
        src: `<script type="text/javascript">window.location = "https://${session.subDomain}.udemy.com${course.url}t/${v._class}/${v.id}";</script>`
      });
    }
  });

  if (retryOnly) {
    // a retry only finishes what failed or was never attempted; already-downloaded lectures
    // are trusted as is instead of re-fetched, which is what makes a retry fast
    var manifest = readManifest(courseDir(course.title));
    var known = manifest ? manifest.lectures : {};
    var dir = courseDir(course.title);
    tasks = tasks.filter(function(task) {
      var entry = known[task.lecture.id];
      var trusted = entry && entry.done !== false && entry.primary && fs.existsSync(path.join(dir, entry.primary));
      if (trusted) task.lecture._trusted = true;
      return !trusted;
    });
  }

  var done = 0;
  var denied = 0;
  await pool(tasks, 6, async function(task) {
    if (prep.cancelled) return;
    try {
      await loadLecture(task.lecture, task.chapter, course, options, data);
    } catch (e) {
      if (e.status == 401 || e.status == 403) denied++;
      skipLecture(data, task.chapter, task.lecture, e.status == 401 || e.status == 403 ? "denied" : "unavailable");
    }
    if (onProgress) onProgress(++done, tasks.length);
  });
  if (prep.cancelled) return null;

  if (tasks.length && denied == tasks.length) {
    throw httpError(403);
  }
  return data;
}

// ---------- running a download ----------
// (the actual download control flow, including its own subtitle fetch, is now
// src/download/orchestrator.ts; only retryLecture's standalone path below is still here)
// Downloads exactly one lecture, independent of any running course-level download.
// Used by the Retry action on a single failed lecture in the course details view.
async function retryLecture(courseId, lectureId) {
  if (downloadControls[courseId]) return false; // the course itself is busy; try again once it finishes
  var store = courseStore[courseId];
  if (!store || !store.byId[lectureId]) return false;

  function setLecture(patch) {
    Object.assign(store.byId[lectureId], patch);
    touchStore(courseId, lectureId);
  }
  setLecture({ state: "downloading", pct: 0, reason: "" });

  var course = { id: courseId, title: store.title, url: null };
  var options = settings.getAll().download;
  var dir = store.dir || courseDir(store.title);

  try {
    var curriculum = await udemyApi.getCurriculum(courseId, apiContext());
    // walk the curriculum to find this lecture's chapter and its position within it
    var ci = -1;
    var chapterName = "";
    var position = 0;
    var found = null;
    (curriculum.results || []).some(function(v) {
      if (v._class == "chapter") {
        ci++;
        chapterName = v.title;
        position = 0;
        return false;
      }
      if (v._class != "lecture") return false;
      var assetType = v.asset && v.asset.asset_type;
      if (!["Video", "Article", "File", "E-Book"].includes(assetType)) return false;
      position++;
      if (v.id != lectureId) return false;
      found = {
        ci: ci,
        chapterName: chapterName,
        position: position,
        lecture: {
          id: v.id,
          assetId: v.asset.id,
          assetCreated: v.asset.created || v.created || null,
          name: v.title,
          type: assetType == "E-Book" ? "File" : assetType,
          assetType: assetType
        }
      };
      return true; // stop walking, found it
    });
    if (!found) throw httpError(404);

    var courseUrl = $('.course[course-id="' + courseId + '"]').first().attr("course-url");
    await loadLecture(found.lecture, { name: found.chapterName }, { id: courseId, url: courseUrl }, options, {
      subs: {},
      skipped: []
    });

    if (found.lecture.type == "Skipped") {
      setLecture({ state: "skipped", reason: found.lecture.reason, pct: 0, badge: null });
      return false;
    }

    var folder = path.join(dir, chapterFolder(found.ci, { name: found.chapterName }));
    await fs.promises.mkdir(folder, { recursive: true });
    var primary = path.join(chapterFolder(found.ci, { name: found.chapterName }), primaryName(found.position - 1, found.lecture));
    var target = path.join(dir, primary);
    // a stale partial download resumes with the URL it was started with, not the one just
    // fetched above; this is a deliberate fresh retry, so start clean rather than risk resuming
    // against a URL that may no longer be valid
    removeQuietly(target + ".mtd", target + ".mtd.meta.json");

    if (found.lecture.type == "Article" || found.lecture.type == "Url") {
      await fs.promises.writeFile(target, found.lecture.src);
    } else {
      await retryOneFile(
        found.lecture.src,
        target,
        function(pct) {
          setLecture({ pct: pct });
        },
        courseId,
        found.lecture.name
      );
    }

    if (found.lecture.caption && !options.skipSubtitles) {
      var lang = found.lecture.caption["English"] ? "English" : Object.keys(found.lecture.caption)[0];
      await fetchSubtitleStandalone(found.lecture.caption[lang], folder, found.position - 1, found.lecture);
    }
    if (found.lecture.supplementary && !options.skipAttachments) {
      for (var ai = 0; ai < found.lecture.supplementary.length; ai++) {
        var asset = found.lecture.supplementary[ai];
        var file = path.join(folder, attachmentName(found.position - 1, ai, asset));
        if (asset.type == "Url" || asset.type == "Article") await fs.promises.writeFile(file, asset.src);
        else await retryOneFile(asset.src, file, function() {}, courseId, asset.name);
      }
    }

    var manifest = readManifest(dir) || { version: 1, courseId: courseId, title: store.title, lectures: {} };
    var size = null;
    try {
      size = fs.statSync(target).size;
    } catch (e) {}
    manifest.lectures[lectureId] = {
      assetId: found.lecture.assetId,
      created: found.lecture.assetCreated,
      title: found.lecture.name,
      primary: primary,
      quality: found.lecture.quality,
      subs: !options.skipSubtitles,
      attach: !options.skipAttachments,
      done: true,
      at: new Date().toISOString()
    };
    manifest.title = store.title;
    manifest.updatedAt = new Date().toISOString();
    writeManifest(dir, manifest);

    setLecture({
      state: "done",
      pct: 100,
      size: size,
      note: /^\d+$/.test(String(found.lecture.quality || "")) ? found.lecture.quality + "p" : found.lecture.quality || "",
      badge: null
    });
    return true;
  } catch (err) {
    setLecture({ state: "failed", reason: describeError(err.status), speed: 0 });
    return false;
  }
}

// A small retrying single-file downloader, for retryLecture (no pause/resume, just retry on drop).
// rangeDownloader.ts (see its own header comment) owns retrying each byte range internally and
// only reports "end" once the file is actually, fully renamed to its final name, so there is no
// separate stall watchdog here racing against it: what the promise settles with is always what is
// really on disk.
function retryOneFile(url, dest, onProgress, courseId, label) {
  var downloader = new Downloader();
  function attempt() {
    return new Promise(function(resolve, reject) {
      var dl = fs.existsSync(dest + ".mtd") ? downloader.resumeDownload(dest) : downloader.download(url, dest);
      dl.setRetryOptions({ maxRetries: 2, retryInterval: 1500 });
      dl.setOptions({ threadsCount: 5, timeout: 20000 });
      dl.on("progress", function(stats) {
        onProgress(Math.round(stats.total.completed) || 0);
      });
      dl.on("log", function(e) {
        if (courseId) devlog[e.level == "error" ? "error" : e.level == "warn" ? "warn" : "info"](courseId, (label ? label + ": " : "") + e.text);
      });
      dl.on("end", function() {
        if (courseId) devlog.info(courseId, (label ? label + ": " : "") + "done");
        resolve();
      });
      dl.on("error", function() {
        var status = (dl.error && dl.error.status) || 0;
        if (courseId) devlog.error(courseId, (label ? label + ": " : "") + "failed (" + (status || "connection") + ")");
        if (status == 401 || status == 403) removeQuietly(dl.filePath, dl.filePath + ".mtd", dl.filePath + ".mtd.meta.json");
        reject(httpError(status));
      });
      dl.start();
    });
  }
  return (async function() {
    for (var i = 1; ; i++) {
      try {
        return await attempt();
      } catch (e) {
        if (i >= 2) throw e;
        await new Promise(function(r) {
          setTimeout(r, 1500 * i);
        });
      }
    }
  })();
}

// Same subtitle fetch as inside initDownload, usable standalone by retryLecture.
function fetchSubtitleStandalone(url, dir, lectureIndex, lecture) {
  var vttName = sanitize(lectureIndex + 1 + ". " + lecture.name.trim() + ".vtt");
  var vtt = path.join(dir, vttName);
  var srt = vtt.replace(/\.vtt$/, ".srt");
  if (fs.existsSync(srt)) return Promise.resolve();
  return new Promise(function(resolve, reject) {
    var out = fs.createWriteStream(vtt);
    out.on("finish", resolve);
    out.on("error", reject);
    https.get(url, function(response) {
      response.pipe(out);
    }).on("error", reject);
  })
    .then(function() {
      return new Promise(function(resolve, reject) {
        var final = fs.createWriteStream(srt);
        final.on("finish", resolve);
        final.on("error", reject);
        fs.createReadStream(vtt)
          .pipe(vtt2srt())
          .pipe(final);
      });
    })
    .then(function() {
      removeQuietly(vtt);
    });
}

// The control flow (sequencing, retry, pause/resume/cancel) lives in src/download/orchestrator.ts
// as CourseDownload, which knows nothing about the DOM or translate(): it emits typed events
// carrying raw data, and this function's only job is turning those into exactly the same
// ui.Row.*/mark()/translate() calls the old, single monolithic initDownload() made inline.
async function initDownload($course, data, subtitle = false) {
  if (data.prep && data.prep.cancelled) return;
  var courseId = $course.attr("course-id");
  ensureDownloadRow($course);
  // every UI update goes to all rows of this course (Courses and Downloads lists)
  var rows = function() {
    return $('.course[course-id="' + courseId + '"]');
  };

  var options = settings.getAll().download;
  var dir = courseDir(data.name);
  var store = null;
  var cancelled = false;

  function mark(lectureId, patch) {
    if (!store || !store.byId[lectureId]) return;
    Object.assign(store.byId[lectureId], patch);
    touchStore(courseId, lectureId);
  }

  function finish(kind, text) {
    if (cancelled) return;
    touchStore(courseId);
    delete downloadControls[courseId];
    ui.Row.state(rows(), kind);
    ui.Row.text(rows(), text);
    ui.Row.now(rows(), "");
  }

  var cd = new orchestratorModule.CourseDownload({
    courseId: courseId,
    data: data,
    dir: dir,
    options: options,
    subtitle: subtitle,
    plan: function(inScope) {
      return planUpdates(data, dir, options, inScope);
    },
    onLog: function(logCourseId, level, text) {
      devlog[level](logCourseId, text);
    }
  });

  downloadControls[courseId] = {
    pause: function() { cd.pause(); },
    resume: function() { cd.resume(); },
    cancel: function() { cd.cancel(); }
  };

  cd.on("started", function(info) {
    ui.Row.state(rows(), "downloading");
    ui.Row.now(rows(), "");
    rows().attr("data-path", info.dir);
  });

  cd.on("status", function(key) {
    var text = key == "checking-updates" ? translate("Checking for updates") : translate("Connection lost, trying again");
    ui.Row.text(rows(), text + "…");
  });

  cd.on("planned", function(info) {
    store = buildStore(courseId, data.name, dir, data, "downloading", info.hadManifest);
    touchStore(courseId);
  });

  cd.on("lecture-start", function(item) {
    mark(item.lecture.id, { state: "downloading", pct: 0 });
  });

  cd.on("progress", function(info) {
    var view = info.view;
    var parts = [translate("Lecture") + " " + Math.min(info.done + 1, info.total) + "/" + info.total];
    if (view.quality) parts.push(view.quality);
    if (!info.paused && view.speed) parts.push(ui.formatSpeed(view.speed));
    ui.Row.progress(rows(), info.done + (view.filePct || 0) / 100, info.total);
    ui.Row.text(rows(), (info.paused ? translate("Paused") + " · " : "") + parts.join(" · "));
    ui.Row.now(rows(), view.name + (view.filePct ? " · " + view.filePct + "%" : ""));
    if (info.currentItem) mark(info.currentItem.lecture.id, { pct: view.filePct || 0, speed: info.paused ? 0 : view.speed, note: view.quality });
  });

  cd.on("lecture-done", function(info) {
    mark(info.item.lecture.id, { state: "done", pct: 100, size: info.size, speed: 0 });
  });

  cd.on("lecture-failed", function(info) {
    mark(info.item.lecture.id, { state: "failed", reason: describeError(info.status, info.item.lecture.name), speed: 0, pct: 0 });
  });

  cd.on("row-progress", function(info) {
    ui.Row.progress(rows(), info.done, info.total);
  });

  cd.on("paused", function() {
    ui.Row.state(rows(), "paused");
  });

  cd.on("resumed", function() {
    ui.Row.state(rows(), "downloading");
  });

  cd.on("cancelled", function(info) {
    cancelled = true;
    if (info.lectureId) mark(info.lectureId, { state: "queued", pct: 0, speed: 0 });
    if (store) store.phase = "idle";
    touchStore(courseId);
    delete downloadControls[courseId];
    ui.Row.state(rows(), "idle");
    ui.Row.text(rows(), translate("Canceled"));
    ui.Row.now(rows(), "");
    ui.Row.progress(rows(), 0, 0);
  });

  cd.on("retrying", function() {
    ui.Row.text(rows(), translate("Retrying") + "…");
  });

  cd.on("finished", function(info) {
    var skippedNote = info.skippedCount
      ? " · " + info.skippedCount + " " + translate(info.skippedCount == 1 ? "lecture skipped (protected or unavailable)" : "lectures skipped (protected or unavailable)")
      : "";

    if (info.reason == "no-downloadable") {
      finish(
        "error",
        info.skippedCount
          ? translate("None of the lectures can be downloaded. They are protected or unavailable.")
          : translate("This course has no downloadable lectures.")
      );
      return;
    }

    if (info.reason == "up-to-date") {
      var checked = new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      ui.Row.progress(rows(), 1, 1);
      if (store) store.phase = "done";
      finish("done", translate("Up to date") + " · " + info.counts.unchanged + " " + translate("lectures unchanged") + skippedNote + " · " + checked);
      return;
    }

    if (info.reason == "unexpected-error") {
      if (store) store.phase = "error";
      finish("error", describeError(info.status, info.lectureName));
      return;
    }

    // "completed" or "partial-failure": the loop ran to the end, with real done/total/failed numbers
    var when = new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    var changes = info.hadManifest
      ? " · " + info.counts.new + " " + translate("new") + ", " + info.counts.updated + " " + translate("updated") + ", " + info.counts.unchanged + " " + translate("unchanged")
      : "";
    ui.Row.progress(rows(), info.total, info.total);
    if (info.failed.length) {
      if (store) store.phase = "error";
      var failNote = " · " + info.failed.length + " " + translate(info.failed.length == 1 ? "lecture failed" : "lectures failed");
      finish("error", translate("Downloaded") + " " + info.done + "/" + info.total + failNote + skippedNote);
    } else {
      if (store) store.phase = "done";
      finish("done", translate("Completed") + " · " + when + changes + skippedNote);
    }
  });

  await cd.run();
}
