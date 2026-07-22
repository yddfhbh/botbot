import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import {
  applyGameStartSignalToNetwork,
  applyBrowserControlMessage,
  armClosureCaptureWindow,
  buildSnapshotSignature,
  buildSnapshotToken,
  captureTetrioGame,
  clearSnapshotFile,
  consumeGameStartSignal,
  createBrowserControlState,
  createBootstrapState,
  createClosureCaptureState,
  createGameStartSignalState,
  createSnapshotTracking,
  deriveGameplayPhase,
  disarmClosureCaptureWindow,
  determineChromiumOwnership,
  expireClosureCaptureWindow,
  activatePendingClosureCaptureArm,
  clearPendingClosureCaptureArm,
  exposeTetrioGameFromPausedCallFrames,
  getBootstrapReadinessStatus,
  hasUnconsumedGameStartSignal,
  hasPendingClosureCaptureArm,
  isBootstrapReadyForClosureCapture,
  isClosureCaptureArmed,
  isGameplayExpectedForClosureCapture,
  isTransientRuntimeError,
  isVsWsSimEnvEnabled,
  isTetrioGameEndedState,
  pausedFrameExposureExpression,
  noteGameStartSignal,
  readTetrioState,
  requestClosureCaptureArm,
  reactivateClosureCaptureArmAfterBootstrap,
  resetGameStartSignalState,
  resetPausedScopeScanProgress,
  resetClosureCaptureLocatorHint,
  resetBootstrapState,
  resetTetrioNetworkState,
  resolvePollMs,
  resolveUseSeedSimulationFallback,
  resetSnapshotTracking,
  safeRuntimeEvaluate,
  scheduleClosureCaptureContinuation,
  scheduleNextClosureCaptureAttempt,
  shouldAttemptClosureCapture,
  shouldLogClosureCaptureSkipped,
  shouldLogStateReason,
  shouldAdvanceGameEpoch,
  shouldHandleEndedGame,
  tetrioStateExpression,
  updateBootstrapDocumentState
} from "./tetrio-cdp-source.mjs";

test("connect-only snapshot helper never claims Chromium ownership", () => {
  assert.equal(
    determineChromiumOwnership({ connectOnly: true, alreadyOpen: false }),
    false
  );
  assert.equal(
    determineChromiumOwnership({ connectOnly: true, alreadyOpen: true }),
    false
  );
});

test("snapshot helper owns Chromium only when it launched the browser", () => {
  assert.equal(
    determineChromiumOwnership({ connectOnly: false, alreadyOpen: false }),
    true
  );
  assert.equal(
    determineChromiumOwnership({ connectOnly: false, alreadyOpen: true }),
    false
  );
});

function createBoard() {
  return Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => 0));
}

function createGame({
  destroyed = false,
  started = true,
  playing = true,
  current = "t",
  hold = "i",
  queue = ["o", "s", "z"],
  pieceCounter = 0,
  linesCleared = undefined,
  board = createBoard()
} = {}) {
  return {
    ejectState() {
      return {
        game: {
          board,
          falling: { type: current, x: 4, y: 19, rotation: 0 },
          hold,
          queue,
          stats: {
            piecesplaced: pieceCounter,
            lines: linesCleared,
            combo: 0,
            b2b: 0,
            impendingdamage: 0
          },
          destroyed,
          dead: destroyed,
          gameover: destroyed,
          started
        }
      };
    },
    ejectBoardState() {
      return { b: board };
    },
    isPlaying() {
      return playing;
    },
    isStarted() {
      return started;
    }
  };
}

function evaluateInWindow(expression, windowOverrides = {}, extraContext = {}) {
  const window = {
    ...windowOverrides
  };
  window.window = window;
  const context = {
    window,
    location: { href: "https://tetr.io/" },
    Date,
    Math,
    Object,
    Array,
    Boolean,
    Number,
    String,
    ...extraContext
  };
  return {
    result: vm.runInNewContext(expression, context),
    window
  };
}

async function withPatchedDateNow(getNow, callback) {
  const originalDateNow = Date.now;
  Date.now = getNow;
  try {
    return await callback();
  } finally {
    Date.now = originalDateNow;
  }
}

function createReadStateCdp(values) {
  const queue = [...values];
  return {
    runtimeCalls: [],
    async send(method, params = {}) {
      if (method !== "Runtime.evaluate") {
        throw new Error(`Unhandled method ${method}`);
      }
      this.runtimeCalls.push(params);
      if (String(params.expression).includes("document.readyState")) {
        return {
          result: {
            value: {
              readyState: "complete",
              href: "https://tetr.io/"
            }
          }
        };
      }
      return {
        result: {
          value: queue.shift() ?? {
            ok: false,
            ready: false,
            reason: "mock state missing"
          }
        }
      };
    }
  };
}

function readyBootstrapState(now = 20_000, { transportReadyAt = 18_500 } = {}) {
  const bootstrapState = createBootstrapState(0);
  updateBootstrapDocumentState(
    bootstrapState,
    { readyState: "complete", href: "https://tetr.io/" },
    1
  );
  bootstrapState.transportReadyAt = transportReadyAt;
  bootstrapState.readyLogged = false;
  bootstrapState.waitingLogged = false;
  return bootstrapState;
}

function armedClosureCaptureState(
  now = 20_000,
  { reason = "ribbon_seed", windowMs = 8000 } = {}
) {
  const closureCaptureState = createClosureCaptureState();
  armClosureCaptureWindow(closureCaptureState, {
    reason,
    now,
    windowMs,
    log: () => {}
  });
  return closureCaptureState;
}

test("game ended handling is triggered only once per ended session", () => {
  const endedState = {
    ok: true,
    ready: false,
    reason: "TETR.IO game ended"
  };
  assert.equal(isTetrioGameEndedState(endedState), true);
  assert.equal(shouldHandleEndedGame(endedState, false), true);
  assert.equal(shouldHandleEndedGame(endedState, true), false);
});

test("resetSnapshotTracking clears stable signature state", () => {
  const tracking = createSnapshotTracking();
  tracking.stableSignature = "sig";
  tracking.stableCount = 2;
  tracking.lastWrittenSignature = "written";
  tracking.lastLoggedToken = "browser-1-0";
  tracking.pendingPieceKey = "1:0";
  tracking.pendingPieceDetectedAt = 123;
  tracking.lastPerfLoggedPieceKey = "1:0";

  resetSnapshotTracking(tracking);

  assert.deepEqual(tracking, {
    stableSignature: "",
    stableCount: 0,
    lastWrittenSignature: "",
    lastLoggedToken: "",
    pendingPieceKey: "",
    pendingPieceDetectedAt: 0,
    lastPerfLoggedPieceKey: ""
  });
});

test("snapshot helper defaults browser poll to 8ms", () => {
  assert.equal(resolvePollMs({}), 8);
  assert.equal(resolvePollMs({ pollMs: "12" }), 12);
});

