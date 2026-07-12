import { fileURLToPath } from "node:url";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_BRIDGE_PATH = fileURLToPath(
  new URL("../vs-ws-bridge.json", import.meta.url)
);

const MAX_DEPTH = 12;
const MAX_VISITED_OBJECTS = 5000;
const BRIDGE_OPTION_KEYS = [
  "bagtype",
  "nextcount",
  "boardwidth",
  "boardheight",
  "precountdown",
  "countdown_count",
  "countdown_interval",
  "garbagemultiplier"
];
const ROOM_OPTION_KEYS = ["seed", ...BRIDGE_OPTION_KEYS];
const REQUIRED_LOCAL_OPTION_KEYS = [
  "seed",
  "bagtype",
  "nextcount",
  "boardwidth",
  "boardheight"
];
const GARBAGE_DATA_KEYS = [
  "type",
  "gameid",
  "frame",
  "amt",
  "size",
  "x",
  "y",
  "zthalt",
  "iid",
  "ackiid",
  "cid"
];

export function isVsWsSimEnabled(env = process.env) {
  return env?.FUSION_VS_WS_SIM === "1";
}

export function createVsBridgeState(
  bridgeFilePath = DEFAULT_BRIDGE_PATH,
  log = null
) {
  const state = {
    bridgeFilePath: path.resolve(bridgeFilePath),
    sequence: 0,
    current: null,
    currentSignature: "",
    garbageKeys: new Set(),
    lastDisabledRoundId: "",
    lastWaitingReason: "",
    lastLocalPlayerSignature: "",
    selfUser: {
      userid: null,
      username: null
    },
    roomUsers: new Map(),
    roundPlayers: new Map(),
    roomOptions: {},
    roundObservedAt: 0,
    roundObservationKey: "",
    log,
    ingest(root, context = {}) {
      return ingestVsBridgeRoot(state, root, context, state.log);
    }
  };

  log?.(`[vs-bridge] enabled path=${displayPath(state.bridgeFilePath)}`);
  return state;
}

export function updateVsBridgeState(
  state,
  decodedRoots,
  log = state?.log ?? null,
  capturedAt = Date.now()
) {
  if (!state || !Array.isArray(decodedRoots)) {
    return null;
  }

  for (const root of decodedRoots) {
    ingestVsBridgeRoot(state, root, { timestamp: capturedAt }, log);
  }

  return state.current;
}

export function ingestVsBridgeRoot(
  state,
  root,
  context = {},
  log = state?.log ?? null
) {
  if (!state || !root || typeof root !== "object") {
    return state?.current ?? null;
  }

  const capturedAt = normalizeTimestamp(context.timestamp);
  updateSelfUserCache(state, root);
  updateRoomUsersCache(state, root);
  updateRoundPlayersCache(state, root);
  updateRoomOptionsCache(state, root);
  updateRoundObservation(state, capturedAt);

  const built = tryBuildBridge(state, capturedAt, log);
  if (built) {
    maybeLogResolvedLocalPlayer(state, built.local, log);
  }

  if (!state.current?.active) {
    return state.current;
  }

  if (bridgeSessionShouldEnd(root, state.current.local.gameid)) {
    markVsBridgeInactive(state, log);
    return state.current;
  }

  const garbageEvents = collectVsIncomingGarbage(root, state.current);
  if (garbageEvents.length === 0) {
    return state.current;
  }

  let changed = false;
  for (const event of garbageEvents) {
    if (state.garbageKeys.has(event.dedupeKey)) {
      continue;
    }
    state.garbageKeys.add(event.dedupeKey);
    state.current.incomingGarbage.push({
      ownerGameId: event.ownerGameId,
      eventType: event.eventType,
      eventFrame: event.eventFrame,
      eventId: event.eventId,
      data: event.data
    });
    changed = true;
    log?.(
      `[vs-bridge] incoming garbage observed amt=${event.data.amt ?? 0} hole=${event.data.x ?? 0}`
    );
    log?.("[vs-bridge] garbage application disabled in validation phase");
  }

  if (!changed) {
    return state.current;
  }

  state.sequence += 1;
  state.current.sequence = state.sequence;
  state.current.capturedAt = capturedAt;
  safeWriteBridgeFile(state, log);
  return state.current;
}

