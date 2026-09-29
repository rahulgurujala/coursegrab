// Course download engine: reads a course from Udemy, decides what needs downloading
// (new, updated or missing lectures only) and saves it to disk.
//
// Loaded after app.js, which provides: $, ui, settings, translate, subDomain,
// fs, homedir, sanitize, vtt2srt, https, Downloader, downloadControls, ensureDownloadRow.
// Udemy API calls live in src/api/udemy.ts, course state in src/store/*.ts (both compiled to
// dist/ and required below, the same way assets/js/rangeDownloader.js already is).

const path = require("path");
const udemyApi = require("./dist/api/udemy.js");
const manifestStore = require("./dist/store/manifest.js");
const courseStoreModule = require("./dist/store/courseStore.js");

const SKIPPED_FILE = "Skipped lectures.txt";

// courseStore is the SAME object courseStoreModule exports, not a copy: assets/js/details.js
// still reads the global `courseStore` directly (courseStore[id], courseStore[id].byId[...]),
// and will keep doing so unchanged until it is ported too.
var courseStore = courseStoreModule.courseStore;
var readManifest = manifestStore.readManifest;
var writeManifest = manifestStore.writeManifest;
var buildStore = courseStoreModule.buildStore;

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
// network call itself), compiled to dist/api/udemy.js and require()'d the same way
// assets/js/rangeDownloader.js already is. This just supplies the auth/logging context it needs.
function apiContext() {
  return {
    subDomain: subDomain,
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

// A single path segment must stay well under the filesystem's NAME_MAX (255 bytes on every
// platform this app targets). This is also the backstop against a malformed URL ever producing
// a name the OS refuses to open (see guessExtension's comment for a real case of exactly that).
function capName(name, maxLen) {
  maxLen = maxLen || 150;
  if (name.length <= maxLen) return name;
  var dot = name.lastIndexOf(".");
  var ext = dot > -1 && name.length - dot <= 12 ? name.slice(dot) : "";
  return name.slice(0, maxLen - ext.length) + ext;
}

function chapterFolder(chapterIndex, chapter) {
  return capName(sanitize(chapterIndex + 1 + ". " + chapter.name));
}

// Same file names as earlier versions, so folders from older downloads are recognised.
function primaryName(lectureIndex, lecture) {
  var base = lectureIndex + 1 + ". " + lecture.name.trim();
  if (lecture.type == "Article" || lecture.type == "Url") {
    return capName(sanitize(base + ".html"));
  }
  return capName(sanitize(base + "." + (lecture.type == "File" ? "pdf" : "mp4")));
}

// Best-effort file extension from a download URL. Some of Udemy's supplementary-asset URLs are
// missing the "?" that should separate the path from the query string: a real failure had
// "Expires=...&Signature=..." glued directly onto the filename with no "?" at all, which broke
// the previous "everything after the last dot" guess and produced an ENAMETOOLONG-length name.
// Split on either separator, and only trust a result that actually looks like an extension.
function guessExtension(url) {
  var path = (url || "").split(/[?&]/)[0];
  var last = path.split("/").pop() || "";
  var dot = last.lastIndexOf(".");
  var ext = dot == -1 ? "" : last.slice(dot + 1);
  return /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext : "";
}

function removeQuietly() {
  for (var i = 0; i < arguments.length; i++) {
    try {
      fs.unlinkSync(arguments[i]);
    } catch (e) {}
  }
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
        src: `<script type="text/javascript">window.location = "https://${subDomain}.udemy.com${course.url}t/${v._class}/${v.id}";</script>`
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

// ---------- what needs downloading ----------
// Compares the course with the manifest saved in its folder by an earlier download.
function planUpdates(data, dir, options, inScope, dryRun) {
  var manifest = readManifest(dir);
  var known = manifest ? manifest.lectures : {};
  var counts = { new: 0, updated: 0, missing: 0, unchanged: 0 };
  var seen = {};

  data.chapters.forEach(function(chapter, ci) {
    chapter.lectures.forEach(function(lecture, li) {
      if (lecture.type == "Skipped") return;
      var entry = known[lecture.id];
      var primary = path.join(chapterFolder(ci, chapter), primaryName(li, lecture));
      var target = path.join(dir, primary);
      seen[lecture.id] = true;
      lecture.primary = primary;
      if (!inScope[lecture.id]) {
        // outside the chosen lecture range: leave files and records alone
        lecture.status = "outside";
        lecture.skip = true;
        return;
      }

      if (lecture._trusted) {
        // retrying the course: already downloaded successfully before, take it as is without
        // re-checking Udemy for this lecture (that is what Get updates is for)
        lecture.status = "unchanged";
        lecture.skip = true;
        counts.unchanged++;
        return;
      }

      if (!entry) {
        lecture.status = "new";
      } else if (
        (entry.assetId != null && lecture.assetId != null && entry.assetId != lecture.assetId) ||
        (entry.created && lecture.assetCreated && entry.created != lecture.assetCreated)
      ) {
        // the instructor replaced this video: fetch the new one
        lecture.status = "updated";
        var old = path.join(dir, entry.primary || primary);
        if (!dryRun) removeQuietly(old, old + ".mtd", old + ".mtd.meta.json", old.replace(/\.[^.]+$/, ".srt"), target, target + ".mtd", target + ".mtd.meta.json");
      } else {
        // same content; follow a rename or reorder by moving the file instead of downloading again
        var oldPath = entry.primary ? path.join(dir, entry.primary) : target;
        var moved = oldPath != target && fs.existsSync(oldPath) && !fs.existsSync(target);
        if (moved && !dryRun) {
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(oldPath, target);
            var oldSub = oldPath.replace(/\.[^.]+$/, ".srt");
            if (fs.existsSync(oldSub)) fs.renameSync(oldSub, target.replace(/\.[^.]+$/, ".srt"));
          } catch (e) {}
        }
        var wantsSubs = !options.skipSubtitles && !!lecture.caption;
        var wantsFiles = !options.skipAttachments && !!(lecture.supplementary && lecture.supplementary.length);
        var complete =
          (fs.existsSync(target) || (dryRun && moved)) &&
          !fs.existsSync(target + ".mtd") &&
          entry.done !== false &&
          (!wantsSubs || entry.subs) &&
          (!wantsFiles || entry.attach);
        lecture.status = complete ? "unchanged" : "missing";
      }
      counts[lecture.status]++;
      lecture.skip = lecture.status == "unchanged";
    });
  });

  var removed = Object.keys(known).filter(function(id) {
    return !seen[id];
  }).length;
  return { manifest: manifest, counts: counts, removed: removed, hadManifest: !!manifest };
}

// ---------- running a download ----------
function fetchSubtitle(url, dir, lectureIndex, lecture) {
  var vttName = sanitize(lectureIndex + 1 + ". " + lecture.name.trim() + ".vtt");
  var vtt = path.join(dir, vttName);
  var srt = vtt.replace(/\.vtt$/, ".srt");
  if (fs.existsSync(srt)) return Promise.resolve();
  return new Promise(function(resolve, reject) {
    var out = fs.createWriteStream(vtt);
    out.on("finish", resolve);
    out.on("error", reject);
    https.get(url, function(response) { response.pipe(out); }).on("error", reject);
  })
    .then(function() {
      return new Promise(function(resolve, reject) {
        var final = fs.createWriteStream(srt);
        final.on("finish", resolve);
        final.on("error", reject);
        fs.createReadStream(vtt).pipe(vtt2srt()).pipe(final);
      });
    })
    .then(function() {
      removeQuietly(vtt);
    });
}

function attachmentName(lectureIndex, index, asset) {
  var base = lectureIndex + 1 + "." + (index + 1) + " " + asset.name.trim();
  if (asset.type == "Url" || asset.type == "Article") return capName(sanitize(base + ".html"));
  var nameExt = asset.name.indexOf(".") > -1 ? asset.name.split(".").pop() : "";
  var ext = guessExtension(asset.src) || nameExt || "bin";
  return capName(sanitize(base + (nameExt == ext ? "" : "." + ext)));
}

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
// rangeDownloader.js (see its own header comment) owns retrying each byte range internally and
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
  var view = { quality: "", speed: 0, name: "", filePct: 0 };
  var cancelled = false;
  var paused = false;
  var canPause = false;
  var current = null; // { dl, abort } of the file being downloaded
  var downloader = new Downloader();
  var done = 0;
  var total = 0;

  var store = null;
  var currentItem = null;
  function mark(lecture, patch) {
    if (!store || !store.byId[lecture.id]) return;
    Object.assign(store.byId[lecture.id], patch);
    touchStore(courseId, lecture.id);
  }

  ui.Row.state(rows(), "downloading");
  ui.Row.now(rows(), "");
  rows().attr("data-path", dir);

  function paint() {
    var parts = [translate("Lecture") + " " + Math.min(done + 1, total) + "/" + total];
    if (view.quality) parts.push(view.quality);
    if (!paused && view.speed) parts.push(ui.formatSpeed(view.speed));
    ui.Row.progress(rows(), done + (view.filePct || 0) / 100, total);
    ui.Row.text(rows(), (paused ? translate("Paused") + " · " : "") + parts.join(" · "));
    ui.Row.now(rows(), view.name + (view.filePct ? " · " + view.filePct + "%" : ""));
    if (currentItem) mark(currentItem.lecture, { pct: view.filePct || 0, speed: paused ? 0 : view.speed, note: view.quality });
  }

  downloadControls[courseId] = {
    pause: function() {
      if (!canPause || cancelled || !current) return;
      try {
        current.dl.stop();
      } catch (e) {}
      paused = true;
      view.speed = 0;
      ui.Row.state(rows(), "paused");
      paint();
    },
    resume: function() {
      try {
        if (current) current.dl.resume();
      } catch (e) {}
      paused = false;
      ui.Row.state(rows(), "downloading");
      paint();
    },
    cancel: function() {
      cancelled = true;
      if (current) {
        try {
          current.dl.stop();
        } catch (e) {}
        current.abort();
      }
      if (currentItem) mark(currentItem.lecture, { state: "queued", pct: 0, speed: 0 });
      if (store) store.phase = "idle";
      touchStore(courseId);
      delete downloadControls[courseId];
      ui.Row.state(rows(), "idle");
      ui.Row.text(rows(), translate("Canceled"));
      ui.Row.now(rows(), "");
      ui.Row.progress(rows(), 0, 0);
    }
  };

  function errorReason(status) {
    return describeError(status, view.name);
  }

  function finish(kind, text) {
    if (cancelled) return;
    touchStore(courseId);
    delete downloadControls[courseId];
    ui.Row.state(rows(), kind);
    ui.Row.text(rows(), text);
    ui.Row.now(rows(), "");
  }

  // Downloads one file. Partly downloaded files continue where they stopped and complete files are kept.
  // rangeDownloader.js (see its header comment) retries each byte range on its own and only ever
  // reports "end" once the file has actually been renamed to its final, complete name, so there is
  // no separate watchdog here racing its own stop() against the download finishing anyway: what
  // this promise settles with always matches what is really on disk.
  function fetchFile(url, dest) {
    return new Promise(function(resolve, reject) {
      var dl;
      if (fs.existsSync(dest + ".mtd")) {
        dl = downloader.resumeDownload(dest);
        if (!fs.statSync(dest + ".mtd").size) dl = downloader.download(url, dest);
      } else if (fs.existsSync(dest)) {
        resolve();
        return;
      } else {
        dl = downloader.download(url, dest);
      }

      var settled = false;
      function settle(err) {
        if (settled) return;
        settled = true;
        canPause = false;
        current = null;
        err ? reject(err) : resolve();
      }
      current = { dl: dl, abort: function() { settle(new Error("cancelled")); } };
      dl.setRetryOptions({ maxRetries: 2, retryInterval: 1500 });
      dl.setOptions({ threadsCount: 5, timeout: 20000 });
      dl.on("start", function() {
        canPause = true;
      });
      dl.on("progress", function(stats) {
        view.speed = parseInt(stats.present.speed / 1000) || 0;
        view.filePct = Math.round(stats.total.completed) || 0;
        paint();
      });
      dl.on("log", function(e) {
        devlog[e.level == "error" ? "error" : e.level == "warn" ? "warn" : "info"](courseId, view.name + ": " + e.text);
      });
      dl.on("end", function() {
        settle();
      });
      dl.on("error", function() {
        var status = (dl.error && dl.error.status) || 0;
        devlog.error(courseId, view.name + ": failed (" + (status || "connection") + ")");
        if (status == 401 || status == 403) removeQuietly(dl.filePath, dl.filePath + ".mtd", dl.filePath + ".mtd.meta.json");
        settle(httpError(status));
      });
      dl.start();
    });
  }

  // A dropped connection is retried a few times, continuing from the data already saved.
  async function fetchFileWithRetry(url, dest) {
    for (var attempt = 1; ; attempt++) {
      try {
        return await fetchFile(url, dest);
      } catch (err) {
        var denied = err.status == 401 || err.status == 403;
        if (cancelled || denied || attempt >= 2) throw err;
        devlog.warn(courseId, view.name + ": lecture-level retry " + attempt + " after " + (err.status || "connection error"));
        ui.Row.text(rows(), translate("Connection lost, trying again") + "…");
        await new Promise(function(resolve) {
          setTimeout(resolve, 1500 * attempt);
        });
        if (cancelled) throw err;
      }
    }
  }

  async function saveLecture(item, manifest) {
    var lecture = item.lecture;
    manifest.lectures[lecture.id] = {
      assetId: lecture.assetId,
      created: lecture.assetCreated,
      title: lecture.name,
      primary: lecture.primary,
      quality: lecture.quality,
      subs: !options.skipSubtitles,
      attach: !options.skipAttachments,
      done: true,
      at: new Date().toISOString()
    };
    manifest.title = data.name;
    manifest.updatedAt = new Date().toISOString();
    writeManifest(dir, manifest);
  }

  async function downloadLecture(item) {
    var lecture = item.lecture;
    var folder = path.join(dir, chapterFolder(item.ci, data.chapters[item.ci]));
    await fs.promises.mkdir(folder, { recursive: true });
    view.name = lecture.name;
    view.filePct = 0;
    view.quality = /^\d+$/.test(lecture.quality || "") && lecture.type == "Video" ? lecture.quality + "p" : lecture.quality || "";
    paint();

    var target = path.join(folder, primaryName(item.li, lecture));
    if (lecture.type == "Article" || lecture.type == "Url") {
      await fs.promises.writeFile(target, lecture.src);
    } else {
      await fetchFileWithRetry(lecture.src, target);
    }
    if (cancelled) return;

    if (lecture.caption && subtitle) {
      view.filePct = 0;
      view.quality = "Subtitle";
      view.speed = 0;
      paint();
      await fetchSubtitle(lecture.caption[subtitle] || lecture.caption[Object.keys(lecture.caption)[0]], folder, item.li, lecture);
    }

    if (lecture.supplementary) {
      for (var ai = 0; ai < lecture.supplementary.length; ai++) {
        if (cancelled) return;
        var asset = lecture.supplementary[ai];
        view.filePct = 0;
        view.quality = asset.quality;
        paint();
        var file = path.join(folder, attachmentName(item.li, ai, asset));
        if (asset.type == "Url" || asset.type == "Article") await fs.promises.writeFile(file, asset.src);
        else await fetchFileWithRetry(asset.src, file);
      }
    }
  }

  try {
    // what to download: every lecture in the chosen range, minus what is already saved and unchanged
    var all = [];
    data.chapters.forEach(function(chapter, ci) {
      chapter.lectures.forEach(function(lecture, li) {
        if (lecture.type != "Skipped") all.push({ ci: ci, li: li, lecture: lecture });
      });
    });
    ui.Row.text(rows(), translate("Checking for updates") + "…");
    var selected = all;
    if (options.enableDownloadStartEnd && all.length) {
      var start = Math.max(1, Math.min(options.downloadStart || 1, all.length));
      var end = options.downloadEnd;
      if (!end || end < 1 || end > all.length) end = all.length;
      if (start > end) start = end;
      selected = all.slice(start - 1, end);
    }
    var inScope = {};
    selected.forEach(function(item) {
      inScope[item.lecture.id] = true;
    });
    var plan = planUpdates(data, dir, options, inScope);
    var work = selected.filter(function(item) {
      return !item.lecture.skip;
    });
    total = work.length;
    store = buildStore(courseId, data.name, dir, data, "downloading", plan.hadManifest);
    touchStore(courseId);

    var skippedNote = data.skipped.length
      ? " · " + data.skipped.length + " " + translate(data.skipped.length == 1 ? "lecture skipped (protected or unavailable)" : "lectures skipped (protected or unavailable)")
      : "";

    if (data.skipped.length) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, SKIPPED_FILE),
          "These lectures were not downloaded because they are protected or unavailable.\n\n" +
            data.skipped.map(function(s) { return s.chapter + ": " + s.name + " (" + s.reason + ")"; }).join("\n") +
            "\n"
        );
      } catch (e) {}
    }

    if (!all.length) {
      finish(
        "error",
        data.skipped.length
          ? translate("None of the lectures can be downloaded. They are protected or unavailable.")
          : translate("This course has no downloadable lectures.")
      );
      return;
    }

    var manifest = plan.manifest || { version: 1, courseId: courseId, title: data.name, lectures: {} };

    if (!work.length) {
      var checked = new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      ui.Row.progress(rows(), 1, 1);
      writeManifest(dir, manifest);
      if (store) store.phase = "done";
      finish("done", translate("Up to date") + " · " + plan.counts.unchanged + " " + translate("lectures unchanged") + skippedNote + " · " + checked);
      return;
    }

    var failed = [];
    for (var item of work) {
      if (cancelled) return;
      currentItem = item;
      mark(item.lecture, { state: "downloading", pct: 0 });
      try {
        await downloadLecture(item);
      } catch (err) {
        if (cancelled) return;
        var reason = errorReason(err.status);
        mark(item.lecture, { state: "failed", reason: reason, speed: 0, pct: 0 });
        failed.push({ chapter: data.chapters[item.ci].name, name: item.lecture.name, reason: reason });
        currentItem = null;
        continue; // one lecture failing must not stop the rest of the course
      }
      if (cancelled) return;
      var savedSize = null;
      try {
        savedSize = fs.statSync(path.join(dir, item.lecture.primary)).size;
      } catch (e) {}
      mark(item.lecture, { state: "done", pct: 100, size: savedSize, speed: 0 });
      currentItem = null;
      done++;
      view.filePct = 0;
      await saveLecture(item, manifest);
      ui.Row.progress(rows(), done, total);
    }
    // lectures that were left alone keep their entry; make sure the file exists after a first run
    writeManifest(dir, manifest);

    var when = new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    var changes = plan.hadManifest
      ? " · " + plan.counts.new + " " + translate("new") + ", " + plan.counts.updated + " " + translate("updated") + ", " + plan.counts.unchanged + " " + translate("unchanged")
      : "";
    ui.Row.progress(rows(), total, total);
    if (failed.length) {
      if (store) store.phase = "error";
      var failNote =
        " · " + failed.length + " " + translate(failed.length == 1 ? "lecture failed" : "lectures failed");
      finish("error", translate("Downloaded") + " " + done + "/" + total + failNote + skippedNote);
    } else {
      if (store) store.phase = "done";
      finish("done", translate("Completed") + " · " + when + changes + skippedNote);
    }
  } catch (err) {
    if (cancelled) return;
    if (currentItem) mark(currentItem.lecture, { state: "failed", reason: errorReason(err.status), speed: 0 });
    if (store) store.phase = "error";
    if (options.autoRetry && (data.retries || 0) < 5) {
      data.retries = (data.retries || 0) + 1;
      ui.Row.text(rows(), translate("Retrying") + "…");
      setTimeout(function() {
        initDownload(rows().filter("#downloads-list .course").first(), data, subtitle);
      }, 5000 * data.retries);
      return;
    }
    finish("error", errorReason(err.status));
  }
}