test("VS WebSocket simulation disables browser seed fallback only when enabled", () => {
  assert.equal(resolveUseSeedSimulationFallback(true, {}), true);
  assert.equal(
    resolveUseSeedSimulationFallback(true, { FUSION_VS_WS_SIM: "0" }),
    true
  );
  assert.equal(
    resolveUseSeedSimulationFallback(true, { FUSION_VS_WS_SIM: "1" }),
    false
  );
  assert.equal(
    resolveUseSeedSimulationFallback(false, { FUSION_VS_WS_SIM: "1" }),
    false
  );
});

test("VS sim env detection only enables suppression for env value 1", () => {
  assert.equal(isVsWsSimEnvEnabled({}), false);
  assert.equal(isVsWsSimEnvEnabled({ FUSION_VS_WS_SIM: "0" }), false);
  assert.equal(isVsWsSimEnvEnabled({ FUSION_VS_WS_SIM: "1" }), true);
});

test("closure capture probe is skipped when gameplay is not expected", () => {
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: false,
      stateOk: false,
      gameplayExpected: false,
      lastCaptureAt: 0,
      lastPageProbeAt: 0,
      now: 10_000
    }),
    false
  );
});

test("closure capture probe is attempted when gameplay is expected and cooldown elapsed", () => {
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: false,
      stateOk: false,
      gameplayExpected: true,
      lastCaptureAt: 0,
      lastPageProbeAt: 0,
      now: 10_000
    }),
    true
  );
});

test("closure capture probe is suppressed while VS round is active", () => {
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: true,
      stateOk: false,
      gameplayExpected: true,
      lastCaptureAt: 0,
      lastPageProbeAt: 0,
      now: 10_000
    }),
    false
  );
});

test("closure capture probe is not attempted after state is already ok", () => {
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: false,
      stateOk: true,
      gameplayExpected: true,
      lastCaptureAt: 0,
      lastPageProbeAt: 0,
      now: 10_000
    }),
    false
  );
});

test("closure capture probe is not attempted before cooldown elapses", () => {
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: false,
      stateOk: false,
      gameplayExpected: true,
      lastCaptureAt: 9_500,
      lastPageProbeAt: 9_500,
      now: 10_000
    }),
    false
  );
});

test("game start signal arms a bounded closure capture window", () => {
  const closureCaptureState = createClosureCaptureState();
  armClosureCaptureWindow(closureCaptureState, {
    reason: "ribbon_seed",
    now: 1_000,
    windowMs: 8_000,
    log: () => {}
  });

  assert.equal(isClosureCaptureArmed(closureCaptureState, 1_001), true);
  assert.equal(
    isGameplayExpectedForClosureCapture({
      state: { ok: false, playing: false, countdown: false },
      closureCaptureState,
      now: 1_001
    }),
    true
  );
  assert.equal(isClosureCaptureArmed(closureCaptureState, 9_100), false);
});

test("closure capture window disarms immediately on lobby or game end transition", () => {
  const closureCaptureState = armedClosureCaptureState(1_000);
  disarmClosureCaptureWindow(closureCaptureState, {
    reason: "game_ended",
    log: () => {}
  });

  assert.equal(isClosureCaptureArmed(closureCaptureState, 1_001), false);
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: false,
      stateOk: false,
      gameplayExpected: isGameplayExpectedForClosureCapture({
        state: { ok: false, playing: false, countdown: false },
        closureCaptureState,
        now: 1_001
      }),
      lastCaptureAt: 0,
      lastPageProbeAt: 0,
      now: 10_000
    }),
    false
  );
});

test("closure capture skipped logging is throttled while gameplay is not expected", () => {
  assert.equal(
    shouldLogClosureCaptureSkipped({
      gameplayExpected: false,
      lastSkippedLogAt: 0,
      now: 10_000
    }),
    false
  );
  assert.equal(
    shouldLogClosureCaptureSkipped({
      gameplayExpected: false,
      lastSkippedLogAt: 0,
      now: 70_000
    }),
    true
  );
});

test("Bot Off -> On control message opens a bounded arming window", () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();

  assert.equal(
    applyBrowserControlMessage({
      message: { type: "bot_enabled", enabled: true },
      controlState,
      closureCaptureState,
      now: 2_000,
      log: () => {}
    }),
    true
  );
  assert.equal(controlState.botEnabled, true);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 2_001), true);
});

test("bootstrap not ready stores a pending bot_on arm instead of consuming the live window", () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();
  const logs = [];

  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    bootstrapReady: false,
    now: 2_000,
    log: (line) => logs.push(line)
  });

  assert.equal(controlState.botEnabled, true);
  assert.equal(hasPendingClosureCaptureArm(closureCaptureState), true);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 2_001), false);
  assert.equal(closureCaptureState.pendingCaptureArm?.reason, "bot_on");
  assert.ok(
    logs.includes("[browser] closure capture pending reason=bot_on bootstrap_not_ready")
  );
});

test("repeated Bot On control messages do not extend the arming window", () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();

  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    now: 2_000,
    log: () => {}
  });
  const firstArmedUntil = closureCaptureState.armedUntil;

  assert.equal(
    applyBrowserControlMessage({
      message: { type: "bot_enabled", enabled: true },
      controlState,
      closureCaptureState,
      now: 6_000,
      log: () => {}
    }),
    false
  );
  assert.equal(closureCaptureState.armedUntil, firstArmedUntil);
});

test("arming window expires without reopening until a fresh signal arrives", () => {
  const closureCaptureState = armedClosureCaptureState(2_000);
  expireClosureCaptureWindow(closureCaptureState, 10_001);

  assert.equal(isClosureCaptureArmed(closureCaptureState, 10_001), false);
  assert.equal(closureCaptureState.armedUntil, 0);
});

test("Bot Off control message disarms the arming window immediately", () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();

  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    now: 2_000,
    log: () => {}
  });
  assert.equal(
    applyBrowserControlMessage({
      message: { type: "bot_enabled", enabled: false },
      controlState,
      closureCaptureState,
      now: 3_000,
      log: () => {}
    }),
    true
  );
  assert.equal(controlState.botEnabled, false);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 3_001), false);
});

test("Bot Off clears a pending bootstrap arm immediately", () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();

  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    bootstrapReady: false,
    now: 2_000,
    log: () => {}
  });
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: false },
    controlState,
    closureCaptureState,
    now: 2_500,
    log: () => {}
  });

  assert.equal(hasPendingClosureCaptureArm(closureCaptureState), false);
  assert.equal(controlState.botEnabled, false);
});

test("bootstrap ready activates a pending arm without charging the waiting time to the 8s window", () => {
  const closureCaptureState = createClosureCaptureState();
  requestClosureCaptureArm(closureCaptureState, {
    reason: "bot_on",
    bootstrapReady: false,
    now: 2_000,
    log: () => {}
  });

  activatePendingClosureCaptureArm(closureCaptureState, {
    now: 12_000,
    log: () => {}
  });

  assert.equal(hasPendingClosureCaptureArm(closureCaptureState), false);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 12_001), true);
  assert.equal(closureCaptureState.armedReason, "bot_on_after_bootstrap");
  assert.equal(closureCaptureState.armedUntil, 20_000);
  assert.equal(closureCaptureState.nextAttemptAt, 12_000);
});

