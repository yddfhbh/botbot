import test from "node:test";
import assert from "node:assert/strict";

import { determineChromiumOwnership } from "./tetrio-cdp-source.mjs";

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
