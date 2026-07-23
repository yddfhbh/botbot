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
  advanceGameStartSignalGeneration,
  buildSnapshotSignature,
  buildSnapshotToken,
  captureTetrioGame,
  cheapGameSignalExpression,
  clearSnapshotFile,
  completeNextGameReacquire,
  consumeGameStartSignal,
  createBrowserControlState,
  createBootstrapState,
  createClosureCaptureState,
  createEndedGameCandidateState,
  createGameStartSignalState,
  createSessionModeState,
  createInteractionTrackerInstallState,
  createNextGameReacquireState,
  createPostGameInteractionWatchState,
  createSnapshotTracking,
  carryPendingPostGameInteractionIntoReacquire,
  cancelPostGameInteractionWatch,
  deriveGameplayPhase,
  disarmClosureCaptureWindow,
  determineChromiumOwnership,
  ensureNextGameInteractionTrackerInstalled,
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
  nextGameInteractionTrackerExpression,
  pausedFrameExposureExpression,
  handleDddGameOptions,
  noteGameStartSignal,
  primeNextGameInteractionBaseline,
  primePostGameInteractionWatchBaseline,
  readTetrioState,
  readNextGameInteractionState,
  registerNextGameInteractionTrackerForFutureDocuments,
  requestClosureCaptureArm,
  reactivateClosureCaptureArmAfterBootstrap,
  resetGameStartSignalState,
  resetPostGameInteractionWatch,
  resetPausedScopeScanProgress,
  resetClosureCaptureLocatorHint,
  resetBootstrapState,
  resetTetrioNetworkState,
  releaseEndedGameCandidateHandle,
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
  setNextGameInteractionBaseline,
  startPostGameInteractionWatch,
  startNextGameReacquire,
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
    key: "0:ddd_game_options:ddd:seed-a",
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

test("next generation accepts the same game-start signal key again", () => {
  const signalState = createGameStartSignalState();
  noteGameStartSignal(signalState, {
    key: "ddd:seed-a",
    source: "ddd_game_options",
    now: 60_000
  });

  advanceGameStartSignalGeneration(signalState, { preserveSince: 70_000 });

  assert.equal(
    noteGameStartSignal(signalState, {
      key: "ddd:seed-a",
      source: "ddd_game_options",
      now: 71_000
    }),
    true
  );
  assert.deepEqual(consumeGameStartSignal(signalState), {
    key: "1:ddd_game_options:ddd:seed-a",
    source: "ddd_game_options",
    seenAt: 71_000,
    details: null
  });
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
      key: "0:ribbon_seed:ribbon:game-2",
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
  closureCaptureState.lastSuccessfulPausedLocation = {
    frameIndex: 1,
    scopeIndex: 4,
    candidateIndex: 77,
    locator: "Ai",
    propertyKey: "Ai"
  };

  assert.equal(resetClosureCaptureLocatorHint(closureCaptureState), true);
  assert.equal(closureCaptureState.lastSuccessfulLocator, "");
  assert.equal(closureCaptureState.lastSuccessfulPausedLocation, null);
});

test("next-game reacquire starts after game end and completes on next epoch", () => {
  const logs = [];
  const nextGameReacquireState = createNextGameReacquireState();

  assert.equal(
    startNextGameReacquire(nextGameReacquireState, {
      now: 10_000,
      epoch: 1,
      locator: "closure:Ai",
      log: (line) => logs.push(line)
    }),
    true
  );
  assert.equal(nextGameReacquireState.active, true);
  assert.equal(nextGameReacquireState.startedAt, 10_000);
  assert.equal(
    completeNextGameReacquire(nextGameReacquireState, {
      epoch: 2,
      log: (line) => logs.push(line)
    }),
    true
  );
  assert.equal(nextGameReacquireState.active, false);
  assert.ok(logs.includes("[browser] next-game reacquire started epoch=1 locator=closure:Ai"));
  assert.ok(logs.includes("[browser] next-game reacquire completed epoch=2"));
});

