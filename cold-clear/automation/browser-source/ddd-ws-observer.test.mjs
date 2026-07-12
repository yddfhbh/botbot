import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  decodeGameOptionsCandidates,
  findGameOptions,
  installDddWsObserver,
  sanitizeGameOptions,
  split87Frame,
  tryUnpackAtOffsets
} from "./ddd-ws-observer.mjs";

function encodeLength(length) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(length, 0);
  return buf;
}

function make87Frame(chunks) {
  return Buffer.concat([
    Buffer.from([0x87, 0x00, 0x00, 0x00]),
    ...chunks.flatMap((chunk) => [encodeLength(chunk.length), chunk])
  ]);
}

class FakeCdp {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
  }

  async send(method, params = {}) {
    this.sent.push({ method, params });
    return {};
  }

  on(method, handler) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(handler);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(handler);
      if (listeners.size === 0) {
        this.listeners.delete(method);
      }
    };
  }

  emit(method, params) {
    const listeners = this.listeners.get(method);
    if (!listeners) {
      return;
    }
    for (const handler of [...listeners]) {
      handler(params);
    }
  }
}

function makeTempTraceFile(name = "ws-live-candidates.jsonl") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ddd-ws-observer-"));
  return {
    dir,
    filePath: path.join(dir, name)
  };
}

function cleanupTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, "utf8").trim();
  if (!content) {
    return [];
  }

  return content.split("\n").map((line) => JSON.parse(line));
}

function vsRoundPayload({
  localGameId = 5449,
  opponentGameId = 5450,
  seed = 1744077373
} = {}) {
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
        gameid: localGameId,
        options: {
          gameid: localGameId,
          seed,
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
        gameid: opponentGameId,
        options: {
          gameid: opponentGameId,
          seed,
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
    }
  };
}

async function withTraceEnv(value, run) {
  const previous = process.env.FUSION_DDD_WS_TRACE;
  if (value === undefined) {
    delete process.env.FUSION_DDD_WS_TRACE;
  } else {
    process.env.FUSION_DDD_WS_TRACE = value;
  }

  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.FUSION_DDD_WS_TRACE;
    } else {
      process.env.FUSION_DDD_WS_TRACE = previous;
    }
  }
}

test("general buffer returns no split87 chunks", () => {
  assert.deepEqual(split87Frame(Buffer.from("plain")), []);
});

test("split87Frame extracts one chunk", () => {
  const chunk = Buffer.from("hello");
  assert.deepEqual(split87Frame(make87Frame([chunk])), [chunk]);
});

test("split87Frame extracts multiple chunks", () => {
  const chunks = [Buffer.from("one"), Buffer.from("two")];
  assert.deepEqual(split87Frame(make87Frame(chunks)), chunks);
});

test("split87Frame rejects invalid lengths safely", () => {
  const invalid = Buffer.concat([
    Buffer.from([0x87, 0x00, 0x00, 0x00]),
    encodeLength(0x7fffffff)
  ]);
  assert.deepEqual(split87Frame(invalid), []);
});

test("tryUnpackAtOffsets decodes from offset zero", () => {
  const values = tryUnpackAtOffsets(Buffer.from("payload"), (buffer) => {
    if (buffer.toString("utf8") === "payload") {
      return { seed: 1, bagtype: "7-bag" };
    }
    throw new Error("bad");
  });
  assert.deepEqual(values, [{ seed: 1, bagtype: "7-bag" }]);
});

test("tryUnpackAtOffsets decodes after a leading byte prefix", () => {
  const values = tryUnpackAtOffsets(Buffer.from("xxpayload"), (buffer) => {
    if (buffer.toString("utf8") === "payload") {
      return { seed: 2, bagtype: "bag" };
    }
    throw new Error("bad");
  });
  assert.deepEqual(values, [{ seed: 2, bagtype: "bag" }]);
});

