// Isolated marketing capture: use the real application without opening a window.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
globalThis.captureRequire = require;
if (!process.env.JAVDEX_TEST_USER_DATA)
  throw new Error("An isolated capture profile is required");
app.setAppPath(root);
BrowserWindow.prototype.show = function () {};
require(path.join(root, "out/main/index.js"));
