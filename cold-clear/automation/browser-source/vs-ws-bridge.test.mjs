import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectVsIncomingGarbage,
  createVsBridgeState,
  deriveVsRoundBridge,
  markVsBridgeInactive,
  updateVsBridgeState,
  writeVsBridgeFile
} from "./vs-ws-bridge.mjs";

function makeTempBridgeFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vs-ws-bridge-"));
  return {
    dir,
    filePath: path.join(dir, "vs-ws-bridge.json")
  };
}

function cleanupTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sampleRoundRoot(overrides = {}) {
  return {
    user: {
      _id: "63b3ad2b1103e5097025feba",
      username: "hebi_"
    },
    players: [
      {
        username: "hebi_",
        userid: "63b3ad2b1103e5097025feba",
        gameid: 4382,
        alive: true,
        options: {
          seed: 2034120187
        }
      },
      {
        username: "guest-e00651",
        userid: "6a5042ff2dfdb4928a8950fe",
        gameid: 4383,
        alive: true,
        options: {
          seed: 2034120187
        }
      }
    ],
    options: {
      seed: 187156,
      bagtype: "7-bag",
      nextcount: 5,
      boardwidth: 10,
      boardheight: 20,
      precountdown: 5000,
      countdown_count: 3,
      countdown_interval: 1000,
      garbagemultiplier: 0
    },
    ...overrides
  };
}

test("deriveVsRoundBridge identifies local player from root.user and players", () => {
  const bridge = deriveVsRoundBridge(sampleRoundRoot(), 1783780572968);

  assert.ok(bridge);
  assert.equal(bridge.bridge.local.username, "hebi_");
  assert.equal(bridge.bridge.local.gameid, 4382);
  assert.equal(bridge.bridge.roundId, "4382:2034120187");
  assert.deepEqual(bridge.bridge.opponents, [
    {
      username: "guest-e00651",
      userid: "6a5042ff2dfdb4928a8950fe",
      gameid: 4383
    }
  ]);
});

test("deriveVsRoundBridge selects local player seed and ignores room seed", () => {
  const result = deriveVsRoundBridge(sampleRoundRoot(), 1783780572968);

  assert.ok(result);
  assert.equal(result.bridge.options.seed, 2034120187);
  assert.equal(result.roomSeed, 187156);
  assert.equal("roomSeed" in result.bridge.options, false);
});

test("deriveVsRoundBridge verifies shared player seeds", () => {
  const mismatch = deriveVsRoundBridge(
    sampleRoundRoot({
      players: [
        {
          username: "hebi_",
          userid: "63b3ad2b1103e5097025feba",
          gameid: 4382,
          options: { seed: 2034120187 }
        },
        {
          username: "guest-e00651",
          userid: "6a5042ff2dfdb4928a8950fe",
          gameid: 4383,
          options: { seed: 2034120188 }
        }
      ]
    }),
    1783780572968
  );

  assert.equal(mismatch, null);
});

test("deriveVsRoundBridge computes readyAt from precountdown and countdown interval", () => {
  const capturedAt = 1783780572968;
  const result = deriveVsRoundBridge(sampleRoundRoot(), capturedAt);

  assert.ok(result);
  assert.equal(result.bridge.readyAt, capturedAt + 8000);
});

test("writeVsBridgeFile writes atomically without leaving a temp file", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    writeVsBridgeFile(filePath, {
      version: 1,
      sequence: 1,
      roundId: "4382:2034120187",
      active: true
    });

    assert.equal(existsSync(filePath), true);
    assert.equal(existsSync(`${filePath}.tmp`), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test("collectVsIncomingGarbage keeps only interaction events with ownerGameId", () => {
  const currentBridge = {
    roundId: "4382:2034120187",
    local: { gameid: 4382 }
  };
  const root = {
    gameid: 4383,
    replay: {
      events: [
        {
          type: "interaction",
          frame: 179,
          id: 2,
          data: {
            type: "garbage",
            gameid: 4382,
            frame: 214,
            amt: 2,
            size: 2,
            x: 2,
            y: { ignored: true },
            iid: 11,
            cid: "cid-1"
          }
        },
        {
          type: "interaction_confirm",
          frame: 180,
          id: 3,
          data: {
            type: "garbage",
            gameid: 4382,
            frame: 214,
            amt: 2,
            size: 2,
            x: 2,
            iid: 11,
            cid: "cid-1"
          }
        }
      ]
    },
    copies: [
      {
        replay: {
          events: [
            {
              type: "interaction",
              frame: 181,
              data: {
                type: "garbage",
                gameid: 4382,
                frame: 215,
                amt: 3,
                size: 3,
                x: 6,
                iid: 12,
                cid: "cid-2"
              }
            }
          ]
        }
      }
    ]
  };

  const events = collectVsIncomingGarbage(root, currentBridge);

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, {
    type: "garbage",
    gameid: 4382,
    frame: 214,
    amt: 2,
    size: 2,
    x: 2,
    iid: 11,
    cid: "cid-1"
  });
});

test("updateVsBridgeState stores round start and deduped interaction garbage", () => {
  const { dir, filePath } = makeTempBridgeFile();
  const logs = [];

  try {
    const state = createVsBridgeState(filePath);
    updateVsBridgeState(state, [sampleRoundRoot()], (line) => logs.push(line), 1000);
    updateVsBridgeState(
      state,
      [
        {
          gameid: 4383,
          replay: {
            events: [
              {
                type: "interaction",
                frame: 179,
                id: 2,
                data: {
                  type: "garbage",
                  gameid: 4382,
                  frame: 214,
                  amt: 2,
                  size: 2,
                  x: 2,
                  iid: 11,
                  cid: "cid-1"
                }
              },
              {
                type: "interaction",
                frame: 179,
                id: 2,
                data: {
                  type: "garbage",
                  gameid: 4382,
                  frame: 214,
                  amt: 2,
                  size: 2,
                  x: 2,
                  iid: 11,
                  cid: "cid-1"
                }
              },
              {
                type: "interaction_confirm",
                frame: 180,
                id: 3,
                data: {
                  type: "garbage",
                  gameid: 4382,
                  frame: 214,
                  amt: 2,
                  size: 2,
                  x: 2,
                  iid: 11,
                  cid: "cid-1"
                }
              }
            ]
          }
        }
      ],
      (line) => logs.push(line),
      2000
    );

    const bridge = readJson(filePath);
    assert.equal(bridge.roundId, "4382:2034120187");
    assert.equal(bridge.sequence, 2);
    assert.equal(bridge.options.seed, 2034120187);
    assert.equal(bridge.incomingGarbage.length, 1);
    assert.equal(bridge.incomingGarbage[0].eventType, "interaction");
    assert.ok(logs.includes("[vs-sim] shared round seed verified"));
    assert.ok(
      logs.includes("[vs-sim] garbage application disabled in validation phase")
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("markVsBridgeInactive writes an inactive bridge snapshot", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath);
    updateVsBridgeState(state, [sampleRoundRoot()], () => {}, 1000);
    markVsBridgeInactive(state, () => {});

    const bridge = readJson(filePath);
    assert.equal(bridge.active, false);
    assert.equal(bridge.roundId, "4382:2034120187");
  } finally {
    cleanupTempDir(dir);
  }
});
