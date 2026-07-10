import assert from "node:assert/strict";
import test from "node:test";

import {
  computeEffectiveStatePollMs,
  shouldAttemptDebuggerProbe,
  shouldDecodeRibbonFrame
} from "./tetrio-cdp-source.mjs";

test("debugger_probe_mode disabled never probes", () => {
  assert.equal(
    shouldAttemptDebuggerProbe({
      mode: "disabled",
      needsProbe: true,
      gameCaptured: false,
      playing: false,
      lastKnownPlaying: false,
      now: 20_000,
      lastAttemptAt: 0
    }),
    false
  );
});

test("startup_only stops probing after the game object is captured", () => {
  assert.equal(
    shouldAttemptDebuggerProbe({
      mode: "startup_only",
      needsProbe: true,
      gameCaptured: true,
      playing: false,
      lastKnownPlaying: false,
      now: 20_000,
      lastAttemptAt: 0
    }),
    false
  );
});

test("ribbon until_seed stops deep decode after seed capture", () => {
  assert.equal(
    shouldDecodeRibbonFrame({
      mode: "until_seed",
      seedCaptured: true,
      direction: "received"
    }),
    false
  );
  assert.equal(
    shouldDecodeRibbonFrame({
      mode: "until_seed",
      seedCaptured: false,
      direction: "received"
    }),
    true
  );
});

test("effective state poll never runs faster than the minimum", () => {
  assert.equal(computeEffectiveStatePollMs(8, 16), 16);
  assert.equal(computeEffectiveStatePollMs(40, 16), 40);
});