export function markVsBridgeInactive(state, log = state?.log ?? null) {
  if (!state?.current?.active) {
    return;
  }

  state.sequence += 1;
  state.lastDisabledRoundId = state.current.roundId;
  state.current = {
    ...state.current,
    sequence: state.sequence,
    active: false,
    capturedAt: Date.now()
  };
  safeWriteBridgeFile(state, log);
}

export function deriveVsRoundBridge(root, capturedAt = Date.now()) {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return null;
  }

  const state = {
    selfUser: {
      userid: null,
      username: null
    },
    roomUsers: new Map(),
    roundPlayers: new Map(),
    roomOptions: {},
    roundObservedAt: 0,
    roundObservationKey: "",
    current: null,
    currentSignature: "",
    garbageKeys: new Set(),
    lastDisabledRoundId: "",
    lastWaitingReason: "",
    lastLocalPlayerSignature: "",
    sequence: 0,
    bridgeFilePath: DEFAULT_BRIDGE_PATH,
    log: null
  };

  updateSelfUserCache(state, root);
  updateRoomUsersCache(state, root);
  updateRoundPlayersCache(state, root);
  updateRoomOptionsCache(state, root);
  updateRoundObservation(state, capturedAt);

  return buildBridgeFromState(state, capturedAt);
}

export function collectVsIncomingGarbage(root, currentBridge) {
  if (!root || typeof root !== "object" || !currentBridge) {
    return [];
  }

  const matches = [];
  const seen = new WeakSet();
  const counters = { visitedObjects: 0 };
  walkBridgeObject(
    root,
    "root",
    [{ value: root }],
    seen,
    counters,
    (value, pathLabel, lineage) => {
      const match = buildIncomingGarbageEvent(
        value,
        pathLabel,
        lineage,
        currentBridge
      );
      if (match) {
        matches.push(match);
      }
    },
    0
  );
  return matches;
}

export function writeVsBridgeFile(bridgeFilePath, payload) {
  const directory = path.dirname(bridgeFilePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${bridgeFilePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2));
  rmSync(bridgeFilePath, { force: true });
  renameSync(temporaryPath, bridgeFilePath);
}

function tryBuildBridge(state, capturedAt, log) {
  const built = buildBridgeFromState(state, capturedAt);
  if (!built) {
    return null;
  }

  clearWaitingReason(state);
  const signature = JSON.stringify(built);
  if (built.bridge.roundId === state.lastDisabledRoundId) {
    return built.bridge;
  }
  if (
    state.current?.roundId === built.bridge.roundId &&
    state.currentSignature === signature
  ) {
    return built.bridge;
  }

  const previousIncomingGarbage =
    state.current?.roundId === built.bridge.roundId
      ? state.current.incomingGarbage
      : [];

  state.sequence += 1;
  state.current = {
    ...built.bridge,
    roomSeed: built.roomSeed ?? null,
    version: 1,
    sequence: state.sequence,
    active: true,
    capturedAt,
    incomingGarbage: previousIncomingGarbage
  };
  state.currentSignature = signature;

  if (previousIncomingGarbage.length === 0) {
    state.garbageKeys.clear();
  }

  if (safeWriteBridgeFile(state, log)) {
    log?.(`[vs-bridge] written roundId=${state.current.roundId}`);
  }
  return state.current;
}

