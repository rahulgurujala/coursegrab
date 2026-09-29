// Every scenario here was exercised manually, by hand, against this exact server pattern while
// building rangeDownloader.ts this session (the false-failure bug this module exists to fix was
// found and verified this way before any of this was a permanent test). This file is that same
// verification, kept, instead of thrown away once the manual check passed once.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import type { AddressInfo } from "net";
import { Downloader, normalizeUrl, partialPaths } from "../../src/download/rangeDownloader";

const SIZE = 3 * 1024 * 1024; // 3MB, matches the fixed byte fill used to verify content below

function byteFor(url: string): number {
  let a = 7;
  for (const c of url) a = (a * 31 + c.charCodeAt(0)) % 251;
  return a;
}

function rangeFromHeader(header: string | undefined, size: number): { start: number; end: number; status: 200 | 206 } {
  const m = /bytes=(\d+)-(\d*)/.exec(header || "");
  if (!m) return { start: 0, end: size - 1, status: 200 };
  const start = +m[1]!;
  const end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
  return { start, end, status: 206 };
}

let server: http.Server;
let base: string;
let flakyHits: number;
let flakyHeadHits: number;

beforeAll(() => {
  return new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      const url = (req.url || "").split("?")[0]!;

      if (url.startsWith("/flaky/") && req.method === "GET") {
        // a realistic flaky CDN: honors the Range request properly (206, correct bytes for that
        // range), then the connection just dies partway through, same as a real dropped socket.
        // GET only, not HEAD: a HEAD probe has no "mid-transfer" to drop, that is a different
        // scenario (covered separately below) with its own, much smaller retry budget, and this
        // budget is sized for however many of the 5 concurrent range fetches hit it, not for one
        // single sequential HEAD request potentially absorbing most of it by itself.
        if (flakyHits < 12) {
          flakyHits++;
          const { start, end, status } = rangeFromHeader(req.headers.range, SIZE);
          const b = byteFor(url);
          const headers: http.OutgoingHttpHeaders = { "Content-Length": end - start + 1, "Accept-Ranges": "bytes" };
          if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${SIZE}`;
          res.writeHead(status, headers);
          res.write(Buffer.alloc(Math.min(20000, end - start + 1), b));
          setTimeout(() => req.socket.destroy(), 80);
          return;
        }
        // recovered: fall through to the normal range-respecting handler below
      }

      if (url.startsWith("/flaky-head/") && req.method === "HEAD" && flakyHeadHits < 2) {
        // the HEAD probe itself drops a couple of times before succeeding, no data involved at
        // all: proves _head()'s own retry (added this phase, found missing by exactly this kind
        // of test) recovers on its own, the same way a range fetch already did.
        flakyHeadHits++;
        res.writeHead(200, { "Content-Length": SIZE, "Accept-Ranges": "bytes" });
        setTimeout(() => req.socket.destroy(), 30);
        return;
      }

      if (url.startsWith("/ignores-range/")) {
        // misbehaving server: 200 with the full body regardless of the Range header sent
        const b = byteFor(url);
        res.writeHead(200, { "Content-Length": SIZE, "Accept-Ranges": "bytes" });
        res.end(Buffer.alloc(SIZE, b));
        return;
      }

      if (url.startsWith("/dead/")) {
        res.writeHead(200, { "Content-Length": SIZE, "Accept-Ranges": "bytes" });
        if (req.method !== "HEAD") res.write(Buffer.alloc(20000, 1));
        setTimeout(() => req.socket.destroy(), 60);
        return;
      }

      if (url.startsWith("/huge/")) {
        // a long-but-healthy transfer: proves there is no fixed-time watchdog that would kill a
        // large lecture just for legitimately taking a while
        const hugeSize = 60 * 1024 * 1024;
        const { start, end, status } = rangeFromHeader(req.headers.range, hugeSize);
        const headers: http.OutgoingHttpHeaders = { "Content-Length": end - start + 1, "Accept-Ranges": "bytes" };
        if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${hugeSize}`;
        res.writeHead(status, headers);
        if (req.method === "HEAD") return res.end();
        let pos = start;
        const tick = setInterval(() => {
          if (pos > end) {
            clearInterval(tick);
            return res.end();
          }
          const n = Math.min(300 * 1024, end - pos + 1);
          res.write(Buffer.alloc(n, 3));
          pos += n;
        }, 5);
        res.on("close", () => clearInterval(tick));
        return;
      }

      // default: a well-behaved range-respecting server, throttled a bit so pause/resume has time
      // to actually land mid-transfer instead of finishing before the test can pause it
      const slow = url.startsWith("/slow/");
      const size = slow ? 12 * 1024 * 1024 : SIZE;
      const { start, end, status } = rangeFromHeader(req.headers.range, size);
      const headers: http.OutgoingHttpHeaders = { "Content-Length": end - start + 1, "Accept-Ranges": "bytes", "Content-Type": "video/mp4" };
      if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      res.writeHead(status, headers);
      if (req.method === "HEAD") return res.end();
      const b = byteFor(url);
      let pos = start;
      // bytes/sec PER CONNECTION: the pause/resume tests use threadsCount: 3, each range gets its
      // own connection/tick loop here, so the aggregate is roughly 3x this for /slow/. Divided by
      // 3 up front so the actual aggregate lands near the intended ~1.5MB/s (a 12MB file taking
      // ~8s), instead of finishing before a test's "pause after 1MB downloaded" trigger can land.
      const rate = slow ? 500 * 1024 : 64 * 1024 * 1024;
      const tick = setInterval(() => {
        if (pos > end) {
          clearInterval(tick);
          return res.end();
        }
        const n = Math.min(Math.max(rate / 20, 1), end - pos + 1);
        res.write(Buffer.alloc(n, b));
        pos += n;
      }, 50);
      res.on("close", () => clearInterval(tick));
    });
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(() => {
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

let dir: string;
beforeEach(() => {
  flakyHits = 0;
  flakyHeadHits = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-rd-test-"));
});

function verifyContent(url: string, file: string, expectedSize?: number) {
  const buf = fs.readFileSync(file);
  if (expectedSize != null) expect(buf.length).toBe(expectedSize);
  const b = byteFor(new URL(url).pathname);
  const step = Math.max(1, Math.floor(buf.length / 500));
  for (let i = 0; i < buf.length; i += step) {
    expect(buf[i]).toBe(b);
  }
}

describe("rangeDownloader", () => {
  it("downloads a healthy file completely and leaves no .mtd sidecar", async () => {
    const dest = path.join(dir, "healthy.mp4");
    const url = base + "/course/healthy.mp4";
    await new Promise<void>((resolve, reject) => {
      const dl = new Downloader().download(url, dest);
      dl.on("end", resolve);
      dl.on("error", () => reject(dl.error));
      dl.start();
    });
    verifyContent(url, dest, SIZE);
    expect(fs.existsSync(dest + ".mtd")).toBe(false);
  });

  it("recovers from a connection that drops mid-transfer and ends up done, not failed", async () => {
    // this is the exact bug this module was built to fix: a real CDN dropping mid-range must
    // still end in a correct, complete file, not a false "failed" with the file done in the
    // background after the fact
    const dest = path.join(dir, "flaky.mp4");
    const url = base + "/flaky/course.mp4";
    await new Promise<void>((resolve, reject) => {
      const dl = new Downloader().download(url, dest);
      dl.setRetryOptions({ maxRetries: 5, retryInterval: 50 });
      dl.on("end", resolve);
      dl.on("error", () => reject(dl.error));
      dl.start();
    });
    verifyContent(url, dest, SIZE);
  });

  it("recovers from the initial HEAD probe dropping, not just a range fetch", async () => {
    const dest = path.join(dir, "flaky-head.mp4");
    const url = base + "/flaky-head/course.mp4";
    await new Promise<void>((resolve, reject) => {
      const dl = new Downloader().download(url, dest);
      dl.setRetryOptions({ maxRetries: 5, retryInterval: 30 });
      dl.on("end", resolve);
      dl.on("error", () => reject(dl.error));
      dl.start();
    });
    verifyContent(url, dest, SIZE);
  });

  it("fails cleanly and quickly against a connection that never recovers, without hanging", async () => {
    const dest = path.join(dir, "dead.mp4");
    const url = base + "/dead/course.mp4";
    const startedAt = Date.now();
    await expect(
      new Promise<void>((resolve, reject) => {
        const dl = new Downloader().download(url, dest);
        dl.setOptions({ timeout: 1000 });
        dl.setRetryOptions({ maxRetries: 1, retryInterval: 50 });
        dl.on("end", resolve);
        dl.on("error", () => reject(dl.error));
        dl.start();
      })
    ).rejects.toBeTruthy();
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("treats a server that ignores the Range request as a failure instead of corrupting the file", async () => {
    // a response to a ranged request that comes back 200 (full body) must never be written at
    // that range's offset: it would silently corrupt everything after byte 0
    const dest = path.join(dir, "ignores-range.mp4");
    const url = base + "/ignores-range/course.mp4";
    await expect(
      new Promise<void>((resolve, reject) => {
        const dl = new Downloader().download(url, dest);
        dl.setOptions({ threadsCount: 5 });
        dl.setRetryOptions({ maxRetries: 1, retryInterval: 20 });
        dl.on("end", resolve);
        dl.on("error", () => reject(dl.error));
        dl.start();
      })
    ).rejects.toBeTruthy();
    // never renamed to its final name: nothing trustworthy was ever produced
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("completes a long healthy transfer without a fixed-time watchdog killing it", async () => {
    const dest = path.join(dir, "huge.mp4");
    const url = base + "/huge/course.mp4";
    await new Promise<void>((resolve, reject) => {
      const dl = new Downloader().download(url, dest);
      dl.setOptions({ timeout: 30000 });
      dl.on("end", resolve);
      dl.on("error", () => reject(dl.error));
      dl.start();
    });
    expect(fs.statSync(dest).size).toBe(60 * 1024 * 1024);
  }, 15000);

  it("pauses and resumes mid-download, landing on the correct final content", async () => {
    const dest = path.join(dir, "pauseresume.mp4");
    const url = base + "/slow/course.mp4";
    await new Promise<void>((resolve, reject) => {
      const dl = new Downloader().download(url, dest);
      dl.setOptions({ timeout: 15000 });
      let paused = false;
      dl.on("progress", (stats) => {
        if (!paused && stats.total.downloaded > 1024 * 1024) {
          paused = true;
          dl.stop();
          setTimeout(() => dl.resume(), 150);
        }
      });
      dl.on("end", resolve);
      dl.on("error", () => reject(dl.error));
      dl.start();
    });
    verifyContent(url, dest, 12 * 1024 * 1024);
  }, 15000);

  it("resumes correctly after being stopped and recreated as a fresh instance (simulated app restart)", async () => {
    const dest = path.join(dir, "restart.mp4");
    const url = base + "/slow/course.mp4";

    const firstRun = new Downloader().download(url, dest);
    firstRun.setOptions({ threadsCount: 3, timeout: 15000 });
    let stopped = false;
    await new Promise<void>((resolve) => {
      firstRun.on("progress", (stats) => {
        if (!stopped && stats.total.downloaded > 1024 * 1024) {
          stopped = true;
          firstRun.stop();
          resolve();
        }
      });
      firstRun.start();
    });

    const [work, meta] = partialPaths(dest);
    expect(fs.existsSync(work)).toBe(true);
    // NOT fs.statSync(work).size: the work file is pre-allocated to its full target size via
    // ftruncate as soon as the download starts (a sparse file), so its on-disk size is always
    // the full 12MB from the very first moment regardless of how many real bytes have landed.
    // Actual progress lives in the sidecar's per-range positions.
    const metaBefore = JSON.parse(fs.readFileSync(meta, "utf8")) as { ranges: { start: number; pos: number }[] };
    const partialSize = metaBefore.ranges.reduce((sum, r) => sum + (r.pos - r.start), 0);

    // a brand new Downloader instance, the way the app creates one fresh on every launch
    await new Promise<void>((resolve, reject) => {
      const secondRun = new Downloader().resumeDownload(dest);
      secondRun.setOptions({ threadsCount: 3, timeout: 15000 });
      secondRun.on("end", resolve);
      secondRun.on("error", () => reject(secondRun.error));
      secondRun.start();
    });

    verifyContent(url, dest, 12 * 1024 * 1024);
    expect(partialSize).toBeGreaterThan(0);
    expect(partialSize).toBeLessThan(12 * 1024 * 1024);
  }, 15000);

  it("normalizes a protocol-relative or scheme-less URL instead of throwing ERR_INVALID_URL", () => {
    // seen directly in production: some Udemy asset URLs come back as "//cdn.../file", no
    // scheme at all, which new URL() rejects outright with no base to resolve against. Real
    // Udemy CDN URLs are always https, hence the https: prefix (this is a unit test, not an
    // end-to-end download, specifically so it does not need a local HTTPS test server to prove).
    expect(normalizeUrl("//cdn.example.com/video.mp4?sig=abc")).toBe("https://cdn.example.com/video.mp4?sig=abc");
    expect(normalizeUrl("cdn.example.com/video.mp4")).toBe("https://cdn.example.com/video.mp4");
    expect(normalizeUrl("https://cdn.example.com/video.mp4")).toBe("https://cdn.example.com/video.mp4");
    expect(normalizeUrl("http://cdn.example.com/video.mp4")).toBe("http://cdn.example.com/video.mp4");
  });
});
