import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveGameStateSnapshot } from "./tetrio-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, "../test-fixtures");

function readFixture(name) {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8"));
}

test("solo structure reads like the existing solo path", () => {
  const fixture = readFixture("solo-eject-state.json");
  const snapshot = resolveGameStateSnapshot({
    ...fixture,
    selector: { playerSelector: "auto" },
    targetTitle: "TETR.IO",
    targetUrl: "https://tetr.io/"
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.mode, "solo");
  assert.equal(snapshot.current, "t");
  assert.deepEqual(snapshot.queue.slice(0, 3), ["j", "l", "o"]);
  assert.equal(snapshot.selectedPath, "state");
});

test("players[0].isLocal=true is selected in versus", () => {
  const fixture = readFixture("vs-two-players-left-local.json");
  const snapshot = resolveGameStateSnapshot({
    ...fixture,
    selector: { playerSelector: "auto" },
    targetTitle: "TETR.IO",
    targetUrl: "https://tetr.io/"
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.mode, "versus");
  assert.equal(snapshot.selectedPath, "state.players[0]");
  assert.equal(snapshot.selectionReason, "isLocal");
  assert.equal(snapshot.nickname, "hebi_");
});

test("players[1].isLocal=true is selected in versus", () => {
  const fixture = readFixture("vs-two-players-right-local.json");
  const snapshot = resolveGameStateSnapshot({
    ...fixture,
    selector: { playerSelector: "auto" },
    targetTitle: "TETR.IO",
    targetUrl: "https://tetr.io/"
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.selectedPath, "state.players[1]");
  assert.equal(snapshot.selectionReason, "isLocal");
});

test("selector left and right choose the expected candidates", () => {
  const fixture = readFixture("vs-two-players-right-local.json");

  const leftSnapshot = resolveGameStateSnapshot({
    ...fixture,
    selector: { playerSelector: "left" },
    targetTitle: "TETR.IO",
    targetUrl: "https://tetr.io/"
  });
  const rightSnapshot = resolveGameStateSnapshot({
    ...fixture,
    selector: { playerSelector: "right" },
    targetTitle: "TETR.IO",
    targetUrl: "https://tetr.io/"
  });

  assert.equal(leftSnapshot.selectedPath, "state.players[0]");
  assert.equal(rightSnapshot.selectedPath, "state.players[1]");
});

test("selector nickname chooses the matching candidate", () => {
  const fixture = readFixture("vs-nickname-selector.json");
  const snapshot = resolveGameStateSnapshot({
    ...fixture,
    selector: { playerSelector: "nickname", playerNickname: "hebi_" },
    targetTitle: "TETR.IO",
    targetUrl: "https://tetr.io/"
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.selectedPath, "state.players[1]");
  assert.equal(snapshot.selectionReason, "nickname_match");
});

test("missing pieceCounter still generates a fallback token", () => {
  const fixture = readFixture("vs-no-piece-counter.json");
  const snapshot = resolveGameStateSnapshot({
    ...fixture,
    selector: { playerSelector: "auto" },
    targetTitle: "TETR.IO",
    targetUrl: "https://tetr.io/"
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.pieceCounter, undefined);
  assert.match(snapshot.token, /^browser-fallback-/);
});

test("missing board/current/queue returns ok:false and writes a dump", () => {
  const dumpDir = mkdtempSync(path.join(os.tmpdir(), "tetrio-state-test-"));
  const dumpPath = path.join(dumpDir, "state-dump.json");

  const snapshot = resolveGameStateSnapshot({
    exported: { game: { players: [{ username: "broken" }] } },
    boardState: {},
    pageHints: { gameIsPlaying: true, gameIsStarted: true },
    selector: {
      playerSelector: "auto",
      dumpStateOnFail: true,
      dumpStatePath: dumpPath
    },
    targetTitle: "TETR.IO",
    targetUrl: "https://tetr.io/"
  });

  assert.equal(snapshot.ok, false);
  assert.match(snapshot.reason, /board\/current\/queue/i);
  const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
  assert.equal(dump.lastReason, snapshot.reason);
  assert.ok(Array.isArray(dump.candidateRootPaths));

  rmSync(dumpDir, { recursive: true, force: true });
});
