import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChromeArgs,
  shutdownChromium,
  waitForCdpReady
} from "./chromium-launch.mjs";

test("buildChromeArgs keeps CDP port, profile, and URL aligned", () => {
  const args = buildChromeArgs({
    port: 9333,
    url: "https://tetr.io/",
    profileDir: "C:/tmp/tetrio-profile"
  });

  assert.ok(args.includes("--remote-debugging-port=9333"));
  assert.ok(args.includes("--remote-allow-origins=*"));
  assert.ok(args.includes("--user-data-dir=C:/tmp/tetrio-profile"));
  assert.equal(args.at(-1), "https://tetr.io/");
});

test("waitForCdpReady resolves once /json/version responds", async () => {
  let attempts = 0;
  await waitForCdpReady(9222, {
    timeoutMs: 1000,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("not ready");
      }
      return { ok: true };
    },
    sleepImpl: async () => {}
  });
  assert.equal(attempts, 3);
});

test("shutdownChromium kills an owned browser process", async () => {
  const calls = [];
  const browserProcess = {
    pid: 1234,
    exitCode: null,
    killed: false,
    kill(signal) {
      calls.push(signal ?? "SIGTERM");
      this.killed = true;
      this.exitCode = 0;
    }
  };

  const stopped = await shutdownChromium(browserProcess, {
    graceMs: 100,
    sleepImpl: async () => {}
  });

  assert.equal(stopped, true);
  assert.deepEqual(calls, ["SIGTERM"]);
});
