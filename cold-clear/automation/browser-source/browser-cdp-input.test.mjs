import test from "node:test";
import assert from "node:assert/strict";

import { handleMessage, normalizeSequenceActions } from "./browser-cdp-input.mjs";

function createFakeCdp({ failDispatch } = {}) {
  const events = [];
  return {
    events,
    async send(method, params = {}) {
      if (method === "Input.dispatchKeyEvent") {
        if (failDispatch) {
          await failDispatch({ method, params, events });
        }
        events.push({
          type: params.type,
          code: params.code,
          key: params.key
        });
      }
      return {};
    },
    isOpen() {
      return true;
    },
    close() {
      return Promise.resolve();
    }
  };
}

function createContext(cdp, pressedKeys = new Set()) {
  const responses = [];
  return {
    cdp,
    pressedKeys,
    responses,
    context: {
      cdp,
      port: 9222,
      url: "https://tetr.io/",
      targetHint: "TETR.IO",
      pressedKeys,
      writeResponse(payload) {
        responses.push(payload);
      }
    }
  };
}

test("sequence preserves action order and responds once", async () => {
  const cdp = createFakeCdp();
  const { context, responses } = createContext(cdp);

  await handleMessage(
    {
      id: 1,
      type: "sequence",
      actions: [
        { key: "moveLeft", durationMs: 10 },
        { key: "rotateCW", durationMs: 10 },
        { key: "hardDrop", durationMs: 8 }
      ]
    },
    context
  );

  assert.deepEqual(
    cdp.events.map((event) => `${event.type}:${event.code}`),
    [
      "keyDown:ArrowLeft",
      "keyUp:ArrowLeft",
      "keyDown:KeyX",
      "keyUp:KeyX",
      "keyDown:Space",
      "keyUp:Space"
    ]
  );
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0], {
    ok: true,
    id: 1,
    type: "sequence",
    actionCount: 3
  });
});

test("releaseAll only sends keyUp for tracked keys", async () => {
  const cdp = createFakeCdp();
  const pressedKeys = new Set(["KeyC", "Space"]);
  const { context, responses } = createContext(cdp, pressedKeys);

  await handleMessage({ id: 2, type: "releaseAll" }, context);

  assert.deepEqual(
    cdp.events.map((event) => `${event.type}:${event.code}`),
    ["keyUp:KeyC", "keyUp:Space"]
  );
  assert.equal(pressedKeys.size, 0);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].type, "releaseAll");
});

test("input errors release tracked keys before returning one error response", async () => {
  let failed = false;
  const cdp = createFakeCdp({
    async failDispatch({ params }) {
      if (!failed && params.type === "keyUp" && params.code === "KeyC") {
        failed = true;
        throw new Error("simulated keyUp failure");
      }
    }
  });
  const pressedKeys = new Set();
  const { context, responses } = createContext(cdp, pressedKeys);

  await handleMessage(
    {
      id: 3,
      type: "sequence",
      actions: [{ key: "hold", durationMs: 10 }]
    },
    context
  );

  assert.deepEqual(
    cdp.events.map((event) => `${event.type}:${event.code}`),
    ["keyDown:KeyC", "keyUp:KeyC"]
  );
  assert.equal(pressedKeys.size, 0);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].error, /simulated keyUp failure/);
});

test("sequence normalization preserves the original action order", () => {
  const actions = normalizeSequenceActions([
    { key: "hold", durationMs: 10, afterMs: 4 },
    { key: "moveLeft", durationMs: 10, afterMs: 3 },
    { key: "hardDrop", durationMs: 8 }
  ]);

  assert.deepEqual(
    actions.map((action) => [action.key, action.durationMs, action.afterMs]),
    [
      ["hold", 10, 4],
      ["moveLeft", 10, 3],
      ["hardDrop", 8, 0]
    ]
  );
});
