import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_BRIDGE_PATH,
  collectVsIncomingGarbage,
  createVsBridgeState,
  deriveVsRoundBridge,
  ingestVsBridgeRoot,
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

function packetA(overrides = {}) {
  return {
    players: [
      {
        userid: "local-id",
        gameid: 5449,
        options: {
          gameid: 5449,
          seed: 1744077373,
          bagtype: "7-bag",
          nextcount: 5,
          boardwidth: 10,
          boardheight: 20
        }
      },
      {
        userid: "guest-id",
        gameid: 5450,
        options: {
          gameid: 5450,
          seed: 1744077373,
          bagtype: "7-bag",
          nextcount: 5,
          boardwidth: 10,
          boardheight: 20
        }
      }
    ],
    ...overrides
  };
}

function packetB(overrides = {}) {
  return {
    players: [
      {
        _id: "local-id",
        username: "hebi_"
      },
      {
        _id: "guest-id",
        username: "guest-e00651"
      }
    ],
    ...overrides
  };
}

function packetC(overrides = {}) {
  return {
    user: {
      _id: "local-id",
      username: "hebi_"
    },
    ...overrides
  };
}

function packetRoomOptions(overrides = {}) {
  return {
    options: {
      seed: 187156,
      precountdown: 5000,
      countdown_count: 3,
      countdown_interval: 1000,
      garbagemultiplier: 0
    },
    ...overrides
  };
}

function combinedRoundRoot(overrides = {}) {
  return {
    user: {
      _id: "local-id",
      username: "hebi_"
    },
    players: [
      {
        userid: "local-id",
        _id: "local-id",
        username: "hebi_",
        gameid: 5449,
        options: {
          gameid: 5449,
          seed: 1744077373,
          bagtype: "7-bag",
          nextcount: 5,
          boardwidth: 10,
          boardheight: 20
        }
      },
      {
        userid: "guest-id",
        _id: "guest-id",
        username: "guest-e00651",
        gameid: 5450,
        options: {
          gameid: 5450,
          seed: 1744077373,
          bagtype: "7-bag",
          nextcount: 5,
          boardwidth: 10,
          boardheight: 20
        }
      }
    ],
    options: {
      seed: 187156,
      precountdown: 5000,
      countdown_count: 3,
      countdown_interval: 1000,
      garbagemultiplier: 0
    },
    ...overrides
  };
}

test("createVsBridgeState logs its enabled absolute bridge path", () => {
  const logs = [];
  const state = createVsBridgeState(DEFAULT_BRIDGE_PATH, (line) => logs.push(line));

  assert.ok(path.isAbsolute(state.bridgeFilePath));
  assert.match(
    state.bridgeFilePath.replace(/\\/g, "/"),
    /\/cold-clear\/automation\/vs-ws-bridge\.json$/
  );
  assert.ok(
    logs.includes(
      `[vs-bridge] enabled path=${state.bridgeFilePath.replace(/\\/g, "/")}`
    )
  );
});

test("deriveVsRoundBridge identifies local player and ignores room seed for round seed", () => {
  const bridge = deriveVsRoundBridge(combinedRoundRoot(), 1783780572968);

  assert.ok(bridge);
  assert.equal(bridge.bridge.local.username, "hebi_");
  assert.equal(bridge.bridge.local.userid, "local-id");
  assert.equal(bridge.bridge.local.gameid, 5449);
  assert.equal(bridge.bridge.roundId, "5449:1744077373");
  assert.equal(bridge.bridge.options.seed, 1744077373);
  assert.equal(bridge.roomSeed, 187156);
  assert.deepEqual(bridge.bridge.opponents, [
    {
      username: "guest-e00651",
      userid: "guest-id",
      gameid: 5450
    }
  ]);
});

test("deriveVsRoundBridge computes readyAt from room countdown options", () => {
  const capturedAt = 1783780572968;
  const result = deriveVsRoundBridge(combinedRoundRoot(), capturedAt);

  assert.ok(result);
  assert.equal(result.bridge.readyAt, capturedAt + 3000);
  assert.equal(result.bridge.readyOffsetMs, 3000);
  assert.equal(result.bridge.readyOffsetSource, "countdown");
});