test("ended game candidate handle is not released until an explicit lifecycle event", async () => {
  const candidate = createEndedGameCandidateState();
  candidate.objectId = "ended-object-1";
  candidate.locator = "Ai";
  candidate.epoch = 1;
  const methods = [];

  assert.equal(candidate.objectId, "ended-object-1");

  await releaseEndedGameCandidateHandle({
    async send(method, params) {
      methods.push({ method, params });
      return {};
    }
  }, candidate, {
    reason: "bot_off",
    log: () => {}
  });

  assert.equal(candidate.objectId, "");
  assert.deepEqual(
    methods.map((entry) => entry.method),
    ["Runtime.releaseObject", "Runtime.releaseObjectGroup"]
  );
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
  assert.ok(
    logs.some((line) => line.startsWith("[browser] full closure scan attempt=1/2"))
  );
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

test("targeted paused-location hint hits before the broad full scan", async () => {
  const logs = [];
  const methods = [];
  const cdp = {
    async send(method, params = {}) {
      methods.push({ method, params });
      if (method === "Runtime.getProperties") {
        return {
          result: [
            {
              name: "Ai",
              value: { objectId: "candidate-77" }
            }
          ]
        };
      }
      if (method === "Runtime.callFunctionOn") {
        assert.equal(params.objectId, "candidate-77");
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
    callFrames: [null, {
      callFrameId: "frame-1",
      scopeChain: [null, null, null, null, { object: { objectId: "scope-4" } }]
    }]
  }, {
    closureCaptureState: {
      lastSuccessfulLocator: "",
      lastSuccessfulPausedLocation: {
        frameIndex: 1,
        scopeIndex: 4,
        candidateIndex: 0,
        locator: "Ai",
        propertyKey: "Ai"
      },
      fullScanAttemptsInWindow: 0
    },
    log: (line) => logs.push(line)
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    methods.map((entry) => entry.method),
    ["Runtime.getProperties", "Runtime.callFunctionOn"]
  );
  assert.ok(
    logs.includes("[browser] targeted paused locator hit frame=1 scope=4 candidate=0")
  );
  assert.equal(
    logs.some((line) => line.startsWith("[browser] full closure scan attempt=")),
    false
  );
});

test("targeted paused-location hint miss falls back to the broad full scan", async () => {
  const logs = [];
  let callFunctionOnCount = 0;
  const cdp = {
    async send(method) {
      if (method === "Runtime.getProperties") {
        return {
          result: [
            {
              name: "Ai",
              value: { objectId: callFunctionOnCount === 0 ? "candidate-ended" : "candidate-fresh" }
            }
          ]
        };
      }
      if (method === "Runtime.callFunctionOn") {
        callFunctionOnCount += 1;
        return {
          result: {
            value:
              callFunctionOnCount === 1
                ? { ok: false }
                : { ok: true, source: "closure:Ai", locator: "Ai" }
          }
        };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };

  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.lastSuccessfulPausedLocation = {
    frameIndex: 0,
    scopeIndex: 0,
    candidateIndex: 0,
    locator: "Ai",
    propertyKey: "Ai"
  };

  const result = await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [{
      callFrameId: "frame-0",
      scopeChain: [{ object: { objectId: "scope-0" } }]
    }]
  }, {
    closureCaptureState,
    log: (line) => logs.push(line)
  });

  assert.equal(result.ok, true);
  assert.equal(callFunctionOnCount, 2);
  assert.ok(
    logs.includes("[browser] targeted paused locator miss frame=0 scope=0 candidate=0")
  );
  assert.ok(logs.includes("[browser] full closure scan attempt=1/2"));
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
    assert.equal(first.outcome, "continuation_required");
    assert.equal(first.continuationReason, "paused_budget_reached");
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
  assert.ok(logs.includes("[browser] full closure scan attempt=2/2 resume_from=0:0:2"));
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
    assert.equal(first.outcome, "continuation_required");
    assert.equal(first.continuationReason, "paused_budget_reached");
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
  assert.ok(logs.includes("[browser] full closure scan attempt=2/2 resume_from=0:0:2"));
});

test("preflight retries do not prevent the first full scan attempt", async () => {
  const logs = [];
  let pausedEvents = 0;
  const closureCaptureState = createClosureCaptureState();
  armClosureCaptureWindow(closureCaptureState, {
    reason: "bot_on",
    now: 1_000,
    log: () => {}
  });
  closureCaptureState.lastSuccessfulLocator = "Ai";
  const cdp = {
    async send(method, params = {}) {
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
      if (pausedEvents < 3) {
        throw new Error("timeout");
      }
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
  assert.equal(first.outcome, "preflight_not_visible");
  assert.equal(second.ok, false);
  assert.equal(second.outcome, "preflight_not_visible");
  assert.equal(third.ok, false);
  assert.equal(third.outcome, "completed_not_found");
  assert.equal(closureCaptureState.captureAttemptsInWindow, 3);
  assert.equal(closureCaptureState.fullScanAttemptsInWindow, 1);
  assert.equal(
    logs.filter((line) => line === "[browser] fast closure locator failed; falling back to scan").length,
    1
  );
  assert.equal(
    logs.filter((line) => line.startsWith("[browser] full closure scan attempt=")).length,
    1
  );
  assert.equal(pausedEvents, 3);
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
        outcome: "continuation_required",
        continuationReason: "paused_budget_reached",
        resumeCursor: { frameIndex: 0, scopeIndex: 0, candidateIndex: 2 }
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

test("cheap game signal treats visible result over canvas as inactive result", () => {
  const nodes = {
    result: {
      isConnected: true,
      parentElement: null,
      getBoundingClientRect: () => ({ width: 100, height: 40 })
    },
    canvas: {
      isConnected: true,
      parentElement: null,
      getBoundingClientRect: () => ({ width: 640, height: 360 })
    }
  };
  const { result } = evaluateInWindow(cheapGameSignalExpression(), {
    getComputedStyle() {
      return { display: "block", visibility: "visible", opacity: "1" };
    }
  }, {
    document: {
      body: { innerText: "40 LINES finished retry continue" },
      querySelectorAll(selector) {
        if (selector.includes("result")) return [nodes.result];
        if (selector === "canvas") return [nodes.canvas];
        return [];
      }
    },
    location: { pathname: "/solo/results", hash: "" }
  });

  assert.equal(result.label, "result");
  assert.equal(result.active, false);
});

test("cheap game signal does not treat 40 LINES body text alone as a result screen", () => {
  const { result } = evaluateInWindow(cheapGameSignalExpression(), {
    getComputedStyle() {
      return { display: "block", visibility: "visible", opacity: "1" };
    }
  }, {
    document: {
      body: { innerText: "40 LINES" },
      querySelectorAll() {
        return [];
      }
    },
    location: { pathname: "/solo/play", hash: "" }
  });

  assert.equal(result.label, "inactive");
  assert.equal(result.active, false);
});

test("cheap game signal ignores hidden stale result elements", () => {
  const hiddenResult = {
    isConnected: true,
    parentElement: null,
    getBoundingClientRect: () => ({ width: 100, height: 40 })
  };
  const gameplay = {
    isConnected: true,
    parentElement: null,
    getBoundingClientRect: () => ({ width: 300, height: 600 })
  };
  const { result } = evaluateInWindow(cheapGameSignalExpression(), {
    getComputedStyle(node) {
      if (node === hiddenResult) {
        return { display: "none", visibility: "visible", opacity: "1" };
      }
      return { display: "block", visibility: "visible", opacity: "1" };
    }
  }, {
    document: {
      body: { innerText: "" },
      querySelectorAll(selector) {
        if (selector.includes("result")) return [hiddenResult];
        if (selector.includes("board") || selector.includes("playfield") || selector.includes("hud")) {
          return [gameplay];
        }
        return [];
      }
    },
    location: { pathname: "/solo/play", hash: "" }
  });

  assert.equal(result.label, "playing");
  assert.equal(result.active, true);
});

test("cheap game signal treats visible countdown as active", () => {
  const countdown = {
    isConnected: true,
    parentElement: null,
    getBoundingClientRect: () => ({ width: 120, height: 60 })
  };
  const { result } = evaluateInWindow(cheapGameSignalExpression(), {
    getComputedStyle() {
      return { display: "block", visibility: "visible", opacity: "1" };
    }
  }, {
    document: {
      body: { innerText: "ready" },
      querySelectorAll(selector) {
        if (selector.includes("countdown") || selector.includes("ready")) return [countdown];
        return [];
      }
    },
    location: { pathname: "/solo/play", hash: "" }
  });

  assert.equal(result.label, "countdown");
  assert.equal(result.active, true);
});

test("next-game interaction tracker dedupes pointerup and click into one generation", () => {
  const listeners = new Map();
  let now = 1_000;
  const document = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    }
  };
  const { result, window } = evaluateInWindow(
    nextGameInteractionTrackerExpression(),
    {},
    {
      document,
      Date: { now: () => now }
    }
  );

  assert.equal(result.ok, true);
  listeners.get("pointerup")?.({
    type: "pointerup",
    target: { tagName: "BUTTON", id: "retry", className: "cta" }
  });
  now += 50;
  listeners.get("click")?.({
    type: "click",
    target: { tagName: "BUTTON", id: "retry", className: "cta" }
  });

  assert.equal(window.__fusionNextGameInteraction.generation, 1);
  assert.equal(window.__fusionNextGameInteraction.type, "pointerup");
});

test("next-game interaction tracker dedupes pointerdown pointerup and click into one generation", () => {
  const listeners = new Map();
  let now = 1_500;
  const document = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    }
  };
  const { window } = evaluateInWindow(
    nextGameInteractionTrackerExpression(),
    {},
    {
      document,
      Date: { now: () => now }
    }
  );

  listeners.get("pointerdown")?.({
    type: "pointerdown",
    target: { tagName: "BUTTON", id: "retry", className: "cta" }
  });
  now += 60;
  listeners.get("pointerup")?.({
    type: "pointerup",
    target: { tagName: "BUTTON", id: "retry", className: "cta" }
  });
  now += 60;
  listeners.get("click")?.({
    type: "click",
    target: { tagName: "BUTTON", id: "retry", className: "cta" }
  });

  assert.equal(window.__fusionNextGameInteraction.generation, 1);
  assert.equal(window.__fusionNextGameInteraction.type, "pointerdown");
});

test("next-game interaction tracker accepts Enter and ignores unrelated keys", () => {
  const listeners = new Map();
  let now = 2_000;
  const document = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    }
  };
  const { window } = evaluateInWindow(
    nextGameInteractionTrackerExpression(),
    {},
    {
      document,
      Date: { now: () => now }
    }
  );

  listeners.get("keydown")?.({
    type: "keydown",
    key: "ArrowLeft",
    target: { tagName: "BODY", id: "", className: "" }
  });
  assert.equal(window.__fusionNextGameInteraction.generation, 0);
  listeners.get("keydown")?.({
    type: "keydown",
    key: "Enter",
    target: { tagName: "BODY", id: "", className: "" }
  });
  assert.equal(window.__fusionNextGameInteraction.generation, 1);
});

test("next-game interaction tracker ignores repeated keydown events", () => {
  const listeners = new Map();
  let now = 2_500;
  const document = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    }
  };
  const { window } = evaluateInWindow(
    nextGameInteractionTrackerExpression(),
    {},
    {
      document,
      Date: { now: () => now }
    }
  );

  listeners.get("keydown")?.({
    type: "keydown",
    key: "Enter",
    repeat: true,
    target: { tagName: "BODY", id: "", className: "" }
  });
  assert.equal(window.__fusionNextGameInteraction.generation, 0);
  now += 10;
  listeners.get("keydown")?.({
    type: "keydown",
    key: "r",
    repeat: false,
    target: { tagName: "BODY", id: "", className: "" }
  });
  assert.equal(window.__fusionNextGameInteraction.generation, 1);
});

