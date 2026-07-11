import assert from "node:assert/strict";
import test from "node:test";

import { createFocusController, handleTapMessage } from "./browser-cdp-input.mjs";

test("focus mode per_plan does not request focus for every tap", () => {
  const focus = createFocusController("per_plan");

  assert.equal(focus.shouldFocusForTap("moveLeft"), true);
  focus.afterTap("moveLeft");
  assert.equal(focus.shouldFocusForTap("rotateCW"), false);
  focus.afterTap("rotateCW");
  assert.equal(focus.shouldFocusForTap("hardDrop"), false);
  focus.afterTap("hardDrop");
  assert.equal(focus.shouldFocusForTap("moveRight"), true);
});

test("focus mode per_harddrop only focuses before hard drop", () => {
  const focus = createFocusController("per_harddrop");

  assert.equal(focus.shouldFocusForTap("moveLeft"), false);
  assert.equal(focus.shouldFocusForTap("rotateCW"), false);
  assert.equal(focus.shouldFocusForTap("hardDrop"), true);
});

test("tap requests return ok:true and dispatch key events", async () => {
  const sent = [];
  const response = await handleTapMessage(
    { id: 7, type: "tap", key: "moveLeft", durationMs: 20 },
    {
      cdp: {
        isOpen() {
          return true;
        },
        async send(method, params) {
          sent.push({ method, params });
          return {};
        }
      },
      port: 9222,
      url: "https://tetr.io/",
      targetHint: "TETR.IO",
      focusMode: "per_harddrop",
      focusController: createFocusController("per_harddrop"),
      pressedKeys: new Set(),
      lastFocus: null,
      setCdp() {},
      setLastFocus() {}
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.id, 7);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].method, "Input.dispatchKeyEvent");
  assert.equal(sent[0].params.type, "keyDown");
  assert.equal(sent[0].params.key, "ArrowLeft");
  assert.equal(sent[1].params.type, "keyUp");
});

test("unknown key returns ok:false", async () => {
  const response = await handleTapMessage(
    { id: 9, type: "tap", key: "mystery", durationMs: 20 },
    {
      cdp: null,
      port: 9222,
      url: "https://tetr.io/",
      targetHint: "TETR.IO",
      focusMode: "per_harddrop",
      focusController: createFocusController("per_harddrop"),
      pressedKeys: new Set(),
      lastFocus: null,
      setCdp() {},
      setLastFocus() {}
    }
  );

  assert.equal(response.ok, false);
  assert.match(response.error, /unknown key/);
});
