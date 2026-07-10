import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const PIECE_NAMES = ["i", "o", "t", "s", "z", "j", "l"];
const MAX_DUMP_DEPTH = 5;
const MAX_RECURSION_OBJECTS = 300;

export function normalizeSelectorConfig(options = {}) {
  return {
    playerSelector: `${options.playerSelector ?? "auto"}`.trim().toLowerCase() || "auto",
    playerNickname: `${options.playerNickname ?? ""}`.trim(),
    playerUserId: `${options.playerUserId ?? ""}`.trim(),
    dumpStateOnFail: options.dumpStateOnFail !== false,
    dumpStatePath:
      `${options.dumpStatePath ?? "automation/debug/tetrio-state-dump.json"}`.trim() ||
      "automation/debug/tetrio-state-dump.json"
  };
}

export function normalizePiece(value) {
  if (value === null || value === undefined || value === false) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return PIECE_NAMES[Math.trunc(value)] ?? null;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (!text) return null;
    if (PIECE_NAMES.includes(text)) return text;
    for (const token of text.split(/[^a-z0-9]+/)) {
      if (PIECE_NAMES.includes(token)) return token;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const piece = normalizePiece(item);
      if (piece) return piece;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const key of ["type", "symbol", "id", "piece", "name", "mino", "value", "kind"]) {
      const piece = normalizePiece(value[key]);
      if (piece) return piece;
    }
  }
  return null;
}

export function filled(cell) {
  if (cell === null || cell === undefined || cell === false || cell === 0 || cell === "") {
    return false;
  }
  if (typeof cell === "string") {
    const text = cell.trim().toLowerCase();
    return text !== "" && text !== "." && text !== "0" && text !== "empty";
  }
  if (typeof cell === "object") {
    if ("empty" in cell) return !cell.empty;
    if ("filled" in cell) return Boolean(cell.filled);
    if ("type" in cell) return filled(cell.type);
    if ("mino" in cell) return filled(cell.mino);
  }
  return true;
}

export function rowCells(row) {
  if (Array.isArray(row)) return row;
  if (Array.isArray(row?.cells)) return row.cells;
  if (Array.isArray(row?.row)) return row.row;
  return null;
}

export function queueFrom(...values) {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const queue = value.map((item) => normalizePiece(item)).filter(Boolean);
    if (queue.length > 0) return queue.slice(0, 12);
  }
  return [];
}

export function numberFrom(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

export function integerFrom(...values) {
  const number = numberFrom(...values);
  return number === null ? null : Math.trunc(number);
}

export function rotationFrom(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      return ["north", "east", "south", "west"][((Math.trunc(value) % 4) + 4) % 4] ?? null;
    }
    if (typeof value === "string") {
      const text = value.trim().toLowerCase();
      if (!text) continue;
      if (["north", "n", "spawn", "0"].includes(text)) return "north";
      if (["east", "e", "right", "r", "1"].includes(text)) return "east";
      if (["south", "s", "2"].includes(text)) return "south";
      if (["west", "w", "left", "l", "3"].includes(text)) return "west";
    }
  }
  return null;
}

function lowerText(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function truthy(value) {
  return value === true;
}

function boolOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function getFirstValue(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

function getBoardCandidate(...values) {
  for (const value of values) {
    const board = coerceBoard(value);
    if (board) return board;
  }
  return null;
}

function coerceBoard(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (value.every((row) => rowCells(row))) {
    return value;
  }
  return null;
}

function hasBoardCurrentQueue(candidate) {
  return Boolean(candidate.board && candidate.current && candidate.queue.length > 0);
}

function boardToField(board) {
  return Array.from({ length: 40 }, (_, rowIndex) => {
    const sourceRow = board[board.length - 1 - rowIndex];
    const cells = rowCells(sourceRow);
    return Array.from({ length: 10 }, (_, x) => filled(cells ? cells[x] : null));
  });
}

function safeKeys(value) {
  if (!value || typeof value !== "object") return [];
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function hashField(field) {
  const bits = field
    .map((row) => row.map((cell) => (cell ? "1" : "0")).join(""))
    .join("|");
  return hashString(bits);
}

function shallowShape(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sampleKinds: value.slice(0, 5).map((item) => describeValueKind(item))
    };
  }
  if (typeof value !== "object") {
    return {
      type: typeof value,
      value:
        typeof value === "string" ? value.slice(0, 80) : typeof value === "number" ? value : undefined
    };
  }
  const keys = safeKeys(value).slice(0, 20);
  return {
    type: "object",
    keys,
    sample: Object.fromEntries(
      keys.slice(0, 8).map((key) => [key, describeValueKind(value[key])])
    )
  };
}

function describeValueKind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function summarizeShape(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value !== "object") {
    if (typeof value === "string") return value.slice(0, 120);
    return value;
  }
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DUMP_DEPTH) return "[MaxDepth]";
  seen.add(value);
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: value.slice(0, 4).map((item) => summarizeShape(item, depth + 1, seen))
    };
  }
  const keys = safeKeys(value).slice(0, 20);
  const summary = {};
  for (const key of keys.slice(0, 10)) {
    summary[key] = summarizeShape(value[key], depth + 1, seen);
  }
  return {
    type: "object",
    keys,
    summary
  };
}