function buildBridgeFromState(state, capturedAt) {
  const selfUser = state.selfUser ?? {};
  if (!selfUser.userid && !selfUser.username) {
    setWaitingReason(state, "self_user_missing");
    return null;
  }

  const roundPlayers = [...state.roundPlayers.values()]
    .map((player) => withBackfilledRoundUsername(state, player))
    .filter((player) => player?.userid);
  if (roundPlayers.length < 2) {
    setWaitingReason(state, "round_players_missing");
    return null;
  }

  const localPlayer = resolveLocalPlayer(selfUser, roundPlayers);
  if (!localPlayer) {
    setWaitingReason(state, "local_player_unresolved");
    return null;
  }

  const opponents = roundPlayers.filter(
    (player) => player.userid !== localPlayer.userid
  );
  if (opponents.length !== 1) {
    setWaitingReason(state, "round_players_missing");
    return null;
  }

  const localOptions = asPlainObject(localPlayer.options);
  if (!hasScalarKeys(localOptions, REQUIRED_LOCAL_OPTION_KEYS)) {
    setWaitingReason(state, "round_options_incomplete");
    return null;
  }

  const playerSeeds = roundPlayers
    .map((player) => sanitizeScalar(player?.options?.seed))
    .filter((seed) => seed !== undefined);
  if (playerSeeds.length !== roundPlayers.length) {
    setWaitingReason(state, "round_options_incomplete");
    return null;
  }

  const roundSeed = playerSeeds[0];
  if (!playerSeeds.every((seed) => seed === roundSeed)) {
    setWaitingReason(state, "round_seed_mismatch");
    return null;
  }

  const options = pickBridgeOptions(state.roomOptions, localOptions, roundSeed);
  const localGameId = sanitizeScalar(
    localPlayer.gameid ?? localOptions.gameid
  );
  if (localGameId === undefined) {
    setWaitingReason(state, "round_options_incomplete");
    return null;
  }

  const readyAt =
    (state.roundObservedAt || capturedAt) +
    normalizeDuration(options.precountdown ?? 0) +
    normalizeCount(options.countdown_count ?? 0) *
      normalizeDuration(options.countdown_interval ?? 0);

  return {
    roomSeed: sanitizeScalar(state.roomOptions.seed),
    bridge: {
      roundId: `${localGameId}:${roundSeed}`,
      readyAt,
      local: summarizeBridgePlayer(localPlayer, state.selfUser),
      opponents: opponents.map((player) => summarizeBridgePlayer(player, null)),
      options
    }
  };
}

function updateSelfUserCache(state, root) {
  const user = asPlainObject(root.user);
  if (!user) {
    return;
  }

  const userid = sanitizeScalar(user._id ?? user.userid ?? user.user_id);
  const username = sanitizeScalar(user.username ?? user.name);
  if (userid !== undefined) {
    state.selfUser.userid = userid;
  }
  if (username !== undefined) {
    state.selfUser.username = username;
  }
}

function updateRoomUsersCache(state, root) {
  const players = Array.isArray(root.players) ? root.players : null;
  if (!players) {
    return;
  }

  for (const player of players) {
    const source = asPlainObject(player);
    if (!source) {
      continue;
    }
    const userid = sanitizeScalar(source._id ?? source.userid ?? source.user_id);
    const username = sanitizeScalar(source.username ?? source.name);
    if (userid === undefined) {
      continue;
    }

    const entry = state.roomUsers.get(userid) ?? { userid, username: null };
    if (username !== undefined) {
      entry.username = username;
    }
    state.roomUsers.set(userid, entry);
  }
}

function updateRoundPlayersCache(state, root) {
  const players = Array.isArray(root.players) ? root.players : null;
  if (!players) {
    return;
  }

  for (const player of players) {
    const source = asPlainObject(player);
    if (!source) {
      continue;
    }

    const userid = sanitizeScalar(source.userid ?? source._id ?? source.user_id);
    if (userid === undefined) {
      continue;
    }

    const gameid = sanitizeScalar(source.gameid ?? source?.options?.gameid);
    const username =
      sanitizeScalar(source.username ?? source.name ?? source?.options?.username) ??
      state.roomUsers.get(userid)?.username ??
      null;
    const options = asPlainObject(source.options);

    const hasRoundData =
      gameid !== undefined ||
      (options && Object.keys(options).length > 0);
    if (!hasRoundData) {
      continue;
    }

    const entry = state.roundPlayers.get(userid) ?? {
      userid,
      username: null,
      gameid: undefined,
      options: {}
    };

    if (username !== null) {
      entry.username = username;
    }
    if (gameid !== undefined) {
      entry.gameid = gameid;
    }
    if (options) {
      entry.options = {
        ...entry.options,
        ...pickScalarFields(options, ROOM_OPTION_KEYS.concat(["gameid", "username"]))
      };
    }
    state.roundPlayers.set(userid, entry);
  }

  for (const [userid, entry] of state.roundPlayers.entries()) {
    if (!entry.username && state.roomUsers.has(userid)) {
      entry.username = state.roomUsers.get(userid)?.username ?? entry.username;
      state.roundPlayers.set(userid, entry);
    }
  }
}

