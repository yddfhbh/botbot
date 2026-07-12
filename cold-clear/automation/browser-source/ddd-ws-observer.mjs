import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_BRIDGE_PATH,
  createVsBridgeState,
  ingestVsBridgeRoot,
  isVsWsSimEnabled,
  markVsBridgeInactive,
} from "./vs-ws-bridge.mjs";

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_VISITED_OBJECTS = 5000;
const MAX_TRACE_RECORDS = 500;
const MAX_TRACE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TRACE_RECORD_BYTES = 32 * 1024;
const DEFAULT_TRACE_FILE_PATH = path.join("automation", "ws-live-candidates.jsonl");
const DEFAULT_VS_BRIDGE_PATH = DEFAULT_BRIDGE_PATH;
const SENSITIVE_KEYS = new Set([
  "token",
  "auth",
  "authorization",
  "cookie",
  "session",
  "jwt",
  "password",
  "secret",
  "signature",
  "endpoint",
  "handling"
]);
const ALLOWED_OPTION_KEYS = [
  "seed",
  "bagtype",
  "nextcount",
  "boardwidth",
  "boardheight",
  "boardbuffer",
  "countdown",
  "countdown_count",
  "countdown_interval",
  "precountdown",
  "gameid",
  "gametype",
  "spinbonuses",
  "combotable",
  "b2bcharging",
  "garbagemultiplier",
  "garbagecap",
  "garbageblocking",
  "display_next",
  "display_hold"
];
const IDENTITY_KEYS = new Set([
  "gameid",
  "game_id",
  "id",
  "userid",
  "user_id",
  "username",
  "name",
  "players",
  "player",
  "slot",
  "index"
]);
const BOARD_KEYS = new Set(["board", "field"]);
const PIECE_KEYS = new Set([
  "falling",
  "active",
  "current",
  "piece",
  "hold",
  "held",
  "queue",
  "bag",
  "next",
  "preview",
  "pieces"
]);
const REPLAY_KEYS = new Set([
  "replay",
  "events",
  "frames",
  "frame",
  "ige",
  "data",
  "key",
  "keys",
  "inputs",
  "interaction",
  "lock",
  "spawn"
]);
const GARBAGE_KEYS = new Set([
  "garbage",
  "garbagequeue",
  "incoming",
  "targets",
  "target",
  "attack",
  "damage",
  "gameover",
  "gameoverreason",
  "winner",
  "victims"
]);
const CONTEXT_KEYS = [
  "username",
  "name",
  "userid",
  "gameid",
  "slot",
  "index",
  "local",
  "self",
  "me",
  "opponent",
  "type",
  "role"
];
const TRACE_FIRST_LOG_KINDS = new Set(["identity", "board", "replay", "garbage"]);
const TRACE_SUMMARY_SCALAR_KEYS = [
  "seed",
  "gameid",
  "username",
  "name",
  "userid",
  "piece",
  "current",
  "hold",
  "held",
  "incoming",
  "frame",
  "id",
  "slot",
  "index"
];
const GARBAGE_INTERACTION_EVENT_TYPES = new Set([
  "interaction",
  "interaction_confirm"
]);
const GARBAGE_INTERACTION_DATA_KEYS = [
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

function safeLog(log, message) {
  try {
    log?.(message);
  } catch {}
}

export async function installDddWsObserver(
  cdp,
  {
    unpack,
    log,
    traceEnabled = process.env.FUSION_DDD_WS_TRACE === "1",
    traceFilePath = DEFAULT_TRACE_FILE_PATH,
    vsSimEnabled = isVsWsSimEnabled(),
    vsBridgePath = DEFAULT_VS_BRIDGE_PATH,
    onVsRoundStatus = null,
    perfEnabled = process.env.FUSION_BROWSER_PERF === "1"
  } = {}
) {
  const logger = (message) => safeLog(log, message);

  if (typeof unpack !== "function") {
    safeLog(log, "[ws-observer] msgpackr unavailable; observer inactive");
    return () => {};
  }

  const vsBridgeEnabled =
    vsSimEnabled || typeof onVsRoundStatus === "function";

  let vsBridge = null;
  if (vsBridgeEnabled) {
    try {
      vsBridge = createVsBridgeState(vsBridgePath, logger);
    } catch (error) {
      safeLog(
        log,
        `[vs-bridge] initialization failed: ${error?.message ?? String(error)}`
      );
    }
  }

  const observerState = {
    requestUrls: new Map(),
    lastOptionsSignature: "",
    framesReceived: 0,
    binaryFramesReceived: 0,
    decodeAttempts: 0,
    optionsCaptured: 0,
    trace: null,
    vsBridge,
    lastVsRoundStatusKey: "",
    perf: perfEnabled
      ? {
          lastLoggedAt: Date.now(),
          wsFrames: 0,
          wsFrameElapsedTotalMs: 0
        }
      : null
  };
  if (traceEnabled) {
    try {
      observerState.trace = createTraceRecorder(traceFilePath, logger);
    } catch (error) {
      safeLog(
        log,
        `[ws-trace] disabled after initialization error: ${
          error?.message ?? String(error)
        }`
      );
    }
  }

  await cdp.send("Network.enable").catch(() => undefined);

  const offCreated = cdp.on("Network.webSocketCreated", (event) => {
    try {
      const requestId = event?.requestId;
      const url = typeof event?.url === "string" ? event.url : "";
      if (!requestId || !url) {
        return;
      }
      observerState.requestUrls.set(requestId, url);
      safeLog(log, `[ws-observer] websocket opened host=${safeUrlHost(url)}`);
    } catch {}
  });

  const offClosed = cdp.on("Network.webSocketClosed", (event) => {
    try {
      if (event?.requestId) {
        observerState.requestUrls.delete(event.requestId);
      }
      markVsBridgeInactive(observerState.vsBridge, logger);
      emitVsRoundStatusIfChanged(observerState, onVsRoundStatus);
    } catch {}
  });

  const offReceived = cdp.on("Network.webSocketFrameReceived", (event) => {
    try {
      const frameStartedAt = Date.now();
      observerState.framesReceived += 1;
      const payloadData = event?.response?.payloadData;
      if (typeof payloadData !== "string" || payloadData.length === 0) {
        recordPerfFrame(observerState, frameStartedAt, logger);
        return;
      }

      const opcode = event?.response?.opcode;
      if (opcode === 2) {
        observerState.binaryFramesReceived += 1;
        const payload = Buffer.from(payloadData, "base64");
        if (payload.length === 0 || payload.length > MAX_PAYLOAD_BYTES) {
          return;
        }
        const decodedRoots = collectDecodedRoots(payload, unpack);
        const candidates = collectOptionCandidates(decodedRoots);
        const timestamp = Date.now();
        const urlHost = resolveTraceUrlHost(event?.requestId, observerState);
        observerState.decodeAttempts += decodeAttemptCount(payload);
        for (const chunk of split87Frame(payload)) {
          observerState.decodeAttempts += decodeAttemptCount(chunk);
        }
        logCapturedCandidates(candidates, event?.requestId, observerState, log);
        for (const decodedRoot of decodedRoots) {
          try {
            ingestVsBridgeRoot(
              observerState.vsBridge,
              decodedRoot,
              {
                timestamp,
                urlHost,
                requestId: event?.requestId ?? null
              },
              logger
            );
          } catch {}
        }
        emitVsRoundStatusIfChanged(observerState, onVsRoundStatus);
        traceDecodedRoots(decodedRoots, event, observerState, log);
        recordPerfFrame(observerState, frameStartedAt, logger);
        return;
      }

      if (opcode === 1) {
        if (payloadData.length > MAX_PAYLOAD_BYTES) {
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(payloadData);
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== "object") {
          return;
        }
        const decodedRoots = collectDecodedRoots(parsed, unpack);
        const candidates = collectOptionCandidates(decodedRoots);
        const timestamp = Date.now();
        const urlHost = resolveTraceUrlHost(event?.requestId, observerState);
        logCapturedCandidates(candidates, event?.requestId, observerState, log);
        for (const decodedRoot of decodedRoots) {
          try {
            ingestVsBridgeRoot(
              observerState.vsBridge,
              decodedRoot,
              {
                timestamp,
                urlHost,
                requestId: event?.requestId ?? null
              },
              logger
            );
          } catch {}
        }
        emitVsRoundStatusIfChanged(observerState, onVsRoundStatus);
        traceDecodedRoots(decodedRoots, event, observerState, log);
      }
      recordPerfFrame(observerState, frameStartedAt, logger);
    } catch {}
  });

  return () => {
    markVsBridgeInactive(observerState.vsBridge, logger);
    emitVsRoundStatusIfChanged(observerState, onVsRoundStatus);
    offCreated();
    offClosed();
    offReceived();
    observerState.requestUrls.clear();
    finalizeTrace(observerState, logger);
  };
}

function emitVsRoundStatusIfChanged(observerState, onVsRoundStatus) {
  if (typeof onVsRoundStatus !== "function") {
    return;
  }

  const current = observerState?.vsBridge?.current ?? null;
  const active = Boolean(current?.active);
  const roundId = active ? String(current?.roundId ?? "") : "";
  const localGameId = active ? String(current?.local?.gameid ?? "") : "";
  const localUserId = active ? String(current?.local?.userid ?? "") : "";
  const localUsername = active ? String(current?.local?.username ?? "") : "";
  const seed = active ? String(current?.options?.seed ?? "") : "";
  const nextKey = `${active ? 1 : 0}|${roundId}|${localGameId}|${localUserId}|${localUsername}|${seed}`;
  if (nextKey === observerState.lastVsRoundStatusKey) {
    return;
  }
  observerState.lastVsRoundStatusKey = nextKey;
  try {
    onVsRoundStatus({
      active,
      roundId,
      localGameId,
      localUserId,
      localUsername,
      seed
    });
  } catch {}
}

function recordPerfFrame(observerState, frameStartedAt, log) {
  const perf = observerState?.perf;
  if (!perf) {
    return;
  }
  perf.wsFrames += 1;
  perf.wsFrameElapsedTotalMs += Math.max(0, Date.now() - frameStartedAt);
  if (Date.now() - perf.lastLoggedAt < 2000) {
    return;
  }
  safeLog(log, `[browser-perf] ws_frame elapsed_ms=${perf.wsFrameElapsedTotalMs}`);
  perf.lastLoggedAt = Date.now();
  perf.wsFrames = 0;
  perf.wsFrameElapsedTotalMs = 0;
}

export function split87Frame(buf) {
  const chunks = [];

  if (!Buffer.isBuffer(buf) || buf.length < 4) {
    return chunks;
  }

  if (buf[0] !== 0x87) {
    return chunks;
  }

  let pos = 4;

  while (pos + 4 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    pos += 4;

    if (
      length <= 0 ||
      length > 2 * 1024 * 1024 ||
      pos + length > buf.length
    ) {
      break;
    }

    chunks.push(buf.subarray(pos, pos + length));
    pos += length;
  }

  return chunks;
}

export function tryUnpackAtOffsets(buffer, unpack) {
  const values = [];

  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length === 0 ||
    typeof unpack !== "function"
  ) {
    return values;
  }

  const maximumOffset = Math.min(24, buffer.length - 1);

  for (let offset = 0; offset <= maximumOffset; offset += 1) {
    try {
      values.push(unpack(buffer.subarray(offset)));
    } catch {}
  }

  return values;
}

