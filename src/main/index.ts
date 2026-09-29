// Electron main process entry point. Split out of the old root index.js into main/window.ts
// (window + menu), main/updater.ts (update IPC), main/quitState.ts (the one piece of state both
// need); this file just wires them to the app lifecycle, the same split principle used throughout
// this rewrite: no file mixes unrelated concerns.

import { app, ipcMain } from "electron";
import * as remoteMain from "@electron/remote/main";
import * as path from "path";
import { createWindow, getWindow } from "./window";
import { registerUpdater } from "./updater";
import { quitState } from "./quitState";

remoteMain.initialize();

// Keep the pre-rebrand "Udeler" data folder so existing logins/settings carry over.
// COURSEGRAB_USER_DATA lets tests run against a throwaway folder instead of real settings.
app.setPath("userData", process.env.COURSEGRAB_USER_DATA || path.join(app.getPath("appData"), "Udeler"));

// This method will be called when Electron has finished initialization and is ready to create
// browser windows. Some APIs can only be used after this event occurs.
app.on("ready", () => {
  // in development the Dock would otherwise show the Electron icon
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(path.join(__dirname, "..", "..", "assets/images/build/icon.png"));
  }
  createWindow();
});

// Quit when all windows are closed.
app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  // On macOS it's common to re-create a window in the app when the dock icon is clicked and
  // there are no other windows open.
  if (!getWindow()) {
    createWindow();
  }
});

ipcMain.on("quitApp", () => {
  quitState.downloadsSaved = true;
  app.quit();
});

registerUpdater(getWindow);