function updateRoomOptionsCache(state, root) {
  const options = asPlainObject(root.options);
  if (!options) {
    return;
  }

  state.roomOptions = {
    ...state.roomOptions,
    ...pickScalarFields(options, ROOM_OPTION_KEYS)
  };
}

function updateRoundObservation(state, capturedAt) {
  const observationKey = [...state.roundPlayers.values()]
    .map((player) => {
      const seed = sanitizeScalar(player?.options?.seed) ?? "";
      const gameid = sanitizeScalar(player?.gameid ?? player?.options?.gameid) ?? "";
      return `${player?.userid ?? ""}:${gameid}:${seed}`;
    })
    .filter((entry) => entry !== "::")
    .sort()
    .join("|");

  if (!observationKey) {
    return;
  }
  if (state.roundObservationKey !== observationKey) {
    state.roundObservationKey = observationKey;
    state.roundObservedAt = capturedAt;
  }
}

function resolveLocalPlayer(selfUser, roundPlayers) {
  if (selfUser.userid !== null && selfUser.userid !== undefined) {
    const matches = roundPlayers.filter(
      (player) => player.userid === selfUser.userid
    );
    if (matches.length === 1) {
      return matches[0];
    }
    return null;
  }

  if (selfUser.username !== null && selfUser.username !== undefined) {
    const matches = roundPlayers.filter(
      (player) => player.username === selfUser.username
    );
    if (matches.length === 1) {
      return matches[0];
    }
  }

  return null;
}

function summarizeBridgePlayer(player, selfUser = null) {
  const summary = {
    username:
      sanitizeScalar(player?.username) ??
      sanitizeScalar(selfUser?.username) ??
      null,
    userid: sanitizeScalar(player?.userid) ?? null,
    gameid: sanitizeScalar(player?.gameid ?? player?.options?.gameid) ?? null
  };
  return summary;
}

function withBackfilledRoundUsername(state, player) {
  if (!player) {
    return player;
  }
  if (player.username) {
    return player;
  }
  return {
    ...player,
    username: state.roomUsers.get(player.userid)?.username ?? null
  };
}

function pickBridgeOptions(roomOptions, localOptions, roundSeed) {
  const options = { seed: roundSeed };
  for (const key of BRIDGE_OPTION_KEYS) {
    const localValue = sanitizeScalar(localOptions?.[key]);
    const roomValue = sanitizeScalar(roomOptions?.[key]);
    if (localValue !== undefined) {
      options[key] = localValue;
    } else if (roomValue !== undefined) {
      options[key] = roomValue;
    }
  }
  return options;
}

function maybeLogResolvedLocalPlayer(state, local, log) {
  const signature = [
    local?.username ?? "",
    local?.userid ?? "",
    local?.gameid ?? ""
  ].join("|");
  if (!signature || signature === state.lastLocalPlayerSignature) {
    return;
  }
  state.lastLocalPlayerSignature = signature;
  log?.(
    `[vs-bridge] local player username=${local.username ?? "null"} userid=${local.userid ?? "null"} gameid=${local.gameid ?? "null"}`
  );
}

function setWaitingReason(state, reason) {
  if (state.lastWaitingReason === reason) {
    return;
  }
  state.lastWaitingReason = reason;
  state.log?.(`[vs-bridge] waiting reason=${reason}`);
}

function clearWaitingReason(state) {
  state.lastWaitingReason = "";
}