test("findGameOptions accepts direct seed and bagtype objects", () => {
  const result = findGameOptions({ seed: 1, bagtype: "7-bag", gameid: "abc" });
  assert.deepEqual(sanitizeGameOptions(result), {
    seed: 1,
    bagtype: "7-bag",
    gameid: "abc"
  });
});

test("findGameOptions accepts nested options objects", () => {
  const result = findGameOptions({
    gameid: "room-1",
    options: { seed: 3, bagtype: "7-bag", nextcount: 5 }
  });
  assert.deepEqual(sanitizeGameOptions(result), {
    seed: 3,
    bagtype: "7-bag",
    nextcount: 5,
    gameid: "room-1"
  });
});

test("findGameOptions accepts nested setoptions objects", () => {
  const result = findGameOptions({
    gameid: "room-2",
    setoptions: { seed: 4, bagtype: "7-bag", boardwidth: 10 }
  });
  assert.deepEqual(sanitizeGameOptions(result), {
    seed: 4,
    bagtype: "7-bag",
    boardwidth: 10,
    gameid: "room-2"
  });
});

test("findGameOptions rejects seed-only objects without bagtype", () => {
  assert.equal(findGameOptions({ seed: 5 }), null);
  assert.equal(sanitizeGameOptions({ seed: 5 }), null);
});

test("findGameOptions handles cyclic objects without infinite recursion", () => {
  const root = {};
  root.self = root;
  root.items = [root];
  assert.equal(findGameOptions(root), null);
});

test("findGameOptions skips sensitive-key subtrees", () => {
  const result = findGameOptions({
    payload: {
      token: {
        options: {
          seed: 6,
          bagtype: "7-bag"
        }
      }
    }
  });
  assert.equal(result, null);
});

test("same option signature logs only once", async () => {
  const cdp = new FakeCdp();
  const logs = [];
  await installDddWsObserver(cdp, {
    unpack: () => {
      throw new Error("unused");
    },
    log: (line) => logs.push(line)
  });

  cdp.emit("Network.webSocketCreated", {
    requestId: "req-1",
    url: "wss://spool.tetr.io/socket?token=secret"
  });
  const payload = JSON.stringify({
    gameid: "g-1",
    options: {
      seed: 7,
      bagtype: "7-bag",
      nextcount: 5,
      boardwidth: 10,
      boardheight: 40
    }
  });

  cdp.emit("Network.webSocketFrameReceived", {
    requestId: "req-1",
    response: {
      opcode: 1,
      payloadData: payload
    }
  });
  cdp.emit("Network.webSocketFrameReceived", {
    requestId: "req-1",
    response: {
      opcode: 1,
      payloadData: payload
    }
  });

  assert.equal(
    logs.filter((line) => line === "[ws-observer] game options captured").length,
    1
  );
  assert.ok(logs.includes("[ws-observer] url_host=spool.tetr.io"));
});

test("observer does not modify unrelated network objects", async () => {
  const cdp = new FakeCdp();
  const network = {
    seed: null,
    nextCount: 6,
    readyAt: 0,
    ribbonSeen: false,
    lastPageProbeAt: 0
  };

  await installDddWsObserver(cdp, {
    unpack: () => {
      throw new Error("unused");
    },
    log: () => {}
  });

  cdp.emit("Network.webSocketFrameReceived", {
    requestId: "req-2",
    response: {
      opcode: 1,
      payloadData: JSON.stringify({
        options: { seed: 8, bagtype: "7-bag", nextcount: 5 }
      })
    }
  });

  assert.deepEqual(network, {
    seed: null,
    nextCount: 6,
    readyAt: 0,
    ribbonSeen: false,
    lastPageProbeAt: 0
  });
});