export function decodeGameOptionsCandidates(payload, unpack) {
  return collectOptionCandidates(collectDecodedRoots(payload, unpack));
}

export function findGameOptions(root) {
  const seen = new WeakSet();
  const counters = {
    visitedObjects: 0
  };
  return visitForGameOptions(root, 0, seen, counters);
}

export function sanitizeGameOptions(options) {
  if (!options || typeof options !== "object") {
    return null;
  }

  const sanitized = {};
  for (const key of ALLOWED_OPTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) {
      continue;
    }
    try {
      sanitized[key] = options[key];
    } catch {}
  }

  if (
    !Object.prototype.hasOwnProperty.call(sanitized, "seed") ||
    !Object.prototype.hasOwnProperty.call(sanitized, "bagtype")
  ) {
    return null;
  }

  return sanitized;
}

function collectDecodedCandidates(target, values) {
  for (const value of values) {
    const match = findGameOptions(value);
    const sanitized = sanitizeGameOptions(match);
    if (sanitized) {
      target.push(sanitized);
    }
  }
}

function visitForGameOptions(value, depth, seen, counters) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (depth > MAX_DEPTH || counters.visitedObjects >= MAX_VISITED_OBJECTS) {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }

  seen.add(value);
  counters.visitedObjects += 1;

  const directMatch = extractGameOptionsCandidate(value);
  if (directMatch) {
    return directMatch;
  }

  if (depth === MAX_DEPTH) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = visitForGameOptions(entry, depth + 1, seen, counters);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    let nestedValue;
    try {
      nestedValue = value[key];
    } catch {
      continue;
    }
    const nested = visitForGameOptions(
      nestedValue,
      depth + 1,
      seen,
      counters
    );
    if (nested) {
      return nested;
    }
  }

  return null;
}