function writeJsonAtomic(outputPath, payload) {
  const directory = path.dirname(outputPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2));
  try {
    renameSync(temporaryPath, outputPath);
  } catch {
    copyFileSync(temporaryPath, outputPath);
    rmSync(temporaryPath, { force: true });
  }
}

function getPlayerNickname(player) {
  return (
    getFirstValue(
      player?.username,
      player?.name,
      player?.nickname,
      player?.displayName,
      player?.user?.username,
      player?.user?.name,
      player?.user?.nickname,
      player?.state?.username,
      player?.state?.name,
      player?.state?.nickname
    ) ?? ""
  );
}

function getPlayerUserId(player) {
  const value = getFirstValue(
    player?.user?.id,
    player?.userID,
    player?.userId,
    player?.userid,
    player?.id,
    player?.state?.user?.id,
    player?.state?.userId
  );
  return value === undefined ? "" : `${value}`;
}

function getPlayerLocalFlag(player) {
  return [
    player?.isLocal,
    player?.local,
    player?.self,
    player?.you,
    player?.me,
    player?.controlled,
    player?.controllable,
    player?.state?.isLocal
  ].some(truthy);
}

function getPlayerDeadFlag(player, state, boardState) {
  return [
    player?.dead,
    player?.destroyed,
    player?.gameover,
    player?.gameOver,
    player?.alive === false ? true : null,
    player?.state?.dead,
    player?.state?.destroyed,
    state?.dead,
    state?.destroyed,
    state?.gameover,
    boardState?.dead
  ].some(truthy);
}

function getPlayerStatusTexts(player, state, boardState) {
  return [
    player?.status,
    player?.phase,
    player?.state?.status,
    player?.state?.phase,
    state?.status,
    state?.phase,
    boardState?.status,
    boardState?.phase
  ]
    .map(lowerText)
    .filter(Boolean);
}

function buildCandidate(pathLabel, player, state, boardState) {
  if (!player || typeof player !== "object") return null;
  const board = getBoardCandidate(
    player.board,
    player.matrix,
    player.field,
    player.playfield,
    player.grid,
    player.boardState?.b,
    player.state?.board,
    player.state?.matrix,
    player.state?.field,
    player.game?.board
  );
  const activeState =
    getFirstValue(
      player.falling,
      player.active,
      player.current,
      player.piece,
      player.state?.falling,
      player.state?.active,
      player.state?.current,
      player.state?.piece,
      player.boardState?.falling
    ) ?? null;
  const current = normalizePiece(activeState);
  const queue = queueFrom(
    player.bag,
    player.queue,
    player.next,
    player.preview,
    player.previews,
    player.pieces,
    player.state?.bag,
    player.state?.queue,
    player.state?.next,
    player.state?.preview
  );
  const hold = normalizePiece(player.hold ?? player.held ?? player.state?.hold ?? player.state?.held);
  const stats = getFirstValue(player.stats, player.state?.stats, state?.stats, state?.game?.stats) ?? {};
  const activeX = integerFrom(activeState?.x, activeState?.col, activeState?.column, activeState?.cx);
  const activeY = integerFrom(activeState?.y, activeState?.row, activeState?.cy);
  const activeRotation = rotationFrom(
    activeState?.rotation,
    activeState?.rot,
    activeState?.orientation,
    activeState?.dir,
    activeState?.state
  );
  const pieceCounter = getFirstPieceCounter(player, state, boardState, stats);
  return {
    path: pathLabel,
    player,
    board,
    current,
    queue,
    hold,
    stats,
    activeX,
    activeY,
    activeRotation,
    nickname: getPlayerNickname(player),
    userId: getPlayerUserId(player),
    isLocal: getPlayerLocalFlag(player),
    dead: getPlayerDeadFlag(player, state, boardState),
    statuses: getPlayerStatusTexts(player, state, boardState),
    pieceCounter
  };
}