test("observer frame handlers swallow internal errors", async () => {
  const cdp = new FakeCdp();
  await installDddWsObserver(cdp, {
    unpack: () => {
      throw new Error("unused");
    },
    log: () => {
      throw new Error("log failure");
    }
  });

  assert.doesNotThrow(() => {
    cdp.emit("Network.webSocketCreated", {
      requestId: "req-3",
      url: "wss://spool.tetr.io/socket"
    });
    cdp.emit("Network.webSocketFrameReceived", {
      requestId: "req-3",
      response: {
        opcode: 1,
        payloadData: JSON.stringify({
          options: { seed: 9, bagtype: "7-bag" }
        })
      }
    });
  });
});

test("observer stays inactive when msgpack unpack is unavailable", async () => {
  const cdp = new FakeCdp();
  const logs = [];
  const cleanup = await installDddWsObserver(cdp, {
    unpack: null,
    log: (line) => logs.push(line)
  });

  assert.deepEqual(logs, ["[ws-observer] msgpackr unavailable; observer inactive"]);
  assert.equal(cdp.sent.length, 0);
  assert.equal(cdp.listeners.size, 0);
  cleanup();
});

test("VS sim OFF leaves bridge logging and files untouched", async () => {
  const cdp = new FakeCdp();
  const logs = [];
  const { dir, filePath } = makeTempTraceFile("vs-ws-bridge.json");

  try {
    const cleanup = await installDddWsObserver(cdp, {
      unpack: (buffer) => JSON.parse(buffer.toString("utf8")),
      log: (line) => logs.push(line),
      vsSimEnabled: false,
      vsBridgePath: filePath
    });

    cdp.emit("Network.webSocketFrameReceived", {
      requestId: "req-1",
      response: {
        opcode: 1,
        payloadData: JSON.stringify({
          user: { _id: "local-id", username: "hebi_" },
          players: [
            {
              userid: "local-id",
              gameid: 5449,
              options: {
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
                seed: 1744077373,
                bagtype: "7-bag",
                nextcount: 5,
                boardwidth: 10,
                boardheight: 20
              }
            }
          ]
        })
      }
    });

    cleanup();

    assert.equal(existsSync(filePath), false);
    assert.equal(logs.some((line) => line.startsWith("[vs-bridge]")), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test("VS bridge initialization failure does not stop the observer", async () => {
  const cdp = new FakeCdp();
  const logs = [];

  const cleanup = await installDddWsObserver(cdp, {
    unpack: () => ({ seed: 1, bagtype: "7-bag" }),
    log: (line) => logs.push(line),
    vsSimEnabled: true,
    vsBridgePath: Symbol("bad-path")
  });

  assert.equal(typeof cleanup, "function");
  assert.ok(
    logs.some((line) => line.startsWith("[vs-bridge] initialization failed:"))
  );
});

test("observer callback fires only when active state or roundId changes", async () => {
  const cdp = new FakeCdp();
  const statuses = [];
  const cleanup = await installDddWsObserver(cdp, {
    unpack: () => {
      throw new Error("unused");
    },
    log: () => {},
    vsSimEnabled: true,
    onVsRoundStatus: (status) => statuses.push(status)
  });

  cdp.emit("Network.webSocketCreated", {
    requestId: "req-vs-1",
    url: "wss://spool.tetr.io/socket"
  });
  cdp.emit("Network.webSocketFrameReceived", {
    requestId: "req-vs-1",
    response: {
      opcode: 1,
      payloadData: JSON.stringify(vsRoundPayload())
    }
  });
  cdp.emit("Network.webSocketFrameReceived", {
    requestId: "req-vs-1",
    response: {
      opcode: 1,
      payloadData: JSON.stringify(vsRoundPayload())
    }
  });
  cdp.emit("Network.webSocketFrameReceived", {
    requestId: "req-vs-1",
    response: {
      opcode: 1,
      payloadData: JSON.stringify(vsRoundPayload({ localGameId: 5451, seed: 1744077374 }))
    }
  });
  cdp.emit("Network.webSocketClosed", { requestId: "req-vs-1" });
  cleanup();

  assert.deepEqual(statuses, [
    {
      active: true,
      roundId: "5449:1744077373",
      localGameId: "5449",
      localUserId: "local-id",
      localUsername: "hebi_",
      seed: "1744077373"
    },
    {
      active: true,
      roundId: "5451:1744077374",
      localGameId: "5451",
      localUserId: "local-id",
      localUsername: "hebi_",
      seed: "1744077374"
    },
    {
      active: false,
      roundId: "",
      localGameId: "",
      localUserId: "",
      localUsername: "",
      seed: ""
    }
  ]);
});

test("observer callback enables VS bridge identity tracking even without VS sim env", async () => {
  const cdp = new FakeCdp();
  const statuses = [];
  const cleanup = await installDddWsObserver(cdp, {
    unpack: () => {
      throw new Error("unused");
    },
    log: () => {},
    vsSimEnabled: false,
    onVsRoundStatus: (status) => statuses.push(status)
  });

  cdp.emit("Network.webSocketFrameReceived", {
    requestId: "req-vs-bridge-only",
    response: {
      opcode: 1,
      payloadData: JSON.stringify(vsRoundPayload())
    }
  });
  cleanup();

  assert.equal(statuses[0]?.active, true);
  assert.equal(statuses[0]?.localGameId, "5449");
  assert.equal(statuses[0]?.localUserId, "local-id");
});

test("observer callback errors do not stop frame handling", async () => {
  const cdp = new FakeCdp();
  const logs = [];
  const cleanup = await installDddWsObserver(cdp, {
    unpack: () => {
      throw new Error("unused");
    },
    log: (line) => logs.push(line),
    vsSimEnabled: true,
    onVsRoundStatus: () => {
      throw new Error("status callback failure");
    }
  });

  assert.doesNotThrow(() => {
    cdp.emit("Network.webSocketFrameReceived", {
      requestId: "req-vs-throw",
      response: {
        opcode: 1,
        payloadData: JSON.stringify(vsRoundPayload())
      }
    });
  });

  cleanup();
  assert.ok(logs.some((line) => line.startsWith("[vs-bridge] written roundId=")));
});

test("trace file is not created when trace env is absent", async () => {
  const cdp = new FakeCdp();
  const { dir, filePath } = makeTempTraceFile();

  try {
    await withTraceEnv(undefined, async () => {
      const cleanup = await installDddWsObserver(cdp, {
        unpack: () => {
          throw new Error("unused");
        },
        log: () => {},
        traceFilePath: filePath
      });

      cdp.emit("Network.webSocketFrameReceived", {
        response: {
          opcode: 1,
          payloadData: JSON.stringify({
            username: "HEBI_",
            options: { seed: 11, bagtype: "7-bag", gameid: "2718" }
          })
        }
      });

      cleanup();
    });

    assert.equal(existsSync(filePath), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test("trace=1 starts JSONL recording and keeps options capture logs unchanged", async () => {
  const cdp = new FakeCdp();
  const logs = [];
  const { dir, filePath } = makeTempTraceFile();

  try {
    await withTraceEnv("1", async () => {
      const cleanup = await installDddWsObserver(cdp, {
        unpack: () => {
          throw new Error("unused");
        },
        log: (line) => logs.push(line),
        traceFilePath: filePath
      });

      cdp.emit("Network.webSocketCreated", {
        requestId: "req-trace-1",
        url: "wss://spool.tetr.io/socket?token=secret"
      });
      cdp.emit("Network.webSocketFrameReceived", {
        requestId: "req-trace-1",
        response: {
          opcode: 1,
          payloadData: JSON.stringify({
            username: "HEBI_",
            options: { seed: 12, bagtype: "7-bag", nextcount: 5, gameid: "2718" }
          })
        }
      });

      cleanup();
    });

    assert.equal(existsSync(filePath), true);
    assert.ok(
      logs.some((line) => line === "[ws-observer] game options captured")
    );
    assert.ok(
      logs.some((line) => line.startsWith("[ws-trace] recording "))
    );
    assert.ok(
      logs.some((line) => line.startsWith("[ws-trace] records="))
    );
    assert.equal(readJsonLines(filePath).length > 0, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test("trace records options path and parent context", async () => {
  const cdp = new FakeCdp();
  const { dir, filePath } = makeTempTraceFile();

  try {
    const cleanup = await installDddWsObserver(cdp, {
      unpack: () => {
        throw new Error("unused");
      },
      log: () => {},
      traceEnabled: true,
      traceFilePath: filePath
    });

    cdp.emit("Network.webSocketFrameReceived", {
      requestId: "req-path",
      response: {
        opcode: 1,
        payloadData: JSON.stringify({
          data: {
            players: [
              {
                username: "HEBI_",
                userid: "user-1",
                local: true,
                options: {
                  seed: "171149873",
                  bagtype: "7-bag",
                  gameid: "2718"
                }
              }
            ]
          }
        })
      }
    });

    cleanup();

    const optionsRecord = readJsonLines(filePath).find(
      (entry) => entry.kind === "options"
    );
    assert.ok(optionsRecord);
    assert.equal(optionsRecord.path, "root.data.players[0].options");
    assert.deepEqual(optionsRecord.context, {
      username: "HEBI_",
      userid: "user-1",
      gameid: "2718",
      local: true
    });
  } finally {
    cleanupTempDir(dir);
  }
});

test("trace stores board candidates as summary only", async () => {
  const cdp = new FakeCdp();
  const { dir, filePath } = makeTempTraceFile();
  const board = Array.from({ length: 20 }, (_, row) =>
    Array.from({ length: 10 }, (_, col) => (row === 19 && col < 4 ? 1 : 0))
  );

  try {
    const cleanup = await installDddWsObserver(cdp, {
      unpack: () => {
        throw new Error("unused");
      },
      log: () => {},
      traceEnabled: true,
      traceFilePath: filePath
    });

    cdp.emit("Network.webSocketFrameReceived", {
      response: {
        opcode: 1,
        payloadData: JSON.stringify({ board })
      }
    });

    cleanup();

    const boardRecord = readJsonLines(filePath).find(
      (entry) => entry.kind === "board"
    );
    assert.ok(boardRecord);
    assert.deepEqual(boardRecord.summary, {
      boardRows: 20,
      boardWidth: 10,
      filledCells: 4
    });
    assert.equal("board" in boardRecord, false);
    assert.equal("field" in boardRecord, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test("trace limits queue samples to 12 items", async () => {
  const cdp = new FakeCdp();
  const { dir, filePath } = makeTempTraceFile();
  const queue = Array.from({ length: 20 }, (_, index) => `P${index}`);

  try {
    const cleanup = await installDddWsObserver(cdp, {
      unpack: () => {
        throw new Error("unused");
      },
      log: () => {},
      traceEnabled: true,
      traceFilePath: filePath
    });

    cdp.emit("Network.webSocketFrameReceived", {
      response: {
        opcode: 1,
        payloadData: JSON.stringify({
          current: "T",
          hold: "I",
          queue
        })
      }
    });

    cleanup();

    const pieceRecord = readJsonLines(filePath).find(
      (entry) => entry.kind === "piece"
    );
    assert.ok(pieceRecord);
    assert.equal(pieceRecord.summary.queueLength, 20);
    assert.equal(pieceRecord.summary.queueSample.length, 12);
    assert.deepEqual(pieceRecord.summary.queueSample, queue.slice(0, 12));
  } finally {
    cleanupTempDir(dir);
  }
});

test("trace stores at most three replay event samples", async () => {
  const cdp = new FakeCdp();
  const { dir, filePath } = makeTempTraceFile();

  try {
    const cleanup = await installDddWsObserver(cdp, {
      unpack: () => {
        throw new Error("unused");
      },
      log: () => {},
      traceEnabled: true,
      traceFilePath: filePath
    });

    cdp.emit("Network.webSocketFrameReceived", {
      response: {
        opcode: 1,
        payloadData: JSON.stringify({
          replay: {
            events: [
              { frame: 14, type: "keydown", data: { key: "Left" } },
              { frame: 15, type: "rotate", data: { key: "CW" } },
              { frame: 16, type: "drop", data: { key: "HD" } },
              { frame: 17, type: "spawn", data: { key: "T" } }
            ]
          }
        })
      }
    });

    cleanup();

    const replayRecord = readJsonLines(filePath).find(
      (entry) => entry.kind === "replay"
    );
    assert.ok(replayRecord);
    assert.equal(replayRecord.summary.eventCount, 4);
    assert.equal(replayRecord.summary.eventSamples.length, 3);
    assert.deepEqual(replayRecord.summary.eventSamples[0], {
      keys: ["data", "frame", "type"],
      frame: 14,
      type: "keydown",
      dataKeys: ["key"]
    });
  } finally {
    cleanupTempDir(dir);
  }
});

test("trace records garbage interaction scalar values and keeps confirm separate", async () => {
  const cdp = new FakeCdp();
  const { dir, filePath } = makeTempTraceFile();
  const interactionData = {
    type: "garbage",
    gameid: 3839,
    frame: 214,
    amt: 4,
    size: 4,
    x: 6,
    y: { blocked: true },
    zthalt: ["skip-me"],
    iid: 91,
    ackiid: 92,
    cid: "garbage-1"
  };

  try {
    const cleanup = await installDddWsObserver(cdp, {
      unpack: () => {
        throw new Error("unused");
      },
      log: () => {},
      traceEnabled: true,
      traceFilePath: filePath
    });

    cdp.emit("Network.webSocketFrameReceived", {
      response: {
        opcode: 1,
        payloadData: JSON.stringify({
          gameid: 3840,
          replay: {
            events: [
              { type: "interaction", frame: 179, id: 2, data: interactionData },
              { type: "interaction", frame: 179, id: 2, data: interactionData },
              {
                type: "interaction_confirm",
                frame: 180,
                id: 3,
                data: interactionData
              }
            ]
          }
        })
      }
    });

    cleanup();

    const interactions = readJsonLines(filePath).filter(
      (entry) => entry.kind === "garbage_interaction"
    );
    assert.equal(interactions.length, 2);

    const direct = interactions.find(
      (entry) => entry.eventType === "interaction"
    );
    const confirm = interactions.find(
      (entry) => entry.eventType === "interaction_confirm"
    );
    assert.ok(direct);
    assert.ok(confirm);
    assert.deepEqual(direct.data, {
      type: "garbage",
      gameid: 3839,
      frame: 214,
      amt: 4,
      size: 4,
      x: 6,
      iid: 91,
      ackiid: 92,
      cid: "garbage-1"
    });
    assert.equal(direct.eventFrame, 179);
    assert.equal(direct.eventId, 2);
    assert.equal(direct.ownerGameId, 3840);
    assert.equal("y" in direct.data, false);
    assert.equal("zthalt" in direct.data, false);
    assert.equal(confirm.eventFrame, 180);
    assert.equal(confirm.ownerGameId, 3840);
  } finally {
    cleanupTempDir(dir);
  }
});

test("trace records round_start players and keeps room seed separate", async () => {
  const cdp = new FakeCdp();
  const { dir, filePath } = makeTempTraceFile();

  try {
    const cleanup = await installDddWsObserver(cdp, {
      unpack: () => {
        throw new Error("unused");
      },
      log: () => {},
      traceEnabled: true,
      traceFilePath: filePath
    });

    cdp.emit("Network.webSocketFrameReceived", {
      response: {
        opcode: 1,
        payloadData: JSON.stringify({
          players: [
            {
              username: "hebi_",
              userid: "user-a",
              gameid: 3839,
              seed: 484243732
            },
            {
              username: "guest-e00651",
              userid: "user-b",
              gameid: 3840,
              seed: 484243732
            }
          ],
          options: {
            seed: 187156,
            bagtype: "7-bag"
          }
        })
      }
    });

    cleanup();

    const roundStart = readJsonLines(filePath).find(
      (entry) => entry.kind === "round_start"
    );
    assert.ok(roundStart);
    assert.equal(roundStart.roomSeed, 187156);
    assert.deepEqual(roundStart.players, [
      {
        username: "hebi_",
        userid: "user-a",
        gameid: 3839,
        seed: 484243732
      },
      {
        username: "guest-e00651",
        userid: "user-b",
        gameid: 3840,
        seed: 484243732
      }
    ]);
    assert.equal("seed" in roundStart, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test("trace redacts sensitive subtrees and never records raw payload data", async () => {
  const cdp = new FakeCdp();
  const { dir, filePath } = makeTempTraceFile();
  const secretPayload = JSON.stringify({
    username: "visible-user",
    token: {
      options: {
        seed: "should-not-leak",
        bagtype: "7-bag"
      }
    },
    signature: "sig-secret",
    replay: {
      events: [
        {
          frame: 1,
          type: "keydown",
          data: {
            key: "Left",
            authorization: "auth-secret"
          }
        }
      ]
    }
  });

  try {
    const cleanup = await installDddWsObserver(cdp, {
      unpack: () => {
        throw new Error("unused");
      },
      log: () => {},
      traceEnabled: true,
      traceFilePath: filePath
    });

    cdp.emit("Network.webSocketFrameReceived", {
      requestId: "req-sensitive",
      response: {
        opcode: 1,
        payloadData: secretPayload
      }
    });

    cleanup();

    const recorded = readFileSync(filePath, "utf8");
    assert.doesNotMatch(recorded, /should-not-leak/);
    assert.doesNotMatch(recorded, /sig-secret/);
    assert.doesNotMatch(recorded, /auth-secret/);
    assert.doesNotMatch(recorded, /payloadData/);
    assert.doesNotMatch(recorded, /"token"/);
    assert.doesNotMatch(recorded, /"signature"/);
  } finally {
    cleanupTempDir(dir);
  }
});

test("trace caps duplicate signatures at three records", async () => {
  const cdp = new FakeCdp();
  const { dir, filePath } = makeTempTraceFile();
  const payload = JSON.stringify({
    username: "HEBI_",
    index: 0
  });

  try {
    const cleanup = await installDddWsObserver(cdp, {
      unpack: () => {
        throw new Error("unused");
      },
      log: () => {},
      traceEnabled: true,
      traceFilePath: filePath
    });

    for (let index = 0; index < 5; index += 1) {
      cdp.emit("Network.webSocketFrameReceived", {
        response: {
          opcode: 1,
          payloadData: payload
        }
      });
    }

    cleanup();

    assert.equal(readJsonLines(filePath).length, 3);
  } finally {
    cleanupTempDir(dir);
  }
});

test("trace stops after 500 records without exceeding the file limit", async () => {
  const cdp = new FakeCdp();
  const logs = [];
  const { dir, filePath } = makeTempTraceFile();
  const payload = JSON.stringify({
    items: Array.from({ length: 700 }, (_, index) => ({
      username: `user-${index}`,
      index
    }))
  });

  try {
    const cleanup = await installDddWsObserver(cdp, {
      unpack: () => {
        throw new Error("unused");
      },
      log: (line) => logs.push(line),
      traceEnabled: true,
      traceFilePath: filePath
    });

    cdp.emit("Network.webSocketFrameReceived", {
      response: {
        opcode: 1,
        payloadData: payload
      }
    });

    cleanup();

    const records = readJsonLines(filePath);
    assert.equal(records.length, 500);
    assert.equal(
      logs.filter((line) => line === "[ws-trace] limit reached; recording stopped")
        .length,
      1
    );
    assert.ok(statSync(filePath).size <= 5 * 1024 * 1024);
  } finally {
    cleanupTempDir(dir);
  }
});

test("trace initialization errors do not stop the observer", async () => {
  const cdp = new FakeCdp();
  const logs = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), "ddd-ws-observer-bad-"));

  try {
    const cleanup = await installDddWsObserver(cdp, {
      unpack: () => {
        throw new Error("unused");
      },
      log: (line) => logs.push(line),
      traceEnabled: true,
      traceFilePath: dir
    });

    assert.doesNotThrow(() => {
      cdp.emit("Network.webSocketFrameReceived", {
        response: {
          opcode: 1,
          payloadData: JSON.stringify({
            options: { seed: 13, bagtype: "7-bag", gameid: "g-13" }
          })
        }
      });
    });

    cleanup();

    assert.ok(
      logs.some((line) =>
        line.startsWith("[ws-trace] disabled after initialization error: ")
      )
    );
    assert.ok(logs.includes("[ws-observer] game options captured"));
  } finally {
    cleanupTempDir(dir);
  }
});

test("DDD WebSocket observer is installed by default", () => {
  const source = readFileSync(
    new URL("./tetrio-cdp-source.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /await import\("\.\/ddd-ws-observer\.mjs"\)/);
  assert.match(source, /installDddWsObserver\(cdp,\s*\{/);
  assert.match(source, /unpack:\s*msgpack\?\.unpack\s*\?\?\s*null/);
  assert.match(source, /log:\s*message\s*=>\s*console\.log\(message\)/);
  assert.match(source, /\[ws-observer\] installed/);
  assert.doesNotMatch(source, /FUSION_DDD_WS_OBSERVER/);
  assert.doesNotMatch(source, /dddWsObserverEnabled/);

  const pageEnableIndex = source.indexOf('cdp.send("Page.enable")');
  const runtimeEnableIndex = source.indexOf('cdp.send("Runtime.enable")');
  const readyIndex = source.indexOf("process.stdout.write(");
  const observerIndex = source.indexOf('await import("./ddd-ws-observer.mjs")');
  const bringToFrontIndex = source.indexOf('cdp.send("Page.bringToFront")');

  assert.ok(pageEnableIndex >= 0);
  assert.ok(runtimeEnableIndex > pageEnableIndex);
  assert.ok(readyIndex > runtimeEnableIndex);
  assert.ok(observerIndex > readyIndex);
  assert.ok(bringToFrontIndex > observerIndex);
});

test("DDD WebSocket observer cleanup runs before cdp close", () => {
  const source = readFileSync(
    new URL("./tetrio-cdp-source.mjs", import.meta.url),
    "utf8"
  );

  const cleanupCallIndex = source.indexOf("dddWsObserverCleanup();");
  const cleanupGuardIndex = source.indexOf(
    'if (typeof dddWsObserverCleanup === "function")'
  );
  const closeIndex = source.indexOf("await cdp.close()");

  assert.ok(cleanupGuardIndex >= 0);
  assert.ok(cleanupCallIndex > cleanupGuardIndex);
  assert.ok(closeIndex > cleanupCallIndex);
});

test("decodeGameOptionsCandidates inspects split87 chunks and raw payload", () => {
  const prefixed = Buffer.from("xxpayload");
  const chunked = make87Frame([prefixed]);
  const unpack = (buffer) => {
    if (buffer.toString("utf8") === "payload") {
      return {
        gameid: "g-2",
        options: {
          seed: 10,
          bagtype: "7-bag",
          nextcount: 5
        }
      };
    }
    throw new Error("bad");
  };

  const decoded = decodeGameOptionsCandidates(chunked, unpack);
  assert.equal(decoded.length, 2);
  assert.deepEqual(decoded[0], {
    seed: 10,
    bagtype: "7-bag",
    nextcount: 5,
    gameid: "g-2"
  });
  assert.deepEqual(decoded[1], decoded[0]);
});
