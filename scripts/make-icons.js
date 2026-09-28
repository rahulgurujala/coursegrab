// Regenerates the app icons (png, ico, icns) from assets/images/build/icon.svg.
// Run: bunx electron scripts/make-icons.js   (icns needs macOS `iconutil`; skipped elsewhere)
const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "assets", "images", "build");
const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

app.disableHardwareAcceleration();
app.whenReady().then(main).catch(e => {
  console.error(e);
  app.exit(1);
});

async function main() {
  // render once at 1024 and scale down
  const html = `<body style="margin:0;background:transparent">${svg.replace("<svg ", '<svg width="1024" height="1024" ')}</body>`;
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 500));
  const full = await win.webContents.capturePage();
  const png = {};
  for (const px of sizes) {
    png[px] = (px == 1024 ? full : full.resize({ width: px, height: px, quality: "best" })).toPNG();
  }

  fs.writeFileSync(path.join(dir, "icon.png"), png[1024]);

  // ico: PNG frames packed into one file
  const ico = [16, 24, 32, 48, 64, 128, 256];
  const head = Buffer.alloc(6 + 16 * ico.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(ico.length, 4);
  let offset = head.length;
  ico.forEach((px, i) => {
    const o = 6 + 16 * i;
    head[o] = px === 256 ? 0 : px;
    head[o + 1] = px === 256 ? 0 : px;
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(png[px].length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += png[px].length;
  });
  fs.writeFileSync(path.join(dir, "icon.ico"), Buffer.concat([head, ...ico.map(px => png[px])]));

  if (process.platform === "darwin") {
    const set = path.join(dir, "icon.iconset");
    fs.mkdirSync(set, { recursive: true });
    const map = { "icon_16x16": 16, "icon_16x16@2x": 32, "icon_32x32": 32, "icon_32x32@2x": 64, "icon_128x128": 128, "icon_128x128@2x": 256, "icon_256x256": 256, "icon_256x256@2x": 512, "icon_512x512": 512, "icon_512x512@2x": 1024 };
    for (const [name, px] of Object.entries(map)) fs.writeFileSync(path.join(set, name + ".png"), png[px]);
    execFileSync("iconutil", ["-c", "icns", set, "-o", path.join(dir, "icon.icns")]);
    fs.rmSync(set, { recursive: true });
  }
  app.quit();
}
