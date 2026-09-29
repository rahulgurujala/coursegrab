// A small, direct multi-connection HTTP(S) range downloader. Replaces mt-files-downloader.
//
// Root cause of "file is actually complete on disk but the app shows it failed": that library
// writes into a .mtd file and only renames it to the final name once its whole internal task
// chain (validate, truncate, rename) finishes, but its own DownloadValidator considers the
// download valid as soon as ANY ONE of the parallel threads reaches its end, not all of them,
// and stop()/destroy() only tear down its thread/socket objects, not that already-scheduled
// task chain. Our own stall watchdog (built to work around the library's other bugs) could call
// stop() while the chain was in that finalize tail, which the library then silently swallowed
// (status already "stopped") rather than reporting one way or the other; the finalize chain kept
// running anyway and renamed the file to its final, complete name a moment later. Our code had
// already reported "failed" and moved on by then, so the file was complete but the UI was not.
//
// This module owns the whole lifecycle directly: it writes into <dest>.mtd (a real, pre-sized
// file with only the fetched byte ranges filled in, matching the old on-disk contract that the
// rest of the app already checks for), tracks each range's own progress in a small sidecar JSON,
// and only ever renames to <dest> once every range has actually finished. "end" and "error" are
// therefore always in sync with what is really on disk; there is no separate finalize step that
// can succeed after the promise has already settled.

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { EventEmitter } = require("events");
const { URL } = require("url");

function workPath(dest) {
  return dest + ".mtd";
}
function metaPath(dest) {
  return dest + ".mtd.meta.json";
}

// Every place in the app that cleans up a partial download removes both.
function partialPaths(dest) {
  return [workPath(dest), metaPath(dest)];
}

const MAX_REDIRECTS = 5;

function request(url, options) {
  return new Promise(function(resolve, reject) {
    function go(u, hops) {
      var parsed = new URL(u);
      var lib = parsed.protocol == "http:" ? http : https;
      var req = lib.request(parsed, options, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops >= MAX_REDIRECTS) {
            reject(Object.assign(new Error("Too many redirects"), { status: 0 }));
            return;
          }
          go(new URL(res.headers.location, u).href, hops + 1);
          return;
        }
        resolve({ res: res, req: req });
      });
      req.on("timeout", function() {
        req.destroy(new Error("timeout"));
      });
      req.on("error", function(e) {
        reject(e);
      });
      req.end();
    }
    go(url, 0);
  });
}

class Download extends EventEmitter {
  constructor() {
    super();
    // -3 destroyed, -2 stopped/paused, -1 error, 0 not started, 1 downloading, 3 finished
    this.status = 0;
    this.url = "";
    this.filePath = "";
    this.error = null;
    this._threadsCount = 5;
    this._timeout = 20000;
    this._retry = { maxRetries: 2, retryInterval: 1500 };
    this._ranges = null;
    this._size = 0;
    this._fd = null;
    this._aborted = false;
    this._requests = [];
    this._lastSaved = 0;
    this._lastEmit = 0;
    this._speedSamples = [];
    this.stats = { total: { size: 0, downloaded: 0, completed: 0 }, present: { speed: 0 } };
  }

  setOptions(opts) {
    if (opts && opts.threadsCount) this._threadsCount = opts.threadsCount;
    if (opts && opts.timeout) this._timeout = opts.timeout;
    return this;
  }

  setRetryOptions(opts) {
    this._retry.maxRetries = opts && opts.maxRetries != null ? opts.maxRetries : 2;
    this._retry.retryInterval = (opts && opts.retryInterval) || 1500;
    return this;
  }

  getStats() {
    return this.stats;
  }

  _setupFresh(url, dest) {
    this.url = url;
    this.filePath = dest;
  }