test("bootstrap ready can restart an existing arm once without repeated extension", () => {
  const closureCaptureState = armedClosureCaptureState(2_000, {
    reason: "game_start_transition"
  });

  reactivateClosureCaptureArmAfterBootstrap(closureCaptureState, {
    now: 5_000,
    log: () => {}
  });
  const firstArmedUntil = closureCaptureState.armedUntil;
  const firstReason = closureCaptureState.armedReason;

  assert.equal(firstReason, "game_start_transition_after_bootstrap");
  assert.equal(firstArmedUntil, 13_000);

  reactivateClosureCaptureArmAfterBootstrap(closureCaptureState, {
    now: 5_000,
    log: () => {}
  });

  assert.equal(closureCaptureState.armedReason, "game_start_transition_after_bootstrap");
  assert.equal(closureCaptureState.armedUntil, 13_000);
});

test("bootstrap readiness uses document and transport signals without game object state", () => {
  const bootstrapState = createBootstrapState(0);
  updateBootstrapDocumentState(
    bootstrapState,
    { readyState: "interactive", href: "https://tetr.io/" },
    100
  );
  bootstrapState.transportReadyAt = 1_000;

  const waiting = getBootstrapReadinessStatus(bootstrapState, 2_000);
  const ready = getBootstrapReadinessStatus(bootstrapState, 2_600);

  assert.equal(waiting.ready, false);
  assert.match(waiting.reason, /transport_settling_/);
  assert.equal(ready.ready, true);
  assert.equal(isBootstrapReadyForClosureCapture(bootstrapState, 2_600), true);
});

test("clearing a pending arm is idempotent", () => {
  const closureCaptureState = createClosureCaptureState();
  assert.equal(clearPendingClosureCaptureArm(closureCaptureState), false);
  requestClosureCaptureArm(closureCaptureState, {
    reason: "bot_on",
    bootstrapReady: false,
    now: 1_000,
    log: () => {}
  });
  assert.equal(clearPendingClosureCaptureArm(closureCaptureState), true);
  assert.equal(hasPendingClosureCaptureArm(closureCaptureState), false);
});

test("game-start signal arm allows an immediate first capture attempt without waiting for cooldown", async () => {
  let captureCalls = 0;
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  requestClosureCaptureArm(closureCaptureState, {
    reason: "game_start_signal",
    bootstrapReady: true,
    now: 50_000,
    log: (line) => logs.push(line)
  });
  const cdp = createReadStateCdp([
    {
      ok: false,
      ready: false,
      playing: true,
      countdown: false,
      reason: "TETR.IO game instance not captured yet"
    }
  ]);

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 50_000, seed: null },
    probeState: { lastCaptureAt: 50_000, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(50_000),
    browserControlState,
    closureCaptureState,
    now: 50_000,
    log: (line) => logs.push(line),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "still hidden" };
    }
  });

  assert.equal(captureCalls, 1);
  assert.equal(closureCaptureState.retryCount, 1);
  assert.equal(closureCaptureState.nextAttemptAt, 50_750);
  assert.equal(deriveGameplayPhase({ playing: true, countdown: false }), "playing");
  assert.ok(
    logs.includes("[browser] closure capture armed reason=game_start_signal")
  );
});

test("pending bot_on arm performs zero heavy capture attempts while bootstrap remains blocked", async () => {
  let captureCalls = 0;
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const browserControlState = createBrowserControlState();
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState: browserControlState,
    closureCaptureState,
    bootstrapReady: false,
    now: 1_000,
    log: (line) => logs.push(line)
  });
  const cdp = {
    async send(method, params = {}) {
      assert.equal(method, "Runtime.evaluate");
      if (String(params.expression).includes("document.readyState")) {
        return {
          result: {
            value: {
              readyState: "loading",
              href: "https://tetr.io/"
            }
          }
        };
      }
      return {
        result: {
          value: {
            ok: false,
            ready: false,
            reason: "TETR.IO game instance not captured yet"
          }
        }
      };
    }
  };

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: createBootstrapState(0),
    browserControlState,
    closureCaptureState,
    now: 2_000,
    log: (line) => logs.push(line),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(hasPendingClosureCaptureArm(closureCaptureState), true);
  assert.ok(logs.includes("[browser] closure capture blocked reason=bootstrap_not_ready"));
});

test("pending bot_on arm activates on bootstrap ready transition and captures immediately", async () => {
  let captureCalls = 0;
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const browserControlState = createBrowserControlState();
  const bootstrapState = createBootstrapState(0);
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState: browserControlState,
    closureCaptureState,
    bootstrapReady: false,
    now: 1_000,
    log: (line) => logs.push(line)
  });

  const cdp = createReadStateCdp([
    {
      ok: false,
      ready: false,
      playing: true,
      countdown: false,
      reason: "TETR.IO game instance not captured yet"
    }
  ]);
  updateBootstrapDocumentState(
    bootstrapState,
    { readyState: "interactive", href: "https://tetr.io/" },
    100
  );
  bootstrapState.transportReadyAt = 500;

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 60_000, seed: null },
    probeState: { lastCaptureAt: 60_000, lastGameplayPhase: "inactive" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    now: 2_100,
    log: (line) => logs.push(line),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "still hidden" };
    }
  });

  assert.equal(captureCalls, 1);
  assert.equal(closureCaptureState.armedReason, "bot_on_after_bootstrap");
  assert.equal(closureCaptureState.nextAttemptAt, 2_850);
  assert.ok(logs.includes("[browser] bootstrap ready; activating pending arm reason=bot_on"));
  assert.ok(logs.includes("[browser] closure capture first attempt reason=bot_on_after_bootstrap"));
});

test("bootstrap ready transition only reactivates once and does not extend the window on later polls", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const browserControlState = createBrowserControlState();
  const bootstrapState = createBootstrapState(0);
  browserControlState.botEnabled = true;
  requestClosureCaptureArm(closureCaptureState, {
    reason: "bot_on",
    bootstrapReady: false,
    now: 1_000,
    log: () => {}
  });
  updateBootstrapDocumentState(
    bootstrapState,
    { readyState: "interactive", href: "https://tetr.io/" },
    100
  );
  bootstrapState.transportReadyAt = 500;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, playing: true, countdown: false, reason: "hidden" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    now: 2_100,
    log: (line) => logs.push(line),
    captureGameFn: async () => ({ ok: false, reason: "still hidden" })
  });
  const firstArmedUntil = closureCaptureState.armedUntil;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, playing: true, countdown: false, reason: "hidden" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "playing" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    now: 2_200,
    log: (line) => logs.push(line),
    captureGameFn: async () => ({ ok: false, reason: "still hidden" })
  });

  assert.equal(closureCaptureState.armedUntil, firstArmedUntil);
  assert.equal(
    logs.filter((line) => line === "[browser] bootstrap ready; activating pending arm reason=bot_on").length,
    1
  );
});