function extractGameOptionsCandidate(value) {
  if (hasSeedAndBagtype(value)) {
    return value;
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "options") &&
    hasSeedAndBagtype(value.options)
  ) {
    return mergeAllowedOptionShape(value, value.options);
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "setoptions") &&
    hasSeedAndBagtype(value.setoptions)
  ) {
    return mergeAllowedOptionShape(value, value.setoptions);
  }

  return null;
}

function hasSeedAndBagtype(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, "seed") &&
      Object.prototype.hasOwnProperty.call(value, "bagtype")
  );
}

function mergeAllowedOptionShape(parent, child) {
  const merged = {};
  for (const source of [parent, child]) {
    for (const key of ALLOWED_OPTION_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        continue;
      }
      try {
        merged[key] = source[key];
      } catch {}
    }
  }
  return merged;
}

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(String(key).toLowerCase());
}

function logCapturedCandidates(candidates, requestId, observerState, log) {
  for (const options of candidates) {
    const signature = buildOptionsSignature(options);
    if (!signature || signature === observerState.lastOptionsSignature) {
      continue;
    }
    observerState.lastOptionsSignature = signature;
    observerState.optionsCaptured += 1;

    safeLog(log, "[ws-observer] game options captured");
    if (requestId && observerState.requestUrls.has(requestId)) {
      safeLog(
        log,
        `[ws-observer] url_host=${safeUrlHost(
          observerState.requestUrls.get(requestId)
        )}`
      );
    }
    safeLog(log, `[ws-observer] seed=${String(options.seed)}`);
    safeLog(log, `[ws-observer] bagtype=${String(options.bagtype)}`);
    if (Object.prototype.hasOwnProperty.call(options, "nextcount")) {
      safeLog(log, `[ws-observer] nextcount=${String(options.nextcount)}`);
    }
    if (
      Object.prototype.hasOwnProperty.call(options, "boardwidth") &&
      Object.prototype.hasOwnProperty.call(options, "boardheight")
    ) {
      safeLog(
        log,
        `[ws-observer] board=${String(options.boardwidth)}x${String(
          options.boardheight
        )}`
      );
    }
    if (Object.prototype.hasOwnProperty.call(options, "gameid")) {
      safeLog(log, `[ws-observer] gameid=${String(options.gameid)}`);
    }
  }
}

