import assert from "node:assert/strict";
import test from "node:test";

import { pack, unpack } from "msgpackr";

import { getCurrentAndNext } from "./tetrio-queue.mjs";
import { findGameOptions, inspectPayloadForGameOptions, redactObject, split87Frame, tryUnpackAtOffsets } from "./tetrio-ws-seed.mjs";

test("split87Frame returns embedded payload chunks", () => {
  const first = Buffer.from([1, 2, 3]);
  const second = Buffer.from([4, 5]);
  const frame = Buffer.concat([
    Buffer.from([0x87, 0x00, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, first.length]),
    first,
    Buffer.from([0x00, 0x00, 0x00, second.length]),
    second
  ]);

  const chunks = split87Frame(frame);
  assert.deepEqual(chunks.map((chunk) => [...chunk]), [[1, 2, 3], [4, 5]]);
});

test("tryUnpackAtOffsets finds msgpack payload behind a prefix", () => {
  const encoded = pack({ seed: 12345, bagtype: "7-bag" });
  const payload = Buffer.concat([Buffer.from([0xde, 0xad]), Buffer.from(encoded)]);

  const decoded = tryUnpackAtOffsets(payload, unpack, 4);
  assert.ok(decoded.some((entry) => entry.offset === 2 && entry.decoded.seed === 12345));
});

test("findGameOptions prefers nested options objects with game metadata", () => {
  const decoded = {
    outer: {
      seed: "wrong",
      bagtype: "7-bag"
    },
    event: {
      game: {
        setoptions: {
          seed: "24680",
          bagtype: "7-bag",
          nextcount: 6,
          boardwidth: 10,
          boardheight: 20
        }
      }
    }
  };

  const match = findGameOptions(decoded);
  assert.equal(match?.path, "event.game.setoptions");
  assert.equal(match?.options.seed, "24680");
});

test("redaction removes sensitive auth-style keys recursively", () => {
  const redacted = redactObject({
    token: "abc",
    nested: {
      jwt: "secret",
      sessionId: "hidden",
      keep: "visible"
    }
  });

  assert.equal(redacted.token, "<redacted>");
  assert.equal(redacted.nested.jwt, "<redacted>");
  assert.equal(redacted.nested.sessionId, "<redacted>");
  assert.equal(redacted.nested.keep, "visible");
});

test("inspectPayloadForGameOptions finds options in a split 0x87 frame", () => {
  const encoded = Buffer.from(
    pack({
      route: {
        options: {
          seed: 13579,
          bagtype: "7-bag",
          nextcount: 6,
          boardwidth: 10,
          boardheight: 20
        }
      }
    })
  );
  const chunk = Buffer.concat([Buffer.from([0x00, 0x01]), encoded]);
  const frame = Buffer.concat([
    Buffer.from([0x87, 0x00, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, chunk.length]),
    chunk
  ]);

  const capture = inspectPayloadForGameOptions(frame, unpack);
  assert.equal(capture?.seed, "13579");
  assert.equal(capture?.bagtype, "7-bag");
  assert.equal(capture?.offset, 2);
  assert.equal(capture?.frame, "0x87");
});

test("getCurrentAndNext is deterministic for TETR.IO 7-bag seed reproduction", () => {
  const currentAndNext = getCurrentAndNext(1, 0, 6);

  assert.equal(currentAndNext.current, "O");
  assert.deepEqual(currentAndNext.queue, ["J", "I", "L", "S", "T", "Z"]);
});