test("independent game-start signal state tracks unconsumed signals without game object state", () => {
  const signalState = createGameStartSignalState();

  assert.equal(
    noteGameStartSignal(signalState, {
      key: "ddd:seed-a",
      source: "ddd_game_options",
      now: 60_000,
      details: { seed: "a" }
    }),
    true
  );
  assert.equal(hasUnconsumedGameStartSignal(signalState), true);
  assert.equal(signalState.latestSource, "ddd_game_options");
  assert.deepEqual(signalState.latestDetails, { seed: "a" });
  assert.deepEqual(consumeGameStartSignal(signalState), {
    key: "ddd:seed-a",
    source: "ddd_game_options",
    seenAt: 60_000,
    details: { seed: "a" }
  });
  assert.equal(hasUnconsumedGameStartSignal(signalState), false);
});

test("repeated game-start signal keys do not create duplicate transitions", () => {
  const signalState = createGameStartSignalState();
  noteGameStartSignal(signalState, {
    key: "ddd:seed-a",
    source: "ddd_game_options",
    now: 60_000
  });

  assert.equal(
    noteGameStartSignal(signalState, {
      key: "ddd:seed-a",
      source: "ddd_game_options",
      now: 61_000
    }),
    false
  );
  assert.equal(hasUnconsumedGameStartSignal(signalState), true);
});

test("game-start signal cutoff preserves recent next-game signals while ignoring stale prior-game ones", () => {
  const signalState = createGameStartSignalState();
  noteGameStartSignal(signalState, {
    key: "ddd:game-1",
    source: "ddd_game_options",
    now: 1_000
  });
  noteGameStartSignal(signalState, {
    key: "ribbon:game-2",
    source: "ribbon_seed",
    now: 59_500,
    details: { seed: "next-seed" }
  });

  assert.equal(hasUnconsumedGameStartSignal(signalState, { since: 50_000 }), true);
  assert.deepEqual(
    consumeGameStartSignal(signalState, { since: 50_000 }),
    {
      key: "ribbon:game-2",
      source: "ribbon_seed",
      seenAt: 59_500,
      details: { seed: "next-seed" }
    }
  );
  assert.equal(hasUnconsumedGameStartSignal(signalState, { since: 50_000 }), false);
});

test("game-start signal can rehydrate network fallback state after ended cleanup", () => {
  const network = {
    seed: null,
    nextCount: 6,
    readyAt: 0,
    ribbonSeen: false,
    lastPageProbeAt: 0
  };

  assert.equal(
    applyGameStartSignalToNetwork(network, {
      key: "ribbon:game-2",
      source: "ribbon_seed",
      seenAt: 60_000,
      details: {
        seed: "456",
        nextCount: 8,
        readyAt: 64_500
      }
    }),
    true
  );
  assert.deepEqual(network, {
    seed: "456",
    nextCount: 8,
    readyAt: 64_500,
    ribbonSeen: false,
    lastPageProbeAt: 0
  });
});

test("game-start signal state can be reset on navigation or browser restart", () => {
  const signalState = createGameStartSignalState();
  noteGameStartSignal(signalState, {
    key: "ddd:seed-a",
    source: "ddd_game_options",
    now: 60_000
  });

  assert.equal(resetGameStartSignalState(signalState), true);
  assert.equal(hasUnconsumedGameStartSignal(signalState), false);
  assert.equal(signalState.latestKey, "");
});

test("network state reset clears stale ribbon timing and seed state", () => {
  const network = {
    seed: "123",
    nextCount: 8,
    readyAt: 999,
    ribbonSeen: true,
    lastPageProbeAt: 555
  };

  assert.equal(resetTetrioNetworkState(network), true);
  assert.deepEqual(network, {
    seed: null,
    nextCount: 6,
    readyAt: 0,
    ribbonSeen: false,
    lastPageProbeAt: 0
  });
});

test("locator hint reset clears the cached fast-path name", () => {
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.lastSuccessfulLocator = "Ai";

  assert.equal(resetClosureCaptureLocatorHint(closureCaptureState), true);
  assert.equal(closureCaptureState.lastSuccessfulLocator, "");
});

test("resetPausedScopeScanProgress clears continuation cursor and budget", () => {
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 320;
  closureCaptureState.pausedScopeScanCursor = {
    frameIndex: 1,
    scopeIndex: 2,
    propertyIndex: 3,
    completedScopeKeys: ["0:0:scope-1"],
    seenCandidateKeys: ["0:0:scope-1:Ai:candidate-1"]
  };
  closureCaptureState.scanBudgetExhausted = true;

  assert.equal(resetPausedScopeScanProgress(closureCaptureState), true);
  assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 0);
  assert.equal(closureCaptureState.pausedScopeScanCursor, null);
  assert.equal(closureCaptureState.scanBudgetExhausted, false);
});

test("new arm resets stale paused scan budget attempt cursor and fast-path state", () => {
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.fullScanAttemptsInWindow = 2;
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 700;
  closureCaptureState.pausedScopeScanCursor = {
    frameIndex: 4,
    scopeIndex: 3,
    propertyIndex: 9,
    completedScopeKeys: ["1:1:scope-1"],
    seenCandidateKeys: ["1:1:scope-1:Ai:candidate-1"]
  };
  closureCaptureState.scanBudgetExhausted = true;
  closureCaptureState.fastLocatorAttempted = true;
  closureCaptureState.nextAttemptAt = 999_999;

  armClosureCaptureWindow(closureCaptureState, {
    reason: "bot_on",
    now: 20_000,
    log: () => {}
  });

  assert.equal(closureCaptureState.fullScanAttemptsInWindow, 0);
  assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 0);
  assert.equal(closureCaptureState.scanBudgetExhausted, false);
  assert.equal(closureCaptureState.fastLocatorAttempted, false);
  assert.equal(closureCaptureState.nextAttemptAt, 20_000);
  assert.deepEqual(closureCaptureState.pausedScopeScanCursor, {
    frameIndex: 0,
    scopeIndex: 0,
    propertyIndex: 0,
    completedScopeKeys: [],
    seenCandidateKeys: []
  });
});