test("deriveVsRoundBridge falls back to precountdown when countdown metadata is invalid", () => {
  const capturedAt = 1783780572968;
  const result = deriveVsRoundBridge(
    combinedRoundRoot({
      options: {
        seed: 187156,
        precountdown: 5000,
        countdown_count: 0,
        countdown_interval: "bad"
      }
    }),
    capturedAt
  );

  assert.ok(result);
  assert.equal(result.bridge.readyAt, capturedAt + 5000);
  assert.equal(result.bridge.readyOffsetMs, 5000);
  assert.equal(result.bridge.readyOffsetSource, "precountdown_fallback");
});

test("writeVsBridgeFile writes atomically without leaving a temp file", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    writeVsBridgeFile(filePath, {
      version: 1,
      sequence: 1,
      roundId: "5449:1744077373",
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
    roundId: "5449:1744077373",
    local: { gameid: 5449 }
  };
  const root = {
    gameid: 5450,
    replay: {
      events: [
        {
          type: "interaction",
          frame: 179,
          id: 2,
          data: {
            type: "garbage",
            gameid: 5449,
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
            gameid: 5449,
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
                gameid: 5449,
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
    gameid: 5449,
    frame: 214,
    amt: 2,
    size: 2,
    x: 2,
    iid: 11,
    cid: "cid-1"
  });
});

test("split identity packets build the same bridge in A->B->C order", () => {
  const { dir, filePath } = makeTempBridgeFile();
  const logs = [];

  try {
    const state = createVsBridgeState(filePath, (line) => logs.push(line));
    ingestVsBridgeRoot(state, packetA(), { timestamp: 1000 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 1100 });
    ingestVsBridgeRoot(state, packetC(), { timestamp: 1200 });

    const bridge = readJson(filePath);
    assert.equal(bridge.local.username, "hebi_");
    assert.equal(bridge.local.userid, "local-id");
    assert.equal(bridge.local.gameid, 5449);
    assert.equal(bridge.opponents[0].gameid, 5450);
    assert.equal(bridge.options.seed, 1744077373);
    assert.equal(bridge.roomSeed, null);
    assert.equal(bridge.readyAt, 1000);
    assert.ok(
      logs.includes(
        "[vs-bridge] local player username=hebi_ userid=local-id gameid=5449"
      )
    );
    assert.ok(logs.includes("[vs-bridge] written roundId=5449:1744077373"));
  } finally {
    cleanupTempDir(dir);
  }
});

test("split identity packets build the same bridge in C->B->A order", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    ingestVsBridgeRoot(state, packetC(), { timestamp: 1200 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 1100 });
    ingestVsBridgeRoot(state, packetA(), { timestamp: 1000 });

    const bridge = readJson(filePath);
    assert.equal(bridge.local.username, "hebi_");
    assert.equal(bridge.local.userid, "local-id");
    assert.equal(bridge.local.gameid, 5449);
    assert.equal(bridge.opponents[0].gameid, 5450);
    assert.equal(bridge.options.seed, 1744077373);
    assert.equal(bridge.readyAt, 1000);
  } finally {
    cleanupTempDir(dir);
  }
});

test("room options arriving later update readyAt without changing the round seed", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    ingestVsBridgeRoot(state, packetA(), { timestamp: 1000 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 1100 });
    ingestVsBridgeRoot(state, packetC(), { timestamp: 1200 });
    ingestVsBridgeRoot(state, packetRoomOptions(), { timestamp: 2000 });

    const bridge = readJson(filePath);
    assert.equal(bridge.options.seed, 1744077373);
    assert.equal(bridge.roomSeed, 187156);
    assert.equal(bridge.readyAt, 1000 + 3000);
  } finally {
    cleanupTempDir(dir);
  }
});

