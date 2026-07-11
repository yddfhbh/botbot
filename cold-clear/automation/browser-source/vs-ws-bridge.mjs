import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_BRIDGE_PATH = path.join("automation", "vs-ws-bridge.json");
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
  return {
    bridgeFilePath,
    sequence: 0,
    current: null,
    garbageKeys: new Set(),
    lastDisabledRoundId: "",
    log
  };
}

export function updateVsBridgeState(
  state,
  decodedRoots,
  log = state?.log ?? null,
  capturedAt = Date.now()
) {
  if (!state) {
    return null;
  }

  for (const root of decodedRoots) {
    const round = deriveVsRoundBridge(root, capturedAt);
    if (round && round.bridge.roundId !== state.current?.roundId) {
      state.sequence += 1;
      state.current = {
        ...round.bridge,
        version: 1,
        sequence: state.sequence,
        active: true,
        capturedAt,
        incomingGarbage: []
      };
      state.garbageKeys.clear();
      state.lastDisabledRoundId = "";
      writeVsBridgeFile(state.bridgeFilePath, state.current);
      log?.(
        `[vs-sim] local player username=${state.current.local.username} gameid=${state.current.local.gameid}`
      );
      log?.(`[vs-sim] round seed=${state.current.options.seed}`);
      if (round.roomSeed !== undefined) {
        log?.(`[vs-sim] room seed ignored=${round.roomSeed}`);
      }
      log?.("[vs-sim] shared round seed verified");
    }

    if (!state.current?.active) {
      continue;
    }

    if (bridgeSessionShouldEnd(root, state.current.local.gameid)) {
      markVsBridgeInactive(state, log);
      continue;
    }

    const garbageEvents = collectVsIncomingGarbage(root, state.current);
    if (garbageEvents.length === 0) {
      continue;
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
        `[vs-sim] incoming garbage observed amt=${event.data.amt ?? 0} hole=${event.data.x ?? 0}`
      );
      log?.("[vs-sim] garbage application disabled in validation phase");
    }
    if (changed) {
      state.sequence += 1;
      state.current.sequence = state.sequence;
      writeVsBridgeFile(state.bridgeFilePath, state.current);
    }
  }

  return state.current;
}

export function markVsBridgeInactive(state, log = state?.log ?? null) {
  if (!state?.current?.active) {
    return;
  }
  state.sequence += 1;
  state.current = {
    ...state.current,
    sequence: state.sequence,
    active: false,
    capturedAt: Date.now()
  };
  writeVsBridgeFile(state.bridgeFilePath, state.current);
  log?.(`[vs-sim] round ended roundId=${state.current.roundId}`);
}

export function deriveVsRoundBridge(root, capturedAt = Date.now()) {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return null;
  }
  const players = Array.isArray(root.players) ? root.players : null;
  if (!players || players.length !== 2) {
    return null;
  }

  const localIndex = findLocalPlayerIndex(root.user, players);
  if (localIndex < 0) {
    return null;
  }

  const local = summarizeBridgePlayer(players[localIndex]);
  if (!local?.username || !local?.userid || local?.gameid === undefined) {
    return null;
  }

  const playerSeeds = players
    .map((player) => sanitizeScalar(player?.options?.seed))
    .filter((seed) => seed !== undefined);
  if (playerSeeds.length !== players.length) {
    return null;
  }
  const roundSeed = playerSeeds[localIndex];
  if (roundSeed === undefined) {
    return null;
  }
  if (!playerSeeds.every((seed) => seed === roundSeed)) {
    return null;
  }

  const opponents = players
    .map((player, index) => (index === localIndex ? null : summarizeBridgePlayer(player)))
    .filter(Boolean);
  if (opponents.length !== 1) {
    return null;
  }

  const rootOptions = root.options && typeof root.options === "object" ? root.options : {};
  const localOptions =
    players[localIndex].options && typeof players[localIndex].options === "object"
      ? players[localIndex].options
      : {};
  const options = pickBridgeOptions(rootOptions, localOptions, roundSeed);
  if (!options.bagtype) {
    return null;
  }

  const readyAt =
    capturedAt +
    normalizeDuration(options.precountdown ?? 0) +
    normalizeCount(options.countdown_count ?? 0) *
      normalizeDuration(options.countdown_interval ?? 0);

  return {
    roomSeed: sanitizeScalar(rootOptions.seed),
    bridge: {
      roundId: `${local.gameid}:${roundSeed}`,
      readyAt,
      local,
      opponents,
      options
    }
  };
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

function pickBridgeOptions(rootOptions, localOptions, roundSeed) {
  const options = { seed: roundSeed };
  for (const key of BRIDGE_OPTION_KEYS) {
    const localValue = sanitizeScalar(localOptions[key]);
    const rootValue = sanitizeScalar(rootOptions[key]);
    if (localValue !== undefined) {
      options[key] = localValue;
    } else if (rootValue !== undefined) {
      options[key] = rootValue;
    }
  }
  return options;
}

function findLocalPlayerIndex(user, players) {
  if (!user || typeof user !== "object") {
    return -1;
  }

  const userId = sanitizeScalar(user._id);
  if (userId !== undefined) {
    const idMatches = players
      .map((player, index) =>
        sanitizeScalar(player?.userid) === userId ? index : null
      )
      .filter((index) => index !== null);
    if (idMatches.length === 1) {
      return idMatches[0];
    }
  }

  const username = sanitizeScalar(user.username);
  if (username !== undefined) {
    const nameMatches = players
      .map((player, index) =>
        sanitizeScalar(player?.username) === username ? index : null
      )
      .filter((index) => index !== null);
    if (nameMatches.length === 1) {
      return nameMatches[0];
    }
  }

  return -1;
}

function summarizeBridgePlayer(player) {
  if (!player || typeof player !== "object" || Array.isArray(player)) {
    return null;
  }
  const summary = {};
  for (const key of ["username", "userid", "gameid"]) {
    const scalar = sanitizeScalar(player[key]);
    if (scalar !== undefined) {
      summary[key] = scalar;
    }
  }
  return summary;
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
    const scalar = sanitizeScalar(source[key]);
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