test("fresh arm prevents first full scan from exhausting before attempt logging", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.fullScanAttemptsInWindow = 2;
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 700;
  closureCaptureState.pausedScopeScanCursor = {
    frameIndex: 9,
    scopeIndex: 9,
    propertyIndex: 9,
    completedScopeKeys: ["9:9:scope-stale"],
    seenCandidateKeys: ["9:9:scope-stale:Ai:candidate-stale"]
  };
  closureCaptureState.scanBudgetExhausted = true;

  armClosureCaptureWindow(closureCaptureState, {
    reason: "bot_on",
    now: 30_000,
    log: () => {}
  });

  const result = await exposeTetrioGameFromPausedCallFrames({
    async send(method) {
      if (method === "Runtime.getProperties") {
        return {
          result: [{ name: "Ai", value: { objectId: "candidate-1" } }]
        };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: { ok: false }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  }, {
    callFrames: [{
      callFrameId: "frame-1",
      scopeChain: [{ object: { objectId: "scope-1" } }]
    }]
  }, {
    closureCaptureState,
    log: (line) => logs.push(line)
  });

  assert.equal(result.reason, "TETR.IO active game variable was not in paused scopes");
  assert.ok(logs.includes("[browser] full closure scan attempt=1/2"));
  assert.equal(
    logs.some((line) => line.includes("cumulative budget exhausted")),
    false
  );
});

test("retry scheduling does not consume paused scan budget", () => {
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 280;

  assert.equal(scheduleClosureCaptureContinuation(closureCaptureState, 10_000, 100), 100);
  assert.equal(closureCaptureState.nextAttemptAt, 10_100);
  assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 280);

  assert.equal(scheduleNextClosureCaptureAttempt(closureCaptureState, 11_000, [750]), 750);
  assert.equal(closureCaptureState.nextAttemptAt, 11_750);
  assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 280);
});

