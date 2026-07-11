import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  captureTetrioExportExpression,
  computeEffectiveStatePollMs,
  formatStateEvalPerfLog,
  shouldAttemptDebuggerProbe,
  shouldAttemptStartupDirectScan,
  shouldDecodeRibbonFrame
} from "./tetrio-cdp-source.mjs";

function createMockGame() {
  return {
    ejectState() {
      return { game: { stub: true } };
    },
    ejectBoardState() {
      return { stub: true };
    }
  };
}

function runCaptureExpression(windowOverrides, options = {}) {
  const windowObject = { ...windowOverrides };
  windowObject.window = windowObject;
  const context = {
    window: windowObject,
    document: { title: "TETR.IO" },
    location: { href: "https://tetr.io/" }
  };
  const result = vm.runInNewContext(captureTetrioExportExpression(options), context);
  return { result, windowObject };
}

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

test("manual mode never auto probes while playing", () => {
  assert.equal(
    shouldAttemptDebuggerProbe({
      mode: "manual",
      needsProbe: true,
      gameCaptured: false,
      playing: true,
      lastKnownPlaying: true,
      now: 20_000,
      lastAttemptAt: 0
    }),
    false
  );
});

test("startup_only allows one initial probe while already playing", () => {
  assert.equal(
    shouldAttemptDebuggerProbe({
      mode: "startup_only",
      needsProbe: true,
      gameCaptured: false,
      playing: true,
      lastKnownPlaying: true,
      now: 20_000,
      lastAttemptAt: 0
    }),
    true
  );
  assert.equal(
    shouldAttemptDebuggerProbe({
      mode: "startup_only",
      needsProbe: true,
      gameCaptured: false,
      playing: true,
      lastKnownPlaying: true,
      now: 20_000,
      lastAttemptAt: 10_000
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

test("startup direct scan finds nested game under window.game", () => {
  const mockGame = createMockGame();
  const { result, windowObject } = runCaptureExpression(
    {
      game: {
        nested: mockGame
      }
    },
    { allowStartupDirectScan: true }
  );

  assert.equal(result.ok, true);
  assert.equal(result.quick, false);
  assert.equal(result.scanMode, "startup_direct");
  assert.equal(result.captureSource, "window.game.nested");
  assert.equal(windowObject.__fusionTetrioGame, mockGame);
});

test("startup direct scan finds top-level window property game", () => {
  const mockGame = createMockGame();
  const { result, windowObject } = runCaptureExpression(
    {
      hiddenFusionSlot: mockGame
    },
    { allowStartupDirectScan: true }
  );

  assert.equal(result.ok, true);
  assert.equal(result.captureSource, "window.hiddenFusionSlot");
  assert.equal(windowObject.__fusionTetrioGame, mockGame);
});

test("captured game uses quick path on later polls", () => {
  const mockGame = createMockGame();
  const first = runCaptureExpression(
    {
      game: {
        nested: mockGame
      }
    },
    { allowStartupDirectScan: true }
  );
  const second = runCaptureExpression(
    {
      __fusionTetrioGame: first.windowObject.__fusionTetrioGame
    },
    { allowStartupDirectScan: false }
  );

  assert.equal(first.result.captureSource, "window.game.nested");
  assert.equal(second.result.ok, true);
  assert.equal(second.result.quick, true);
  assert.equal(second.result.scanMode, false);
  assert.equal(second.result.captureSource, "window.__fusionTetrioGame");
});

test("disabled mode still allows startup direct scan helper decisions", () => {
  assert.equal(
    shouldAttemptStartupDirectScan({
      gameCaptured: false,
      now: 20_000,
      sessionStartedAt: 10_000,
      lastAttemptAt: 0,
      attempts: 0
    }),
    true
  );
  assert.equal(
    shouldAttemptStartupDirectScan({
      gameCaptured: true,
      now: 20_000,
      sessionStartedAt: 10_000,
      lastAttemptAt: 0,
      attempts: 0
    }),
    false
  );
});

test("state perf logs show quick, startup scan, and disabled modes", () => {
  assert.equal(
    formatStateEvalPerfLog({ quick: true }, 3),
    "[perf][state] quick=true scan=false eval_ms=3"
  );
  assert.equal(
    formatStateEvalPerfLog({ quick: false, scanMode: "startup_direct" }, 9),
    "[perf][state] quick=false scan=startup_direct eval_ms=9"
  );
  assert.equal(
    formatStateEvalPerfLog({ quick: false, scanMode: "disabled", scanReason: "no_game" }, 1),
    "[perf][state] quick=false scan=disabled reason=no_game"
  );
});
