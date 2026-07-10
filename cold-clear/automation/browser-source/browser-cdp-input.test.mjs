import assert from "node:assert/strict";
import test from "node:test";

import { createFocusController } from "./browser-cdp-input.mjs";

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