test("fast closure locator hint succeeds before the paused scope scan", async () => {
  const logs = [];
  const methods = [];
  const cdp = {
    async send(method, params = {}) {
      methods.push({ method, params });
      if (method === "Debugger.evaluateOnCallFrame") {
        return {
          result: {
            value: {
              ok: true,
              source: "closure:Ai",
              locator: "Ai"
            }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  const result = await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [{ callFrameId: "frame-1", scopeChain: [] }]
  }, {
    closureCaptureState: { lastSuccessfulLocator: "Ai" },
    log: (line) => logs.push(line)
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    methods.map((entry) => entry.method),
    ["Debugger.evaluateOnCallFrame"]
  );
  assert.ok(logs.includes("[browser] fast closure locator succeeded locator=Ai"));
});

test("locator hint failure falls back to the paused scope scan", async () => {
  const logs = [];
  const methods = [];
  const cdp = {
    async send(method, params = {}) {
      methods.push({ method, params });
      if (method === "Debugger.evaluateOnCallFrame") {
        return {
          result: {
            value: { ok: false }
          }
        };
      }
      if (method === "Runtime.getProperties") {
        assert.equal(params.objectId, "scope-1");
        return {
          result: [
            {
              name: "Ai",
              value: { objectId: "candidate-1" }
            }
          ]
        };
      }
      if (method === "Runtime.callFunctionOn") {
        assert.equal(params.objectId, "candidate-1");
        return {
          result: {
            value: {
              ok: true,
              source: "closure:Ai",
              locator: "Ai"
            }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  const result = await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [{
      callFrameId: "frame-1",
      scopeChain: [{ object: { objectId: "scope-1" } }]
    }]
  }, {
    closureCaptureState: { lastSuccessfulLocator: "Ai" },
    log: (line) => logs.push(line)
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    methods.map((entry) => entry.method),
    [
      "Debugger.evaluateOnCallFrame",
      "Runtime.getProperties",
      "Runtime.callFunctionOn"
    ]
  );
  assert.ok(logs.includes("[browser] fast closure locator failed; falling back to scan"));
});

test("first solo full scan resumes from the saved cursor without rechecking candidates", async () => {
  const logs = [];
  const visitedCandidates = [];
  const closureCaptureState = createClosureCaptureState();
  let fakeNow = 1_000;
  const descriptors = [1, 2, 3].map((index) => ({
    name: `Ai${index}`,
    value: { objectId: `candidate-${index}` }
  }));
  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.getProperties") {
        return { result: descriptors };
      }
      if (method === "Runtime.callFunctionOn") {
        visitedCandidates.push(params.objectId);
        fakeNow += 180;
        return {
          result: {
            value:
              params.objectId === "candidate-3"
                ? { ok: true, source: "closure:Ai3", locator: "Ai3" }
                : { ok: false }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  await withPatchedDateNow(() => fakeNow, async () => {
    const first = await exposeTetrioGameFromPausedCallFrames(cdp, {
      callFrames: [{
        callFrameId: "frame-1",
        scopeChain: [{ object: { objectId: "scope-1" } }]
      }]
    }, {
      closureCaptureState,
      log: (line) => logs.push(line)
    });
    assert.equal(first.ok, false);
    assert.equal(first.outcome, "partial_budget_exhausted");
    assert.equal(closureCaptureState.fullScanAttemptsInWindow, 1);
    assert.deepEqual(visitedCandidates, ["candidate-1", "candidate-2"]);

    const second = await exposeTetrioGameFromPausedCallFrames(cdp, {
      callFrames: [{
        callFrameId: "frame-2",
        scopeChain: [{ object: { objectId: "scope-1" } }]
      }]
    }, {
      closureCaptureState,
      log: (line) => logs.push(line)
    });
    assert.equal(second.ok, true);
    assert.equal(second.locator, "Ai3");
  });

  assert.deepEqual(visitedCandidates, ["candidate-1", "candidate-2", "candidate-3"]);
  assert.equal(closureCaptureState.pausedScopeScanCursor, null);
  assert.ok(logs.includes("[browser] full closure scan attempt=1/2"));
  assert.ok(logs.includes("[browser] full closure scan attempt=2/2"));
  assert.ok(
    logs.some((line) =>
      line.startsWith("[browser] full closure scan progress attempt=1/2 frame=0 scope=0 candidate=2")
    )
  );
  assert.ok(
    logs.includes("[browser] full closure scan continuation from frame=0 scope=0 candidate=2")
  );
});

test("paused scan continuation preserves cursor and remaining cumulative budget", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const visitedCandidates = [];
  let fakeNow = 1_000;
  const descriptors = Array.from({ length: 4 }, (_, index) => ({
    name: `Ai${index + 1}`,
    value: { objectId: `candidate-${index + 1}` }
  }));
  const cdp = {
    async send(method, params = {}) {
      if (method === "Runtime.getProperties") {
        return { result: descriptors };
      }
      if (method === "Runtime.callFunctionOn") {
        visitedCandidates.push(params.objectId);
        fakeNow += 175;
        return {
          result: {
            value:
              params.objectId === "candidate-4"
                ? { ok: true, source: "closure:Ai4", locator: "Ai4" }
                : { ok: false }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  await withPatchedDateNow(() => fakeNow, async () => {
    const first = await exposeTetrioGameFromPausedCallFrames(cdp, {
      callFrames: [{
        callFrameId: "frame-1",
        scopeChain: [{ object: { objectId: "scope-1" } }]
      }]
    }, {
      closureCaptureState,
      log: (line) => logs.push(line)
    });
    assert.equal(first.ok, false);
    assert.equal(first.reason, "TETR.IO paused scope scan pause budget reached");
    assert.equal(first.outcome, "partial_budget_exhausted");
    assert.equal(first.progress?.pausedMs, 350);
    assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 350);
    assert.deepEqual(closureCaptureState.pausedScopeScanCursor, {
      frameIndex: 0,
      scopeIndex: 0,
      propertyIndex: 2,
      completedScopeKeys: [],
      seenCandidateKeys: [
        "0:0:scope-1:Ai1:candidate-1",
        "0:0:scope-1:Ai2:candidate-2"
      ]
    });

    const second = await exposeTetrioGameFromPausedCallFrames(cdp, {
      callFrames: [{
        callFrameId: "frame-2",
        scopeChain: [{ object: { objectId: "scope-1" } }]
      }]
    }, {
      closureCaptureState,
      log: (line) => logs.push(line)
    });
    assert.equal(second.ok, true);
    assert.equal(second.locator, "Ai4");
  });

  assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 700);
  assert.ok(closureCaptureState.cumulativePausedScanBudgetUsedMs <= 700);
  assert.equal(closureCaptureState.pausedScopeScanCursor, null);
  assert.equal(visitedCandidates.length, 4);
  assert.equal(visitedCandidates[0], "candidate-1");
  assert.equal(visitedCandidates.at(-1), "candidate-4");
  assert.ok(
    logs.includes("[browser] full closure scan continuation from frame=0 scope=0 candidate=2")
  );
});

test("capture window limits full paused-scope scans and avoids repeated fast-locator spam", async () => {
  const logs = [];
  let pausedEvents = 0;
  const methods = [];
  const closureCaptureState = createClosureCaptureState();
  armClosureCaptureWindow(closureCaptureState, {
    reason: "bot_on",
    now: 1_000,
    log: () => {}
  });
  closureCaptureState.lastSuccessfulLocator = "Ai";
  const cdp = {
    async send(method, params = {}) {
      methods.push(method);
      if (method === "Runtime.evaluate") {
        return {
          result: {
            objectId: "fn-1"
          }
        };
      }
      if (method === "Debugger.enable" || method === "Debugger.disable") {
        return {};
      }
      if (method === "Debugger.setBreakpointOnFunctionCall") {
        return { breakpointId: `bp-${Math.random()}` };
      }
      if (method === "Debugger.removeBreakpoint") {
        return {};
      }
      if (method === "Runtime.releaseObjectGroup") {
        return {};
      }
      if (method === "Debugger.resume") {
        return {};
      }
      if (method === "Debugger.evaluateOnCallFrame") {
        return {
          result: {
            value: { ok: false }
          }
        };
      }
      if (method === "Runtime.getProperties") {
        return {
          result: [
            {
              name: "Ai",
              value: { objectId: "candidate-1" }
            }
          ]
        };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: { ok: false }
          }
        };
      }
      throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
    },
    async waitForEvent() {
      pausedEvents += 1;
      return {
        callFrames: [{
          callFrameId: `frame-${pausedEvents}`,
          scopeChain: [{ object: { objectId: `scope-${pausedEvents}` } }]
        }]
      };
    }
  };

  const first = await captureTetrioGame(cdp, {
    closureCaptureState,
    log: (line) => logs.push(line)
  });
  const second = await captureTetrioGame(cdp, {
    closureCaptureState,
    log: (line) => logs.push(line)
  });
  const third = await captureTetrioGame(cdp, {
    closureCaptureState,
    log: (line) => logs.push(line)
  });

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(third.reason, "TETR.IO capture attempt window budget exhausted");
  assert.equal(
    logs.filter((line) => line === "[browser] fast closure locator failed; falling back to scan").length,
    1
  );
  assert.equal(
    logs.filter((line) => line.startsWith("[browser] full closure scan attempt=")).length,
    2
  );
  assert.equal(
    methods.filter((method) => method === "Debugger.evaluateOnCallFrame").length,
    1
  );
});

test("partial full scan keeps the window armed and bot enabled until the second failure", async () => {
  const logs = [];
  let attempt = 0;
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    now: 20_000,
    log: () => {}
  });

  const captureGameFn = async () => {
    attempt += 1;
    closureCaptureState.fullScanAttemptsInWindow = attempt;
    if (attempt === 1) {
      return {
        ok: false,
        reason: "TETR.IO paused scope scan pause budget reached",
        outcome: "partial_budget_exhausted"
      };
    }
    return {
      ok: false,
      reason: "TETR.IO active game variable was not in paused scopes",
      outcome: "completed_not_found"
    };
  };

  const first = await readTetrioState(createReadStateCdp([
    {
      ok: false,
      ready: false,
      playing: true,
      countdown: false,
      reason: "TETR.IO game instance not captured yet"
    }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(20_000),
    browserControlState: controlState,
    closureCaptureState,
    now: 20_000,
    log: (line) => logs.push(line),
    captureGameFn
  });

  assert.equal(first.ok, false);
  assert.equal(controlState.botEnabled, true);
  assert.equal(closureCaptureState.fullScanAttemptsInWindow, 1);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 20_001), true);
  assert.equal(closureCaptureState.nextAttemptAt, 20_100);
  assert.equal(closureCaptureState.retryCount, 0);
  assert.ok(
    logs.includes("[browser] full closure scan paused budget reached; scheduling continuation")
  );
  assert.equal(
    logs.includes("[browser] closure capture disarmed reason=scan_budget_exhausted"),
    false
  );

  const second = await readTetrioState(createReadStateCdp([
    {
      ok: false,
      ready: false,
      playing: true,
      countdown: false,
      reason: "TETR.IO game instance not captured yet"
    }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 20_000, seed: null },
    probeState: { lastCaptureAt: 20_000, lastGameplayPhase: "playing" },
    bootstrapState: readyBootstrapState(20_100),
    browserControlState: controlState,
    closureCaptureState,
    now: 20_100,
    log: (line) => logs.push(line),
    captureGameFn
  });

  assert.equal(second.ok, false);
  assert.equal(controlState.botEnabled, true);
  assert.equal(closureCaptureState.fullScanAttemptsInWindow, 0);
  assert.equal(isClosureCaptureArmed(closureCaptureState, 20_101), false);
  assert.ok(logs.includes("[browser] closure capture disarmed reason=scan_budget_exhausted"));
});

test("suppressed VS reason is not periodically re-logged", () => {
  assert.equal(
    shouldLogStateReason({
      reason: "VS WebSocket simulation owns live state",
      lastReason: "VS WebSocket simulation owns live state",
      lastReasonAt: 1_000,
      now: 20_000,
      suppressRepeatedReason: true
    }),
    false
  );
});

test("VS queue reference for seed 220638408 matches the Rust validation fixture", () => {
  const source = readFileSync(
    new URL("./tetrio-cdp-source.mjs", import.meta.url),
    "utf8"
  );
  const createPrngSource = source.match(
    /function createPrng\(seed\) \{[\s\S]*?\n\}/
  )?.[0];
  const generateQueueSource = source.match(
    /function generate7BagQueue\(seed, count\) \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(createPrngSource);
  assert.ok(generateQueueSource);

  const queue = Array.from(vm.runInNewContext(
    `${createPrngSource}\n${generateQueueSource}\ngenerate7BagQueue("220638408", 28)`,
    { Math, Number }
  ));

  assert.deepEqual(queue, [
    "i", "o", "z", "s", "t", "l", "j",
    "t", "z", "s", "i", "j", "o", "l",
    "i", "j", "s", "l", "t", "o", "z",
    "z", "l", "o", "i", "s", "t", "j"
  ]);
});

test("snapshot tokens and signatures include the game epoch", () => {
  const state = {
    pieceCounter: 0,
    current: "t",
    hold: "i",
    queue: ["o", "s"],
    activeX: 4,
    activeY: 19,
    activeRotation: "north"
  };

  assert.equal(buildSnapshotToken(1, 0), "browser-1-0");
  assert.equal(buildSnapshotToken(2, 0), "browser-2-0");
  assert.notEqual(buildSnapshotToken(1, 0), buildSnapshotToken(2, 0));
  assert.notEqual(buildSnapshotSignature(1, state), buildSnapshotSignature(2, state));
});

test("new game detection only advances epoch after waiting for the next game", () => {
  const activeState = {
    ok: true,
    ready: true,
    playing: true,
    countdown: false
  };
  assert.equal(shouldAdvanceGameEpoch(activeState, true), true);
  assert.equal(shouldAdvanceGameEpoch(activeState, false), false);
});

test("clearSnapshotFile removes stale snapshot output", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "tetrio-cdp-source-"));
  const snapshotPath = path.join(tempDir, "live-snapshot.json");
  writeFileSync(snapshotPath, "{}");
  assert.equal(existsSync(snapshotPath), true);

  clearSnapshotFile(snapshotPath);

  assert.equal(existsSync(snapshotPath), false);
});

test("tetrioStateExpression keeps existing field and piece extraction behavior", () => {
  const board = createBoard();
  board[39][0] = 1;
  const game = createGame({
    current: "l",
    hold: "j",
    queue: ["s", "z", "i"],
    pieceCounter: 3,
    board
  });

  const { result, window } = evaluateInWindow(tetrioStateExpression(), {
    __fusionTetrioGame: game
  });

  assert.equal(result.ok, true);
  assert.equal(result.current, "l");
  assert.equal(result.hold, "j");
  assert.deepEqual(result.queue, ["s", "z", "i"]);
  assert.equal(result.pieceCounter, 3);
  assert.equal(result.linesCleared, undefined);
  assert.equal(result.field[0][0], true);
  assert.equal(window.__fusionTetrioGame, game);
});

test("tetrioStateExpression extracts optional lines cleared stats", () => {
  const game = createGame({
    current: "i",
    linesCleared: 24
  });

  const { result } = evaluateInWindow(tetrioStateExpression(), {
    __fusionTetrioGame: game
  });

  assert.equal(result.ok, true);
  assert.equal(result.linesCleared, 24);
});

test("tetrioStateExpression Runtime.evaluate does not use awaitPromise", async () => {
  const cdp = createReadStateCdp([
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]);

  await readTetrioState(cdp, {
    probePageState: false,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState()
  });

  const tetrioEval = cdp.runtimeCalls.find((call) =>
    String(call.expression).includes("const pieceNames")
  );
  assert.ok(tetrioEval);
  assert.equal(Object.hasOwn(tetrioEval, "awaitPromise"), false);
});

test("safeRuntimeEvaluate returns fallback when Promise was collected", async () => {
  const fallback = { result: { value: { ok: false, ready: false } } };
  const cdp = {
    async send() {
      throw new Error("Promise was collected");
    }
  };

  const result = await safeRuntimeEvaluate(
    cdp,
    { expression: "42", returnByValue: true },
    fallback
  );

  assert.equal(result, fallback);
});

test("Promise was collected is classified as a transient runtime error", () => {
  assert.equal(isTransientRuntimeError(new Error("Promise was collected")), true);
});

test("Promise was collected once does not prevent the next poll from recovering", async () => {
  let stateReads = 0;
  const cdp = {
    async send(method, params = {}) {
      assert.equal(method, "Runtime.evaluate");
      if (String(params.expression).includes("document.readyState")) {
        return {
          result: {
            value: {
              readyState: "complete",
              href: "https://tetr.io/"
            }
          }
        };
      }
      stateReads += 1;
      if (stateReads === 1) {
        throw new Error("Promise was collected");
      }
      return {
        result: {
          value: {
            ok: true,
            ready: true,
            playing: true,
            countdown: false,
            pieceCounter: 0,
            current: "t",
            hold: null,
            queue: ["i", "o"]
          }
        }
      };
    }
  };
  const transientState = { lastRuntimeError: "" };
  const logs = [];

  const first = await readTetrioState(cdp, {
    probePageState: false,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    transientState,
    log: (line) => logs.push(line)
  });
  const second = await readTetrioState(cdp, {
    probePageState: false,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    transientState,
    log: (line) => logs.push(line)
  });

  assert.equal(first.ok, false);
  assert.equal(second.ok, true);
  assert.ok(
    logs.some((line) =>
      line.includes("[browser] transient Runtime.evaluate failure: Promise was collected; retrying")
    )
  );
});

test("VS sim OFF reads state then probes once after cooldown", async () => {
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]);
  let captureCalls = 0;

  const state = await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    network: { lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    closureCaptureState: armedClosureCaptureState(20_000),
    now: 20_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(
    isBootstrapReadyForClosureCapture(readyBootstrapState(20_000), 20_000),
    true
  );
  assert.equal(captureCalls, 1);
  assert.equal(state.ok, true);
});

test("Bot On arming opens the solo bootstrap capture window", async () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    now: 20_000,
    log: () => {}
  });
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]);
  let captureCalls = 0;

  const state = await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    network: { lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    closureCaptureState,
    now: 20_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    },
    log: () => {}
  });

  assert.equal(captureCalls, 1);
  assert.equal(state.ok, true);
});