test("reacquire baseline is seeded from the current page interaction generation", async () => {
  const nextGameReacquireState = createNextGameReacquireState();
  startNextGameReacquire(nextGameReacquireState, {
    now: 3_000,
    epoch: 1,
    log: () => {}
  });

  const baseline = await primeNextGameInteractionBaseline(null, nextGameReacquireState, {
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 5,
      timestamp: 3_010
    })
  });

  assert.equal(baseline, 5);
  assert.equal(nextGameReacquireState.interactionBaselineGeneration, 5);
  assert.equal(nextGameReacquireState.lastInteractionGenerationSeen, 5);
  assert.equal(nextGameReacquireState.lastInteractionGenerationHandled, 5);
});

test("post-game interaction watch starts on first not-playing transition baseline", async () => {
  const watch = createPostGameInteractionWatchState();

  const baseline = await primePostGameInteractionWatchBaseline(null, watch, {
    now: 3_500,
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 64,
      timestamp: 3_505
    })
  });

  assert.equal(baseline, 64);
  assert.equal(watch.active, true);
  assert.equal(watch.firstNotPlayingAt, 3_500);
  assert.equal(watch.interactionBaselineGeneration, 64);
  assert.equal(watch.lastInteractionGenerationSeen, 64);
});

test("baseline-matching generation is ignored during reacquire", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  startNextGameReacquire(nextGameReacquireState, {
    now: 26_000,
    epoch: 1,
    interactionBaselineGeneration: 88,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(26_200),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 26_200,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 88,
      timestamp: 26_150,
      type: "keydown",
      targetTag: "BODY",
      targetId: "",
      targetClass: ""
    })
  });

  assert.equal(closureCaptureState.armedReason, "");
  assert.equal(
    logs.some((line) => line.includes("generation=88 type=keydown")),
    false
  );
});

test("baseline capture absorbs the race before the initial interaction read", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 4_000,
    epoch: 1,
    log: () => {}
  });
  await primeNextGameInteractionBaseline(null, nextGameReacquireState, {
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 6,
      timestamp: 4_010,
      type: "click",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    })
  });
  let captureCalls = 0;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(4_100),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 4_100,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 6,
      timestamp: 4_010,
      type: "click",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(closureCaptureState.armedReason, "");
  assert.equal(
    logs.some((line) => line.includes("closure capture armed reason=next_game_user_interaction")),
    false
  );
});