test("readyAt log prefers countdown and does not add precountdown on top", () => {
  const { dir, filePath } = makeTempBridgeFile();
  const logs = [];

  try {
    const state = createVsBridgeState(filePath, (line) => logs.push(line));
    ingestVsBridgeRoot(state, combinedRoundRoot(), { timestamp: 1000 }, (line) =>
      logs.push(line)
    );

    assert.ok(
      logs.includes("[vs-bridge] readyAt offset_ms=3000 source=countdown")
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("readyAt log falls back to precountdown when countdown metadata is missing", () => {
  const { dir, filePath } = makeTempBridgeFile();
  const logs = [];

  try {
    const state = createVsBridgeState(filePath, (line) => logs.push(line));
    ingestVsBridgeRoot(
      state,
      combinedRoundRoot({
        options: {
          seed: 187156,
          precountdown: 5000
        }
      }),
      { timestamp: 1000 },
      (line) => logs.push(line)
    );

    assert.ok(
      logs.includes(
        "[vs-bridge] readyAt offset_ms=5000 source=precountdown_fallback"
      )
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("shared player seed mismatch logs once and blocks bridge creation", () => {
  const { dir, filePath } = makeTempBridgeFile();
  const logs = [];

  try {
    const state = createVsBridgeState(filePath, (line) => logs.push(line));
    ingestVsBridgeRoot(
      state,
      packetA({
        players: [
          {
            userid: "local-id",
            gameid: 5449,
            options: {
              gameid: 5449,
              seed: 1744077373,
              bagtype: "7-bag",
              nextcount: 5,
              boardwidth: 10,
              boardheight: 20
            }
          },
          {
            userid: "guest-id",
            gameid: 5450,
            options: {
              gameid: 5450,
              seed: 1744077374,
              bagtype: "7-bag",
              nextcount: 5,
              boardwidth: 10,
              boardheight: 20
            }
          }
        ]
      }),
      { timestamp: 1000 }
    );
    ingestVsBridgeRoot(state, packetC(), { timestamp: 1001 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 1002 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 1003 });

    assert.equal(existsSync(filePath), false);
    assert.equal(
      logs.filter((line) => line === "[vs-bridge] waiting reason=round_seed_mismatch").length,
      1
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("same round packets do not rewrite the bridge unnecessarily", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    ingestVsBridgeRoot(state, packetA(), { timestamp: 1000 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 1100 });
    ingestVsBridgeRoot(state, packetC(), { timestamp: 1200 });
    const firstBridge = readJson(filePath);
    ingestVsBridgeRoot(state, packetA(), { timestamp: 4000 });
    ingestVsBridgeRoot(state, packetB(), { timestamp: 4100 });
    ingestVsBridgeRoot(state, packetC(), { timestamp: 4200 });
    const secondBridge = readJson(filePath);

    assert.equal(firstBridge.sequence, 1);
    assert.equal(secondBridge.sequence, 1);
    assert.deepEqual(secondBridge, firstBridge);
  } finally {
    cleanupTempDir(dir);
  }
});

test("updateVsBridgeState stores round start and deduped interaction garbage", () => {
  const { dir, filePath } = makeTempBridgeFile();
  const logs = [];

  try {
    const state = createVsBridgeState(filePath, (line) => logs.push(line));
    updateVsBridgeState(
      state,
      [packetA(), packetB(), packetC()],
      (line) => logs.push(line),
      1000
    );
    updateVsBridgeState(
      state,
      [
        {
          gameid: 5450,
          replay: {
            events: [
              {
                type: "interaction",
                frame: 179,
                id: 2,
                data: {
                  type: "garbage",
                  gameid: 5449,
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
                  gameid: 5449,
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
                  gameid: 5449,
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
    assert.equal(bridge.roundId, "5449:1744077373");
    assert.equal(bridge.sequence, 2);
    assert.equal(bridge.options.seed, 1744077373);
    assert.equal(bridge.incomingGarbage.length, 1);
    assert.equal(bridge.incomingGarbage[0].eventType, "interaction");
    assert.ok(
      logs.includes("[vs-bridge] garbage application disabled in validation phase")
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("markVsBridgeInactive writes an inactive bridge snapshot", () => {
  const { dir, filePath } = makeTempBridgeFile();

  try {
    const state = createVsBridgeState(filePath, () => {});
    updateVsBridgeState(state, [packetA(), packetB(), packetC()], () => {}, 1000);
    markVsBridgeInactive(state, () => {});

    const bridge = readJson(filePath);
    assert.equal(bridge.active, false);
    assert.equal(bridge.roundId, "5449:1744077373");
  } finally {
    cleanupTempDir(dir);
  }
});