function buildOptionsSignature(options) {
  if (!options) {
    return "";
  }
  return [
    options.seed,
    options.bagtype,
    options.gameid,
    options.boardwidth,
    options.boardheight,
    options.nextcount
  ].join("|");
}

function safeUrlHost(url) {
  try {
    return new URL(url).host || "unknown";
  } catch {
    return "unknown";
  }
}

function decodeAttemptCount(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return 0;
  }
  return Math.min(24, buffer.length - 1) + 1;
}

function collectDecodedRoots(payload, unpack) {
  if (Buffer.isBuffer(payload)) {
    const roots = [];
    for (const chunk of split87Frame(payload)) {
      roots.push(...tryUnpackAtOffsets(chunk, unpack));
    }
    roots.push(...tryUnpackAtOffsets(payload, unpack));
    return roots;
  }

  if (payload && typeof payload === "object") {
    return [payload];
  }

  return [];
}

function collectOptionCandidates(decodedRoots) {
  const candidates = [];
  collectDecodedCandidates(candidates, decodedRoots);
  return candidates;
}

function createTraceRecorder(traceFilePath, log) {
  const filePath = path.resolve(traceFilePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  rmSync(filePath, { force: true });
  safeLog(log, `[ws-trace] recording ${traceFilePath.replace(/\\/g, "/")}`);
  return {
    filePath,
    displayPath: traceFilePath.replace(/\\/g, "/"),
    records: 0,
    fileBytes: 0,
    stopped: false,
    stopLogged: false,
    signatureCounts: new Map(),
    firstKindsLogged: new Set(),
    kindCounts: {
      options: 0,
      identity: 0,
      board: 0,
      piece: 0,
      replay: 0,
      garbage: 0,
      garbage_interaction: 0,
      round_start: 0,
      mixed: 0
    }
  };
}

function traceDecodedRoots(decodedRoots, event, observerState, log) {
  const trace = observerState.trace;
  if (!trace || trace.stopped) {
    return;
  }

  for (const root of decodedRoots) {
    try {
      const candidates = collectTraceCandidates(root);
      for (const candidate of candidates) {
        maybeRecordTraceCandidate(candidate, event, observerState, log);
      }
    } catch {}
  }
}

function collectTraceCandidates(root) {
  const candidates = [];
  const seen = new WeakSet();
  const counters = {
    visitedObjects: 0
  };

  walkTraceCandidates(root, "root", [], seen, counters, candidates, 0);
  return candidates;
}

function walkTraceCandidates(
  value,
  pathLabel,
  ancestors,
  seen,
  counters,
  candidates,
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

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walkTraceCandidates(
        value[index],
        `${pathLabel}[${index}]`,
        ancestors,
        seen,
        counters,
        candidates,
        depth + 1
      );
    }
    return;
  }

  const lineage = [{ value, path: pathLabel }, ...ancestors];
  candidates.push(...buildTraceEntriesForObject(value, pathLabel, lineage));

  const nextAncestors = lineage.slice(0, 4);
  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    let nextValue;
    try {
      nextValue = value[key];
    } catch {
      continue;
    }
    walkTraceCandidates(
      nextValue,
      `${pathLabel}.${key}`,
      nextAncestors,
      seen,
      counters,
      candidates,
      depth + 1
    );
  }
}

