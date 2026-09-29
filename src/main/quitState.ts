// Shared between window.ts (the close handler checks it) and index.ts/updater.ts (both set it):
// true once the renderer has been told to save its downloads list, so it is safe to let the
// window close or the app quit without another save-prompt round trip. Same object-with-property
// pattern as shared/session.ts, for the same reason: a plain export gets frozen at import time,
// this needs to be read fresh after another module mutates it.
export const quitState = { downloadsSaved: false };