test("end confirmation watch captures AGAIN pointerdown before reacquire starts", async () => {
  const logs = [];
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const postGameInteractionWatchState = createPostGameInteractionWatchState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startPostGameInteractionWatch(postGameInteractionWatchState, {
    now: 24_500,
    baselineGeneration: 64,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(24_800),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState,
    endedGameCandidate,
    waitingForNextGame: false,
    now: 24_800,
    log: (line) => logs.push(line),
    readNextGameInteractionStateFn: async () => ({
      generation: 65,
      timestamp: 24_700,
      type: "pointerdown",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(postGameInteractionWatchState.pendingGeneration, 65);
  assert.equal(postGameInteractionWatchState.pendingType, "pointerdown");
  assert.equal(captureCalls, 0);
  assert.ok(
    logs.includes("[browser] post-game interaction captured before end confirmation generation=65 type=pointerdown")
  );
});

test("normal gameplay interactions before first not-playing are not stored as pending", async () => {
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const postGameInteractionWatchState = createPostGameInteractionWatchState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;

  await readTetrioState(createReadStateCdp([
    {
      ok: true,
      ready: true,
      playing: true,
      countdown: false,
      pieceCounter: 10,
      current: "t",
      hold: null,
      queue: ["i", "o"]
    }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "playing" },
    bootstrapState: readyBootstrapState(4_900),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 4_900,
    readNextGameInteractionStateFn: async () => ({
      generation: 11,
      timestamp: 4_850,
      type: "keydown",
      targetTag: "BODY",
      targetId: "",
      targetClass: ""
    })
  });

  assert.equal(postGameInteractionWatchState.pendingGeneration, 0);
});

test("pending post-game interaction carries into reacquire without being erased by a later baseline", () => {
  const logs = [];
  const watch = createPostGameInteractionWatchState();
  const nextGameReacquireState = createNextGameReacquireState();
  startPostGameInteractionWatch(watch, {
    now: 5_000,
    baselineGeneration: 64,
    log: () => {}
  });
  watch.pendingGeneration = 65;
  watch.pendingTimestamp = 5_100;
  watch.pendingType = "pointerdown";
  watch.pendingTargetTag = "BUTTON";
  watch.pendingTargetId = "retry";
  watch.pendingTargetClass = "cta";
  startNextGameReacquire(nextGameReacquireState, {
    now: 5_200,
    epoch: 1,
    interactionBaselineGeneration: watch.interactionBaselineGeneration,
    log: () => {}
  });

  const carried = carryPendingPostGameInteractionIntoReacquire(
    watch,
    nextGameReacquireState,
    {
      log: (line) => logs.push(line)
    }
  );

  assert.equal(carried, true);
  assert.equal(nextGameReacquireState.interactionBaselineGeneration, 64);
  assert.equal(nextGameReacquireState.lastInteractionGenerationSeen, 65);
  assert.equal(nextGameReacquireState.lastInteractionGenerationHandled, 64);
  assert.equal(nextGameReacquireState.pendingInteractionGeneration, 65);
  assert.ok(
    logs.includes("[browser] pending post-game interaction carried into reacquire generation=65")
  );
});

test("carried pending interaction arms exactly once after game end confirmation", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  closureCaptureState.captureAttemptsInWindow = 2;
  closureCaptureState.fullScanAttemptsInWindow = 2;
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 562;
  closureCaptureState.pausedScopeScanCursor = {
    frameIndex: 4,
    scopeIndex: 2,
    propertyIndex: 7,
    completedScopeKeys: ["1:0:scope-1"],
    seenCandidateKeys: ["1:0:scope-1:Ai:candidate-1"]
  };
  closureCaptureState.lastSuccessfulLocator = "Ai";
  closureCaptureState.armedUntil = 27_500;
  closureCaptureState.armedReason = "next_game_user_interaction";
  closureCaptureState.nextAttemptAt = 27_150;
  const nextGameReacquireState = createNextGameReacquireState();
  startNextGameReacquire(nextGameReacquireState, {
    now: 27_000,
    epoch: 1,
    interactionBaselineGeneration: 88,
    log: () => {}
  });
  nextGameReacquireState.pendingInteractionGeneration = 90;
  nextGameReacquireState.pendingInteractionTimestamp = 27_050;
  nextGameReacquireState.pendingInteractionSource = "post_game";

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(27_100),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 27_100,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 90,
      timestamp: 27_050,
      type: "pointerdown",
      targetTag: "DIV",
      targetId: "start_results",
      targetClass: ""
    })
  });

  assert.equal(nextGameReacquireState.lastInteractionGenerationHandled, 90);
  assert.equal(nextGameReacquireState.pendingInteractionGeneration, 0);
  assert.equal(nextGameReacquireState.interactionPhase, "capture_armed");
  assert.equal(closureCaptureState.captureAttemptsInWindow, 0);
  assert.equal(closureCaptureState.fullScanAttemptsInWindow, 0);
  assert.equal(closureCaptureState.cumulativePausedScanBudgetUsedMs, 0);
  assert.equal(closureCaptureState.scanBudgetExhausted, false);
  assert.equal(closureCaptureState.lastSuccessfulLocator, "Ai");
  assert.equal(closureCaptureState.nextAttemptAt, 27_400);
  assert.equal(
    logs.filter((line) => line === "[browser] carried interaction armed generation=90").length,
    1
  );
  assert.ok(
    logs.includes(
      "[browser] resetting closure window for carried interaction previous_capture_attempts=2 previous_full_scan_attempts=2 previous_paused_used_ms=562"
    )
  );
  assert.ok(
    logs.includes("[browser] closure capture armed reason=next_game_carried_interaction generation=90")
  );
  assert.ok(
    logs.includes(
      "[browser] closure window initialized reason=next_game_carried_interaction capture_attempts=0 full_scan_attempts=0 paused_used_ms=0 cursor=0:0:0 exhausted=false remaining_paused_ms=700"
    )
  );
});

test("carried interaction exhaustion consumes the generation and blocks repeated capture attempts", async () => {
  const logs = [];
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  startNextGameReacquire(nextGameReacquireState, {
    now: 41_000,
    epoch: 2,
    interactionBaselineGeneration: 160,
    log: () => {}
  });
  closureCaptureState.armedUntil = 49_000;
  closureCaptureState.armedReason = "next_game_carried_interaction";
  closureCaptureState.nextAttemptAt = 41_000;
  nextGameReacquireState.interactionPhase = "capture_armed";
  nextGameReacquireState.interactionWindowGeneration = 163;
  nextGameReacquireState.pendingInteractionGeneration = 163;
  nextGameReacquireState.pendingInteractionTimestamp = 41_050;
  nextGameReacquireState.pendingInteractionSource = "post_game";

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(41_000),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 41_000,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return {
        ok: false,
        reason: "TETR.IO full closure scan cumulative budget exhausted",
        outcome: "continuation_required",
        continuationReason: "paused_budget_reached",
        windowBudgetExhausted: true
      };
    }
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 41_000, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(41_500),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 41_500,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run again" };
    }
  });

  assert.equal(captureCalls, 1);
  assert.equal(nextGameReacquireState.lastInteractionGenerationHandled, 163);
  assert.equal(nextGameReacquireState.pendingInteractionGeneration, 0);
  assert.equal(nextGameReacquireState.interactionWindowGeneration, 0);
  assert.equal(nextGameReacquireState.interactionPhase, "reacquiring");
  assert.equal(isClosureCaptureArmed(closureCaptureState, 41_500), false);
  assert.ok(logs.includes("[browser] carried interaction capture exhausted generation=163"));
  assert.ok(logs.includes("[browser] closure capture disarmed reason=scan_budget_exhausted"));
  assert.ok(logs.includes("[browser] waiting for fresh next-game interaction after capture exhaustion"));
});

test("not-playing R key is stored as pending post-game interaction", async () => {
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 25_500,
    baselineGeneration: 64,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(25_700),
    browserControlState: { botEnabled: true },
    closureCaptureState: createClosureCaptureState(),
    nextGameReacquireState: createNextGameReacquireState(),
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 25_700,
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 65,
      timestamp: 25_650,
      type: "keydown",
      targetTag: "BODY",
      targetId: "",
      targetClass: ""
    })
  });

  assert.equal(watch.pendingGeneration, 65);
  assert.equal(watch.pendingType, "keydown");
});

test("trusted result-screen pointerdown provisionally arms next-game capture before end confirmation", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 30_000,
    baselineGeneration: 76,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(30_100),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 30_100,
    log: (line) => logs.push(line),
    readNextGameInteractionStateFn: async () => ({
      generation: 77,
      key: null,
      timestamp: 30_080,
      type: "pointerdown",
      targetTag: "DIV",
      targetId: "start_results",
      targetClass: ""
    })
  });

  assert.equal(
    closureCaptureState.armedReason.startsWith("next_game_provisional_interaction"),
    true
  );
  assert.equal(closureCaptureState.nextAttemptAt, 30_550);
  assert.equal(nextGameReacquireState.provisionalInteractionGeneration, 77);
  assert.ok(logs.includes("[browser] trusted next-game interaction provisional arm generation=77"));
});