function buildTraceEntriesForObject(value, pathLabel, lineage) {
  const entries = [];
  const safeKeys = Object.keys(value).filter((key) => !isSensitiveKey(key));
  const keySet = new Set(safeKeys.map((key) => key.toLowerCase()));
  const roundStartRecord =
    pathLabel === "root" ? buildRoundStartTraceRecord(value) : null;
  if (roundStartRecord) {
    entries.push(roundStartRecord);
  }
  const garbageInteractionRecord = buildGarbageInteractionRecord(
    value,
    lineage
  );
  if (garbageInteractionRecord) {
    entries.push(garbageInteractionRecord);
  }

  if (hasSeedAndBagtype(value)) {
    entries.push(buildOptionTraceRecord(value, pathLabel, lineage));
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "options") &&
    hasSeedAndBagtype(value.options)
  ) {
    entries.push(
      buildOptionTraceRecord(
        mergeAllowedOptionShape(value, value.options),
        `${pathLabel}.options`,
        [{ value: value.options, path: `${pathLabel}.options` }, ...lineage]
      )
    );
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "setoptions") &&
    hasSeedAndBagtype(value.setoptions)
  ) {
    entries.push(
      buildOptionTraceRecord(
        mergeAllowedOptionShape(value, value.setoptions),
        `${pathLabel}.setoptions`,
        [{ value: value.setoptions, path: `${pathLabel}.setoptions` }, ...lineage]
      )
    );
  }

  const kind = classifyTraceKind(keySet);
  if (kind) {
    entries.push(buildTraceRecord(kind, value, pathLabel, safeKeys, lineage));
  }

  return entries;
}

function buildOptionTraceRecord(options, pathLabel, lineage) {
  const sanitized = sanitizeGameOptions(options);
  if (!sanitized) {
    return null;
  }

  return {
    kind: "options",
    path: pathLabel,
    keys: Object.keys(sanitized).sort(),
    context: extractTraceContext(lineage),
    summary: summarizeTraceObject(sanitized),
    ...sanitized
  };
}

function buildTraceRecord(kind, value, pathLabel, safeKeys, lineage) {
  return {
    kind,
    path: pathLabel,
    keys: safeKeys.sort(),
    context: extractTraceContext(lineage),
    summary: summarizeTraceObject(value)
  };
}