function getFirstPieceCounter(player, state, boardState, stats) {
  const raw = numberFrom(
    stats?.piecesplaced,
    stats?.piecesPlaced,
    stats?.pieces,
    player?.piecesplaced,
    player?.piecesPlaced,
    player?.pieceCounter,
    player?.piececount,
    player?.lockCounter,
    state?.frame,
    state?.tick,
    boardState?.tick
  );
  return raw === null ? null : Math.max(0, Math.trunc(raw));
}

function addCandidateFromContainer(container, pathLabel, state, boardState, candidates, seenPlayers) {
  if (!container) return;
  if (Array.isArray(container)) {
    container.forEach((player, index) => {
      addCandidateObject(player, `${pathLabel}[${index}]`, state, boardState, candidates, seenPlayers);
    });
    return;
  }
  if (typeof container === "object") {
    addCandidateObject(container, pathLabel, state, boardState, candidates, seenPlayers);
    for (const [key, value] of Object.entries(container).slice(0, 24)) {
      addCandidateObject(value, `${pathLabel}.${key}`, state, boardState, candidates, seenPlayers);
    }
  }
}

function addCandidateObject(player, pathLabel, state, boardState, candidates, seenPlayers) {
  if (!player || typeof player !== "object") return;
  if (seenPlayers.has(player)) return;
  const candidate = buildCandidate(pathLabel, player, state, boardState);
  if (!candidate) return;
  const looksRelevant =
    Boolean(candidate.board) ||
    Boolean(candidate.current) ||
    candidate.queue.length > 0 ||
    Boolean(candidate.nickname) ||
    Boolean(candidate.userId);
  if (!looksRelevant) return;
  seenPlayers.add(player);
  candidates.push(candidate);
}

