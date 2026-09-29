const { app, BrowserWindow, Menu, ipcMain, nativeTheme } = require("electron");
const remoteMain = require("@electron/remote/main");
const path = require("path");
const url = require("url");
remoteMain.initialize();
// Keep the pre-rebrand "Udeler" data folder so existing logins/settings carry over.
// COURSEGRAB_USER_DATA lets tests run against a throwaway folder instead of real settings.
app.setPath(
  "userData",
  process.env.COURSEGRAB_USER_DATA || path.join(app.getPath("appData"), "Udeler")
);
var downloadsSaved = false;
// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win;

function createWindow() {
  // Create the browser window.
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    icon: __dirname + "/assets/images/build/icon.png",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e1013" : "#f7f8fa",
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  win.once("ready-to-show", () => win.show());
  remoteMain.enable(win.webContents);
  // and load the index.html of the app.
  win.loadURL(
    url.format({
      pathname: path.join(__dirname, "index.html"),
      protocol: "file:",
      slashes: true
    })
  );

  // Open the DevTools.
  // win.webContents.openDevTools();

  win.on("close", event => {
    if (!downloadsSaved) {
      event.preventDefault();
      win.webContents.send("saveDownloads");
    }
  });

  // Emitted when the window is closed.
  win.on("closed", () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    win = null;
  });

  const template = [
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteandmatchstyle" },
        { role: "delete" },
        { role: "selectall" }
      ]
    }
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services", submenu: [] },
        { type: "separator" },
        { role: "hide" },
        { role: "hideothers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    });

    template[1].submenu.push(
      { type: "separator" },
      {
        label: "Speech",
        submenu: [{ role: "startspeaking" }, { role: "stopspeaking" }]
      }
    );
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", () => {
  // in development the Dock would otherwise show the Electron icon
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, "assets/images/build/icon.png"));
  }
  createWindow();
});

// Quit when all windows are closed.
app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (win === null) {
    createWindow();
  }
});

ipcMain.on("quitApp", function() {
  downloadsSaved = true;
  app.quit();
});

// ---------- in-app updates ----------
// Windows and Linux (nsis/AppImage) can download and install an update themselves.
// macOS builds are unsigned, and Squirrel.Mac refuses to self-update an unsigned app, so macOS
// gets no update feed at build time (electron-builder does not embed one) and falls back to a
// plain "open the download page" action handled entirely in the renderer; nothing here runs on it.
if (process.platform !== "darwin") {
  var autoUpdater = require("electron-updater").autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("download-progress", function(progress) {
    if (win) win.webContents.send("update:progress", Math.round(progress.percent));
  });
  autoUpdater.on("update-downloaded", function() {
    if (win) win.webContents.send("update:downloaded");
  });
  autoUpdater.on("error", function(err) {
    if (win) win.webContents.send("update:error", String((err && err.message) || err));
  });

  ipcMain.handle("update:check", async function() {
    // only meaningful for a real installed build: an unpackaged dev run has no update feed
    if (!app.isPackaged) return { available: false };
    try {
      var result = await autoUpdater.checkForUpdates();
      var version = result && result.updateInfo && result.updateInfo.version;
      return { available: !!version && version !== app.getVersion(), version: version };
    } catch (e) {
      return { available: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.on("update:download", function() {
    autoUpdater.downloadUpdate().catch(function(e) {
      if (win) win.webContents.send("update:error", String((e && e.message) || e));
    });
  });

  ipcMain.on("update:install", function() {
    downloadsSaved = true; // let quitAndInstall's own close through without our save prompt
    autoUpdater.quitAndInstall();
  });
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
