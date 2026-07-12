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
  clearSnapshotFile,
  createSnapshotTracking,
  createVsObjectTracking,
  determineChromiumOwnership,
  isVsWsSimEnvEnabled,
  isTetrioGameEndedState,
  pausedFrameExposureExpression,
  processVsObjectDiagnostics,
  readTetrioState,
  resolvePollMs,
  resolveUseSeedSimulationFallback,
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
    lastActiveRoundId: ""
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
      localUsername: "hebi_"
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
      localUsername: "hebi_"
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
