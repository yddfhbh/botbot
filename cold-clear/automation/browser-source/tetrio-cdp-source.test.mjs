import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import {
  buildSnapshotSignature,
  buildSnapshotToken,
  buildVsObjectSnapshotSignature,
  captureVsLocalGameObjectFromPausedScope,
  clearSnapshotFile,
  createSnapshotTracking,
  createVsObjectTracking,
  determineChromiumOwnership,
  isVsWsSimEnvEnabled,
  isTetrioGameEndedState,
  pausedFrameExposureExpression,
  processVsObjectDiagnostics,
  readTetrioState,
  readVsLocalGameObjectFromCachedHandle,
  resolvePollMs,
  resolveUseSeedSimulationFallback,
  resolveVsScopePauseBudgetMs,
  resetSnapshotTracking,
  resetVsObjectTracking,
  shouldAttemptClosureCapture,
  shouldLogStateReason,
  shouldAdvanceGameEpoch,
  shouldHandleEndedGame,
  tetrioStateExpression,
  vsObjectStateExpression
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

function createVsBoard(height = 20) {
  return Array.from({ length: height }, () => Array.from({ length: 10 }, () => 0));
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

function createReadStateCdp(values) {
  const queue = [...values];
  return {
    async send(method) {
      if (method !== "Runtime.evaluate") {
        throw new Error(`Unhandled method ${method}`);
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

function createVsLocalGameObject({
  gameid = "4412",
  userid = "local-user",
  username = "hebi_",
  current = "t",
  hold = "i",
  queue = ["o", "s", "z"],
  active = true
} = {}) {
  const board = createVsBoard(20);
  board[19][4] = 1;
  board[18][4] = 1;
  return {
    gameid,
    userid,
    username,
    board,
    current: { type: current },
    hold,
    queue,
    active,
    ejectState() {
      return null;
    },
    ejectBoardState() {
      return null;
    }
  };
}

function createMockVsScopeCdp(initialCallFrames = [], options = {}) {
  const listeners = new Map();
  const history = [];
  const objectIds = new WeakMap();
  const objectsById = new Map();
  const invalidObjectIds = new Set();
  let nextObjectId = 1;
  let pausedCallFrames = initialCallFrames;
  let pauseEventDelayMs = options.pauseEventDelayMs ?? 0;
  let getPropertiesDelayMs = options.getPropertiesDelayMs ?? 0;
  let getPropertiesErrorAtCall = options.getPropertiesErrorAtCall ?? null;
  let resumeErrorsRemaining = options.resumeErrorsRemaining ?? 0;
  let getPropertiesCalls = 0;

  const ensureObjectId = (value) => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return "";
    }
    const existing = objectIds.get(value);
    if (existing) {
      return existing;
    }
    const objectId = `mock-${nextObjectId++}`;
    objectIds.set(value, objectId);
    objectsById.set(objectId, value);
    return objectId;
  };

  const toRemote = (value) => {
    if (value === null) {
      return { type: "object", subtype: "null", value: null };
    }
    const primitiveType = typeof value;
    if (primitiveType === "string" || primitiveType === "number" || primitiveType === "boolean") {
      return {
        type: primitiveType,
        value
      };
    }
    if (primitiveType === "undefined") {
      return { type: "undefined" };
    }
    if (primitiveType === "function") {
      return {
        type: "function",
        className: value.name || "Function",
        description: value.name || "Function",
        objectId: ensureObjectId(value)
      };
    }
    const objectId = ensureObjectId(value);
    if (Array.isArray(value)) {
      return {
        type: "object",
        subtype: "array",
        className: "Array",
        description: `Array(${value.length})`,
        objectId
      };
    }
    return {
      type: "object",
      className: value.constructor?.name || "Object",
      description: value.constructor?.name || "Object",
      objectId
    };
  };

  const buildPausedEvent = () => ({
    callFrames: pausedCallFrames.map((callFrame, frameIndex) => ({
      callFrameId: `frame-${frameIndex}`,
      functionName: callFrame.functionName ?? "",
      scopeChain: (callFrame.scopeChain ?? []).map((scope, scopeIndex) => ({
        type: scope.type,
        object: {
          ...toRemote(scope.object),
          objectId: ensureObjectId(scope.object) || `scope-${frameIndex}-${scopeIndex}`
        }
      }))
    }))
  });

  const emit = (method, params) => {
    const handlers = listeners.get(method);
    if (!handlers) {
      return;
    }
    for (const handler of [...handlers]) {
      handler(params);
    }
  };

  return {
    history,
    setPausedCallFrames(callFrames) {
      pausedCallFrames = callFrames;
    },
    setPauseEventDelayMs(delayMs) {
      pauseEventDelayMs = delayMs;
    },
    setGetPropertiesDelayMs(delayMs) {
      getPropertiesDelayMs = delayMs;
    },
    invalidateObjectId(objectId) {
      invalidObjectIds.add(objectId);
    },
    on(method, handler) {
      const handlers = listeners.get(method) ?? new Set();
      handlers.add(handler);
      listeners.set(method, handlers);
    },
    off(method, handler) {
      const handlers = listeners.get(method);
      if (!handlers) {
        return;
      }
      handlers.delete(handler);
      if (handlers.size === 0) {
        listeners.delete(method);
      }
    },
    waitForEvent(method, predicate = () => true, timeoutMs = 1000) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for CDP event ${method}`));
        }, timeoutMs);
        const handler = (params) => {
          if (!predicate(params)) {
            return;
          }
          cleanup();
          resolve(params);
        };
        const cleanup = () => {
          clearTimeout(timeout);
          this.off(method, handler);
        };
        this.on(method, handler);
      });
    },
    async send(method, params = {}) {
      history.push({ method, params });
      if (
        method === "Debugger.enable" ||
        method === "Debugger.disable"
      ) {
        return {};
      }
      if (method === "Debugger.resume") {
        if (resumeErrorsRemaining > 0) {
          resumeErrorsRemaining -= 1;
          throw new Error("Debugger is not paused");
        }
        return {};
      }
      if (method === "Debugger.pause") {
        setTimeout(() => emit("Debugger.paused", buildPausedEvent()), pauseEventDelayMs);
        return {};
      }
      if (method === "Runtime.getProperties") {
        getPropertiesCalls += 1;
        if (getPropertiesDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, getPropertiesDelayMs));
        }
        if (getPropertiesErrorAtCall !== null && getPropertiesCalls >= getPropertiesErrorAtCall) {
          throw new Error("mock getProperties failure");
        }
        const target = objectsById.get(params.objectId);
        if (!target || invalidObjectIds.has(params.objectId)) {
          throw new Error("Cannot find object with given id");
        }
        const descriptors = Object.getOwnPropertyDescriptors(target);
        return {
          result: Object.entries(descriptors).map(([name, descriptor]) => ({
            name,
            value: Object.hasOwn(descriptor, "value")
              ? toRemote(descriptor.value)
              : undefined
          }))
        };
      }
      throw new Error(`Unhandled CDP method ${method}`);
    }
  };
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

test("VS paused-scope pause budget falls back to 120ms outside the allowed range", () => {
  assert.equal(resolveVsScopePauseBudgetMs("50"), 50);
  assert.equal(resolveVsScopePauseBudgetMs("500"), 500);
  assert.equal(resolveVsScopePauseBudgetMs("49"), 120);
  assert.equal(resolveVsScopePauseBudgetMs("501"), 120);
  assert.equal(resolveVsScopePauseBudgetMs("abc"), 120);
});

test("closure capture probe is attempted when VS sim is off and cooldown elapsed", () => {
  assert.equal(
    shouldAttemptClosureCapture({
      probePageState: true,
      suppressClosureCapture: false,
      stateOk: false,
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
      lastCaptureAt: 0,
      lastPageProbeAt: 0,
      now: 10_000
    }),
    false
  );
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

test("resetVsObjectTracking clears VS diagnostic state", () => {
  const tracking = createVsObjectTracking();
  tracking.roundId = "round-1";
  tracking.lastSnapshotSignature = "sig";
  tracking.lastCandidateLogSignature = "log";
  tracking.lastNotFoundRoundId = "round-1";
  tracking.lastActiveRoundId = "round-1";

  resetVsObjectTracking(tracking);

  assert.deepEqual(tracking, {
    roundId: "",
    lastSnapshotSignature: "",
    lastCandidateLogSignature: "",
    lastNotFoundRoundId: "",
    lastActiveRoundId: "",
    cachedObjectId: "",
    cachedPath: "",
    cachedScore: 0,
    scopeAttempts: 0,
    nextScopeAttemptAt: 0,
    scopeCaptureLocked: false,
    scopeFailureLogged: false,
    scopeCaptureInFlight: false,
    scopeLastScheduledAttempt: 0,
    scopeLastCancelReason: "",
    scopeStats: {
      framesScanned: 0,
      scopesScanned: 0,
      objectsScanned: 0
    }
  });
});

test("VS object snapshot signature changes when board state changes", () => {
  const emptyBoard = createVsBoard(20);
  const filledBoard = createVsBoard(20);
  filledBoard[19][0] = true;

  assert.notEqual(
    buildVsObjectSnapshotSignature({
      roundId: "round-1",
      gameid: "g-1",
      board: emptyBoard,
      current: "T",
      hold: "I",
      queue: ["O"],
      active: true
    }),
    buildVsObjectSnapshotSignature({
      roundId: "round-1",
      gameid: "g-1",
      board: filledBoard,
      current: "T",
      hold: "I",
      queue: ["O"],
      active: true
    })
  );
});

test("VS object probe selects the local player by gameid and reads board queue hold", () => {
  const localBoard = createVsBoard(20);
  localBoard[19][0] = 1;
  localBoard[18][1] = 1;
  const opponentBoard = createVsBoard(20);
  opponentBoard[19][9] = 1;

  const localPlayer = {
    userid: "local-user",
    username: "hebi_",
    gameid: "5449",
    game: {
      board: localBoard,
      current: { type: "t" },
      hold: { type: "i" },
      queue: [{ type: "o" }, { type: "s" }, { type: "z" }],
      active: true
    }
  };
  const opponentPlayer = {
    userid: "guest-user",
    username: "guest_",
    gameid: "5450",
    game: {
      board: opponentBoard,
      current: { type: "l" },
      hold: { type: "j" },
      queue: [{ type: "i" }, { type: "o" }],
      active: true
    }
  };

  const { result } = evaluateInWindow(vsObjectStateExpression({
    roundId: "5449:1744077373",
    gameid: "5449",
    userid: "local-user",
    username: "hebi_"
  }), {
    roomState: {
      players: [opponentPlayer, localPlayer]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.gameid, "5449");
  assert.equal(result.userid, "local-user");
  assert.equal(result.current, "t");
  assert.equal(result.hold, "i");
  assert.deepEqual(result.queue.slice(0, 3), ["o", "s", "z"]);
  assert.equal(result.boardWidth, 10);
  assert.equal(result.boardHeight, 20);
  assert.equal(result.occupiedCells, 2);
  assert.equal(result.active, true);
});

test("VS object probe revalidates cached candidates when the round changes", () => {
  const oldBoard = createVsBoard(20);
  oldBoard[19][0] = 1;
  const newBoard = createVsBoard(20);
  newBoard[19][4] = 1;
  newBoard[18][4] = 1;
  const oldLocal = {
    userid: "local-user",
    username: "hebi_",
    gameid: "5449",
    game: {
      board: oldBoard,
      current: { type: "t" },
      hold: { type: "i" },
      queue: [{ type: "o" }],
      active: true
    }
  };
  const newLocal = {
    userid: "local-user",
    username: "hebi_",
    gameid: "6001",
    game: {
      board: newBoard,
      current: { type: "s" },
      hold: { type: "z" },
      queue: [{ type: "l" }, { type: "j" }],
      active: true
    }
  };
  const window = {
    matchState: {
      players: [oldLocal]
    }
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
    String
  };

  const roundOne = vm.runInNewContext(
    vsObjectStateExpression({
      roundId: "5449:1744077373",
      gameid: "5449",
      userid: "local-user",
      username: "hebi_"
    }),
    context
  );
  assert.equal(roundOne.ok, true);
  assert.equal(roundOne.gameid, "5449");
  assert.equal(roundOne.current, "t");

  window.matchState.players = [oldLocal, newLocal];
  const roundTwo = vm.runInNewContext(
    vsObjectStateExpression({
      roundId: "6001:1744077374",
      gameid: "6001",
      userid: "local-user",
      username: "hebi_"
    }),
    context
  );
  assert.equal(roundTwo.ok, true);
  assert.equal(roundTwo.gameid, "6001");
  assert.equal(roundTwo.current, "s");
  assert.equal(roundTwo.occupiedCells, 2);
});

test("VS object diagnostics keep live snapshot empty when no local object is found", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "vs-object-diagnostics-"));
  const liveSnapshotPath = path.join(tempDir, "live-snapshot.json");
  const vsObjectSnapshotPath = path.join(tempDir, "vs-object-snapshot.json");
  const tracking = createVsObjectTracking();
  const logs = [];
  writeFileSync(liveSnapshotPath, "{\"ok\":true}");

  const first = await processVsObjectDiagnostics(null, {
    vsRoundStatus: {
      active: true,
      roundId: "5449:1744077373",
      localGameId: "5449",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    log: (line) => logs.push(line),
    readVsObjectStateFn: async () => ({
      ok: false,
      reason: "TETR.IO VS local game object not found"
    })
  });

  const second = await processVsObjectDiagnostics(null, {
    vsRoundStatus: {
      active: true,
      roundId: "5449:1744077373",
      localGameId: "5449",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    log: (line) => logs.push(line),
    readVsObjectStateFn: async () => ({
      ok: false,
      reason: "TETR.IO VS local game object not found"
    })
  });

  assert.deepEqual(first, {
    handled: true,
    found: false,
    candidate: null
  });
  assert.deepEqual(second, {
    handled: true,
    found: false,
    candidate: null
  });
  assert.equal(existsSync(liveSnapshotPath), false);
  assert.equal(existsSync(vsObjectSnapshotPath), false);
  assert.deepEqual(logs, ["[vs-object] local game object not found"]);
});

test("VS paused scope capture selects a local-scope candidate with obfuscated variable names", async () => {
  const localGame = createVsLocalGameObject();
  const cdp = createMockVsScopeCdp([
    {
      functionName: "tick",
      scopeChain: [
        {
          type: "local",
          object: {
            x9$: {
              zz_game: localGame
            }
          }
        }
      ]
    }
  ]);
  const logs = [];

  const capture = await captureVsLocalGameObjectFromPausedScope(cdp, {
    roundId: "4412:384296123",
    identity: {
      gameid: "4412",
      userid: "local-user",
      username: "hebi_"
    },
    log: (line) => logs.push(line)
  });

  assert.equal(capture.ok, true);
  assert.equal(capture.candidate.scopeType, "local");
  assert.match(capture.candidate.variablePath, /x9\$\.zz_game/);
  assert.ok(logs.includes("[vs-scope] local game object captured"));
  assert.equal(cdp.history.filter((entry) => entry.method === "Debugger.resume").length, 1);
});

test("VS paused scope capture falls back to closure scope when local scope has no game", async () => {
  const localGame = createVsLocalGameObject();
  const cdp = createMockVsScopeCdp([
    {
      functionName: "raf",
      scopeChain: [
        {
          type: "local",
          object: {
            somethingElse: { value: 1 }
          }
        },
        {
          type: "closure",
          object: {
            q: localGame
          }
        }
      ]
    }
  ]);

  const capture = await captureVsLocalGameObjectFromPausedScope(cdp, {
    roundId: "4412:384296123",
    identity: {
      gameid: "4412",
      userid: "local-user",
      username: "hebi_"
    }
  });

  assert.equal(capture.ok, true);
  assert.equal(capture.candidate.scopeType, "closure");
});

test("VS paused scope capture excludes opponent game objects and prefers the local gameid", async () => {
  const opponentGame = createVsLocalGameObject({
    gameid: "9999",
    userid: "other-user",
    username: "enemy_",
    current: "o"
  });
  const localGame = createVsLocalGameObject({
    gameid: "4412",
    userid: "local-user",
    username: "hebi_",
    current: "t"
  });
  const cdp = createMockVsScopeCdp([
    {
      functionName: "update",
      scopeChain: [
        {
          type: "local",
          object: {
            enemy: opponentGame,
            mine: localGame
          }
        }
      ]
    }
  ]);

  const capture = await captureVsLocalGameObjectFromPausedScope(cdp, {
    roundId: "4412:384296123",
    identity: {
      gameid: "4412",
      userid: "local-user",
      username: "hebi_"
    }
  });

  assert.equal(capture.ok, true);
  assert.equal(capture.candidate.gameid, "4412");
  assert.equal(capture.candidate.current, "t");
});

test("VS paused scope capture rejects opponent-only candidates and still resumes the debugger", async () => {
  const opponentGame = createVsLocalGameObject({
    gameid: "9999",
    userid: "other-user",
    username: "enemy_"
  });
  const cdp = createMockVsScopeCdp([
    {
      functionName: "update",
      scopeChain: [
        {
          type: "local",
          object: {
            enemy: opponentGame
          }
        }
      ]
    }
  ]);

  const capture = await captureVsLocalGameObjectFromPausedScope(cdp, {
    roundId: "4412:384296123",
    identity: {
      gameid: "4412",
      userid: "local-user",
      username: "hebi_"
    }
  });

  assert.equal(capture.ok, false);
  assert.equal(cdp.history.filter((entry) => entry.method === "Debugger.resume").length, 1);
});

test("VS paused scope capture resumes within the pause budget when scope scanning times out", async () => {
  const localGame = createVsLocalGameObject();
  const cdp = createMockVsScopeCdp(
    [
      {
        functionName: "tick",
        scopeChain: [{ type: "local", object: { p: localGame } }]
      }
    ],
    {
      getPropertiesDelayMs: 80
    }
  );
  const logs = [];

  const capture = await captureVsLocalGameObjectFromPausedScope(cdp, {
    roundId: "4412:budget",
    identity: {
      gameid: "4412",
      userid: "local-user",
      username: "hebi_"
    },
    pauseBudgetMs: 50,
    log: (line) => logs.push(line)
  });

  assert.equal(capture.ok, false);
  assert.equal(capture.timedOut, true);
  assert.ok(logs.some((line) => line.startsWith("[vs-scope] scan timed out budget_ms=50 objects_scanned=")));
  const watchdogLog = logs.find((line) => line.startsWith("[vs-scope] resume watchdog fired elapsed_ms="));
  const resumedLog = logs.find((line) => line.startsWith("[vs-scope] pause resumed elapsed_ms="));
  assert.ok(watchdogLog);
  assert.ok(resumedLog);
  assert.ok(Number.parseInt(watchdogLog.split("=").pop(), 10) <= 50);
  assert.ok(Number.parseInt(resumedLog.split("=").pop(), 10) <= 50);
  assert.equal(cdp.history.filter((entry) => entry.method === "Debugger.resume").length, 1);
  assert.equal(cdp.history.some((entry) => entry.method.startsWith("Input.")), false);
});

test("VS paused scope capture resumes on getProperties errors", async () => {
  const localGame = createVsLocalGameObject();
  const cdp = createMockVsScopeCdp(
    [
      {
        functionName: "tick",
        scopeChain: [{ type: "local", object: { p: localGame } }]
      }
    ],
    {
      getPropertiesErrorAtCall: 1
    }
  );

  const capture = await captureVsLocalGameObjectFromPausedScope(cdp, {
    roundId: "4412:error",
    identity: {
      gameid: "4412",
      userid: "local-user",
      username: "hebi_"
    },
    pauseBudgetMs: 50
  });

  assert.equal(capture.ok, false);
  assert.match(capture.reason, /mock getProperties failure/);
  assert.equal(cdp.history.filter((entry) => entry.method === "Debugger.resume").length, 1);
});

test("VS paused scope capture resumes when the round changes during scanning", async () => {
  const localGame = createVsLocalGameObject();
  const cdp = createMockVsScopeCdp(
    [
      {
        functionName: "tick",
        scopeChain: [{ type: "local", object: { p: localGame } }]
      }
    ],
    {
      getPropertiesDelayMs: 80
    }
  );
  let active = true;
  setTimeout(() => {
    active = false;
  }, 15);

  const capture = await captureVsLocalGameObjectFromPausedScope(cdp, {
    roundId: "4412:round-change",
    identity: {
      gameid: "4412",
      userid: "local-user",
      username: "hebi_"
    },
    pauseBudgetMs: 50,
    getVsRoundStatus: () => ({
      active,
      roundId: active ? "4412:round-change" : "5500:next"
    })
  });

  assert.equal(capture.ok, false);
  assert.equal(capture.cancelled, true);
  assert.equal(cdp.history.filter((entry) => entry.method === "Debugger.resume").length, 1);
});

test("VS paused scope capture resumes when VS becomes inactive during scanning", async () => {
  const localGame = createVsLocalGameObject();
  const cdp = createMockVsScopeCdp(
    [
      {
        functionName: "tick",
        scopeChain: [{ type: "local", object: { p: localGame } }]
      }
    ],
    {
      getPropertiesDelayMs: 80
    }
  );
  let active = true;
  setTimeout(() => {
    active = false;
  }, 15);

  const capture = await captureVsLocalGameObjectFromPausedScope(cdp, {
    roundId: "4412:inactive",
    identity: {
      gameid: "4412",
      userid: "local-user",
      username: "hebi_"
    },
    pauseBudgetMs: 50,
    getVsRoundStatus: () => ({
      active,
      roundId: "4412:inactive"
    })
  });

  assert.equal(capture.ok, false);
  assert.equal(capture.cancelled, true);
  assert.equal(cdp.history.filter((entry) => entry.method === "Debugger.resume").length, 1);
});

test("VS paused scope capture stays safe when watchdog and finally overlap", async () => {
  const localGame = createVsLocalGameObject();
  const cdp = createMockVsScopeCdp(
    [
      {
        functionName: "tick",
        scopeChain: [{ type: "local", object: { p: localGame } }]
      }
    ],
    {
      getPropertiesDelayMs: 80,
      resumeErrorsRemaining: 1
    }
  );

  const capture = await captureVsLocalGameObjectFromPausedScope(cdp, {
    roundId: "4412:watchdog-race",
    identity: {
      gameid: "4412",
      userid: "local-user",
      username: "hebi_"
    },
    pauseBudgetMs: 50
  });

  assert.equal(capture.ok, false);
  assert.equal(capture.timedOut, true);
  assert.ok(cdp.history.filter((entry) => entry.method === "Debugger.resume").length >= 1);
});

test("VS diagnostics do not pause before readyAt and start the first gameplay probe at readyAt plus 150ms", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "vs-scope-ready-schedule-"));
  const liveSnapshotPath = path.join(tempDir, "live-snapshot.json");
  const vsObjectSnapshotPath = path.join(tempDir, "vs-object-snapshot.json");
  const tracking = createVsObjectTracking();
  const logs = [];
  let captureCalls = 0;

  const beforeReady = await processVsObjectDiagnostics(null, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:ready",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    log: (line) => logs.push(line),
    nowFn: () => 200,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" }),
    captureVsObjectFromPausedScopeFn: async () => {
      captureCalls += 1;
      return { ok: true, objectId: "cached", candidate: { board: [], queue: [], active: true }, stats: { framesScanned: 0, scopesScanned: 0, objectsScanned: 0 } };
    }
  });
  const atReady = await processVsObjectDiagnostics(null, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:ready",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    log: (line) => logs.push(line),
    nowFn: () => 250,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" }),
    captureVsObjectFromPausedScopeFn: async (_cdp, options) => {
      captureCalls += 1;
      return {
        ok: true,
        objectId: "cached",
        candidate: {
          ok: true,
          objectId: "cached",
          variablePath: "p",
          score: 100,
          board: [],
          queue: [],
          active: true,
          gameid: options.identity.gameid,
          userid: options.identity.userid,
          username: options.identity.username,
          current: "t",
          hold: null,
          capturedAt: 250
        },
        stats: { framesScanned: 0, scopesScanned: 0, objectsScanned: 0 }
      };
    }
  });

  assert.equal(beforeReady.found, false);
  assert.equal(atReady.found, true);
  assert.equal(captureCalls, 1);
  assert.ok(logs.includes("[vs-scope] probe scheduled attempt=1 ready_in_ms=50"));
  assert.ok(logs.includes("[vs-scope] gameplay probe started attempt=1 after_ready_ms=150"));
});

test("VS diagnostics cancel a scheduled gameplay probe when the round changes", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "vs-scope-round-cancel-"));
  const liveSnapshotPath = path.join(tempDir, "live-snapshot.json");
  const vsObjectSnapshotPath = path.join(tempDir, "vs-object-snapshot.json");
  const tracking = createVsObjectTracking();
  const logs = [];

  await processVsObjectDiagnostics(null, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:pending",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 1000
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    log: (line) => logs.push(line),
    nowFn: () => 500,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" })
  });
  await processVsObjectDiagnostics(null, {
    vsRoundStatus: {
      active: true,
      roundId: "5500:next",
      localGameId: "5500",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 2000
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    log: (line) => logs.push(line),
    nowFn: () => 600,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" })
  });

  assert.ok(logs.includes("[vs-scope] probe cancelled reason=round_changed"));
});

test("VS diagnostics cancel a scheduled gameplay probe when the round becomes inactive", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "vs-scope-inactive-cancel-"));
  const liveSnapshotPath = path.join(tempDir, "live-snapshot.json");
  const vsObjectSnapshotPath = path.join(tempDir, "vs-object-snapshot.json");
  const tracking = createVsObjectTracking();
  const logs = [];

  await processVsObjectDiagnostics(null, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:pending",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 1000
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    log: (line) => logs.push(line),
    nowFn: () => 500,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" })
  });
  await processVsObjectDiagnostics(null, {
    vsRoundStatus: {
      active: false,
      roundId: "",
      localGameId: "",
      localUserId: "",
      localUsername: "",
      readyAt: 0
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    log: (line) => logs.push(line),
    nowFn: () => 600,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" })
  });

  assert.ok(logs.includes("[vs-scope] probe cancelled reason=inactive"));
});

test("VS diagnostics caches paused-scope object handles and stops pausing after capture", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "vs-scope-cached-"));
  const liveSnapshotPath = path.join(tempDir, "live-snapshot.json");
  const vsObjectSnapshotPath = path.join(tempDir, "vs-object-snapshot.json");
  const tracking = createVsObjectTracking();
  const localGame = createVsLocalGameObject();
  const cdp = createMockVsScopeCdp([
    {
      functionName: "tick",
      scopeChain: [
        {
          type: "local",
          object: {
            p: localGame
          }
        }
      ]
    }
  ]);

  const first = await processVsObjectDiagnostics(cdp, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:384296123",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    nowFn: () => 0,
    readVsObjectStateFn: async () => ({
      ok: false,
      reason: "window graph miss"
    })
  });
  const second = await processVsObjectDiagnostics(cdp, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:384296123",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    nowFn: () => 250,
    readVsObjectStateFn: async () => ({
      ok: false,
      reason: "window graph miss"
    })
  });
  const third = await processVsObjectDiagnostics(cdp, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:384296123",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    nowFn: () => 400,
    readVsObjectStateFn: async () => ({
      ok: false,
      reason: "window graph miss"
    })
  });

  assert.equal(first.found, false);
  assert.equal(second.found, true);
  assert.equal(third.found, true);
  assert.equal(cdp.history.filter((entry) => entry.method === "Debugger.pause").length, 1);
  assert.equal(cdp.history.some((entry) => entry.method.startsWith("Input.")), false);
  const snapshot = JSON.parse(readFileSync(vsObjectSnapshotPath, "utf8"));
  assert.equal(snapshot.source, "paused_scope");
  assert.equal(snapshot.localGameId, "4412");
  assert.equal(existsSync(liveSnapshotPath), false);
});

test("VS diagnostics discard cached objectIds on round change and capture again for the new round", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "vs-scope-round-reset-"));
  const liveSnapshotPath = path.join(tempDir, "live-snapshot.json");
  const vsObjectSnapshotPath = path.join(tempDir, "vs-object-snapshot.json");
  const tracking = createVsObjectTracking();
  const roundOneGame = createVsLocalGameObject({ gameid: "4412", current: "t" });
  const roundTwoGame = createVsLocalGameObject({ gameid: "5500", current: "s" });
  const cdp = createMockVsScopeCdp([
    {
      functionName: "tick",
      scopeChain: [{ type: "local", object: { p: roundOneGame } }]
    }
  ]);

  await processVsObjectDiagnostics(cdp, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:1",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    nowFn: () => 0,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" })
  });
  await processVsObjectDiagnostics(cdp, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:1",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    nowFn: () => 250,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" })
  });

  const firstObjectId = tracking.cachedObjectId;
  cdp.setPausedCallFrames([
    {
      functionName: "tick",
      scopeChain: [{ type: "local", object: { p: roundTwoGame } }]
    }
  ]);

  await processVsObjectDiagnostics(cdp, {
    vsRoundStatus: {
      active: true,
      roundId: "5500:2",
      localGameId: "5500",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 1150
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    nowFn: () => 1000,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" })
  });
  assert.equal(tracking.cachedObjectId, "");

  await processVsObjectDiagnostics(cdp, {
    vsRoundStatus: {
      active: true,
      roundId: "5500:2",
      localGameId: "5500",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 1150
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    nowFn: () => 1300,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" })
  });

  assert.notEqual(tracking.cachedObjectId, "");
  assert.notEqual(tracking.cachedObjectId, firstObjectId);
  assert.equal(cdp.history.filter((entry) => entry.method === "Debugger.pause").length, 2);
});

test("VS diagnostics wait for the next round after an invalid cached objectId", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "vs-scope-invalid-object-"));
  const liveSnapshotPath = path.join(tempDir, "live-snapshot.json");
  const vsObjectSnapshotPath = path.join(tempDir, "vs-object-snapshot.json");
  const tracking = createVsObjectTracking();
  const localGame = createVsLocalGameObject();
  const cdp = createMockVsScopeCdp([
    {
      functionName: "tick",
      scopeChain: [{ type: "local", object: { p: localGame } }]
    }
  ]);

  await processVsObjectDiagnostics(cdp, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:1",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    nowFn: () => 0,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" })
  });
  await processVsObjectDiagnostics(cdp, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:1",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    nowFn: () => 250,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" })
  });

  const pauseCount = cdp.history.filter((entry) => entry.method === "Debugger.pause").length;
  cdp.invalidateObjectId(tracking.cachedObjectId);

  const invalidRead = await processVsObjectDiagnostics(cdp, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:1",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    nowFn: () => 500,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" })
  });
  const sameRoundRetry = await processVsObjectDiagnostics(cdp, {
    vsRoundStatus: {
      active: true,
      roundId: "4412:1",
      localGameId: "4412",
      localUserId: "local-user",
      localUsername: "hebi_",
      readyAt: 100
    },
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath,
    scopeTraceEnabled: true,
    nowFn: () => 900,
    readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" })
  });

  assert.equal(invalidRead.found, false);
  assert.equal(sameRoundRetry.found, false);
  assert.equal(tracking.cachedObjectId, "");
  assert.equal(cdp.history.filter((entry) => entry.method === "Debugger.pause").length, pauseCount);
});

test("VS diagnostics stop after three paused-scope attempts and log the final failure once", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "vs-scope-max-attempts-"));
  const liveSnapshotPath = path.join(tempDir, "live-snapshot.json");
  const vsObjectSnapshotPath = path.join(tempDir, "vs-object-snapshot.json");
  const tracking = createVsObjectTracking();
  const logs = [];
  let attempts = 0;

  for (const now of [0, 200, 700, 1200, 1700]) {
    await processVsObjectDiagnostics(null, {
      vsRoundStatus: {
        active: true,
        roundId: "4412:1",
        localGameId: "4412",
        localUserId: "local-user",
        localUsername: "hebi_",
        readyAt: 50
      },
      tracking,
      liveSnapshotPath,
      vsObjectSnapshotPath,
      scopeTraceEnabled: true,
      nowFn: () => now,
      log: (line) => logs.push(line),
      readVsObjectStateFn: async () => ({ ok: false, reason: "window graph miss" }),
      captureVsObjectFromPausedScopeFn: async () => {
        attempts += 1;
        return {
          ok: false,
          reason: "not found",
          stats: {
            framesScanned: 2,
            scopesScanned: 3,
            objectsScanned: 4
          }
        };
      }
    });
  }

  assert.equal(attempts, 3);
  assert.equal(
    logs.filter((line) => line === "[vs-scope] local game object not found").length,
    1
  );
});

test("cached VS object handles can be read back without another pause", async () => {
  const game = createVsLocalGameObject({ current: "l", hold: "o", queue: ["i", "t"] });
  const cdp = createMockVsScopeCdp([
    {
      functionName: "tick",
      scopeChain: [{ type: "local", object: { p: game } }]
    }
  ]);

  const capture = await captureVsLocalGameObjectFromPausedScope(cdp, {
    roundId: "4412:1",
    identity: {
      gameid: "4412",
      userid: "local-user",
      username: "hebi_"
    }
  });
  const cached = await readVsLocalGameObjectFromCachedHandle(cdp, {
    objectId: capture.objectId
  });

  assert.equal(cached.ok, true);
  assert.equal(cached.current, "l");
  assert.deepEqual(cached.queue, ["i", "t"]);
  assert.equal(cdp.history.filter((entry) => entry.method === "Debugger.pause").length, 1);
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
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
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
    captureGameFn: async () => {
      captureCalls += 1;
      return { ok: true, source: "closure:Ai" };
    }
  });

  assert.equal(captureCalls, 1);
  assert.equal(state.ok, true);
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
    captureGameFn: async () => {
      throw new Error("should not capture");
    }
  });

  assert.equal(reads, 1);
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