function buildGarbageInteractionRecord(value, lineage) {
  const eventType = sanitizeTraceScalar(value.type);
  if (!GARBAGE_INTERACTION_EVENT_TYPES.has(eventType)) {
    return null;
  }

  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  if (sanitizeTraceScalar(data.type) !== "garbage") {
    return null;
  }

  const record = {
    kind: "garbage_interaction",
    eventType,
    data: pickScalarFields(data, GARBAGE_INTERACTION_DATA_KEYS)
  };
  const eventFrame = sanitizeTraceScalar(value.frame);
  if (eventFrame !== undefined) {
    record.eventFrame = eventFrame;
  }
  const eventId = sanitizeTraceScalar(value.id);
  if (eventId !== undefined) {
    record.eventId = eventId;
  }
  const ownerGameId = findOwnerGameId(lineage);
  if (ownerGameId !== undefined) {
    record.ownerGameId = ownerGameId;
  }
  return record;
}

function buildRoundStartTraceRecord(value) {
  const players = Array.isArray(value.players) ? value.players : null;
  if (!players) {
    return null;
  }

  const summarizedPlayers = players
    .map((player) => summarizeRoundStartPlayer(player))
    .filter((player) => player && Object.keys(player).length > 0);
  if (summarizedPlayers.length === 0) {
    return null;
  }

  const record = {
    kind: "round_start",
    players: summarizedPlayers
  };
  const roomSeed = sanitizeTraceScalar(value?.options?.seed);
  if (roomSeed !== undefined) {
    record.roomSeed = roomSeed;
  }
  return record;
}

function summarizeRoundStartPlayer(player) {
  if (!player || typeof player !== "object" || Array.isArray(player)) {
    return null;
  }

  const summary = {};
  for (const key of ["username", "userid", "gameid", "seed"]) {
    const scalar = sanitizeTraceScalar(player[key]);
    if (scalar !== undefined) {
      summary[key] = scalar;
    }
  }
  return summary;
}

function classifyTraceKind(keySet) {
  const matchedKinds = [];
  if (matchesAnyKeySet(keySet, IDENTITY_KEYS)) {
    matchedKinds.push("identity");
  }
  if (matchesAnyKeySet(keySet, BOARD_KEYS)) {
    matchedKinds.push("board");
  }
  if (matchesAnyKeySet(keySet, PIECE_KEYS)) {
    matchedKinds.push("piece");
  }
  if (matchesAnyKeySet(keySet, REPLAY_KEYS)) {
    matchedKinds.push("replay");
  }
  if (matchesAnyKeySet(keySet, GARBAGE_KEYS)) {
    matchedKinds.push("garbage");
  }

  if (matchedKinds.length === 0) {
    return null;
  }
  if (matchedKinds.length === 1) {
    return matchedKinds[0];
  }
  return "mixed";
}

function matchesAnyKeySet(source, expected) {
  for (const key of expected) {
    if (source.has(key)) {
      return true;
    }
  }
  return false;
}

function extractTraceContext(lineage) {
  const context = {};
  for (const entry of lineage.slice(0, 4)) {
    const source = entry?.value;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    for (const key of CONTEXT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(context, key)) {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        continue;
      }
      const scalar = sanitizeTraceScalar(source[key]);
      if (scalar !== undefined) {
        context[key] = scalar;
      }
    }
  }
  return context;
}

function summarizeTraceObject(value) {
  const summary = {};

  if (!value || typeof value !== "object") {
    return summary;
  }

  for (const key of TRACE_SUMMARY_SCALAR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || isSensitiveKey(key)) {
      continue;
    }
    const scalar = sanitizeTraceScalar(value[key]);
    if (scalar !== undefined) {
      summary[key] = scalar;
    }
  }

  const playerArray = findDirectArray(value, ["players"]);
  if (playerArray) {
    summary.playerCount = playerArray.length;
  }

  const boardInfo = findBoardSummary(value);
  if (boardInfo) {
    Object.assign(summary, boardInfo);
  }

  const queueInfo = findQueueSummary(value);
  if (queueInfo) {
    Object.assign(summary, queueInfo);
  }

  const replayInfo = findReplaySummary(value);
  if (replayInfo) {
    Object.assign(summary, replayInfo);
  }

  return summary;
}