test("provisional arm passes requireActiveGame to exclude the ended object", async () => {
  let captureOptions = null;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 31_000,
    epoch: 1,
    interactionBaselineGeneration: 80,
    log: () => {}
  });
  armClosureCaptureWindow(closureCaptureState, {
    reason: "next_game_provisional_interaction",
    now: 31_000,
    log: () => {}
  });
  closureCaptureState.nextAttemptAt = 31_950;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(31_950),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 31_950,
    log: () => {},
    captureGameFn: async (_cdp, options) => {
      captureOptions = options;
      return { ok: false, reason: "not ready yet" };
    }
  });

  assert.equal(captureOptions?.requireActiveGame, true);
});

test("AGAIN provisional first attempt uses only the non-heavy capture path", async () => {
  let captureOptions = null;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 31_000,
    baselineGeneration: 80,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(31_100),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 31_100,
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 81,
      key: null,
      timestamp: 31_010,
      type: "pointerdown",
      targetTag: "DIV",
      targetId: "start_results",
      targetClass: ""
    })
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(31_550),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 31_550,
    log: () => {},
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: [
        { source: "result_dom", value: true, state: "result" },
        { source: "countdown_dom", value: false, state: "inactive" },
        { source: "gameplay_dom", value: false, state: "inactive" },
        { source: "route_game", value: false, state: "inactive" }
      ]
    }),
    captureGameFn: async (_cdp, options) => {
      captureOptions = options;
      return { ok: false, reason: "still hidden", outcome: "targeted_only_miss" };
    }
  });

  assert.equal(captureOptions?.allowBroadScan, false);
  assert.equal(captureOptions?.pauseTimeoutMs, 100);
});

test("AGAIN provisional targeted miss suppresses broad scan until transition readiness", async () => {
  const logs = [];
  let captureCalls = 0;
  const broadFlags = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 32_000,
    baselineGeneration: 90,
    log: () => {}
  });

  const captureGameFn = async (_cdp, options) => {
    captureCalls += 1;
    broadFlags.push(options.allowBroadScan);
    return captureCalls === 1
      ? { ok: false, reason: "still hidden", outcome: "targeted_only_miss" }
      : { ok: false, reason: "still hidden", outcome: "completed_not_found" };
  };

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(32_100),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 32_100,
    log: (line) => logs.push(line),
    readNextGameInteractionStateFn: async () => ({
      generation: 91,
      key: null,
      timestamp: 32_010,
      type: "pointerdown",
      targetTag: "DIV",
      targetId: "start_results",
      targetClass: ""
    })
  });
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(32_550),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 32_550,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: [
        { source: "result_dom", value: true, state: "result" },
        { source: "countdown_dom", value: false, state: "inactive" },
        { source: "gameplay_dom", value: false, state: "inactive" },
        { source: "route_game", value: false, state: "inactive" }
      ]
    }),
    captureGameFn
  });
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(32_700),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 32_700,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: true,
      source: "countdown_dom",
      label: "countdown",
      sources: [
        { source: "result_dom", value: false, state: "inactive" },
        { source: "countdown_dom", value: true, state: "countdown" },
        { source: "gameplay_dom", value: false, state: "inactive" },
        { source: "route_game", value: true, state: "playing" }
      ]
    }),
    captureGameFn
  });

  assert.deepEqual(broadFlags, [false]);
  assert.ok(logs.includes("[browser] broad scan suppressed while AGAIN transition is not ready"));
});

test("interaction detection logs distinguish restart key and again button", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  startNextGameReacquire(nextGameReacquireState, {
    now: 33_000,
    epoch: 1,
    interactionBaselineGeneration: 10,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(33_100),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 33_100,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 11,
      key: "R",
      timestamp: 33_050,
      type: "keydown",
      targetTag: "BODY",
      targetId: "",
      targetClass: ""
    }),
    captureGameFn: async () => ({ ok: false, reason: "still hidden" })
  });

  assert.ok(
    logs.some((line) => line.includes("type=keydown key=R interaction_kind=restart_key target=BODY"))
  );
});

test("BODY keydown does not provisionally arm next-game capture", async () => {
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 32_000,
    baselineGeneration: 90,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(32_200),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 32_200,
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 91,
      key: " ",
      timestamp: 32_150,
      type: "keydown",
      targetTag: "BODY",
      targetId: "",
      targetClass: ""
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(closureCaptureState.armedReason, "");
  assert.equal(watch.pendingGeneration, 91);
});

test("canvas pointerdown does not provisionally arm next-game capture", async () => {
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 33_000,
    baselineGeneration: 100,
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(33_200),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: watch,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 33_200,
    log: () => {},
    readNextGameInteractionStateFn: async () => ({
      generation: 101,
      key: null,
      timestamp: 33_150,
      type: "pointerdown",
      targetTag: "CANVAS",
      targetId: "pixi",
      targetClass: ""
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(closureCaptureState.armedReason, "");
  assert.equal(watch.pendingGeneration, 101);
});

test("the same trusted generation opens only one provisional window", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 34_000,
    baselineGeneration: 110,
    log: () => {}
  });

  for (const now of [34_100, 34_200]) {
    await readTetrioState(createReadStateCdp([
      { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
    ]), {
      probePageState: true,
      suppressClosureCapture: false,
      useSeedSimulationFallback: false,
      network: { lastPageProbeAt: 0, seed: null },
      probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
      bootstrapState: readyBootstrapState(now),
      browserControlState: { botEnabled: true },
      closureCaptureState,
      nextGameReacquireState,
      postGameInteractionWatchState: watch,
      endedGameCandidate: createEndedGameCandidateState(),
      waitingForNextGame: false,
      now,
      log: (line) => logs.push(line),
      readNextGameInteractionStateFn: async () => ({
        generation: 111,
        key: null,
        timestamp: 34_050,
        type: "pointerdown",
        targetTag: "DIV",
        targetId: "start_results",
        targetClass: ""
      }),
      captureGameFn: async () => ({ ok: false, reason: "should not run" })
    });
  }

  assert.equal(
    logs.filter((line) => line === "[browser] trusted next-game interaction provisional arm generation=111").length,
    1
  );
});

test("game returning to playing cancels post-game watch and clears pending interaction", () => {
  const logs = [];
  const watch = createPostGameInteractionWatchState();
  startPostGameInteractionWatch(watch, {
    now: 6_000,
    baselineGeneration: 64,
    log: () => {}
  });
  watch.pendingGeneration = 65;
  watch.pendingTimestamp = 6_050;

  const cancelled = cancelPostGameInteractionWatch(watch, {
    reason: "playing_resumed",
    log: (line) => logs.push(line)
  });

  assert.equal(cancelled, true);
  assert.equal(watch.active, false);
  assert.equal(watch.pendingGeneration, 0);
  assert.ok(logs.includes("[browser] post-game interaction watch cancelled reason=playing_resumed"));
});

