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

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import { EventEmitter } from "events";
import { URL } from "url";

export type DownloadStatus = -3 | -2 | -1 | 0 | 1 | 3; // destroyed, stopped/paused, error, not started, downloading, finished

export interface DownloadRange {
  start: number;
  end: number; // -1 means "unknown total size, take the whole response"
  pos: number;
}

export interface DownloadStats {
  total: { size: number; downloaded: number; completed: number };
  present: { speed: number };
}

export interface DownloadOptions {
  threadsCount?: number;
  timeout?: number;
}

export interface DownloadRetryOptions {
  maxRetries?: number;
  retryInterval?: number;
}

export interface DownloadError extends Error {
  status?: number;
}

export type DownloadLogLevel = "warn" | "error";

export interface DownloadLogEvent {
  level: DownloadLogLevel;
  text: string;
}

interface DownloadMeta {
  url: string;
  size: number;
  ranges: DownloadRange[];
}

function workPath(dest: string): string {
  return dest + ".mtd";
}
function metaPath(dest: string): string {
  return dest + ".mtd.meta.json";
}

// Every place in the app that cleans up a partial download removes both.
export function partialPaths(dest: string): [string, string] {
  return [workPath(dest), metaPath(dest)];
}

const MAX_REDIRECTS = 5;

// Some of Udemy's asset URLs come back protocol-relative ("//cdn.../file") or without a scheme
// at all: new URL() throws ERR_INVALID_URL on those with no base to resolve against. Normalize
// before parsing (seen directly: a real "Invalid URL" failure on a video lecture).
export function normalizeUrl(u: string): string {
  if (u.indexOf("//") === 0) return "https:" + u;
  if (!/^https?:\/\//i.test(u)) return "https://" + u;
  return u;
}

interface RequestResult {
  res: http.IncomingMessage;
  req: http.ClientRequest;
}

function request(url: string, options: http.RequestOptions): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    function go(u: string, hops: number) {
      const parsed = new URL(normalizeUrl(u));
      const lib = parsed.protocol == "http:" ? http : https;
      const req = lib.request(parsed, options, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops >= MAX_REDIRECTS) {
            reject(Object.assign(new Error("Too many redirects"), { status: 0 }) as DownloadError);
            return;
          }
          go(new URL(res.headers.location, parsed).href, hops + 1);
          return;
        }
        resolve({ res, req });
      });
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
      req.on("error", (e) => {
        reject(e);
      });
      req.end();
    }
    go(url, 0);
  });
}

interface DownloadEventMap {
  start: [];
  progress: [stats: DownloadStats];
  log: [entry: DownloadLogEvent];
  end: [];
  error: [];
  stopped: [];
  destroyed: [];
}

export class Download extends EventEmitter {
  status: DownloadStatus = 0;
  url = "";
  filePath = "";
  error: DownloadError | null = null;
  stats: DownloadStats = { total: { size: 0, downloaded: 0, completed: 0 }, present: { speed: 0 } };

  private _threadsCount = 5;
  private _timeout = 20000;
  private _retry: Required<DownloadRetryOptions> = { maxRetries: 2, retryInterval: 1500 };
  private _ranges: DownloadRange[] | null = null;
  private _size = 0;
  private _fd: number | null = null;
  private _aborted = false;
  private _requests: http.ClientRequest[] = [];
  private _lastSaved = 0;
  private _lastEmit = 0;
  private _speedSamples: { t: number; b: number }[] = [];