function findBoardSummary(value) {
  const board = findFirstOwnObject(value, ["board", "field"]);
  if (!Array.isArray(board) || board.length < 20 || board.length > 40) {
    return null;
  }

  const row = board.find((entry) => Array.isArray(entry));
  if (!row || row.length < 8 || row.length > 12) {
    return null;
  }

  let filledCells = 0;
  for (const currentRow of board) {
    if (!Array.isArray(currentRow)) {
      continue;
    }
    for (const cell of currentRow) {
      if (cell) {
        filledCells += 1;
      }
    }
  }

  return {
    boardRows: board.length,
    boardWidth: row.length,
    filledCells
  };
}

function findQueueSummary(value) {
  const queue = findDirectArray(value, ["queue", "bag", "next", "preview", "pieces"]);
  if (!queue) {
    return null;
  }

  const sample = queue
    .slice(0, 12)
    .map((entry) => sanitizeTraceScalar(entry))
    .filter((entry) => entry !== undefined);

  return {
    queueLength: queue.length,
    queueSample: sample
  };
}

function findReplaySummary(value) {
  const eventContainer = findEventContainer(value);
  if (!eventContainer) {
    return null;
  }

  const { label, events } = eventContainer;
  const summary = {
    [label === "frames" ? "frameCount" : "eventCount"]: events.length,
    eventSamples: events.slice(0, 3).map(summarizeReplayEvent)
  };

  return summary;
}

function findEventContainer(value) {
  const directEvents = findDirectArray(value, ["events", "frames"]);
  if (directEvents) {
    return {
      label: Object.prototype.hasOwnProperty.call(value, "frames") ? "frames" : "events",
      events: directEvents
    };
  }

  for (const key of ["replay", "data"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || isSensitiveKey(key)) {
      continue;
    }
    const nested = value[key];
    if (!nested || typeof nested !== "object") {
      continue;
    }
    const nestedEvents = findDirectArray(nested, ["events", "frames"]);
    if (nestedEvents) {
      return {
        label: Object.prototype.hasOwnProperty.call(nested, "frames") ? "frames" : "events",
        events: nestedEvents
      };
    }
  }

  return null;
}

function summarizeReplayEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return {};
  }

  const sample = {
    keys: Object.keys(event).filter((key) => !isSensitiveKey(key)).sort()
  };

  const frame = sanitizeTraceScalar(event.frame);
  if (frame !== undefined) {
    sample.frame = frame;
  }
  const type = sanitizeTraceScalar(event.type);
  if (type !== undefined) {
    sample.type = type;
  }
  const id = sanitizeTraceScalar(event.id);
  if (id !== undefined) {
    sample.id = id;
  }
  if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
    sample.dataKeys = Object.keys(event.data)
      .filter((key) => !isSensitiveKey(key))
      .sort();
  }

  return sample;
}

function maybeRecordTraceCandidate(candidate, event, observerState, log) {
  if (!candidate) {
    return;
  }

  const trace = observerState.trace;
  if (!trace || trace.stopped) {
    return;
  }

  const record = {
    timestamp: Date.now(),
    urlHost: resolveTraceUrlHost(event?.requestId, observerState),
    requestId: event?.requestId ?? null,
    opcode: event?.response?.opcode ?? null,
    ...candidate
  };
  if (Object.keys(record.context ?? {}).length === 0) {
    delete record.context;
  }
  if (Object.keys(record.summary ?? {}).length === 0) {
    delete record.summary;
  }

  const signature = buildTraceSignature(record);
  const duplicateLimit = traceDuplicateLimit(record);
  const seenCount = trace.signatureCounts.get(signature) ?? 0;
  if (seenCount >= duplicateLimit) {
    return;
  }

  const serialized = JSON.stringify(record);
  const serializedBytes = Buffer.byteLength(serialized);
  if (serializedBytes > MAX_TRACE_RECORD_BYTES) {
    return;
  }

  if (
    trace.records >= MAX_TRACE_RECORDS ||
    trace.fileBytes + serializedBytes + 1 > MAX_TRACE_FILE_BYTES
  ) {
    stopTraceRecording(trace, log);
    return;
  }

  try {
    appendFileSync(trace.filePath, `${serialized}\n`);
  } catch {
    stopTraceRecording(trace, log);
    return;
  }

  trace.signatureCounts.set(signature, seenCount + 1);
  trace.records += 1;
  trace.fileBytes += serializedBytes + 1;
  trace.kindCounts[record.kind] = (trace.kindCounts[record.kind] ?? 0) + 1;

  if (
    TRACE_FIRST_LOG_KINDS.has(record.kind) &&
    !trace.firstKindsLogged.has(record.kind)
  ) {
    trace.firstKindsLogged.add(record.kind);
    safeLog(log, `[ws-trace] first ${record.kind} candidate`);
  }
}