test("capture success enters captured_waiting_start and ignores later interactions", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  startNextGameReacquire(nextGameReacquireState, {
    now: 28_000,
    epoch: 1,
    interactionBaselineGeneration: 88,
    log: () => {}
  });
  nextGameReacquireState.pendingInteractionGeneration = 90;
  nextGameReacquireState.pendingInteractionTimestamp = 28_050;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(28_100),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 28_100,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 0,
      timestamp: 0,
      type: null,
      targetTag: null,
      targetId: null,
      targetClass: null
    }),
    captureGameFn: async () => ({
      ok: true,
      source: "closure:Ai",
      locator: "Ai"
    })
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    { ok: false, ready: false, reason: "TETR.IO game is not started" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(28_450),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 28_450,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 0,
      timestamp: 0,
      type: null,
      targetTag: null,
      targetId: null,
      targetClass: null
    }),
    captureGameFn: async () => ({
      ok: true,
      source: "closure:Ai",
      locator: "Ai"
    })
  });

  assert.equal(nextGameReacquireState.interactionPhase, "captured_waiting_start");
  assert.equal(closureCaptureState.armedReason, "");
  const armLogCountBeforeFollowup = logs.filter((line) =>
    line.includes("closure capture armed reason=next_game_user_interaction")
  ).length;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game is not started" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(28_250),
    browserControlState: { botEnabled: true },
    closureCaptureState,
    nextGameReacquireState,
    postGameInteractionWatchState: createPostGameInteractionWatchState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 28_250,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 92,
      timestamp: 28_200,
      type: "click",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    })
  });

  assert.equal(closureCaptureState.armedReason, "");
  assert.equal(
    logs.filter((line) => line.includes("closure capture armed reason=next_game_user_interaction")).length,
    armLogCountBeforeFollowup
  );
});

test("interaction newer than the baseline still requires a timestamp after reacquire start", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 5_000,
    epoch: 1,
    interactionBaselineGeneration: 5,
    log: () => {}
  });
  let captureCalls = 0;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(5_100),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 5_100,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 6,
      timestamp: 5_000,
      type: "click",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(closureCaptureState.armedReason, "");
  assert.equal(
    logs.some((line) => line.includes("closure capture armed reason=next_game_user_interaction")),
    false
  );
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

test("same ended object reactivating to playing is treated as the next game", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  endedGameCandidate.objectId = "ended-object-1";
  endedGameCandidate.epoch = 1;
  endedGameCandidate.lastPieceCounter = 26;
  endedGameCandidate.lastSignature = "26|t|-|i,o";
  startNextGameReacquire(nextGameReacquireState, {
    now: 40_000,
    epoch: 1,
    locator: "closure:Ai",
    log: (line) => logs.push(line)
  });
  let heavyCaptureCalls = 0;

  const state = await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(40_000),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 40_000,
    log: (line) => logs.push(line),
    readEndedGameCandidateStateFn: async () => ({
      status: "valid_playing",
      reactivated: true,
      state: {
        ok: true,
        ready: true,
        playing: true,
        countdown: false,
        field: createBoard(),
        current: "t",
        hold: null,
        queue: ["i", "o"],
        b2b: false,
        combo: 0,
        incoming: 0,
        pieceCounter: 0
      }
    }),
    captureGameFn: async () => {
      heavyCaptureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(state.ok, true);
  assert.equal(state.playing, true);
  assert.equal(heavyCaptureCalls, 0);
  assert.ok(logs.includes("[browser] ended game object probe scheduled object_id_present=true"));
  assert.ok(logs.includes("[browser] ended game object probe status=valid_playing"));
  assert.ok(logs.includes("[browser] ended game object reactivated epoch=1->2"));
});

test("same ended object remaining ended does not start a heavy scan", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  endedGameCandidate.objectId = "ended-object-1";
  endedGameCandidate.epoch = 1;
  endedGameCandidate.lastPieceCounter = 26;
  startNextGameReacquire(nextGameReacquireState, {
    now: 50_000,
    epoch: 1,
    locator: "closure:Ai",
    log: () => {}
  });
  let heavyCaptureCalls = 0;

  const state = await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(50_000),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 50_000,
    log: (line) => logs.push(line),
    readEndedGameCandidateStateFn: async () => ({ status: "valid_ended" }),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: [{ source: "result_dom", value: true, state: "result" }]
    }),
    captureGameFn: async () => {
      heavyCaptureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(state.ok, false);
  assert.equal(heavyCaptureCalls, 0);
  assert.ok(logs.includes("[browser] ended game object probe status=valid_ended"));
  assert.equal(
    logs.some((line) => line.startsWith("[browser] full closure scan attempt=")),
    false
  );
});

test("ended object probe interval skip logs its guard reason", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  endedGameCandidate.objectId = "ended-object-1";
  nextGameReacquireState.active = true;
  nextGameReacquireState.lastEndedObjectCheckAt = 80_000;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(80_100),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    verboseReacquireLogs: true,
    now: 80_100,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "inactive",
      sources: []
    }),
    captureGameFn: async () => ({ ok: false, reason: "should not run" })
  });

  assert.ok(logs.includes("[browser] ended game object probe skipped reason=interval_wait"));
});

test("object released falls back to cheap signal false->true and arms once", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  endedGameCandidate.objectId = "ended-object-1";
  startNextGameReacquire(nextGameReacquireState, {
    now: 60_000,
    epoch: 1,
    locator: "",
    log: () => {}
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 60_000, seed: null },
    probeState: { lastCaptureAt: 60_000, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(60_000),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 60_000,
    log: (line) => logs.push(line),
    readEndedGameCandidateStateFn: async () => ({ status: "object_released" }),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: [{ source: "result_dom", value: true, state: "result" }]
    }),
    captureGameFn: async () => ({ ok: false, reason: "hidden" })
  });

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 60_000, seed: null },
    probeState: { lastCaptureAt: 60_000, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(60_400),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 60_400,
    log: (line) => logs.push(line),
    readEndedGameCandidateStateFn: async () => ({ status: "object_released" }),
    readCheapGameSignalFn: async () => ({
      active: true,
      source: "countdown_dom",
      label: "countdown",
      sources: [{ source: "countdown_dom", value: true, state: "countdown" }]
    }),
    captureGameFn: async () => ({ ok: false, reason: "hidden" })
  });

  assert.equal(
    logs.filter((line) => line === "[browser] cheap game signal transition inactive->playing source=countdown_dom").length,
    1
  );
  assert.equal(
    logs.filter((line) => line === "[browser] closure capture armed reason=next_game_cheap_signal").length,
    1
  );
  assert.equal(endedGameCandidate.objectId, "");
});

test("reacquire active arms one interaction-based capture window and delays the first full scan", async () => {
  const logs = [];
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  nextGameReacquireState.active = true;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(90_000),
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 90_000,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: [{ source: "result_dom", value: true, state: "result" }]
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 1,
      type: "click",
      timestamp: 90_000,
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run yet" };
    }
  });

  assert.equal(captureCalls, 0);
  assert.equal(closureCaptureState.armedReason, "next_game_user_interaction");
  assert.equal(closureCaptureState.nextAttemptAt, 90_300);
  assert.ok(
    logs.includes("[browser] closure capture armed reason=next_game_user_interaction generation=1")
  );
});

