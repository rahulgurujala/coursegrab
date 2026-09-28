// Course download engine: reads a course from Udemy, decides what needs downloading
// (new, updated or missing lectures only) and saves it to disk.
//
// Loaded after app.js, which provides: $, ui, settings, translate, headers, subDomain,
// fs, homedir, sanitize, vtt2srt, https, Downloader, downloadControls, ensureDownloadRow.

const path = require("path");

const MANIFEST_FILE = ".coursegrab.json";
const SKIPPED_FILE = "Skipped lectures.txt";

// ---------- helpers ----------
function api(url) {
  return new Promise(function(resolve, reject) {
    $.ajax({
      type: "GET",
      url: url,
      headers: headers,
      success: resolve,
      error: function(xhr) {
        var err = new Error("HTTP " + xhr.status);
        err.status = xhr.status;
        reject(err);
      }
    });
  });
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

function chapterFolder(chapterIndex, chapter) {
  return sanitize(chapterIndex + 1 + ". " + chapter.name);
}

// Same file names as earlier versions, so folders from older downloads are recognised.
function primaryName(lectureIndex, lecture) {
  var base = lectureIndex + 1 + ". " + lecture.name.trim();
  if (lecture.type == "Article" || lecture.type == "Url") {
    return sanitize(base + ".html");
  }
  return sanitize(base + "." + (lecture.type == "File" ? "pdf" : "mp4"));
}

function readManifest(dir) {
  try {
    var manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8"));
    return manifest && manifest.lectures ? manifest : null;
  } catch (e) {
    return null;
  }
}

function writeManifest(dir, manifest) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 1));
  } catch (e) {
    // the manifest only speeds up later updates; never fail a download over it
  }
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
  var response = await api(
    `https://${subDomain}.udemy.com/api-2.0/users/me/subscribed-courses/${course.id}/lectures/${lecture.id}?fields[asset]=stream_urls,download_urls,captions,title,filename,data,body&fields[lecture]=asset,supplementary_assets`
  );
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
        var detail = await api(
          `https://${subDomain}.udemy.com/api-2.0/users/me/subscribed-courses/${course.id}/lectures/${lecture.id}/supplementary-assets/${b.id}?fields[asset]=download_urls,external_url,asset_type`
        );
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
async function prepareCourse(course, prep, onProgress) {
  var options = settings.getAll().download;
  var curriculum = await api(
    `https://${subDomain}.udemy.com/api-2.0/courses/${course.id}/cached-subscriber-curriculum-items?page_size=100000`
  );
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
function planUpdates(data, dir, options, inScope) {
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

      if (!entry) {
        lecture.status = "new";
      } else if (
        (entry.assetId != null && lecture.assetId != null && entry.assetId != lecture.assetId) ||
        (entry.created && lecture.assetCreated && entry.created != lecture.assetCreated)
      ) {
        // the instructor replaced this video: fetch the new one
        lecture.status = "updated";
        var old = path.join(dir, entry.primary || primary);
        removeQuietly(old, old + ".mtd", old.replace(/\.[^.]+$/, ".srt"), target, target + ".mtd");
      } else {
        // same content; follow a rename or reorder by moving the file instead of downloading again
        var oldPath = entry.primary ? path.join(dir, entry.primary) : target;
        if (oldPath != target && fs.existsSync(oldPath) && !fs.existsSync(target)) {
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
          fs.existsSync(target) &&
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
  if (asset.type == "Url" || asset.type == "Article") return sanitize(base + ".html");
  var sourceExt = asset.src.split("/").pop().split(".").pop().split("?").shift();
  var nameExt = asset.name.split(".").pop();
  return sanitize(base + (nameExt == sourceExt ? "" : "." + sourceExt));
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
      delete downloadControls[courseId];
      ui.Row.state(rows(), "idle");
      ui.Row.text(rows(), translate("Canceled"));
      ui.Row.now(rows(), "");
      ui.Row.progress(rows(), 0, 0);
    }
  };

  function errorReason(status) {
    var base =
      status == 401 || status == 403
        ? translate("Access was denied. Your session may have expired: sign in again, then retry.")
        : translate("The connection was interrupted.");
    return (view.name ? "“" + view.name + "”: " : "") + base;
  }

  function finish(kind, text) {
    if (cancelled) return;
    delete downloadControls[courseId];
    ui.Row.state(rows(), kind);
    ui.Row.text(rows(), text);
    ui.Row.now(rows(), "");
  }

  // Downloads one file. Partly downloaded files continue where they stopped and complete files are kept.
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

      var timer = null;
      var settled = false;
      function settle(err) {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        canPause = false;
        current = null;
        err ? reject(err) : resolve();
      }
      current = { dl: dl, abort: function() { settle(new Error("cancelled")); } };

      dl.setRetryOptions({ retryInterval: 5000 });
      dl.setOptions({ threadsCount: 5 });
      dl.on("error", function() {
        // handled through the status checks below
      });
      dl.on("start", function() {
        canPause = true;
      });
      dl.on("end", function() {
        settle();
      });
      dl.start();

      var notStarted = 0;
      var restarted = 0;
      timer = setInterval(function() {
        switch (dl.status) {
          case 0:
            // if it does not start in a reasonable time, start again; errors of older tries are ignored
            if (restarted <= 5) {
              notStarted++;
              if (notStarted >= 15) {
                dl.start();
                notStarted = 0;
                restarted++;
              }
            }
            view.speed = 0;
            paint();
            break;
          case 1:
            var running = dl.getStats();
            view.speed = parseInt(running.present.speed / 1000) || 0;
            view.filePct = Math.round(running.total.completed) || 0;
            paint();
            break;
          case 2:
            break;
          case -1:
            var failed = dl.getStats();
            view.speed = parseInt(failed.present.speed / 1000) || 0;
            view.filePct = Math.round(failed.total.completed) || 0;
            paint();
            if (dl.stats.total.size == 0 && fs.existsSync(dl.filePath)) {
              dl.emit("end");
              break;
            }
            clearInterval(timer);
            $.ajax({
              type: "HEAD",
              url: dl.url,
              error: function(xhr) {
                if (xhr.status == 401 || xhr.status == 403) removeQuietly(dl.filePath);
                settle(httpError(xhr.status));
              },
              success: function() {
                settle(httpError(0));
              }
            });
            break;
          default:
            view.speed = 0;
            paint();
        }
      }, 1000);
    });
  }

  // A dropped connection is retried a few times, continuing from the data already saved.
  async function fetchFileWithRetry(url, dest) {
    for (var attempt = 1; ; attempt++) {
      try {
        return await fetchFile(url, dest);
      } catch (err) {
        var denied = err.status == 401 || err.status == 403;
        if (cancelled || denied || attempt >= 3) throw err;
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
      finish("done", translate("Up to date") + " · " + plan.counts.unchanged + " " + translate("lectures unchanged") + skippedNote + " · " + checked);
      return;
    }

    for (var item of work) {
      if (cancelled) return;
      await downloadLecture(item);
      if (cancelled) return;
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
    finish("done", translate("Completed") + " · " + when + changes + skippedNote);
  } catch (err) {
    if (cancelled) return;
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
