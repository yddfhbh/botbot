import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