test("pending retry interaction is preserved while an older interaction window is already armed", async () => {
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 93_000,
    epoch: 1,
    interactionBaselineGeneration: 5,
    log: () => {}
  });
  armClosureCaptureWindow(closureCaptureState, {
    reason: "next_game_user_interaction",
    now: 93_050,
    log: () => {}
  });
  closureCaptureState.nextAttemptAt = 93_350;
  nextGameReacquireState.lastInteractionGenerationHandled = 5;
  const bootstrapState = readyBootstrapState(93_100);
  bootstrapState.lastReady = true;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 93_100,
    log: () => {},
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 6,
      timestamp: 93_090,
      type: "click",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => ({ ok: false, reason: "should not run" })
  });

  assert.equal(nextGameReacquireState.lastInteractionGenerationHandled, 5);
  assert.equal(nextGameReacquireState.pendingInteractionGeneration, 6);
  assert.equal(closureCaptureState.nextAttemptAt, 93_350);
});

test("pending retry interaction can reopen a one-shot window after the old window expires", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 94_000,
    epoch: 1,
    interactionBaselineGeneration: 5,
    log: () => {}
  });
  nextGameReacquireState.pendingInteractionGeneration = 6;
  nextGameReacquireState.pendingInteractionTimestamp = 94_100;
  nextGameReacquireState.pendingInteractionType = "click";
  nextGameReacquireState.pendingInteractionTargetTag = "BUTTON";
  nextGameReacquireState.pendingInteractionTargetId = "retry";
  nextGameReacquireState.pendingInteractionTargetClass = "cta";
  const bootstrapState = readyBootstrapState(94_500);
  bootstrapState.lastReady = true;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 94_500,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 6,
      timestamp: 94_100,
      type: "click",
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => ({ ok: false, reason: "should not run" })
  });

  assert.equal(nextGameReacquireState.lastInteractionGenerationHandled, 6);
  assert.equal(nextGameReacquireState.pendingInteractionGeneration, 0);
  assert.equal(closureCaptureState.armedReason, "next_game_user_interaction");
  assert.equal(closureCaptureState.nextAttemptAt, 94_800);
  assert.ok(
    logs.includes("[browser] closure capture armed reason=next_game_user_interaction generation=6")
  );
});

test("same interaction generation does not rearm or reset the interaction window", async () => {
  const logs = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const endedGameCandidate = createEndedGameCandidateState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  nextGameReacquireState.active = true;
  nextGameReacquireState.lastInteractionGenerationHandled = 1;
  nextGameReacquireState.lastInteractionGenerationSeen = 1;
  nextGameReacquireState.interactionWindowGeneration = 1;
  armClosureCaptureWindow(closureCaptureState, {
    reason: "next_game_user_interaction",
    now: 91_000,
    log: () => {}
  });
  closureCaptureState.nextAttemptAt = 91_300;
  const initialArmedUntil = closureCaptureState.armedUntil;

  const bootstrapState = readyBootstrapState(91_250);
  bootstrapState.lastReady = true;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate,
    waitingForNextGame: true,
    now: 91_250,
    log: (line) => logs.push(line),
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    readNextGameInteractionStateFn: async () => ({
      generation: 1,
      type: "click",
      timestamp: 91_250,
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => ({ ok: false, reason: "still hidden" })
  });

  assert.equal(closureCaptureState.armedUntil, initialArmedUntil);
  assert.equal(closureCaptureState.nextAttemptAt, 91_300);
  assert.equal(
    logs.filter((line) => line.includes("reason=next_game_user_interaction")).length,
    0
  );
});

test("interaction fallback waits 800ms before the second full scan continuation", async () => {
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 95_000,
    epoch: 1,
    interactionBaselineGeneration: 5,
    log: () => {}
  });
  armClosureCaptureWindow(closureCaptureState, {
    reason: "next_game_user_interaction",
    now: 95_000,
    log: () => {}
  });
  closureCaptureState.nextAttemptAt = 95_300;
  const bootstrapState = readyBootstrapState(95_300);
  bootstrapState.lastReady = true;

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState,
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    now: 95_300,
    log: () => {},
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    captureGameFn: async (_cdp, { closureCaptureState: captureState }) => {
      captureState.fullScanAttemptsInWindow = 1;
      return {
        ok: false,
        reason: "TETR.IO paused scope scan limit reached",
        outcome: "completed_not_found",
        windowBudgetExhausted: false
      };
    }
  });

  assert.equal(closureCaptureState.nextAttemptAt, 96_100);
});

test("completed_not_found waits 800ms and follow-up capture uses the short fast timeout", async () => {
  let captureCalls = 0;
  const pauseTimeouts = [];
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 97_000,
    epoch: 1,
    interactionBaselineGeneration: 6,
    log: () => {}
  });
  armClosureCaptureWindow(closureCaptureState, {
    reason: "next_game_user_interaction",
    now: 97_000,
    log: () => {}
  });
  closureCaptureState.nextAttemptAt = 97_300;

  const captureGameFn = async (_cdp, options) => {
    captureCalls += 1;
    pauseTimeouts.push(options.pauseTimeoutMs);
    return captureCalls === 1
      ? {
          ok: false,
          reason: "TETR.IO paused scope scan limit reached",
          outcome: "completed_not_found",
          windowBudgetExhausted: false
        }
      : { ok: false, reason: "still hidden" };
  };

  const baseOptions = {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    browserControlState,
    closureCaptureState,
    nextGameReacquireState,
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: true,
    log: () => {},
    readCheapGameSignalFn: async () => ({
      active: false,
      source: "none",
      label: "result",
      sources: []
    }),
    captureGameFn
  };

  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    ...baseOptions,
    bootstrapState: readyBootstrapState(97_300),
    now: 97_300
  });
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    ...baseOptions,
    bootstrapState: readyBootstrapState(98_000),
    now: 98_000
  });
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    ...baseOptions,
    bootstrapState: readyBootstrapState(98_100),
    now: 98_100
  });

  assert.equal(captureCalls, 2);
  assert.deepEqual(pauseTimeouts, [900, 100]);
});

test("reacquire inactive ignores interaction generations and keeps heavy scan at zero", async () => {
  let captureCalls = 0;
  await readTetrioState(createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]), {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(92_000),
    browserControlState: { botEnabled: true },
    closureCaptureState: createClosureCaptureState(),
    nextGameReacquireState: createNextGameReacquireState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 92_000,
    readNextGameInteractionStateFn: async () => ({
      generation: 4,
      type: "click",
      timestamp: 92_000,
      targetTag: "BUTTON",
      targetId: "retry",
      targetClass: "cta"
    }),
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: false, reason: "should not run" };
    }
  });

  assert.equal(captureCalls, 0);
});

