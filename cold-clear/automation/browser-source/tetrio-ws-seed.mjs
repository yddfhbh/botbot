const SENSITIVE_KEY_PATTERN = /token|auth|cookie|session|jwt/i;

export function split87Frame(buffer) {
  const payload = Buffer.from(buffer);
  const chunks = [];

  if (payload.length < 8 || payload[0] !== 0x87) {
    return chunks;
  }

  let position = 4;
  while (position + 4 <= payload.length) {
    const length = payload.readUInt32BE(position);
    position += 4;
    if (length <= 0 || position + length > payload.length) {
      break;
    }
    chunks.push(payload.subarray(position, position + length));
    position += length;
  }

  return chunks;
}

export function tryUnpackAtOffsets(buffer, unpack, maxOffset = 32) {
  const payload = Buffer.from(buffer);
  const out = [];
  for (let offset = 0; offset <= Math.min(maxOffset, payload.length - 1); offset += 1) {
    try {
      out.push({
        offset,
        decoded: unpack(payload.subarray(offset))
      });
    } catch {}
  }
  return out;
}

export function walkObject(value, visitor, path = "") {
  if (!value || typeof value !== "object") {
    return;
  }

  visitor(value, path);

  if (Array.isArray(value)) {
    value.forEach((child, index) => walkObject(child, visitor, `${path}[${index}]`));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }
    walkObject(child, visitor, path ? `${path}.${key}` : key);
  }
}

function isGameOptionsCandidate(value) {
  return (
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "seed") &&
    Object.prototype.hasOwnProperty.call(value, "bagtype")
  );
}

function scoreOptionsCandidate(candidatePath, candidate) {
  let score = 0;
  if (candidatePath.includes("options")) score += 4;
  if (candidatePath.includes("setoptions")) score += 3;
  if (candidatePath.includes("game")) score += 2;
  if (candidate.nextcount != null) score += 2;
  if (candidate.boardwidth != null) score += 1;
  if (candidate.boardheight != null) score += 1;
  return score;
}

export function findGameOptions(decoded) {
  const candidates = [];

  walkObject(decoded, (value, path) => {
    if (isGameOptionsCandidate(value)) {
      candidates.push({
        path,
        options: value
      });
    }

    if (isGameOptionsCandidate(value?.options)) {
      candidates.push({
        path: path ? `${path}.options` : "options",
        options: value.options
      });
    }

    if (isGameOptionsCandidate(value?.setoptions)) {
      candidates.push({
        path: path ? `${path}.setoptions` : "setoptions",
        options: value.setoptions
      });
    }
  });

  candidates.sort((left, right) => {
    return scoreOptionsCandidate(right.path, right.options) - scoreOptionsCandidate(left.path, left.options);
  });

  return candidates[0] ?? null;
}

export function redactObject(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactObject(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      redacted[key] = "<redacted>";
    } else {
      redacted[key] = redactObject(child);
    }
  }
  return redacted;
}

function parseOptionalInt(value, fallback = null) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function sanitizeUrl(value) {
  if (!value) {
    return "";
  }
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        parsed.searchParams.set(key, "<redacted>");
      }
    }
    return parsed.toString();
  } catch {
    return String(value).replace(/([?&][^=]*(token|auth|cookie|session|jwt)[^=]*)=([^&]+)/gi, "$1=<redacted>");
  }
}

export function inspectPayloadForGameOptions(payload, unpack) {
  if (!(Buffer.isBuffer(payload) || payload instanceof Uint8Array)) {
    return null;
  }

  const buffer = Buffer.from(payload);
  const attempts = [];
  for (const chunk of split87Frame(buffer)) {
    for (const attempt of tryUnpackAtOffsets(chunk, unpack, 32)) {
      attempts.push({ ...attempt, frame: "0x87" });
    }
  }
  for (const attempt of tryUnpackAtOffsets(buffer, unpack, 32)) {
    attempts.push({ ...attempt, frame: "raw" });
  }

  for (const attempt of attempts) {
    const match = findGameOptions(attempt.decoded);
    if (!match?.options) {
      continue;
    }

    const normalized = {
      seed: String(match.options.seed),
      bagtype: String(match.options.bagtype),
      nextcount: parseOptionalInt(match.options.nextcount, 6),
      boardwidth: parseOptionalInt(match.options.boardwidth),
      boardheight: parseOptionalInt(match.options.boardheight),
      options: redactObject(match.options),
      optionsPath: match.path,
      frame: attempt.frame,
      offset: attempt.offset
    };

    if (!normalized.seed || !normalized.bagtype) {
      continue;
    }

    return normalized;
  }

  return null;
}

export function createCaptureQueue() {
  const queue = [];
  let resolveNext = null;

  return {
    push(value) {
      queue.push(value);
      if (resolveNext) {
        const next = resolveNext;
        resolveNext = null;
        next(queue.shift());
      }
    },

    next() {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift());
      }
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    }
  };
}

export function installWebSocketSeedMonitor(
  cdp,
  unpack,
  { onWebSocketOpen = () => undefined, onCapture = () => undefined } = {}
) {
  const seenUrls = new Set();

  const handleCreated = (event) => {
    const wsUrl = sanitizeUrl(event?.url ?? "");
    if (!wsUrl || seenUrls.has(wsUrl)) {
      return;
    }
    seenUrls.add(wsUrl);
    onWebSocketOpen(wsUrl);
  };

  const handleFrame = (event) => {
    const payload = event?.response?.payloadData;
    if (!payload) {
      return;
    }
    const buffer = event?.response?.opcode === 2 ? Buffer.from(payload, "base64") : Buffer.from(payload, "utf8");
    const capture = inspectPayloadForGameOptions(buffer, unpack);
    if (!capture) {
      return;
    }
    onCapture(capture);
  };

  const removeCreated = cdp.on("Network.webSocketCreated", handleCreated);
  const removeReceived = cdp.on("Network.webSocketFrameReceived", handleFrame);
  const removeSent = cdp.on("Network.webSocketFrameSent", handleFrame);

  return () => {
    removeCreated?.();
    removeReceived?.();
    removeSent?.();
  };
}
