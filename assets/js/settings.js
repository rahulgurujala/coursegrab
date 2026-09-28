// Drop-in for electron-settings v3 (get/set/getAll, dot-path keys). Same file, so existing user settings carry over.
const fs = require("fs");
const path = require("path");
const { app } = require("@electron/remote");

const file = path.join(app.getPath("userData"), "Settings");
let data = {};
try {
  data = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  // missing or unreadable file: start empty
}

module.exports = {
  get: key =>
    key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), data),
  getAll: () => data,
  set(key, value) {
    const keys = key.split(".");
    const last = keys.pop();
    const parent = keys.reduce((o, k) => (o[k] = o[k] || {}), data);
    parent[last] = value;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }
};
