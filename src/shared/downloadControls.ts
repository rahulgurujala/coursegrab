// The one shared, mutable registry of "what can I do to this course's running download right
// now": both app.ts (creates/reads entries when a download-button is clicked, or one of the
// pause/resume/cancel buttons) and engine.js (creates entries in initDownload/retryLecture) need
// the exact same object, not a copy, since they mutate it from different files.

export interface DownloadControl {
  pause(): void;
  resume(): void;
  cancel(): void;
}

export const downloadControls: Record<string, DownloadControl> = {};