test("steady-state polls do not invoke the interaction tracker installer", async () => {
  const cdp = createReadStateCdp([
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" },
    { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
  ]);

  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(96_500),
    browserControlState: { botEnabled: true },
    closureCaptureState: createClosureCaptureState(),
    nextGameReacquireState: createNextGameReacquireState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 96_500
  });
  await readTetrioState(cdp, {
    probePageState: true,
    suppressClosureCapture: false,
    useSeedSimulationFallback: false,
    network: { lastPageProbeAt: 0, seed: null },
    probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
    bootstrapState: readyBootstrapState(97_000),
    browserControlState: { botEnabled: true },
    closureCaptureState: createClosureCaptureState(),
    nextGameReacquireState: createNextGameReacquireState(),
    endedGameCandidate: createEndedGameCandidateState(),
    waitingForNextGame: false,
    now: 97_000
  });

  assert.equal(
    cdp.runtimeCalls.some((call) =>
      String(call.expression).includes("__fusionNextGameInteractionTrackerInstalled")
    ),
    false
  );
});

test("interaction tracker registers future documents once and reinstalls for the current document", async () => {
  const calls = [];
  const cdp = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              ok: true,
              installed: true
            }
          }
        };
      }
      return {};
    }
  };
  const installState = createInteractionTrackerInstallState();

  await ensureNextGameInteractionTrackerInstalled(cdp, installState, {
    log: () => {}
  });
  await ensureNextGameInteractionTrackerInstalled(cdp, installState, {
    log: () => {}
  });

  assert.equal(
    calls.filter((call) => call.method === "Page.addScriptToEvaluateOnNewDocument").length,
    1
  );
  assert.equal(
    calls.filter((call) => call.method === "Runtime.evaluate").length,
    2
  );
});

test("lobby polling without interactions keeps heavy scan at zero for 60 seconds", async () => {
  let captureCalls = 0;
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  const browserControlState = createBrowserControlState();
  browserControlState.botEnabled = true;
  startNextGameReacquire(nextGameReacquireState, {
    now: 98_000,
    epoch: 1,
    interactionBaselineGeneration: 5,
    log: () => {}
  });

  for (let second = 0; second < 60; second += 1) {
    await readTetrioState(createReadStateCdp([
      { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" }
    ]), {
      probePageState: true,
      suppressClosureCapture: false,
      useSeedSimulationFallback: false,
      network: { lastPageProbeAt: 0, seed: null },
      probeState: { lastCaptureAt: 0, lastGameplayPhase: "inactive" },
      bootstrapState: readyBootstrapState(98_000 + second * 1000),
      browserControlState,
      closureCaptureState,
      nextGameReacquireState,
      endedGameCandidate: createEndedGameCandidateState(),
      waitingForNextGame: true,
      now: 98_000 + second * 1000,
      log: () => {},
      readCheapGameSignalFn: async () => ({
        active: false,
        source: "none",
        label: "inactive",
        sources: []
      }),
      readNextGameInteractionStateFn: async () => ({
        generation: 5,
        timestamp: 97_000,
        type: "click",
        targetTag: "BUTTON",
        targetId: "retry",
        targetClass: "cta"
      }),
      captureGameFn: async () => {
        captureCalls += 1;
        return { ok: false, reason: "should not run" };
      }
    });
  }

  assert.equal(captureCalls, 0);
});

test("Bot OFF cancels next-game reacquire", () => {
  const logs = [];
  const controlState = createBrowserControlState();
  const closureCaptureState = createClosureCaptureState();
  const nextGameReacquireState = createNextGameReacquireState();
  controlState.botEnabled = true;
  nextGameReacquireState.active = true;

  applyBrowserControlMessage({
    message: { type: "bot_enabled", enabled: false },
    controlState,
    closureCaptureState,
    nextGameReacquireState,
    now: 70_000,
    log: (line) => logs.push(line)
  });

  assert.equal(controlState.botEnabled, false);
  assert.equal(nextGameReacquireState.active, false);
  assert.ok(logs.includes("[browser] next-game reacquire cancelled reason=bot_off"));
});

test("VS gameid options disarm an existing closure window and do not queue a solo signal", () => {
  const logs = [];
  const sessionModeState = createSessionModeState();
  const gameStartSignalState = createGameStartSignalState();
  const closureCaptureState = createClosureCaptureState();
  armClosureCaptureWindow(closureCaptureState, {
    reason: "bot_on",
    now: 10_000,
    log: (line) => logs.push(line)
  });

  const result = handleDddGameOptions({
    sessionModeState,
    gameStartSignalState,
    closureCaptureState,
    signature: "sig-vs",
    options: {
      gameid: "6509",
      seed: "1212141728",
      bagtype: "7-bag",
      nextcount: 6
    },
    capturedAt: 10_100,
    log: (line) => logs.push(line)
  });

  assert.equal(result.selectedVsShadow, true);
  assert.equal(result.queuedSolo, false);
  assert.equal(sessionModeState.mode, "vs_ws_shadow");
  assert.equal(isClosureCaptureArmed(closureCaptureState, 10_101), false);
  assert.equal(hasUnconsumedGameStartSignal(gameStartSignalState), false);
  assert.ok(logs.includes("[browser] closure capture disarmed reason=vs_ws_shadow_selected"));
  assert.ok(logs.includes("[browser] closure capture suppressed for VS WebSocket session"));
});

test("orphan multiplayer options are ignored while VS shadow mode is selected", () => {
  const logs = [];
  const sessionModeState = createSessionModeState();
  const gameStartSignalState = createGameStartSignalState();

  handleDddGameOptions({
    sessionModeState,
    gameStartSignalState,
    signature: "sig-vs",
    options: {
      gameid: "6509",
      seed: "1212141728",
      bagtype: "7-bag",
      nextcount: 6
    },
    capturedAt: 20_000,
    log: () => {}
  });

  const orphan = handleDddGameOptions({
    sessionModeState,
    gameStartSignalState,
    signature: "sig-orphan",
    options: {
      seed: "187156",
      bagtype: "7-bag",
      nextcount: 6
    },
    capturedAt: 20_010,
    log: (line) => logs.push(line)
  });

  assert.equal(orphan.selectedVsShadow, false);
  assert.equal(orphan.queuedSolo, false);
  assert.equal(hasUnconsumedGameStartSignal(gameStartSignalState), false);
  assert.ok(logs.some((line) => line.includes("orphan multiplayer options ignored seed=187156")));
});

test("solo DDD options still queue a solo start signal when VS shadow mode is not selected", () => {
  const logs = [];
  const sessionModeState = createSessionModeState();
  const gameStartSignalState = createGameStartSignalState();

  const result = handleDddGameOptions({
    sessionModeState,
    gameStartSignalState,
    signature: "sig-solo",
    options: {
      seed: "123456",
      bagtype: "7-bag",
      nextcount: 6
    },
    capturedAt: 30_000,
    log: (line) => logs.push(line)
  });

  assert.equal(result.selectedVsShadow, false);
  assert.equal(result.queuedSolo, true);
  assert.equal(hasUnconsumedGameStartSignal(gameStartSignalState), true);
  assert.ok(logs.includes("[browser] solo signal queued key=ddd:sig-solo source=ddd_game_options"));
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
