// In-app update IPC wiring, split out of the old root index.js so window/menu setup and update
// plumbing aren't in the same file.
//
// Windows and Linux (nsis/AppImage) can download and install an update themselves. macOS builds
// are unsigned, and Squirrel.Mac refuses to self-update an unsigned app, so macOS gets no update
// feed at build time (electron-builder does not embed one) and falls back to a plain "open the
// download page" action handled entirely in the renderer; nothing here runs on it. electron-updater
// is require()'d inside the platform guard, not imported at the top, so it is never loaded at all
// on macOS, exactly as it never was before this file existed.

import { app, ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import { quitState } from "./quitState";

function errorMessage(e: unknown): string {
  return String((e as { message?: string } | null)?.message ?? e);
}

export function registerUpdater(getWindow: () => BrowserWindow | null): void {
  if (process.platform === "darwin") return;

  const autoUpdater = require("electron-updater").autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("download-progress", (progress: { percent: number }) => {
    const win = getWindow();
    if (win) win.webContents.send("update:progress", Math.round(progress.percent));
  });

  autoUpdater.on("update-downloaded", () => {
    const win = getWindow();
    if (win) win.webContents.send("update:downloaded");
  });

  autoUpdater.on("error", (err: unknown) => {
    const win = getWindow();
    if (win) win.webContents.send("update:error", errorMessage(err));
  });

  ipcMain.handle("update:check", async () => {
    // only meaningful for a real installed build: an unpackaged dev run has no update feed
    if (!app.isPackaged) return { available: false };
    try {
      const result = await autoUpdater.checkForUpdates();
      const version = result && result.updateInfo && result.updateInfo.version;
      return { available: !!version && version !== app.getVersion(), version };
    } catch (e) {
      return { available: false, error: errorMessage(e) };
    }
  });

  ipcMain.on("update:download", () => {
    autoUpdater.downloadUpdate().catch((e: unknown) => {
      const win = getWindow();
      if (win) win.webContents.send("update:error", errorMessage(e));
    });
  });

  ipcMain.on("update:install", () => {
    quitState.downloadsSaved = true; // let quitAndInstall's own close through without our save prompt
    autoUpdater.quitAndInstall();
  });
}