function collectRecursiveCandidates(root, rootPath, state, boardState, candidates, seenPlayers) {
  const seenObjects = new WeakSet();
  const stack = [{ value: root, path: rootPath, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_RECURSION_OBJECTS) {
    const entry = stack.pop();
    if (!entry?.value || typeof entry.value !== "object") continue;
    if (seenObjects.has(entry.value)) continue;
    seenObjects.add(entry.value);
    visited += 1;
    addCandidateObject(entry.value, entry.path, state, boardState, candidates, seenPlayers);
    if (entry.depth >= 5) continue;
    if (Array.isArray(entry.value)) {
      entry.value.slice(0, 16).forEach((item, index) => {
        if (item && typeof item === "object") {
          stack.push({ value: item, path: `${entry.path}[${index}]`, depth: entry.depth + 1 });
        }
      });
      continue;
    }
    for (const [key, value] of Object.entries(entry.value).slice(0, 20)) {
      if (value && typeof value === "object") {
        stack.push({ value, path: `${entry.path}.${key}`, depth: entry.depth + 1 });
      }
    }
  }
}

export function extractLocalPlayerState({ exported, state, boardState, selector }) {
  const normalized = normalizeSelectorConfig(selector);
  const candidates = [];
  const seenPlayers = new WeakSet();
  const rootPathInfos = [];

  const soloCandidate = buildCandidate("state", state, state, boardState);
  if (soloCandidate && hasBoardCurrentQueue(soloCandidate)) {
    candidates.push(soloCandidate);
    seenPlayers.add(state);
  }

  const explicitRoots = [
    { path: "state.players", value: state?.players },
    { path: "state.game.players", value: state?.game?.players },
    { path: "state.boards", value: state?.boards },
    { path: "state.boardStates", value: state?.boardStates },
    { path: "state.playerStates", value: state?.playerStates },
    { path: "boardState.players", value: boardState?.players },
    { path: "boardState.boards", value: boardState?.boards },
    { path: "boardState.boardStates", value: boardState?.boardStates },
    { path: "exported.players", value: exported?.players },
    { path: "exported.game.players", value: exported?.game?.players },
    { path: "exported.game.boards", value: exported?.game?.boards },
    { path: "exported.game.boardStates", value: exported?.game?.boardStates }
  ];

  for (const rootInfo of explicitRoots) {
    if (!rootInfo.value) continue;
    rootPathInfos.push({
      path: rootInfo.path,
      shallowShape: shallowShape(rootInfo.value)
    });
    addCandidateFromContainer(
      rootInfo.value,
      rootInfo.path,
      state,
      boardState,
      candidates,
      seenPlayers
    );
  }

  collectRecursiveCandidates(state, "state", state, boardState, candidates, seenPlayers);
  if (boardState && typeof boardState === "object") {
    collectRecursiveCandidates(boardState, "boardState", state, boardState, candidates, seenPlayers);
  }
  if (exported && typeof exported === "object") {
    collectRecursiveCandidates(exported, "exported", state, boardState, candidates, seenPlayers);
  }

  const validCandidates = candidates.filter((candidate) => hasBoardCurrentQueue(candidate));
  const selected = selectPlayerCandidate(validCandidates, normalized);
  const mode =
    validCandidates.length <= 1 && selected?.candidate?.path === "state"
      ? "solo"
      : validCandidates.length > 1
        ? "versus"
        : "unknown";

  return {
    selector: normalized,
    mode,
    candidates,
    validCandidates,
    selectedCandidate: selected?.candidate ?? null,
    selectedReason: selected?.reason ?? "none",
    rootPathInfos
  };
}

function selectPlayerCandidate(candidates, selector) {
  if (candidates.length === 0) return null;
  if (selector.playerSelector === "left") {
    return candidates[0] ? { candidate: candidates[0], reason: "left_index_0" } : null;
  }
  if (selector.playerSelector === "right") {
    return candidates[1] ? { candidate: candidates[1], reason: "right_index_1" } : null;
  }
  if (selector.playerSelector === "nickname") {
    const match = candidates.find(
      (candidate) => lowerText(candidate.nickname) === lowerText(selector.playerNickname)
    );
    return match ? { candidate: match, reason: "nickname_match" } : null;
  }
  if (selector.playerSelector === "user_id") {
    const match = candidates.find((candidate) => `${candidate.userId}` === selector.playerUserId);
    return match ? { candidate: match, reason: "user_id_match" } : null;
  }
  const flagMatch = candidates.find((candidate) => candidate.isLocal);
  if (flagMatch) return { candidate: flagMatch, reason: "isLocal" };
  if (selector.playerUserId) {
    const userIdMatch = candidates.find((candidate) => `${candidate.userId}` === selector.playerUserId);
    if (userIdMatch) return { candidate: userIdMatch, reason: "userId" };
  }
  if (selector.playerNickname) {
    const nicknameMatch = candidates.find(
      (candidate) => lowerText(candidate.nickname) === lowerText(selector.playerNickname)
    );
    if (nicknameMatch) return { candidate: nicknameMatch, reason: "nickname" };
  }
  const aliveMatch = candidates.find((candidate) => candidate.current && !candidate.dead);
  if (aliveMatch) return { candidate: aliveMatch, reason: "alive_with_current" };
  return { candidate: candidates[0], reason: "first_valid_candidate" };
}

function classifyPlayingState(selectedCandidate, state, boardState, pageHints) {
  const statuses = selectedCandidate?.statuses ?? [];
  const statusSet = new Set(statuses);
  const dead = selectedCandidate?.dead ?? false;
  const explicitCountdown = [
    selectedCandidate?.player?.countdown,
    selectedCandidate?.player?.state?.countdown,
    state?.countdown,
    boardState?.countdown
  ]
    .map(boolOrNull)
    .find((value) => value !== null);
  const explicitPlaying = [
    pageHints?.gameIsPlaying,
    selectedCandidate?.player?.playing,
    selectedCandidate?.player?.state?.playing,
    state?.playing,
    typeof selectedCandidate?.player?.paused === "boolean" ? !selectedCandidate.player.paused : null
  ]
    .map(boolOrNull)
    .find((value) => value !== null);

  if (dead || statusSet.has("dead") || statusSet.has("destroyed")) {
    return {
      ready: false,
      playing: false,
      countdown: false,
      dead: true,
      source: "dead"
    };
  }
  if (
    statusSet.has("lobby") ||
    statusSet.has("ready") ||
    statusSet.has("countdown") ||
    statusSet.has("gameover") ||
    statusSet.has("game_over")
  ) {
    const countdown = statusSet.has("lobby") || statusSet.has("ready") || statusSet.has("countdown");
    return {
      ready: false,
      playing: false,
      countdown,
      dead: statusSet.has("gameover") || statusSet.has("game_over"),
      source: `status:${[...statusSet].join(",")}`
    };
  }
  if (explicitCountdown === true) {
    return {
      ready: false,
      playing: false,
      countdown: true,
      dead: false,
      source: "countdown_flag"
    };
  }
  if (explicitPlaying === true) {
    return {
      ready: true,
      playing: true,
      countdown: false,
      dead: false,
      source: "explicit_playing_true"
    };
  }
  if (explicitPlaying === false && !selectedCandidate?.current) {
    return {
      ready: false,
      playing: false,
      countdown: true,
      dead: false,
      source: "explicit_playing_false_without_current"
    };
  }
  if (hasBoardCurrentQueue(selectedCandidate) && !dead) {
    return {
      ready: true,
      playing: true,
      countdown: false,
      dead: false,
      source: "valid_player_state_fallback"
    };
  }
  return {
    ready: false,
    playing: false,
    countdown: false,
    dead,
    source: "not_ready"
  };
}

function inspectInterestingPaths(root, rootPath, results, seen = new WeakSet(), depth = 0) {
  if (!root || typeof root !== "object") return;
  if (seen.has(root) || depth > 4) return;
  seen.add(root);

  if (coerceBoard(root)) {
    results.boardLikePaths.push(rootPath);
  }
  const rootPiece = normalizePiece(root);
  if (rootPiece) {
    results.pieceLikePaths.push(rootPath);
  }
  if (Array.isArray(root)) {
    const queue = queueFrom(root);
    if (queue.length > 0) {
      results.queueLikePaths.push(rootPath);
    }
    root.slice(0, 10).forEach((item, index) => {
      inspectInterestingPaths(item, `${rootPath}[${index}]`, results, seen, depth + 1);
    });
    return;
  }

  for (const [key, value] of Object.entries(root).slice(0, 20)) {
    const nextPath = `${rootPath}.${key}`;
    if (coerceBoard(value)) {
      results.boardLikePaths.push(nextPath);
    }
    if (
      /(falling|active|current|piece|hold|held)$/i.test(key) &&
      normalizePiece(value)
    ) {
      results.pieceLikePaths.push(nextPath);
    }
    if (/(bag|queue|next|preview|previews|pieces)$/i.test(key) && queueFrom(value).length > 0) {
      results.queueLikePaths.push(nextPath);
    }
    if (value && typeof value === "object") {
      inspectInterestingPaths(value, nextPath, results, seen, depth + 1);
    }
  }
}

export function buildStateDumpSummary({
  exported,
  state,
  boardState,
  selection,
  href,
  targetTitle,
  targetUrl,
  reason
}) {
  const interestingPaths = {
    boardLikePaths: [],
    pieceLikePaths: [],
    queueLikePaths: []
  };
  inspectInterestingPaths(exported, "exported", interestingPaths);
  if (state && state !== exported) {
    inspectInterestingPaths(state, "state", interestingPaths);
  }
  if (boardState) {
    inspectInterestingPaths(boardState, "boardState", interestingPaths);
  }

  return {
    href,
    target: {
      title: targetTitle,
      url: targetUrl
    },
    exportedTopLevelKeys: safeKeys(exported).slice(0, 50),
    stateTopLevelKeys: safeKeys(state).slice(0, 50),
    boardStateTopLevelKeys: safeKeys(boardState).slice(0, 50),
    candidateRootPaths: selection.rootPathInfos,
    selectedPath: selection.selectedCandidate?.path ?? null,
    selectedCandidateShape: selection.selectedCandidate
      ? shallowShape(selection.selectedCandidate.player)
      : null,
    boardLikePaths: interestingPaths.boardLikePaths.slice(0, 60),
    pieceLikePaths: interestingPaths.pieceLikePaths.slice(0, 60),
    queueLikePaths: interestingPaths.queueLikePaths.slice(0, 60),
    lastReason: reason,
    exportedShape: summarizeShape(exported),
    stateShape: summarizeShape(state),
    boardStateShape: summarizeShape(boardState)
  };
}

export function resolveGameStateSnapshot({
  exported,
  boardState,
  pageHints = {},
  selector = {},
  href = "",
  targetTitle = "",
  targetUrl = ""
}) {
  const normalizedSelector = normalizeSelectorConfig(selector);
  const state = exported && typeof exported === "object" && exported.game ? exported.game : exported;
  if (!state || typeof state !== "object") {
    return finalizeFailure({
      reason: "TETR.IO game state is not available",
      exported,
      state,
      boardState,
      href,
      targetTitle,
      targetUrl,
      selector: normalizedSelector,
      selection: {
        mode: "unknown",
        validCandidates: [],
        selectedCandidate: null,
        selectedReason: "none",
        rootPathInfos: []
      }
    });
  }

  const selection = extractLocalPlayerState({
    exported,
    state,
    boardState,
    selector: normalizedSelector
  });
  const selected = selection.selectedCandidate;
  if (!selected || !hasBoardCurrentQueue(selected)) {
    return finalizeFailure({
      reason: "TETR.IO local player board/current/queue is not available",
      exported,
      state,
      boardState,
      href,
      targetTitle,
      targetUrl,
      selector: normalizedSelector,
      selection
    });
  }

  const field = boardToField(selected.board);
  const playingState = classifyPlayingState(selected, state, boardState, pageHints);
  const pieceCounter = selected.pieceCounter;
  const token =
    pieceCounter !== null
      ? `browser-${pieceCounter}`
      : `browser-fallback-${selected.current}-${selected.queue.join("")}-${selected.hold ?? "-"}-${selected.activeX ?? "-"}-${selected.activeY ?? "-"}-${selected.activeRotation ?? "-"}-${hashField(field)}`;
  const snapshot = {
    ok: true,
    ready: playingState.ready,
    reason: null,
    field,
    current: selected.current,
    hold: selected.hold,
    queue: selected.queue,
    b2b: Math.max(0, numberFrom(selected.stats?.b2b, state?.b2b, 0) ?? 0) > 0,
    combo: Math.max(0, numberFrom(selected.stats?.combo, state?.combo, 0) ?? 0),
    incoming: Math.max(
      0,
      numberFrom(selected.stats?.impendingdamage, selected.stats?.incoming, state?.incoming, 0) ?? 0
    ),
    pieceCounter: pieceCounter ?? undefined,
    token,
    playing: playingState.playing,
    countdown: playingState.countdown,
    activeX: selected.activeX ?? undefined,
    activeY: selected.activeY ?? undefined,
    activeRotation: selected.activeRotation ?? undefined,
    mode: selection.mode,
    candidateCount: selection.validCandidates.length,
    selectedPath: selected.path,
    selectionReason: selection.selectedReason,
    playingSource: playingState.source,
    dead: playingState.dead,
    nickname: selected.nickname,
    userId: selected.userId,
    logs: [
      `[browser] mode=${selection.mode} candidates=${selection.validCandidates.length} selector=${normalizedSelector.playerSelector} selected=${selected.path} reason=${selection.selectedReason}`,
      `[browser] selected nickname=${selected.nickname || "-"} current=${selected.current.toUpperCase()} hold=${selected.hold ? selected.hold.toUpperCase() : "-"} queue=${selected.queue.map((piece) => piece.toUpperCase()).join(",")}`,
      `[browser] playing=${playingState.playing} countdown=${playingState.countdown} dead=${playingState.dead} source=${playingState.source}`,
      `[browser] boardRows=${selected.board.length} current=${selected.current.toUpperCase()} hold=${selected.hold ? selected.hold.toUpperCase() : "-"} queue=${selected.queue.map((piece) => piece.toUpperCase()).join(",")}`,
      `[browser] token=${token}`
    ]
  };
  return snapshot;
}

function finalizeFailure({
  reason,
  exported,
  state,
  boardState,
  href,
  targetTitle,
  targetUrl,
  selector,
  selection
}) {
  const result = {
    ok: false,
    ready: false,
    reason,
    mode: selection.mode ?? "unknown",
    candidateCount: selection.validCandidates?.length ?? 0,
    selectedPath: selection.selectedCandidate?.path ?? null,
    selectionReason: selection.selectedReason ?? "none",
    logs: [
      `[browser] mode=${selection.mode ?? "unknown"} candidates=${selection.validCandidates?.length ?? 0} selector=${selector.playerSelector}`,
      `[browser] reject reason=${reason}`
    ]
  };
  if (selector.dumpStateOnFail) {
    const dumpSummary = buildStateDumpSummary({
      exported,
      state,
      boardState,
      selection,
      href,
      targetTitle,
      targetUrl,
      reason
    });
    writeJsonAtomic(selector.dumpStatePath, dumpSummary);
    result.dumpStatePath = selector.dumpStatePath;
    result.logs.push(`[browser] dumpStatePath=${selector.dumpStatePath}`);
  }
  return result;
}
