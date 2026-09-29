// The main window: creation, its menu, and the close-vs-quit handshake with the renderer (the
// renderer gets a chance to save its downloads list before the window is actually allowed to
// close). Direct port of the window-related half of the old root index.js.

import { app, BrowserWindow, Menu, nativeTheme } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import * as remoteMain from "@electron/remote/main";
import * as path from "path";
import * as url from "url";
import { quitState } from "./quitState";

let win: BrowserWindow | null = null;

export function getWindow(): BrowserWindow | null {
  return win;
}

export function createWindow(): BrowserWindow {
  const projectRoot = path.join(__dirname, "..", "..");

  const current = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    icon: path.join(projectRoot, "assets/images/build/icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e1013" : "#f7f8fa",
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  win = current;

  current.once("ready-to-show", () => current.show());
  remoteMain.enable(current.webContents);
  current.loadURL(
    url.format({
      pathname: path.join(projectRoot, "index.html"),
      protocol: "file:",
      slashes: true
    })
  );

  current.on("close", (event) => {
    if (!quitState.downloadsSaved) {
      event.preventDefault();
      current.webContents.send("saveDownloads");
    }
  });

  // Dereference the window object; the app supports only one window, this is the time to
  // delete the corresponding reference.
  current.on("closed", () => {
    win = null;
  });

  buildMenu();

  return current;
}

function buildMenu(): void {
  const editSubmenu: MenuItemConstructorOptions[] = [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "pasteAndMatchStyle" },
    { role: "delete" },
    { role: "selectAll" }
  ];

  const template: MenuItemConstructorOptions[] = [{ label: "Edit", submenu: editSubmenu }];

  if (process.platform === "darwin") {
    template.unshift({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services", submenu: [] },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    });

    editSubmenu.push(
      { type: "separator" },
      { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] }
    );
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