test("VS sim ON but round inactive still probes after cooldown", async () => {
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 1,
      current: "o",
      hold: null,
      queue: ["s", "z"]
    }
  ]);
  let captureCalls = 0;

  const state = await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    network: { lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    closureCaptureState: armedClosureCaptureState(20_000),
    now: 20_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(
    isBootstrapReadyForClosureCapture(readyBootstrapState(20_000), 20_000),
    true
  );
  assert.equal(captureCalls, 1);
  assert.equal(state.ok, true);
});

test("capture success disarms Bot On arming so heavy capture does not repeat", async () => {
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();
  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: true },
    controlState,
    closureCaptureState,
    now: 20_000,
    log: () => {}
  });
  let captureCalls = 0;
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    network: { lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    closureCaptureState,
    now: 20_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    },
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(29_000),
    closureCaptureState,
    now: 29_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    },
    log: () => {}
  });

  assert.equal(captureCalls, 1);
});

test("VS sim ON with active round suppresses closure capture for ten seconds", async () => {
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]);
  let captureCalls = 0;

  const state = await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: true,
    suppressedReason: "VS WebSocket simulation owns live state",
    network: { lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    now: 20_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(state.reason, "VS WebSocket simulation owns live state");
});

test("suppression keeps cheap state reads active", async () => {
  let reads = 0;
  const cdp = {
    async send(method) {
      assert.equal(method, "Runtime.evaluate");
      reads += 1;
      return {
        result: {
          value: {
            ok: false,
            ready: false,
            reason: "TETR.IO game instance not captured yet"
          }
        }
      };
    }
  };

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: true,
    suppressedReason: "VS WebSocket simulation owns live state",
    network: { lastPageProbeAt: 0 },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(),
    now: 20_000,
    captureGameFn: async () => {
      throw new Error("should not capture");
    }
  });

  assert.equal(reads, 2);
});

