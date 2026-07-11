import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import {
  buildSnapshotSignature,
  buildSnapshotToken,
  clearSnapshotFile,
  createSnapshotTracking,
  determineChromiumOwnership,
  isTetrioGameEndedState,
  pausedFrameExposureExpression,
  resetSnapshotTracking,
  shouldAdvanceGameEpoch,
  shouldHandleEndedGame,
  tetrioStateExpression
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

  resetSnapshotTracking(tracking);

  assert.deepEqual(tracking, {
    stableSignature: "",
    stableCount: 0,
    lastWrittenSignature: "",
    lastLoggedToken: ""
  });
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
  assert.equal(result.field[0][0], true);
  assert.equal(window.__fusionTetrioGame, game);
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