function buildTraceSignature(record) {
  if (record.kind === "garbage_interaction") {
    const data = record.data ?? {};
    return [
      record.eventType ?? "",
      record.ownerGameId ?? "",
      data.gameid ?? "",
      data.iid ?? "",
      data.ackiid ?? "",
      data.cid ?? "",
      data.frame ?? "",
      data.amt ?? "",
      data.size ?? "",
      data.x ?? ""
    ].join("|");
  }

  if (record.kind === "round_start") {
    const players = Array.isArray(record.players)
      ? record.players
          .map((player) =>
            [
              player?.username ?? "",
              player?.userid ?? "",
              player?.gameid ?? "",
              player?.seed ?? ""
            ].join(":")
          )
          .join("|")
      : "";
    return ["round_start", record.roomSeed ?? "", players].join("|");
  }

  const keys = Array.isArray(record.keys) ? [...record.keys].sort().join(",") : "";
  const summary = record.summary ?? {};
  const context = record.context ?? {};
  const firstEventType =
    Array.isArray(summary.eventSamples) && summary.eventSamples[0]
      ? summary.eventSamples[0].type ?? ""
      : "";

  return [
    record.urlHost ?? "",
    record.kind ?? "",
    record.path ?? "",
    keys,
    record.gameid ?? summary.gameid ?? context.gameid ?? "",
    context.username ?? summary.username ?? context.name ?? summary.name ?? "",
    record.seed ?? summary.seed ?? "",
    summary.boardRows ?? "",
    summary.queueLength ?? "",
    firstEventType,
    summary.current ?? summary.piece ?? "",
    summary.hold ?? summary.held ?? "",
    summary.frame ?? "",
    summary.incoming ?? "",
    summary.filledCells ?? ""
  ].join("|");
}

function traceDuplicateLimit(record) {
  if (record.kind === "garbage_interaction" || record.kind === "round_start") {
    return 1;
  }
  return 3;
}

function resolveTraceUrlHost(requestId, observerState) {
  if (!requestId || !observerState.requestUrls.has(requestId)) {
    return "unknown";
  }
  return safeUrlHost(observerState.requestUrls.get(requestId));
}

function sanitizeTraceScalar(value) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

function pickScalarFields(value, keys) {
  const record = {};
  for (const key of keys) {
    if (isSensitiveKey(key) || !Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    const scalar = sanitizeTraceScalar(value[key]);
    if (scalar !== undefined) {
      record[key] = scalar;
    }
  }
  return record;
}

function findOwnerGameId(lineage) {
  for (const entry of lineage) {
    const source = entry?.value;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    for (const key of ["gameid", "game_id"]) {
      const scalar = sanitizeTraceScalar(source[key]);
      if (scalar !== undefined) {
        return scalar;
      }
    }
  }
  return undefined;
}

function findDirectArray(value, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || isSensitiveKey(key)) {
      continue;
    }
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findFirstOwnObject(value, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || isSensitiveKey(key)) {
      continue;
    }
    return value[key];
  }
  return null;
}

function stopTraceRecording(trace, log) {
  if (trace.stopLogged) {
    trace.stopped = true;
    return;
  }
  trace.stopped = true;
  trace.stopLogged = true;
  safeLog(log, "[ws-trace] limit reached; recording stopped");
}

function finalizeTrace(observerState, log) {
  const trace = observerState.trace;
  if (!trace) {
    return;
  }
  safeLog(
    log,
    `[ws-trace] records=${trace.records} options=${trace.kindCounts.options ?? 0} identity=${trace.kindCounts.identity ?? 0} board=${trace.kindCounts.board ?? 0} replay=${trace.kindCounts.replay ?? 0} garbage=${trace.kindCounts.garbage ?? 0}`
  );
}