test("document.readyState=loading keeps closure capture disabled", async () => {
  let captureCalls = 0;
  const cdp = {
    async send(method, params = {}) {
      assert.equal(method, "Runtime.evaluate");
      if (String(params.expression).includes("document.readyState")) {
        return {
          result: {
            value: {
              readyState: "loading",
              href: "https://tetr.io/"
            }
          }
        };
      }
      return {
        result: {
          value: {
            ok: false,
            ready: false,
            reason: "TETR.IO game instance not captured yet"
          }
        }
      };
    }
  };

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: createBootstrapState(0),
    now: 1_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(captureCalls, 0);
});

test("document complete before websocket keeps closure capture disabled", async () => {
  let captureCalls = 0;
  const bootstrapState = createBootstrapState(0);
  updateBootstrapDocumentState(
    bootstrapState,
    { readyState: "complete", href: "https://tetr.io/" },
    100
  );
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]);

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState,
    now: 1_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(captureCalls, 0);
});

test("repeated lobby evaluation never allows closure capture without gameplay expectation", async () => {
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]);

  for (const now of [70_000, 73_000, 76_000]) {
    await readTetrioState(cdp, {
      probePageState: true,
      suppressClosureCapture: false,
      useSeedSimulationFallback: false,
      network: { lastPageProbeAt: 0, seed: null },
      probeState: { lastCaptureAt: 0 },
      bootstrapState: readyBootstrapState(now),
      closureCaptureState,
      now,
      log: () => {},
      captureGameFn: async () => {
        captureCalls += 1;
        return { ok: true, source: "closure:Ai" };
      }
    });
  }

  assert.equal(captureCalls, 0);
});

test("websocket bootstrap waits until 1499ms before enabling capture", async () => {
  let captureCalls = 0;
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]);

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(19_999, { transportReadyAt: 18_501 }),
    now: 19_999,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(
    isBootstrapReadyForClosureCapture(
      readyBootstrapState(19_999, { transportReadyAt: 18_501 }),
      19_999
    ),
    false
  );
  assert.equal(captureCalls, 0);
});

test("websocket bootstrap enables capture after 1500ms", async () => {
  let captureCalls = 0;
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]);

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState: readyBootstrapState(20_000, { transportReadyAt: 18_500 }),
    closureCaptureState: armedClosureCaptureState(20_000),
    now: 20_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(captureCalls, 1);
});

test("bootstrap falls back to connectedAt after 15 seconds without websocket", async () => {
  let captureCalls = 0;
  const bootstrapState = createBootstrapState(0);
  updateBootstrapDocumentState(
    bootstrapState,
    { readyState: "complete", href: "https://tetr.io/" },
    100
  );
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 0,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]);

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0 },
    bootstrapState,
    closureCaptureState: armedClosureCaptureState(15_000),
    now: 15_000,
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(captureCalls, 1);
});

test("navigation resets bootstrap gating before capture can run again", async () => {
  const bootstrapState = readyBootstrapState();
  resetBootstrapState(bootstrapState, { resetConnectedAt: true, now: 30_000 });
  assert.equal(isBootstrapReadyForClosureCapture(bootstrapState, 31_000), false);
});

test("ended cached game is not selected again when a fresh game is available", () => {
  const endedGame = createGame({
    destroyed: true,
    playing: false,
    current: "t",
    pieceCounter: 8
  });
  const freshGame = createGame({
    current: "o",
    hold: "l",
    queue: ["i", "s"],
    pieceCounter: 0
  });

  const { result, window } = evaluateInWindow(tetrioStateExpression(), {
    __fusionTetrioGame: endedGame,
    __fusionEndedTetrioGame: endedGame,
    game: freshGame
  });

  assert.equal(result.ok, true);
  assert.equal(result.current, "o");
  assert.equal(window.__fusionTetrioGame, freshGame);
  assert.equal(window.__fusionEndedTetrioGame, endedGame);
});

test("same object reused for a new game becomes selectable again", () => {
  const reusedGame = createGame({
    destroyed: false,
    current: "s",
    hold: "z",
    queue: ["i", "o"],
    pieceCounter: 0
  });

  const { result, window } = evaluateInWindow(tetrioStateExpression(), {
    __fusionEndedTetrioGame: reusedGame
  });

  assert.equal(result.ok, true);
  assert.equal(result.current, "s");
  assert.equal(window.__fusionTetrioGame, reusedGame);
  assert.equal(Object.hasOwn(window, "__fusionEndedTetrioGame"), false);
});

test("closure exposure skips the ended cached object", () => {
  const endedGame = createGame({
    destroyed: true,
    playing: false
  });

  const { result, window } = evaluateInWindow(
    pausedFrameExposureExpression(),
    {
      __fusionEndedTetrioGame: endedGame
    },
    {
      Ai: endedGame
    }
  );

  assert.equal(result.ok, false);
  assert.equal(Object.hasOwn(window, "__fusionTetrioGame"), false);
});

test("closure exposure allows a reused object once it is no longer ended", () => {
  const reusedGame = createGame({
    destroyed: false,
    current: "i"
  });

  const { result, window } = evaluateInWindow(
    pausedFrameExposureExpression(),
    {
      __fusionEndedTetrioGame: reusedGame
    },
    {
      Ai: reusedGame
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.source, "closure:Ai");
  assert.equal(window.__fusionTetrioGame, reusedGame);
  assert.equal(Object.hasOwn(window, "__fusionEndedTetrioGame"), false);
});

test("captureTetrioGame source still keeps raf and setTimeout breakpoints", () => {
  const source = readFileSync(
    new URL("./tetrio-cdp-source.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /for \(const expression of \["window\.requestAnimationFrame", "window\.setTimeout"\]\)/
  );
});
