import test from "node:test";
import assert from "node:assert/strict";

import { isShutdownCommand, parseArgs } from "./tetrio-browser-host.mjs";

test("browser host parses CLI arguments for Chromium launch", () => {
  const args = parseArgs([
    "--port",
    "9555",
    "--url",
    "https://tetr.io/",
    "--chrome-path",
    "C:/Chrome/chrome.exe",
    "--profile-dir",
    "C:/tmp/profile"
  ]);

  assert.equal(args.port, "9555");
  assert.equal(args.url, "https://tetr.io/");
  assert.equal(args.chromePath, "C:/Chrome/chrome.exe");
  assert.equal(args.profileDir, "C:/tmp/profile");
});

test("browser host recognizes shutdown commands from stdin", () => {
  assert.equal(isShutdownCommand('{"type":"shutdown"}'), true);
  assert.equal(isShutdownCommand('{"type":"noop"}'), false);
  assert.equal(isShutdownCommand("not-json"), false);
});
