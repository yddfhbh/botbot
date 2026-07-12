import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleMessage, normalizeSequenceActions } from "./browser-cdp-input.mjs";

function createFakeCdp({ failDispatch, focusResult } = {}) {
  const events = [];
  return {
    events,
    async send(method, params = {}) {
      if (method === "Page.bringToFront") {
        events.push({ method });
        return {};
      }
      if (method === "Runtime.evaluate") {
        events.push({ method });
        return {
          result: {
            value: focusResult ?? {
              visibilityState: "visible",
              activeTag: "BODY",
              contentEditable: false
            }
          }
        };
      }
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
      focusLogState: { lastKey: "" },
      writeResponse(payload) {
        responses.push(payload);
      }
    }
  };
}

function keyEventCodes(events) {
  return events
    .filter((event) => event.type === "keyDown" || event.type === "keyUp")
    .map((event) => `${event.type}:${event.code}`);
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
    keyEventCodes(cdp.events),
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
  assert.equal(cdp.events[0].method, "Page.bringToFront");
  assert.equal(cdp.events[1].method, "Runtime.evaluate");
});

test("releaseAll only sends keyUp for tracked keys", async () => {
  const cdp = createFakeCdp();
  const pressedKeys = new Set(["KeyC", "Space"]);
  const { context, responses } = createContext(cdp, pressedKeys);

  await handleMessage({ id: 2, type: "releaseAll" }, context);

  assert.deepEqual(
    keyEventCodes(cdp.events),
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
    keyEventCodes(cdp.events),
    ["keyDown:KeyC", "keyUp:KeyC"]
  );
  assert.equal(pressedKeys.size, 0);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].error, /simulated keyUp failure/);
});

test("tap prepares focus before dispatching keys", async () => {
  const cdp = createFakeCdp();
  const { context, responses } = createContext(cdp);

  await handleMessage(
    {
      id: 4,
      type: "tap",
      key: "hardDrop",
      durationMs: 8
    },
    context
  );

  assert.equal(cdp.events[0].method, "Page.bringToFront");
  assert.equal(cdp.events[1].method, "Runtime.evaluate");
  assert.deepEqual(
    cdp.events.slice(2).map((event) => `${event.type}:${event.code}`),
    ["keyDown:Space", "keyUp:Space"]
  );
  assert.equal(responses[0].ok, true);
});

test("unsafe active elements block all key input", async () => {
  const blockedFocusCases = [
    { activeTag: "BUTTON", contentEditable: false },
    { activeTag: "INPUT", contentEditable: false },
    { activeTag: "TEXTAREA", contentEditable: false },
    { activeTag: "DIV", contentEditable: true }
  ];

  for (const focusResult of blockedFocusCases) {
    const cdp = createFakeCdp({ focusResult: { visibilityState: "visible", ...focusResult } });
    const { context, responses } = createContext(cdp);

    await handleMessage(
      {
        id: 5,
        type: "tap",
        key: "moveLeft",
        durationMs: 8
      },
      context
    );

    assert.equal(
      cdp.events.filter((event) => event.type === "keyDown" || event.type === "keyUp").length,
      0
    );
    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, false);
    assert.equal(responses[0].error, "unsafe_active_element");
  }
});

test("safe BODY focus allows key input", async () => {
  const cdp = createFakeCdp({
    focusResult: {
      visibilityState: "visible",
      activeTag: "BODY",
      contentEditable: false
    }
  });
  const { context, responses } = createContext(cdp);

  await handleMessage(
    {
      id: 6,
      type: "sequence",
      actions: [{ key: "rotateCW", durationMs: 10 }]
    },
    context
  );

  assert.deepEqual(
    cdp.events.slice(2).map((event) => `${event.type}:${event.code}`),
    ["keyDown:KeyX", "keyUp:KeyX"]
  );
  assert.equal(responses[0].ok, true);
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

test("browser CDP input helper never dispatches mouse clicks", () => {
  const source = readFileSync(new URL("./browser-cdp-input.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Input\.dispatchMouseEvent/);
});
