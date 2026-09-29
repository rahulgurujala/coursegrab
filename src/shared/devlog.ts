// A ring buffer of network activity (API calls, per-range download attempts, retries, failures)
// that the course details view's debug console reads from. The direct extraction of
// assets/js/devlog.js, with one real change: a typed EventEmitter instead of jQuery's
// $(document).trigger("devlog:add", entry)/$(document).on(...), since this module has no reason
// to depend on jQuery or the DOM at all, only view/courseDetails.ts (which does) needs to react.

import { EventEmitter } from "events";
import type { LogEntry, LogLevel } from "./types";

const LIMIT = 1000;

interface DevlogEventMap {
  add: [entry: LogEntry];
}

class DevlogEmitter extends EventEmitter {
  override on<E extends keyof DevlogEventMap>(event: E, listener: (...args: DevlogEventMap[E]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<E extends keyof DevlogEventMap>(event: E, ...args: DevlogEventMap[E]): boolean {
    return super.emit(event, ...args);
  }
}

export const devlogEvents = new DevlogEmitter();

let entries: LogEntry[] = [];
let seq = 0;

function add(courseId: string | number, level: LogLevel, text: string): LogEntry {
  const entry: LogEntry = { id: ++seq, courseId: String(courseId || ""), level, text, at: Date.now() };
  entries.push(entry);
  if (entries.length > LIMIT) entries.shift();
  devlogEvents.emit("add", entry);
  return entry;
}

export function info(courseId: string | number, text: string): LogEntry {
  return add(courseId, "info", text);
}
export function warn(courseId: string | number, text: string): LogEntry {
  return add(courseId, "warn", text);
}
export function error(courseId: string | number, text: string): LogEntry {
  return add(courseId, "error", text);
}
export function forCourse(courseId: string | number): LogEntry[] {
  const id = String(courseId || "");
  return entries.filter((e) => e.courseId == id);
}
export function clear(courseId: string | number): void {
  const id = String(courseId || "");
  entries = entries.filter((e) => e.courseId != id);
}
