// Every Udemy HTTP call the app makes from the download engine (assets/js/engine.js), extracted
// and typed. No side effects beyond the network call itself: logging is injected via an optional
// callback rather than reaching for the devlog global directly, and there is no filesystem or DOM
// access anywhere in this file.
//
// Uses the platform's native fetch() rather than jQuery's $.ajax(): this file is compiled to a
// real CommonJS module and require()'d (the same pattern assets/js/rangeDownloader.js already
// uses), not loaded as a classic <script> tag, so it does not share the browser "script scope"
// that ui.js/app.js/engine.js/etc. use to see the page's `$`. fetch() needs no such global and is
// natively available in this Electron version (confirmed directly: Electron 44 bundles Node 24,
// fetch has been stable since Node 18).

export interface UdemyApiError extends Error {
  status: number;
}

function makeError(status: number): UdemyApiError {
  const err = new Error("HTTP " + status) as UdemyApiError;
  err.status = status;
  return err;
}

// ---------- raw API response shapes ----------
// These describe what Udemy's API actually returns on the wire, not this app's own domain model
// (see src/shared/types.ts for that; engine.js is what turns one into the other).

export interface CurriculumChapterItem {
  _class: "chapter";
  id: number;
  title: string;
}

export interface CurriculumLectureAsset {
  id: number;
  asset_type: string; // "Video" | "Article" | "File" | "E-Book" | others Udemy may add
  created?: string | null;
}

export interface CurriculumLectureItem {
  _class: "lecture";
  id: number;
  title: string;
  created?: string | null;
  asset?: CurriculumLectureAsset;
}

export interface CurriculumOtherItem {
  _class: string; // "quiz", "practice", and anything else that is neither chapter nor lecture
  id: number;
  title: string;
}

export type CurriculumItem = CurriculumChapterItem | CurriculumLectureItem | CurriculumOtherItem;

export interface CurriculumResponse {
  count: number;
  results: CurriculumItem[];
}

export interface StreamUrlVariant {
  file: string;
  type: string;
  label: string;
}

export interface DownloadUrlVariant {
  file: string;
}

export interface CaptionEntry {
  video_label: string;
  url: string;
}

export interface LectureAssetDetail {
  stream_urls?: { Video?: StreamUrlVariant[] } | null;
  download_urls?: Record<string, DownloadUrlVariant[]> | null;
  captions?: CaptionEntry[];
  title?: string;
  filename?: string;
  data?: { body?: string | null } | null;
  body?: string | null;
}

export interface SupplementaryAssetSummary {
  id: number;
  title: string;
}

export interface LectureDetailResponse {
  asset: LectureAssetDetail;
  supplementary_assets?: SupplementaryAssetSummary[];
}

export interface SupplementaryAssetDetailResponse {
  download_urls?: Record<string, DownloadUrlVariant[]> | null;
  external_url?: string;
  asset_type?: string;
}

// ---------- request plumbing ----------

export type ApiLogLevel = "info" | "error";
export type ApiLogFn = (courseId: string | number, level: ApiLogLevel, text: string) => void;

export interface UdemyApiContext {
  subDomain: string;
  accessToken: string;
  onLog?: ApiLogFn;
}

function authHeaders(ctx: UdemyApiContext): HeadersInit {
  return { Authorization: `Bearer ${ctx.accessToken}` };
}

function logUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function request<T>(url: string, ctx: UdemyApiContext, courseId?: string | number): Promise<T> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers: authHeaders(ctx) });
  } catch {
    // a network-level failure (DNS, connection refused, ...) has no HTTP status at all; 0 matches
    // how the rest of the app already treats "no real status" (see engine.js's describeError())
    if (courseId != null) ctx.onLog?.(courseId, "error", "GET " + logUrl(url) + " -> network error (" + (Date.now() - started) + "ms)");
    throw makeError(0);
  }
  if (courseId != null) {
    ctx.onLog?.(courseId, response.ok ? "info" : "error", "GET " + logUrl(url) + " -> " + response.status + " (" + (Date.now() - started) + "ms)");
  }
  if (!response.ok) {
    throw makeError(response.status);
  }
  return (await response.json()) as T;
}

// ---------- endpoints ----------

export function getCurriculum(courseId: string | number, ctx: UdemyApiContext): Promise<CurriculumResponse> {
  const url = `https://${ctx.subDomain}.udemy.com/api-2.0/courses/${courseId}/cached-subscriber-curriculum-items?page_size=100000`;
  return request<CurriculumResponse>(url, ctx, courseId);
}

export function getLectureDetail(
  courseId: string | number,
  lectureId: string | number,
  ctx: UdemyApiContext
): Promise<LectureDetailResponse> {
  const url =
    `https://${ctx.subDomain}.udemy.com/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}` +
    `?fields[asset]=stream_urls,download_urls,captions,title,filename,data,body&fields[lecture]=asset,supplementary_assets`;
  return request<LectureDetailResponse>(url, ctx, courseId);
}

export function getSupplementaryAssetDetail(
  courseId: string | number,
  lectureId: string | number,
  assetId: string | number,
  ctx: UdemyApiContext
): Promise<SupplementaryAssetDetailResponse> {
  const url =
    `https://${ctx.subDomain}.udemy.com/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}` +
    `/supplementary-assets/${assetId}?fields[asset]=download_urls,external_url,asset_type`;
  return request<SupplementaryAssetDetailResponse>(url, ctx, courseId);
}