function safeWriteBridgeFile(state, log) {
  try {
    writeVsBridgeFile(state.bridgeFilePath, state.current);
    return true;
  } catch (error) {
    log?.(`[vs-bridge] write failed: ${error?.message ?? String(error)}`);
    return false;
  }
}

function displayPath(filePath) {
  return String(filePath).replace(/\\/g, "/");
}

function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return Date.now();
  }
  return Math.floor(number);
}

function hasScalarKeys(value, keys) {
  return keys.every((key) => sanitizeScalar(value?.[key]) !== undefined);
}

function asPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function walkBridgeObject(
  value,
  pathLabel,
  lineage,
  seen,
  counters,
  visit,
  depth
) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (depth > MAX_DEPTH || counters.visitedObjects >= MAX_VISITED_OBJECTS) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  counters.visitedObjects += 1;

  visit(value, pathLabel, lineage);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walkBridgeObject(
        value[index],
        `${pathLabel}[${index}]`,
        lineage,
        seen,
        counters,
        visit,
        depth + 1
      );
    }
    return;
  }

  const nextLineage = [{ value }, ...lineage].slice(0, 4);
  for (const key of Object.keys(value)) {
    walkBridgeObject(
      value[key],
      `${pathLabel}.${key}`,
      nextLineage,
      seen,
      counters,
      visit,
      depth + 1
    );
  }
}

function buildIncomingGarbageEvent(value, pathLabel, lineage, currentBridge) {
  const eventType = sanitizeScalar(value?.type);
  if (eventType !== "interaction") {
    return null;
  }

  const data = value?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  if (sanitizeScalar(data.type) !== "garbage") {
    return null;
  }

  const ownerGameId = findOwnerGameId(lineage);
  if (ownerGameId === undefined || ownerGameId === currentBridge.local.gameid) {
    return null;
  }

  const targetGameId = sanitizeScalar(data.gameid);
  if (targetGameId !== currentBridge.local.gameid) {
    return null;
  }
  if (/\.copies(\[\d+\])?\./.test(pathLabel)) {
    return null;
  }

  const garbageData = pickScalarFields(data, GARBAGE_DATA_KEYS);
  const dedupeKey = [
    currentBridge.roundId,
    ownerGameId,
    garbageData.gameid ?? "",
    garbageData.iid ?? "",
    garbageData.cid ?? "",
    garbageData.frame ?? ""
  ].join("|");

  return {
    ownerGameId,
    eventType,
    eventFrame: sanitizeScalar(value.frame),
    eventId: sanitizeScalar(value.id),
    data: garbageData,
    dedupeKey
  };
}

function bridgeSessionShouldEnd(root, localGameId) {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return false;
  }

  if (Array.isArray(root.players)) {
    for (const player of root.players) {
      if (!player || typeof player !== "object") {
        continue;
      }
      if (sanitizeScalar(player.gameid) !== localGameId) {
        continue;
      }
      if (player.alive === false) {
        return true;
      }
      if (sanitizeScalar(player.gameoverreason) !== undefined) {
        return true;
      }
    }
  }

  if (sanitizeScalar(root.gameid) === localGameId) {
    if (root.alive === false) {
      return true;
    }
    if (sanitizeScalar(root.gameoverreason) !== undefined) {
      return true;
    }
  }

  return false;
}

function findOwnerGameId(lineage) {
  for (const entry of lineage) {
    const source = entry?.value;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    const gameid = sanitizeScalar(source.gameid ?? source.game_id);
    if (gameid !== undefined) {
      return gameid;
    }
  }
  return undefined;
}

function pickScalarFields(source, keys) {
  const picked = {};
  for (const key of keys) {
    const scalar = sanitizeScalar(source?.[key]);
    if (scalar !== undefined) {
      picked[key] = scalar;
    }
  }
  return picked;
}

function normalizeDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  if (number > 0 && number < 60) {
    return number * 1000;
  }
  return number;
}

function normalizeCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return Math.floor(number);
}

function sanitizeScalar(value) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}