  override on<E extends keyof DownloadEventMap>(event: E, listener: (...args: DownloadEventMap[E]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<E extends keyof DownloadEventMap>(event: E, ...args: DownloadEventMap[E]): boolean {
    return super.emit(event, ...args);
  }

  setOptions(opts?: DownloadOptions): this {
    if (opts?.threadsCount) this._threadsCount = opts.threadsCount;
    if (opts?.timeout) this._timeout = opts.timeout;
    return this;
  }

  setRetryOptions(opts?: DownloadRetryOptions): this {
    this._retry.maxRetries = opts?.maxRetries != null ? opts.maxRetries : 2;
    this._retry.retryInterval = opts?.retryInterval || 1500;
    return this;
  }

  getStats(): DownloadStats {
    return this.stats;
  }

  _setupFresh(url: string, dest: string): void {
    this.url = url;
    this.filePath = dest;
  }

  _setupResume(dest: string): void {
    this.filePath = dest;
    let meta: DownloadMeta | null = null;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath(dest), "utf8")) as DownloadMeta;
    } catch {
      // no sidecar, or it is corrupt: fall through to a fresh download (start() will HEAD again)
    }
    if (meta && meta.url && meta.ranges) {
      this.url = meta.url;
      this._size = meta.size;
      this._ranges = meta.ranges;
    }
  }

  start(): this {
    this._aborted = false;
    this._run().catch(() => {
      // failures are reported through the "error" event, never as a rejected promise here
    });
    return this;
  }

  resume(): this {
    return this.start();
  }

  stop(): this {
    this._aborted = true;
    this._closeRequests();
    this._saveMeta();
    this._closeFd();
    this.status = -2;
    this.emit("stopped");
    return this;
  }

  destroy(): this {
    this._aborted = true;
    this._closeRequests();
    this._closeFd();
    this.status = -3;
    const [work, meta] = partialPaths(this.filePath);
    try {
      fs.unlinkSync(this.filePath);
    } catch {}
    try {
      fs.unlinkSync(work);
    } catch {}
    try {
      fs.unlinkSync(meta);
    } catch {}
    this.emit("destroyed");
    return this;
  }

  private _closeRequests(): void {
    this._requests.forEach((req) => {
      try {
        req.destroy();
      } catch {}
    });
    this._requests = [];
  }

  private _closeFd(): void {
    try {
      if (this._fd != null) fs.closeSync(this._fd);
    } catch {}
    this._fd = null;
  }

  private _saveMeta(): void {
    if (!this._ranges) return;
    try {
      fs.writeFileSync(metaPath(this.filePath), JSON.stringify({ url: this.url, size: this._size, ranges: this._ranges }));
    } catch {
      // the sidecar only enables resume; never fail a download over it
    }
  }

  // Retried the same way _downloadRange retries a byte range: a HEAD probe is just as exposed to
  // a transient dropped connection as any other request, and this is the one request every fresh
  // download depends on before any range work even starts (found by an actual test hitting it,
  // not by inspection: a flaky connection here used to fail the whole download with no recovery
  // at all, while the exact same kind of drop on a range fetch already retried and recovered).
  private async _head(): Promise<{ size: number; ranged: boolean }> {
    for (let attempt = 0; ; attempt++) {
      if (this._aborted) throw new Error("aborted");
      try {
        return await this._headOnce();
      } catch (e) {
        if (this._aborted) throw e;
        const err = e as DownloadError;
        const reason = err.status ? "HTTP " + err.status : err.message;
        this.emit("log", { level: "warn", text: "HEAD " + reason + (attempt < this._retry.maxRetries ? ", retrying" : ", giving up") });
        if (attempt >= this._retry.maxRetries) throw err;
        await new Promise((r) => setTimeout(r, this._retry.retryInterval));
      }
    }
  }

  private async _headOnce(): Promise<{ size: number; ranged: boolean }> {
    const { res } = await request(this.url, { method: "HEAD", timeout: this._timeout });
    res.resume();
    if (res.statusCode && res.statusCode >= 400) {
      throw Object.assign(new Error("HTTP " + res.statusCode), { status: res.statusCode }) as DownloadError;
    }
    const len = parseInt(String(res.headers["content-length"]), 10);
    return { size: isNaN(len) ? 0 : len, ranged: res.headers["accept-ranges"] == "bytes" };
  }

  private _planRanges(size: number, threadsCount: number): DownloadRange[] {
    const ranges: DownloadRange[] = [];
    const per = Math.ceil(size / threadsCount);
    for (let i = 0; i < threadsCount; i++) {
      const start = i * per;
      if (start >= size) break;
      const end = Math.min(start + per - 1, size - 1);
      ranges.push({ start, end, pos: start });
    }
    return ranges;
  }

  private async _run(): Promise<void> {
    this.status = 1;
    this.error = null;

    if (!this._ranges) {
      let head: { size: number; ranged: boolean };
      try {
        head = await this._head();
      } catch (e) {
        return this._fail(e as DownloadError);
      }
      if (this._aborted) return;
      this._size = head.size;
      const threads = head.ranged && head.size ? this._threadsCount : 1;
      this._ranges = head.size ? this._planRanges(head.size, threads) : [{ start: 0, end: -1, pos: 0 }];
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this._fd = fs.openSync(workPath(this.filePath), "w");
        if (this._size) fs.ftruncateSync(this._fd, this._size);
      } catch (e) {
        return this._fail(e as DownloadError);
      }
    } else {
      try {
        this._fd = fs.openSync(workPath(this.filePath), fs.existsSync(workPath(this.filePath)) ? "r+" : "w");
      } catch (e) {
        return this._fail(e as DownloadError);
      }
    }
    if (this._aborted) return;

    this.stats.total.size = this._size;
    this.emit("start");
    this._saveMeta();

    const pending = this._ranges.filter((r) => r.end == -1 || r.pos <= r.end);
    try {
      await Promise.all(pending.map((r) => this._downloadRange(r)));
    } catch (e) {
      this._closeFd();
      return this._fail(e as DownloadError);
    }
    if (this._aborted) return;

    this._closeFd();
    const complete = this._ranges.every((r) => r.end == -1 || r.pos > r.end);
    if (!complete) return this._fail(new Error("incomplete"));

    try {
      fs.renameSync(workPath(this.filePath), this.filePath);
    } catch (e) {
      return this._fail(e as DownloadError);
    }
    try {
      fs.unlinkSync(metaPath(this.filePath));
    } catch {}

    this.status = 3;
    this.stats.total.downloaded = this._size;
    this.stats.total.completed = 100;
    this.emit("end");
  }

  private _sumDone(): number {
    if (!this._ranges) return 0;
    return this._ranges.reduce((sum, r) => sum + (r.pos - r.start), 0);
  }

  private _fail(err: DownloadError): void {
    if (this._aborted) return; // an intentional stop()/pause(), not a failure
    this.status = -1;
    this.error = err;
    // always surface the real underlying reason (HTTP status, or the OS/Node error code and
    // message, e.g. ECONNRESET, ENOTFOUND, a TLS error) rather than letting it get collapsed
    // into a generic "connection" label upstream: that generic label is a summary for the UI
    // pill, not a diagnosis, and this is the one place that still has the real error object
    const code = (err as NodeJS.ErrnoException).code;
    const reason = err.status ? "HTTP " + err.status : code ? code + " (" + err.message + ")" : err.message || String(err);
    this.emit("log", { level: "error", text: "failed: " + reason });
    this.emit("error");
  }

  private async _downloadRange(range: DownloadRange): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (this._aborted) return;
      try {
        await this._downloadRangeOnce(range);
        return;
      } catch (e) {
        if (this._aborted) return;
        const err = e as DownloadError;
        const reason = err.status ? "HTTP " + err.status : err.message;
        this.emit("log", {
          level: "warn",
          text: "range " + range.start + "-" + range.end + " " + reason + (attempt < this._retry.maxRetries ? ", retrying" : ", giving up")
        });
        if (attempt >= this._retry.maxRetries) throw err;
        await new Promise((r) => setTimeout(r, this._retry.retryInterval));
      }
    }
  }

  private _downloadRangeOnce(range: DownloadRange): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (range.end != -1) headers.Range = "bytes=" + range.pos + "-" + range.end;
      request(this.url, { method: "GET", headers, timeout: this._timeout })
        .then(({ res, req }) => {
          if (this._aborted) {
            res.destroy();
            resolve();
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            res.resume();
            reject(Object.assign(new Error("HTTP " + res.statusCode), { status: res.statusCode }) as DownloadError);
            return;
          }
          if (range.end != -1 && res.statusCode != 206) {
            // we asked for a byte range and got a full, unranged 200 back: writing that response
            // at this range's offset would silently corrupt the file, so treat it as a failed
            // attempt (and retry) instead of trusting bytes that don't belong at this position
            res.resume();
            reject(Object.assign(new Error("server ignored the range request (" + res.statusCode + ")"), { status: 0 }) as DownloadError);
            return;
          }
          this._requests.push(req);
          res.on("data", (chunk: Buffer) => {
            if (this._aborted) return;
            try {
              fs.writeSync(this._fd!, chunk, 0, chunk.length, range.pos);
            } catch (e) {
              reject(e as DownloadError);
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
            if (this._aborted) {
              resolve();
              return;
            }
            reject(e as DownloadError);
          });
        })
        .catch((e: DownloadError) => {
          if (this._aborted) {
            resolve();
            return;
          }
          reject(e);
        });
    });
  }

  private _track(bytes: number): void {
    const now = Date.now();
    this._speedSamples.push({ t: now, b: bytes });
    this._speedSamples = this._speedSamples.filter((s) => now - s.t < 3000);
    const windowBytes = this._speedSamples.reduce((s, x) => s + x.b, 0);
    const span = Math.max(1, now - (this._speedSamples[0] ? this._speedSamples[0].t : now)) / 1000;
    this.stats.present.speed = windowBytes / span;

    const downloaded = this._sumDone();
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

export class Downloader {
  download(url: string, dest: string): Download {
    const dl = new Download();
    dl._setupFresh(url, dest);
    return dl;
  }
  resumeDownload(dest: string): Download {
    const dl = new Download();
    dl._setupResume(dest);
    return dl;
  }
}

export default Downloader;
