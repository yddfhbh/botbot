const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_VISITED_OBJECTS = 5000;
const SENSITIVE_KEYS = new Set([
  "token",
  "auth",
  "authorization",
  "cookie",
  "session",
  "jwt",
  "password",
  "secret"
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

export async function installDddWsObserver(cdp, { unpack, log }) {
  if (typeof unpack !== "function") {
    log?.("[ws-observer] msgpackr unavailable; observer inactive");
    return () => {};
  }

  const observerState = {
    requestUrls: new Map(),
    lastOptionsSignature: "",
    framesReceived: 0,
    binaryFramesReceived: 0,
    decodeAttempts: 0,
    optionsCaptured: 0
  };

  await cdp.send("Network.enable").catch(() => undefined);

  const offCreated = cdp.on("Network.webSocketCreated", (event) => {
    try {
      const requestId = event?.requestId;
      const url = typeof event?.url === "string" ? event.url : "";
      if (!requestId || !url) {
        return;
      }
      observerState.requestUrls.set(requestId, url);
      log?.(`[ws-observer] websocket opened host=${safeUrlHost(url)}`);
    } catch {}
  });

  const offClosed = cdp.on("Network.webSocketClosed", (event) => {
    try {
      if (event?.requestId) {
        observerState.requestUrls.delete(event.requestId);
      }
    } catch {}
  });

  const offReceived = cdp.on("Network.webSocketFrameReceived", (event) => {
    try {
      observerState.framesReceived += 1;
      const payloadData = event?.response?.payloadData;
      if (typeof payloadData !== "string" || payloadData.length === 0) {
        return;
      }

      const opcode = event?.response?.opcode;
      if (opcode === 2) {
        observerState.binaryFramesReceived += 1;
        const payload = Buffer.from(payloadData, "base64");
        if (payload.length === 0 || payload.length > MAX_PAYLOAD_BYTES) {
          return;
        }
        const candidates = decodeGameOptionsCandidates(payload, unpack);
        observerState.decodeAttempts += decodeAttemptCount(payload);
        for (const chunk of split87Frame(payload)) {
          observerState.decodeAttempts += decodeAttemptCount(chunk);
        }
        logCapturedCandidates(
          candidates,
          event?.requestId,
          observerState,
          log
        );
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
        const candidates = decodeGameOptionsCandidates(parsed, unpack);
        logCapturedCandidates(
          candidates,
          event?.requestId,
          observerState,
          log
        );
      }
    } catch {}
  });

  return () => {
    offCreated();
    offClosed();
    offReceived();
    observerState.requestUrls.clear();
  };
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
  const candidates = [];

  if (Buffer.isBuffer(payload)) {
    for (const chunk of split87Frame(payload)) {
      collectDecodedCandidates(candidates, tryUnpackAtOffsets(chunk, unpack));
    }
    collectDecodedCandidates(candidates, tryUnpackAtOffsets(payload, unpack));
    return candidates;
  }

  if (payload && typeof payload === "object") {
    const match = findGameOptions(payload);
    const sanitized = sanitizeGameOptions(match);
    if (sanitized) {
      candidates.push(sanitized);
    }
  }

  return candidates;
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

    log?.("[ws-observer] game options captured");
    if (requestId && observerState.requestUrls.has(requestId)) {
      log?.(
        `[ws-observer] url_host=${safeUrlHost(
          observerState.requestUrls.get(requestId)
        )}`
      );
    }
    log?.(`[ws-observer] seed=${String(options.seed)}`);
    log?.(`[ws-observer] bagtype=${String(options.bagtype)}`);
    if (Object.prototype.hasOwnProperty.call(options, "nextcount")) {
      log?.(`[ws-observer] nextcount=${String(options.nextcount)}`);
    }
    if (
      Object.prototype.hasOwnProperty.call(options, "boardwidth") &&
      Object.prototype.hasOwnProperty.call(options, "boardheight")
    ) {
      log?.(
        `[ws-observer] board=${String(options.boardwidth)}x${String(
          options.boardheight
        )}`
      );
    }
    if (Object.prototype.hasOwnProperty.call(options, "gameid")) {
      log?.(`[ws-observer] gameid=${String(options.gameid)}`);
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
