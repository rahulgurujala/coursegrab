// Drop-in for electron-settings v3 (get/set/getAll). Same file, so existing user settings carry over.
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
  get: key => data[key],
  getAll: () => data,
  set(key, value) {
    data[key] = value;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }
};
