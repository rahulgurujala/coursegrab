// The real shape of CourseGrab's domain model, as it exists today in assets/js/engine.js,
// assets/js/app.js, assets/js/details.js and assets/js/settings.js. This describes what is
// already there; it does not redesign anything. Some objects here (Lecture in particular) are
// mutated in place as they move through the pipeline (prepareCourse -> loadLecture ->
// planUpdates), which is why several fields are optional: they are only set once that stage has
// run. A later phase that extracts these into store/ and download/ modules is the right place to
// decide whether that should become a cleaner discriminated union instead of one mutable object;
// this phase only names what is already true.

// ---------- settings ----------

export type VideoQuality = "Auto" | "Highest" | "Lowest" | string; // string: a specific label like "720"

export interface DownloadSettings {
  path: string;
  skipSubtitles: boolean;
  skipAttachments: boolean;
  videoQuality: VideoQuality | false;
  autoRetry: boolean;
  enableDownloadStartEnd: boolean;
  downloadStart: number | false;
  downloadEnd: number | false;
}

export interface GeneralSettings {
  language: string;
}

export type Subdomain = string; // "www" or a Udemy Business org subdomain

export interface SettingsData {
  access_token?: string;
  subdomain?: Subdomain;
  general?: GeneralSettings;
  download?: DownloadSettings;
  downloadedCourses?: Record<string, boolean>;
}

// The drop-in replacement for electron-settings v3 (assets/js/settings.js): dot-path get/set
// over one JSON file. Kept as `any` on values here deliberately, the dot-path key encodes the
// type; a typed wrapper belongs in store/settings.ts in a later phase, not this one.
export interface SettingsApi {
  get(key: string): unknown;
  getAll(): SettingsData;
  set(key: string, value: unknown): void;
}

// ---------- course (list/search) ----------

export interface CourseSummary {
  id: string | number;
  title: string;
  url: string;
  image?: string;
}

// ---------- curriculum / lectures ----------

export type LectureType = "Video" | "Article" | "File" | "Url" | "Skipped";

// Only ever assigned once a lecture has been decided undownloadable (loadLecture/skipLecture).
export type SkipReason = "protected" | "unavailable" | "denied";

// Why a lecture will be fetched, set by planUpdates() when comparing against a saved manifest.
export type ChangeBadge = "new" | "updated" | "missing";

export interface SupplementaryAsset {
  src: string;
  name: string;
  quality: "Attachment";
  type: "File" | "Url" | "Article";
}

export interface Lecture {
  id: string | number;
  name: string;
  type: LectureType;

  // Set by prepareCourse() from the curriculum listing, before loadLecture() runs.
  assetId?: string | number | null;
  assetCreated?: string | null;
  assetType?: string; // Udemy's raw asset_type: "Video" | "Article" | "File" | "E-Book"

  // Set by loadLecture() once the per-lecture detail call has resolved. Absent for a lecture
  // that ends up skipped, or before that call has run yet.
  src?: string;
  quality?: string; // a resolution label ("720"), "Article", an attachment's asset type, ...
  caption?: Record<string, string>; // video label -> subtitle URL
  supplementary?: SupplementaryAsset[];
  reason?: SkipReason; // only set when type has been forced to "Skipped"

  // Set by planUpdates() when deciding what needs downloading. status doubles as the change
  // badge shown in the course details store (buildStore() reads lecture.status straight into
  // LectureStoreEntry.badge); there is no separate badge field on the lecture itself.
  primary?: string; // the file's path relative to the course folder
  status?: ChangeBadge | "unchanged" | "outside";
  skip?: boolean;

  // Set by prepareCourse() when retryOnly is true and the manifest already trusts this lecture:
  // planUpdates() then skips re-checking it against Udemy entirely.
  _trusted?: boolean;
}

export interface Chapter {
  name: string;
  lectures: Lecture[];
}

export interface SkippedEntry {
  chapter: string;
  name: string;
  reason: SkipReason | string;
}

// What prepareCourse() returns: a full read of a course, compared against nothing yet.
export interface PrepareCourseData {
  id: string | number;
  name: string;
  chapters: Chapter[];
  skipped: SkippedEntry[];
  subs: Record<string, number>; // video label -> how many lectures have that subtitle
  prep: { cancelled: boolean; failed: boolean };
  retries?: number;
}

// ---------- manifest (.coursegrab.json, one per course folder) ----------

export interface ManifestLectureEntry {
  assetId: string | number | null | undefined;
  created: string | null | undefined;
  title: string;
  primary: string | undefined;
  quality: string | undefined;
  subs: boolean;
  attach: boolean;
  done: boolean;
  at: string; // ISO timestamp
}

export interface Manifest {
  version: 1;
  courseId: string | number;
  title: string;
  lectures: Record<string, ManifestLectureEntry>;
  updatedAt?: string;
}

// ---------- course details store (courseStore, what the UI renders from) ----------

export type LectureViewState =
  | "queued"
  | "downloading"
  | "done"
  | "unchanged"
  | "skipped"
  | "failed"
  | "outside"
  | "saved";

export interface LectureStoreEntry {
  id: string | number;
  num: number;
  name: string;
  state: LectureViewState;
  badge: ChangeBadge | null;
  reason: string;
  pct: number;
  size: number | null;
  note: string;
  speed?: number;
}

export interface ChapterGroup {
  name: string;
  lectures: LectureStoreEntry[];
}

export type CoursePhase = "saved" | "checked" | "downloading" | "done" | "error" | "idle";

export interface CourseStoreEntry {
  id: string | number;
  title: string;
  dir: string;
  phase: CoursePhase;
  chapters: ChapterGroup[];
  byId: Record<string, LectureStoreEntry>;
  note: string;
}

// ---------- debug console (devlog.js) ----------

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  courseId: string;
  level: LogLevel;
  text: string;
  at: number; // Date.now()
}