  _setupResume(dest) {
    this.filePath = dest;
    var meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath(dest), "utf8"));
    } catch (e) {}
    if (meta && meta.url && meta.ranges) {
      this.url = meta.url;
      this._size = meta.size;
      this._ranges = meta.ranges;
    }
  }

  start() {
    this._aborted = false;
    this._run().catch(function() {
      // failures are reported through the "error" event, never as a rejected promise here
    });
    return this;
  }

  resume() {
    return this.start();
  }

  stop() {
    this._aborted = true;
    this._closeRequests();
    this._saveMeta();
    this._closeFd();
    this.status = -2;
    this.emit("stopped", this);
    return this;
  }

  destroy() {
    this._aborted = true;
    this._closeRequests();
    this._closeFd();
    this.status = -3;
    var paths = partialPaths(this.filePath);
    try { fs.unlinkSync(this.filePath); } catch (e) {}
    try { fs.unlinkSync(paths[0]); } catch (e) {}
    try { fs.unlinkSync(paths[1]); } catch (e) {}
    this.emit("destroyed", this);
    return this;
  }

  _closeRequests() {
    this._requests.forEach(function(req) {
      try { req.destroy(); } catch (e) {}
    });
    this._requests = [];
  }

  _closeFd() {
    try {
      if (this._fd != null) fs.closeSync(this._fd);
    } catch (e) {}
    this._fd = null;
  }

  _saveMeta() {
    if (!this._ranges) return;
    try {
      fs.writeFileSync(metaPath(this.filePath), JSON.stringify({ url: this.url, size: this._size, ranges: this._ranges }));
    } catch (e) {}
  }

  async _head() {
    var url = this.url;
    var { res } = await request(url, { method: "HEAD", timeout: this._timeout });
    res.resume();
    if (res.statusCode >= 400) {
      throw Object.assign(new Error("HTTP " + res.statusCode), { status: res.statusCode });
    }
    var len = parseInt(res.headers["content-length"], 10);
    return { size: isNaN(len) ? 0 : len, ranged: res.headers["accept-ranges"] == "bytes" };
  }

  _planRanges(size, threadsCount) {
    var ranges = [];
    var per = Math.ceil(size / threadsCount);
    for (var i = 0; i < threadsCount; i++) {
      var start = i * per;
      if (start >= size) break;
      var end = Math.min(start + per - 1, size - 1);
      ranges.push({ start: start, end: end, pos: start });
    }
    return ranges;
  }

  async _run() {
    this.status = 1;
    this.error = null;

    if (!this._ranges) {
      var head;
      try {
        head = await this._head();
      } catch (e) {
        return this._fail(e);
      }
      if (this._aborted) return;
      this._size = head.size;
      var threads = head.ranged && head.size ? this._threadsCount : 1;
      this._ranges = head.size ? this._planRanges(head.size, threads) : [{ start: 0, end: -1, pos: 0 }];
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this._fd = fs.openSync(workPath(this.filePath), "w");
        if (this._size) fs.ftruncateSync(this._fd, this._size);
      } catch (e) {
        return this._fail(e);
      }
    } else {
      try {
        this._fd = fs.openSync(workPath(this.filePath), fs.existsSync(workPath(this.filePath)) ? "r+" : "w");
      } catch (e) {
        return this._fail(e);
      }
    }
    if (this._aborted) return;

    this.stats.total.size = this._size;
    this.emit("start", this);
    this._saveMeta();

    var pending = this._ranges.filter(function(r) { return r.end == -1 || r.pos <= r.end; });
    try {
      await Promise.all(pending.map((r) => this._downloadRange(r)));
    } catch (e) {
      this._closeFd();
      return this._fail(e);
    }
    if (this._aborted) return;

    this._closeFd();
    var complete = this._ranges.every(function(r) { return r.end == -1 || r.pos > r.end; });
    if (!complete) return this._fail(new Error("incomplete"));

    try {
      fs.renameSync(workPath(this.filePath), this.filePath);
    } catch (e) {
      return this._fail(e);
    }
    try { fs.unlinkSync(metaPath(this.filePath)); } catch (e) {}

    this.status = 3;
    this.stats.total.downloaded = this._size;
    this.stats.total.completed = 100;
    this.emit("end", this);
  }

  _sumDone() {
    if (!this._ranges) return 0;
    return this._ranges.reduce(function(sum, r) { return sum + (r.pos - r.start); }, 0);
  }

  _fail(err) {
    if (this._aborted) return; // an intentional stop()/pause(), not a failure
    this.status = -1;
    this.error = err;
    this.emit("error", this);
  }

  async _downloadRange(range) {
    for (var attempt = 0; ; attempt++) {
      if (this._aborted) return;
      try {
        await this._downloadRangeOnce(range);
        return;
      } catch (e) {
        if (this._aborted) return;
        this.emit("log", { level: "warn", text: "range " + range.start + "-" + range.end + " " + (e.status ? "HTTP " + e.status : e.message) + (attempt < this._retry.maxRetries ? ", retrying" : ", giving up") });
        if (attempt >= this._retry.maxRetries) throw e;
        await new Promise((r) => setTimeout(r, this._retry.retryInterval));
      }
    }
  }

  _downloadRangeOnce(range) {
    return new Promise((resolve, reject) => {
      var headers = {};
      if (range.end != -1) headers.Range = "bytes=" + range.pos + "-" + range.end;
      request(this.url, { method: "GET", headers: headers, timeout: this._timeout })
        .then(({ res, req }) => {
          if (this._aborted) {
            res.destroy();
            resolve();
            return;
          }
          if (res.statusCode >= 400) {
            res.resume();
            reject(Object.assign(new Error("HTTP " + res.statusCode), { status: res.statusCode }));
            return;
          }
          if (range.end != -1 && res.statusCode != 206) {
            // we asked for a byte range and got a full, unranged 200 back: writing that response
            // at this range's offset would silently corrupt the file, so treat it as a failed
            // attempt (and retry) instead of trusting bytes that don't belong at this position
            res.resume();
            reject(Object.assign(new Error("server ignored the range request (" + res.statusCode + ")"), { status: 0 }));
            return;
          }
          this._requests.push(req);
          res.on("data", (chunk) => {
            if (this._aborted) return;
            try {
              fs.writeSync(this._fd, chunk, 0, chunk.length, range.pos);
            } catch (e) {
              reject(e);
              return;
            }
            range.pos += chunk.length;
            this._track(chunk.length);
          });
          res.on("end", () => {
            this._requests = this._requests.filter((r) => r !== req);
            resolve();
          });
          res.on("error", (e) => {
            this._requests = this._requests.filter((r) => r !== req);
            if (this._aborted) return resolve();
            reject(e);
          });
        })
        .catch((e) => {
          if (this._aborted) return resolve();
          reject(e);
        });
    });
  }

  _track(bytes) {
    var now = Date.now();
    this._speedSamples.push({ t: now, b: bytes });
    this._speedSamples = this._speedSamples.filter((s) => now - s.t < 3000);
    var windowBytes = this._speedSamples.reduce((s, x) => s + x.b, 0);
    var span = Math.max(1, now - (this._speedSamples[0] ? this._speedSamples[0].t : now)) / 1000;
    this.stats.present.speed = windowBytes / span;

    var downloaded = this._sumDone();
    this.stats.total.downloaded = downloaded;
    this.stats.total.completed = this._size ? Math.floor((downloaded * 1000) / this._size) / 10 : 0;

    if (now - this._lastSaved > 2000) {
      this._lastSaved = now;
      this._saveMeta();
    }
    if (now - this._lastEmit > 250) {
      this._lastEmit = now;
      this.emit("progress", this.stats);
    }
  }
}

class Downloader {
  download(url, dest) {
    var dl = new Download();
    dl._setupFresh(url, dest);
    return dl;
  }
  resumeDownload(dest) {
    var dl = new Download();
    dl._setupResume(dest);
    return dl;
  }
}

module.exports = Downloader;
module.exports.Downloader = Downloader;
module.exports.Download = Download;
module.exports.partialPaths = partialPaths;
