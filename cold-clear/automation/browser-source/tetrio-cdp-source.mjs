import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_PORT,
  DEFAULT_URL,
  isCdpOpen,
  launchChromium,
  shutdownChromium,
  waitForCdpReady
} from "./chromium-launch.mjs";

const DEFAULT_NEXT_COUNT = 6;
const DEFAULT_STATUS_MS = 2500;
const DEFAULT_CAPTURE_COOLDOWN_MS = 2000;
const DEFAULT_SUPPRESSED_REASON = "VS WebSocket simulation owns live state";
const DEFAULT_VS_OBJECT_SNAPSHOT_PATH = "automation/vs-object-snapshot.json";
const PERF_LOG_INTERVAL_MS = 2000;
const DEFAULT_VS_SCOPE_PAUSE_BUDGET_MS = 120;
const MIN_VS_SCOPE_PAUSE_BUDGET_MS = 50;
const MAX_VS_SCOPE_PAUSE_BUDGET_MS = 500;
const VS_SCOPE_INITIAL_DELAY_MS = 200;
const VS_SCOPE_RETRY_DELAY_MS = 500;
const VS_SCOPE_MAX_ATTEMPTS = 3;
const VS_SCOPE_GAMEPLAY_ATTEMPT_OFFSETS_MS = [150, 700, 1500];
const VS_SCOPE_MAX_DEPTH = 2;
const VS_SCOPE_MAX_OBJECTS = 200;
const VS_SCOPE_MAX_PROPERTIES = 80;
const VS_SCOPE_TYPES = ["local", "closure", "block", "script"];
const VS_SCOPE_PRIORITY = new Map(
  VS_SCOPE_TYPES.map((scopeType, index) => [scopeType, index])
);
const VS_PIECE_NAMES = ["i", "o", "t", "s", "z", "j", "l"];

export function determineChromiumOwnership({ connectOnly, alreadyOpen }) {
  return !connectOnly && !alreadyOpen;
}

export function createSnapshotTracking() {
  return {
    stableSignature: "",
    stableCount: 0,
    lastWrittenSignature: "",
    lastLoggedToken: "",
    pendingPieceKey: "",
    pendingPieceDetectedAt: 0,
    lastPerfLoggedPieceKey: ""
  };
}

export function createVsObjectTracking() {
  return {
    roundId: "",
    lastSnapshotSignature: "",
    lastCandidateLogSignature: "",
    lastNotFoundRoundId: "",
    lastActiveRoundId: "",
    cachedObjectId: "",
    cachedPath: "",
    cachedScore: 0,
    scopeAttempts: 0,
    nextScopeAttemptAt: 0,
    scopeCaptureLocked: false,
    scopeFailureLogged: false,
    scopeCaptureInFlight: false,
    scopeLastScheduledAttempt: 0,
    scopeLastCancelReason: "",
    scopeStats: createVsScopeStats()
  };
}

export function resetSnapshotTracking(tracking) {
  tracking.stableSignature = "";
  tracking.stableCount = 0;
  tracking.lastWrittenSignature = "";
  tracking.lastLoggedToken = "";
  tracking.pendingPieceKey = "";
  tracking.pendingPieceDetectedAt = 0;
  tracking.lastPerfLoggedPieceKey = "";
  return tracking;
}

export function resetVsObjectTracking(tracking) {
  tracking.roundId = "";
  tracking.lastSnapshotSignature = "";
  tracking.lastCandidateLogSignature = "";
  tracking.lastNotFoundRoundId = "";
  tracking.lastActiveRoundId = "";
  tracking.cachedObjectId = "";
  tracking.cachedPath = "";
  tracking.cachedScore = 0;
  tracking.scopeAttempts = 0;
  tracking.nextScopeAttemptAt = 0;
  tracking.scopeCaptureLocked = false;
  tracking.scopeFailureLogged = false;
  tracking.scopeCaptureInFlight = false;
  tracking.scopeLastScheduledAttempt = 0;
  tracking.scopeLastCancelReason = "";
  tracking.scopeStats = createVsScopeStats();
  return tracking;
}

function createVsScopeStats() {
  return {
    framesScanned: 0,
    scopesScanned: 0,
    objectsScanned: 0
  };
}

export function resolveVsScopePauseBudgetMs(
  value = process.env.FUSION_VS_SCOPE_PAUSE_BUDGET_MS
) {
  const parsed = Number.parseInt(value ?? `${DEFAULT_VS_SCOPE_PAUSE_BUDGET_MS}`, 10);
  if (
    !Number.isFinite(parsed) ||
    parsed < MIN_VS_SCOPE_PAUSE_BUDGET_MS ||
    parsed > MAX_VS_SCOPE_PAUSE_BUDGET_MS
  ) {
    return DEFAULT_VS_SCOPE_PAUSE_BUDGET_MS;
  }
  return parsed;
}

export function buildSnapshotSignature(gameEpoch, state) {
  const queueText = state.queue.join(",");
  return `${gameEpoch}|${state.pieceCounter}|${state.current}|${state.hold ?? "-"}|${queueText}|${state.activeX ?? "-"}|${state.activeY ?? "-"}|${state.activeRotation ?? "-"}`;
}

export function buildSnapshotToken(gameEpoch, pieceCounter) {
  return `browser-${gameEpoch}-${pieceCounter}`;
}

export function buildVsObjectSnapshotSignature(snapshot) {
  const boardText = Array.isArray(snapshot?.board)
    ? snapshot.board
        .map((row) => row.map((cell) => (cell ? "1" : "0")).join(""))
        .join("|")
    : "";
  const queueText = Array.isArray(snapshot?.queue) ? snapshot.queue.join(",") : "";
  return [
    snapshot?.roundId ?? "",
    snapshot?.gameid ?? "",
    boardText,
    snapshot?.current ?? "",
    snapshot?.hold ?? "",
    queueText,
    snapshot?.active ?? ""
  ].join("|");
}

export function resolvePollMs(args) {
  return numberArg(args.pollMs, 8);
}

export function resolveUseSeedSimulationFallback(
  requestedValue,
  env = process.env
) {
  return requestedValue && env?.FUSION_VS_WS_SIM !== "1";
}

export function isVsWsSimEnvEnabled(env = process.env) {
  return env?.FUSION_VS_WS_SIM === "1";
}

export function shouldAttemptClosureCapture({
  probePageState,
  suppressClosureCapture,
  stateOk,
  lastCaptureAt = 0,
  lastPageProbeAt = 0,
  now = Date.now(),
  cooldownMs = DEFAULT_CAPTURE_COOLDOWN_MS
}) {
  return Boolean(
    probePageState &&
      !suppressClosureCapture &&
      !stateOk &&
      now - lastCaptureAt >= cooldownMs &&
      now - lastPageProbeAt >= cooldownMs
  );
}

export function shouldLogStateReason({
  reason,
  lastReason,
  lastReasonAt,
  now = Date.now(),
  statusMs = DEFAULT_STATUS_MS,
  suppressRepeatedReason = false
}) {
  if (reason !== lastReason) {
    return true;
  }
  if (suppressRepeatedReason) {
    return false;
  }
  return now - lastReasonAt >= statusMs;
}

function maybeLogBrowserPerf({
  browserPerfEnabled,
  lastPerfLoggedAt,
  maxEventLoopDelayMs
}) {
  if (!browserPerfEnabled || Date.now() - lastPerfLoggedAt < PERF_LOG_INTERVAL_MS) {
    return null;
  }
  console.log(`[browser-perf] max_event_loop_delay_ms=${maxEventLoopDelayMs}`);
  return {
    lastPerfLoggedAt: Date.now(),
    maxEventLoopDelayMs: 0
  };
}

export function isTetrioGameEndedState(state) {
  return Boolean(state?.ok && state.ready === false && state.reason === "TETR.IO game ended");
}

export function shouldHandleEndedGame(state, endedHandled) {
  return isTetrioGameEndedState(state) && !endedHandled;
}

export function isActiveTetrioGameState(state) {
  return Boolean(state?.ok && state.ready && state.playing && !state.countdown);
}

export function shouldAdvanceGameEpoch(state, waitingForNextGame) {
  return waitingForNextGame && isActiveTetrioGameState(state);
}

export function clearSnapshotFile(snapshotPath) {
  rmSync(snapshotPath, { force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotPath = args.snapshotPath ?? "automation/live-snapshot.json";
  const vsObjectSnapshotPath =
    args.vsObjectSnapshotPath ?? DEFAULT_VS_OBJECT_SNAPSHOT_PATH;
  const url = args.url ?? DEFAULT_URL;
  const port = numberArg(args.port, DEFAULT_PORT);
  const targetHint = args.target ?? "TETR.IO";
  const pollMs = resolvePollMs(args);
  const connectOnly = args.connectOnly === "1";
  const probePageState = args.probePageState !== "0";
  const useRibbonWebsocket = args.useRibbonWebsocket !== "0";
  const useSeedSimulationFallback = resolveUseSeedSimulationFallback(
    args.useSeedSimulationFallback !== "0"
  );
  const vsWsSimEnabled = isVsWsSimEnvEnabled();
  const vsObjectTraceEnabled = process.env.FUSION_VS_OBJECT_TRACE === "1";
  const vsScopeTraceEnabled = process.env.FUSION_VS_SCOPE_TRACE === "1";
  const browserPerfEnabled = process.env.FUSION_BROWSER_PERF === "1";
  const chromePath = process.env.CHROME_PATH || "";
  const msgpack = await loadOptionalMsgpack();

  let browserProcess = null;
  let ownsChromium = false;
  const alreadyOpen = await isCdpOpen(port);
  if (determineChromiumOwnership({ connectOnly, alreadyOpen })) {
    browserProcess = launchChromium({ port, url, chromePath });
    ownsChromium = true;
  }

  await waitForCdpReady(port);
  const target = await findOrCreateTarget({ port, url, targetHint });
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable").catch(() => undefined);
  await cdp.send("Runtime.enable").catch(() => undefined);

  process.stdout.write(
    `${JSON.stringify({ type: "ready", ok: true, target: target.title || target.url, port })}\n`
  );
  console.log(`[browser] connected to ${target.title || target.url} on port ${port}`);

  let dddWsObserverCleanup = null;
  let vsRoundActive = false;
  let vsRoundId = "";
  let vsRoundStatus = {
    active: false,
    roundId: "",
    localGameId: "",
    localUserId: "",
    localUsername: "",
    seed: "",
    readyAt: 0
  };
  let lastPerfLoggedAt = Date.now();
  let loopStartedAt = Date.now();
  let maxEventLoopDelayMs = 0;
  try {
    const { installDddWsObserver } =
      await import("./ddd-ws-observer.mjs");

    dddWsObserverCleanup = await installDddWsObserver(cdp, {
      unpack: msgpack?.unpack ?? null,
      log: message => console.log(message),
      onVsRoundStatus: (status) => {
        const nextActive = Boolean(status?.active);
        const nextRoundId = nextActive ? String(status?.roundId ?? "") : "";
        const changed =
          nextActive !== vsRoundActive || nextRoundId !== vsRoundId;
        vsRoundActive = nextActive;
        vsRoundId = nextRoundId;
        vsRoundStatus = {
          active: nextActive,
          roundId: nextRoundId,
          localGameId: nextActive ? String(status?.localGameId ?? "") : "",
          localUserId: nextActive ? String(status?.localUserId ?? "") : "",
          localUsername: nextActive ? String(status?.localUsername ?? "") : "",
          seed: nextActive ? String(status?.seed ?? "") : "",
          readyAt: nextActive ? Number(status?.readyAt ?? 0) || 0 : 0
        };
        if (!changed) {
          return;
        }
        if (vsRoundActive) {
          console.log(
            `[browser] VS round active; live snapshot capture suspended roundId=${vsRoundId}`
          );
        } else {
          console.log("[browser] VS round inactive; live snapshot capture restored");
        }
      },
      perfEnabled: browserPerfEnabled
    });

    console.log("[ws-observer] installed");
  } catch (error) {
    console.log(
      `[ws-observer] installation failed: ${
        error?.message ?? String(error)
      }`
    );
  }
  await cdp.send("Page.bringToFront");
  await installBackgroundInputKeepalive(cdp);
  await safeRuntimeEvaluate(cdp, {
    expression: "window.focus(); document.body && document.body.focus && document.body.focus(); true"
  }).catch(() => undefined);

  const network = createTetrioNetworkState();
  if (useRibbonWebsocket) {
    await installRibbonMonitor(cdp, network, msgpack);
  }

  let gameEpoch = 1;
  let waitingForNextGame = false;
  let endedHandled = false;
  let lastReason = "";
  let lastReasonAt = 0;
  const snapshotTracking = createSnapshotTracking();
  const vsObjectTracking = createVsObjectTracking();
  const probeState = {
    lastCaptureAt: 0
  };

  const stop = async () => {
    clearVsScopeSchedule(vsObjectTracking, "browser_closed", (message) => console.log(message));
    if (typeof dddWsObserverCleanup === "function") {
      try {
        dddWsObserverCleanup();
      } catch {}
      dddWsObserverCleanup = null;
    }
    await cdp.close().catch(() => undefined);
    if (ownsChromium && browserProcess) {
      await shutdownChromium(browserProcess);
    }
  };
  process.on("SIGINT", () => stop().finally(() => process.exit(0)));
  process.on("SIGTERM", () => stop().finally(() => process.exit(0)));

  while (true) {
    const loopNow = Date.now();
    maxEventLoopDelayMs = Math.max(
      maxEventLoopDelayMs,
      Math.max(0, loopNow - (loopStartedAt + pollMs))
    );
    loopStartedAt = loopNow;

    if (vsRoundStatus.active) {
      if (vsObjectTracking.lastActiveRoundId !== vsRoundStatus.roundId) {
        if (vsObjectTracking.lastActiveRoundId) {
          clearVsScopeSchedule(vsObjectTracking, "round_changed", (message) => console.log(message));
        }
        vsObjectTracking.lastActiveRoundId = vsRoundStatus.roundId;
        resetSnapshotTracking(snapshotTracking);
        probeState.lastCaptureAt = 0;
        clearSnapshotFile(snapshotPath);
      }

      await processVsObjectDiagnostics(cdp, {
        vsRoundStatus,
        tracking: vsObjectTracking,
        liveSnapshotPath: snapshotPath,
        vsObjectSnapshotPath,
        traceEnabled: vsObjectTraceEnabled,
        scopeTraceEnabled: vsScopeTraceEnabled,
        getVsRoundStatus: () => vsRoundStatus
      });

      lastReason = "";
      lastReasonAt = 0;
      const perfUpdate = maybeLogBrowserPerf({
        browserPerfEnabled,
        lastPerfLoggedAt,
        maxEventLoopDelayMs
      });
      if (perfUpdate) {
        lastPerfLoggedAt = perfUpdate.lastPerfLoggedAt;
        maxEventLoopDelayMs = perfUpdate.maxEventLoopDelayMs;
      }
      await sleep(pollMs);
      continue;
    }

    if (vsObjectTracking.lastActiveRoundId) {
      clearVsScopeSchedule(vsObjectTracking, "inactive", (message) => console.log(message));
      resetVsObjectTracking(vsObjectTracking);
      clearSnapshotFile(vsObjectSnapshotPath);
      clearSnapshotFile(snapshotPath);
      resetSnapshotTracking(snapshotTracking);
      probeState.lastCaptureAt = 0;
    }

    const state = await readTetrioState(cdp, {
      probePageState,
      useSeedSimulationFallback,
      network,
      probeState,
      suppressClosureCapture: vsWsSimEnabled && vsRoundActive,
      suppressedReason: DEFAULT_SUPPRESSED_REASON,
      perfEnabled: browserPerfEnabled
    });

    if (shouldHandleEndedGame(state, endedHandled)) {
      endedHandled = true;
      waitingForNextGame = true;

      await markCurrentGameAsEnded(cdp);

      resetSnapshotTracking(snapshotTracking);
      probeState.lastCaptureAt = 0;
      clearSnapshotFile(snapshotPath);

      console.log(`[browser] game session ended epoch=${gameEpoch}`);
      console.log("[browser] cleared ended game cache; waiting for next game");
    }

    if (isTetrioGameEndedState(state)) {
      const perfUpdate = maybeLogBrowserPerf({
        browserPerfEnabled,
        lastPerfLoggedAt,
        maxEventLoopDelayMs
      });
      if (perfUpdate) {
        lastPerfLoggedAt = perfUpdate.lastPerfLoggedAt;
        maxEventLoopDelayMs = perfUpdate.maxEventLoopDelayMs;
      }
      await sleep(pollMs);
      continue;
    }

    if (!state.ok || !state.ready || !state.playing || state.countdown) {
      const reason =
        state.reason ??
        (!state.playing ? "page is not playing" : state.countdown ? "countdown active" : "state not ready");
      const now = Date.now();
      if (shouldLogStateReason({
        reason,
        lastReason,
        lastReasonAt,
        now,
        suppressRepeatedReason: state.reason === DEFAULT_SUPPRESSED_REASON
      })) {
        console.log(`[browser] ${reason}`);
        lastReason = reason;
        lastReasonAt = now;
      }
      const perfUpdate = maybeLogBrowserPerf({
        browserPerfEnabled,
        lastPerfLoggedAt,
        maxEventLoopDelayMs
      });
      if (perfUpdate) {
        lastPerfLoggedAt = perfUpdate.lastPerfLoggedAt;
        maxEventLoopDelayMs = perfUpdate.maxEventLoopDelayMs;
      }
      await sleep(pollMs);
      continue;
    }

    if (shouldAdvanceGameEpoch(state, waitingForNextGame)) {
      gameEpoch += 1;
      waitingForNextGame = false;
      endedHandled = false;
      resetSnapshotTracking(snapshotTracking);
      console.log(`[browser] new game detected epoch=${gameEpoch}`);
    }

    lastReason = "";
    lastReasonAt = 0;

    const pieceKey = `${gameEpoch}:${state.pieceCounter}`;
    if (pieceKey !== snapshotTracking.pendingPieceKey) {
      snapshotTracking.pendingPieceKey = pieceKey;
      snapshotTracking.pendingPieceDetectedAt = Date.now();
    }

    const signature = buildSnapshotSignature(gameEpoch, state);
    if (signature === snapshotTracking.stableSignature) {
      snapshotTracking.stableCount += 1;
    } else {
      snapshotTracking.stableSignature = signature;
      snapshotTracking.stableCount = 1;
    }

    if (snapshotTracking.stableCount < 2) {
      await sleep(pollMs);
      continue;
    }

    const snapshot = {
      ok: true,
      source: "browser_cdp",
      field: state.field,
      current: state.current.toUpperCase(),
      hold: state.hold ? state.hold.toUpperCase() : null,
      queue: state.queue.map((piece) => piece.toUpperCase()),
      b2b: Boolean(state.b2b),
      combo: state.combo,
      incoming: state.incoming,
      pieceCounter: state.pieceCounter,
      token: buildSnapshotToken(gameEpoch, state.pieceCounter),
      playing: state.playing,
      countdown: state.countdown,
      activeX: Number.isFinite(state.activeX) ? state.activeX : undefined,
      activeY: Number.isFinite(state.activeY) ? state.activeY : undefined,
      activeRotation: state.activeRotation ?? undefined
    };

    if (signature !== snapshotTracking.lastWrittenSignature) {
      writeSnapshot(snapshotPath, snapshot);
      snapshotTracking.lastWrittenSignature = signature;
      if (
        pieceKey === snapshotTracking.pendingPieceKey &&
        pieceKey !== snapshotTracking.lastPerfLoggedPieceKey
      ) {
        snapshotTracking.lastPerfLoggedPieceKey = pieceKey;
        if (browserPerfEnabled) {
          console.log(
            `[browser-perf] piece_change_to_snapshot_ms=${Math.max(0, Date.now() - snapshotTracking.pendingPieceDetectedAt)}`
          );
        }
      }
      if (snapshot.token !== snapshotTracking.lastLoggedToken) {
        snapshotTracking.lastLoggedToken = snapshot.token;
        console.log(
          `[browser] page state ready pieceCounter=${state.pieceCounter} current=${snapshot.current} hold=${snapshot.hold ?? "-"} queue=${snapshot.queue.join(",")}`
        );
      }
    }

    const perfUpdate = maybeLogBrowserPerf({
      browserPerfEnabled,
      lastPerfLoggedAt,
      maxEventLoopDelayMs
    });
    if (perfUpdate) {
      lastPerfLoggedAt = perfUpdate.lastPerfLoggedAt;
      maxEventLoopDelayMs = perfUpdate.maxEventLoopDelayMs;
    }

    await sleep(pollMs);
  }
}

async function markCurrentGameAsEnded(cdp) {
  await safeRuntimeEvaluate(cdp, {
    expression: `(() => {
      if (window.__fusionTetrioGame) {
        window.__fusionEndedTetrioGame = window.__fusionTetrioGame;
      }

      delete window.__fusionTetrioGame;
      delete window.__fusionTetrioBridge;

      return true;
    })()`,
    returnByValue: true,
    awaitPromise: true
  }).catch(() => undefined);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }
    parsed[key] = next;
    i++;
  }
  return parsed;
}

function numberArg(value, fallback) {
  const parsed = Number.parseInt(value ?? `${fallback}`, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadOptionalMsgpack() {
  try {
    return await import("msgpackr");
  } catch {
    console.log("[browser] msgpackr not installed; ribbon seed parsing will be best-effort only");
    return null;
  }
}

async function findOrCreateTarget({ port, url, targetHint }) {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const pages = list.filter((item) => item.type === "page");
  const hinted = pages.find(
    (item) =>
      item.url?.toLowerCase().includes(targetHint.toLowerCase()) ||
      item.title?.toLowerCase().includes(targetHint.toLowerCase())
  );
  const matchingUrl = pages.find((item) => item.url === url);
  const matchingHost = pages.find((item) => {
    try {
      return new URL(item.url).host === new URL(url).host;
    } catch {
      return false;
    }
  });
  const existing = hinted ?? matchingUrl ?? matchingHost ?? pages[0];
  if (existing?.webSocketDebuggerUrl) return existing;
  return await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT"
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return await response.json();
}

class CdpClient {
  static connect(webSocketDebuggerUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketDebuggerUrl);
      const client = new CdpClient(socket);
      socket.addEventListener("open", () => resolve(client), { once: true });
      socket.addEventListener("error", (event) => reject(event.error ?? event), { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        if (message.method) this.emit(message.method, message.params ?? {});
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  on(method, handler) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(handler);
    this.listeners.set(method, listeners);
    return () => this.off(method, handler);
  }

  off(method, handler) {
    const listeners = this.listeners.get(method);
    if (!listeners) return;
    listeners.delete(handler);
    if (listeners.size === 0) this.listeners.delete(method);
  }

  emit(method, params) {
    const listeners = this.listeners.get(method);
    if (!listeners) return;
    for (const handler of [...listeners]) handler(params);
  }

  waitForEvent(method, predicate = () => true, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, Math.max(1, timeoutMs));
      const handler = (params) => {
        if (!predicate(params)) return;
        cleanup();
        resolve(params);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off(method, handler);
      };
      this.on(method, handler);
    });
  }

  send(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket is not open"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
    return Promise.resolve();
  }
}

function createTetrioNetworkState() {
  return {
    seed: null,
    nextCount: DEFAULT_NEXT_COUNT,
    readyAt: 0,
    ribbonSeen: false,
    lastPageProbeAt: 0
  };
}

async function installBackgroundInputKeepalive(cdp) {
  const source = `(() => {
    if (window.__fusionBackgroundInputKeepalive) return window.__fusionBackgroundInputKeepalive;
    const defineGetter = (target, key, value) => {
      try {
        Object.defineProperty(target, key, {
          configurable: true,
          get: () => value
        });
      } catch {}
    };

    defineGetter(Document.prototype, "hidden", false);
    defineGetter(Document.prototype, "visibilityState", "visible");
    defineGetter(document, "hidden", false);
    defineGetter(document, "visibilityState", "visible");

    try {
      document.hasFocus = () => true;
    } catch {}

    window.addEventListener(
      "blur",
      (event) => {
        event.stopImmediatePropagation();
      },
      true
    );
    document.addEventListener(
      "visibilitychange",
      (event) => {
        event.stopImmediatePropagation();
      },
      true
    );

    window.__fusionBackgroundInputKeepalive = {
      at: Date.now()
    };
    return window.__fusionBackgroundInputKeepalive;
  })()`;

  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source }).catch(() => undefined);
  await cdp.send("Runtime.evaluate", {
    expression: source,
    returnByValue: true,
    awaitPromise: true
  }).catch(() => undefined);
}

async function installRibbonMonitor(cdp, network, msgpack) {
  await cdp.send("Network.enable").catch(() => undefined);
  cdp.on("Network.webSocketCreated", (event) => {
    if (/spool\.tetr\.io\/ribbon/i.test(event?.url ?? "")) {
      network.ribbonSeen = true;
      console.log("[browser] ribbon websocket opened");
    }
  });
  if (!msgpack?.unpack) return;
  const handleFrame = (event) => {
    const payload = event?.response?.payloadData;
    if (!payload) return;
    const buffer = event?.response?.opcode === 2 ? Buffer.from(payload, "base64") : Buffer.from(payload, "utf8");
    inspectRibbonPayload(buffer, network, msgpack.unpack);
  };
  cdp.on("Network.webSocketFrameReceived", handleFrame);
  cdp.on("Network.webSocketFrameSent", handleFrame);
}

function inspectRibbonPayload(payload, network, unpack) {
  const candidates = [];
  for (let offset = 0; offset <= Math.min(24, payload.length - 1); offset++) {
    try {
      candidates.push(unpack(payload.subarray(offset)));
    } catch {}
  }
  for (const decoded of candidates) {
    const options = findOptionsObject(decoded);
    if (options?.seed !== undefined && options?.bagtype !== undefined) {
      network.seed = String(options.seed);
      network.nextCount = Math.max(
        1,
        Number.parseInt(options.nextcount ?? `${DEFAULT_NEXT_COUNT}`, 10) || DEFAULT_NEXT_COUNT
      );
      network.readyAt = Date.now() + estimateCountdownWait(options);
      console.log(`[browser] ribbon seed captured seed=${network.seed}`);
      return;
    }
  }
}

function findOptionsObject(root) {
  let found = null;
  walkObject(root, (value) => {
    if (found || !value || typeof value !== "object") return;
    if (Object.hasOwn(value, "seed") && Object.hasOwn(value, "bagtype")) {
      found = value;
    } else if (
      value.options &&
      typeof value.options === "object" &&
      Object.hasOwn(value.options, "seed") &&
      Object.hasOwn(value.options, "bagtype")
    ) {
      found = value.options;
    }
  });
  return found;
}

function walkObject(value, visit) {
  if (!value || typeof value !== "object") return;
  visit(value);
  if (Array.isArray(value)) {
    value.forEach((item) => walkObject(item, visit));
    return;
  }
  for (const child of Object.values(value)) walkObject(child, visit);
}

function estimateCountdownWait(options) {
  if (options?.countdown === false) return 0;
  const count = finiteNumber(options?.countdown_count);
  const interval = finiteNumber(options?.countdown_interval);
  const pre = finiteNumber(options?.precountdown);
  if (count !== null && interval !== null) {
    return normalizeDuration(pre ?? 0) + count * normalizeDuration(interval) + 250;
  }
  return 4500;
}

function normalizeDuration(value) {
  return value > 0 && value < 60 ? value * 1000 : value;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function readVsLocalGameObject(cdp, identity) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: vsObjectStateExpression(identity),
    returnByValue: true,
    awaitPromise: true
  }, {
    result: {
      value: {
        ok: false,
        reason: "browser execution context not ready yet"
      }
    }
  });
  return raw.result?.value ?? {
    ok: false,
    reason: "VS object probe returned empty"
  };
}

function clearVsCachedHandle(tracking) {
  tracking.cachedObjectId = "";
  tracking.cachedPath = "";
  tracking.cachedScore = 0;
}

function resetVsScopeRoundState(tracking, now) {
  clearVsCachedHandle(tracking);
  tracking.scopeAttempts = 0;
  tracking.nextScopeAttemptAt = now + VS_SCOPE_INITIAL_DELAY_MS;
  tracking.scopeCaptureLocked = false;
  tracking.scopeFailureLogged = false;
  tracking.scopeCaptureInFlight = false;
  tracking.scopeLastScheduledAttempt = 0;
  tracking.scopeLastCancelReason = "";
  tracking.scopeStats = createVsScopeStats();
}

function accumulateVsScopeStats(target, source) {
  target.framesScanned += source?.framesScanned ?? 0;
  target.scopesScanned += source?.scopesScanned ?? 0;
  target.objectsScanned += source?.objectsScanned ?? 0;
}

function isVsScopeTraceEnabled(env = process.env) {
  return env?.FUSION_VS_SCOPE_TRACE === "1";
}

function isInvalidRemoteObjectError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("cannot find object with given id") ||
    message.includes("object id") ||
    message.includes("execution context was destroyed") ||
    message.includes("cannot find default execution context") ||
    message.includes("inspected target navigated or closed")
  );
}

function isVsRoundStillActive(roundId, getVsRoundStatus) {
  const status = typeof getVsRoundStatus === "function" ? getVsRoundStatus() : null;
  return Boolean(status?.active) && String(status?.roundId ?? "") === String(roundId ?? "");
}

function buildVsObjectSnapshot(candidate, vsRoundStatus, source) {
  return {
    roundId: String(vsRoundStatus?.roundId ?? candidate?.roundId ?? ""),
    localGameId: String(vsRoundStatus?.localGameId ?? candidate?.gameid ?? ""),
    gameid: String(candidate?.gameid ?? vsRoundStatus?.localGameId ?? ""),
    board: candidate?.board ?? [],
    current: candidate?.current ? String(candidate.current).toUpperCase() : null,
    hold: candidate?.hold ? String(candidate.hold).toUpperCase() : null,
    queue: Array.isArray(candidate?.queue)
      ? candidate.queue.map((piece) => String(piece).toUpperCase())
      : [],
    active: Boolean(candidate?.active),
    capturedAt: candidate?.capturedAt ?? Date.now(),
    source
  };
}

function logVsScopeCandidate(candidate, roundId, log = (message) => console.log(message)) {
  log("[vs-scope] candidate");
  log(`roundId=${roundId}`);
  log(`frame_index=${candidate.frameIndex}`);
  log(`function_name=${candidate.functionName}`);
  log(`scope_type=${candidate.scopeType}`);
  log(`variable_path=${candidate.variablePath}`);
  log(`score=${candidate.score}`);
  log(`gameid=${candidate.gameid ?? ""}`);
  log(`userid=${candidate.userid ?? ""}`);
  log(`username=${candidate.username ?? ""}`);
  log(`has_eject_state=${candidate.hasEjectState}`);
  log(`has_eject_board_state=${candidate.hasEjectBoardState}`);
  log(`board_shape=${candidate.boardShape ?? ""}`);
  log(`current=${candidate.current ?? ""}`);
  log(`hold=${candidate.hold ?? ""}`);
  log(`queue_length=${candidate.queue.length}`);
}

function logVsScopeCapture(candidate, roundId, log = (message) => console.log(message)) {
  log("[vs-scope] local game object captured");
  log(`roundId=${roundId}`);
  log(`path=${candidate.variablePath}`);
  log(`score=${candidate.score}`);
  log("object_id_cached=true");
}

function logVsScopeNotFound(roundId, attempt, stats, log = (message) => console.log(message)) {
  log("[vs-scope] local game object not found");
  log(`roundId=${roundId}`);
  log(`attempt=${attempt}`);
  log(`frames_scanned=${stats.framesScanned}`);
  log(`scopes_scanned=${stats.scopesScanned}`);
  log(`objects_scanned=${stats.objectsScanned}`);
}

function logVsScopeScheduled(attempt, readyInMs, log = (message) => console.log(message)) {
  log(`[vs-scope] probe scheduled attempt=${attempt} ready_in_ms=${Math.max(0, readyInMs)}`);
}

function logVsScopeGameplayProbeStarted(
  attempt,
  afterReadyMs,
  log = (message) => console.log(message)
) {
  log(`[vs-scope] gameplay probe started attempt=${attempt} after_ready_ms=${Math.max(0, afterReadyMs)}`);
}

function logVsScopeProbeCancelled(reason, log = (message) => console.log(message)) {
  log(`[vs-scope] probe cancelled reason=${reason}`);
}

function measureVsPauseElapsedMs(pauseStartedAt, budgetMs, nowFn = () => Date.now()) {
  if (!pauseStartedAt) {
    return 0;
  }
  return Math.min(
    budgetMs,
    Math.max(0, nowFn() - pauseStartedAt)
  );
}

function resolveVsScopeAttemptAt(readyAt, attempt) {
  const readyTime = Number(readyAt);
  if (!Number.isFinite(readyTime) || readyTime <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const offsetMs =
    VS_SCOPE_GAMEPLAY_ATTEMPT_OFFSETS_MS[Math.max(0, attempt - 1)] ??
    VS_SCOPE_GAMEPLAY_ATTEMPT_OFFSETS_MS[VS_SCOPE_GAMEPLAY_ATTEMPT_OFFSETS_MS.length - 1];
  return readyTime + offsetMs;
}

function clearVsScopeSchedule(tracking, reason, log = (message) => console.log(message)) {
  const hadPendingProbe =
    Boolean(tracking.lastActiveRoundId) &&
    !tracking.cachedObjectId &&
    !tracking.scopeCaptureLocked &&
    tracking.scopeAttempts < VS_SCOPE_MAX_ATTEMPTS &&
    (tracking.scopeLastScheduledAttempt > 0 || tracking.scopeCaptureInFlight);
  if (hadPendingProbe && tracking.scopeLastCancelReason !== reason) {
    logVsScopeProbeCancelled(reason, log);
  }
  tracking.nextScopeAttemptAt = 0;
  tracking.scopeCaptureInFlight = false;
  tracking.scopeLastScheduledAttempt = 0;
  tracking.scopeLastCancelReason = reason;
}

function formatVsRootPath(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? name
    : `[${JSON.stringify(name)}]`;
}

function appendVsPath(basePath, name) {
  if (/^\d+$/.test(name)) {
    return `${basePath}[${name}]`;
  }
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `${basePath}.${name}`
    : `${basePath}[${JSON.stringify(name)}]`;
}

function remotePrimitiveValue(remoteValue) {
  if (!remoteValue || typeof remoteValue !== "object") {
    return undefined;
  }
  if (Object.hasOwn(remoteValue, "value")) {
    return remoteValue.value;
  }
  if (remoteValue.type === "undefined") {
    return undefined;
  }
  return undefined;
}

function remoteObjectId(remoteValue) {
  return typeof remoteValue?.objectId === "string" ? remoteValue.objectId : "";
}

function isRemoteObjectLike(remoteValue) {
  return Boolean(
    remoteValue &&
      typeof remoteValue === "object" &&
      (remoteValue.type === "object" || remoteValue.type === "function") &&
      remoteObjectId(remoteValue)
  );
}

function isRemoteArrayLike(remoteValue) {
  return Boolean(
    isRemoteObjectLike(remoteValue) &&
      (remoteValue.subtype === "array" || /array/i.test(remoteValue.className ?? ""))
  );
}

function isRemoteSkippable(remoteValue) {
  if (!isRemoteObjectLike(remoteValue)) {
    return true;
  }
  const subtype = String(remoteValue.subtype ?? "").toLowerCase();
  const className = String(remoteValue.className ?? "").toLowerCase();
  const description = String(remoteValue.description ?? "").toLowerCase();
  return (
    subtype === "window" ||
    subtype === "node" ||
    subtype === "regexp" ||
    subtype === "date" ||
    subtype === "arraybuffer" ||
    subtype === "typedarray" ||
    className === "window" ||
    className === "document" ||
    className.includes("arraybuffer") ||
    className.includes("uint") ||
    className.includes("int") ||
    className.includes("float") ||
    className.includes("dataview") ||
    description.startsWith("window")
  );
}

function ensureVsScopeCanContinue(context) {
  if (context?.abortState?.aborted) {
    throw new Error(context.abortState.reason || "VS scope scan aborted");
  }
  if ((context?.stats?.objectsScanned ?? 0) >= VS_SCOPE_MAX_OBJECTS) {
    throw new Error("VS scope object budget exceeded");
  }
}

function markVsObjectScanned(remoteValue, context) {
  const objectId = remoteObjectId(remoteValue);
  if (!objectId) {
    return false;
  }
  if (context.seenObjectIds.has(objectId)) {
    return false;
  }
  context.seenObjectIds.add(objectId);
  context.stats.objectsScanned += 1;
  ensureVsScopeCanContinue(context);
  return true;
}

async function getRemoteProperties(cdp, remoteValue, context) {
  ensureVsScopeCanContinue(context);
  const objectId = remoteObjectId(remoteValue);
  if (!objectId) {
    return [];
  }
  if (context.propertyCache.has(objectId)) {
    return await context.propertyCache.get(objectId);
  }
  const pending = cdp
    .send("Runtime.getProperties", {
      objectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: false
    })
    .then((result) => {
      const properties = [];
      for (const property of result?.result ?? []) {
        if (!property || !Object.hasOwn(property, "value")) {
          continue;
        }
        if (property.name === "__proto__") {
          continue;
        }
        properties.push({
          name: property.name,
          value: property.value
        });
        if (properties.length >= VS_SCOPE_MAX_PROPERTIES) {
          break;
        }
      }
      return properties;
    });
  context.propertyCache.set(objectId, pending);
  return await pending;
}

function propertiesToMap(properties) {
  const map = new Map();
  for (const property of properties) {
    if (!map.has(property.name)) {
      map.set(property.name, property.value);
    }
  }
  return map;
}

async function getRemoteArrayItems(cdp, remoteValue, context) {
  if (!isRemoteObjectLike(remoteValue)) {
    return [];
  }
  const properties = await getRemoteProperties(cdp, remoteValue, context);
  return properties
    .filter((property) => /^\d+$/.test(property.name))
    .sort((left, right) => Number(left.name) - Number(right.name))
    .slice(0, VS_SCOPE_MAX_PROPERTIES)
    .map((property) => property.value);
}

async function getRemoteRowCells(cdp, remoteValue, context, depth = 0) {
  if (depth > 1 || !isRemoteObjectLike(remoteValue)) {
    return null;
  }
  if (isRemoteArrayLike(remoteValue)) {
    const items = await getRemoteArrayItems(cdp, remoteValue, context);
    if (items.length > 0) {
      return items;
    }
  }
  const propertyMap = propertiesToMap(await getRemoteProperties(cdp, remoteValue, context));
  for (const key of ["cells", "row", "data", "cols", "entries"]) {
    const nested = propertyMap.get(key);
    if (nested && isRemoteObjectLike(nested)) {
      const items = await getRemoteArrayItems(cdp, nested, context);
      if (items.length > 0) {
        return items;
      }
    }
  }
  const numeric = (await getRemoteProperties(cdp, remoteValue, context))
    .filter((property) => /^\d+$/.test(property.name))
    .sort((left, right) => Number(left.name) - Number(right.name))
    .slice(0, VS_SCOPE_MAX_PROPERTIES)
    .map((property) => property.value);
  return numeric.length > 0 ? numeric : null;
}

async function isRemoteCellFilled(cdp, remoteValue, context, depth = 0) {
  const primitive = remotePrimitiveValue(remoteValue);
  if (
    primitive === null ||
    primitive === undefined ||
    primitive === false ||
    primitive === 0 ||
    primitive === ""
  ) {
    return false;
  }
  if (typeof primitive === "string") {
    const text = primitive.trim().toLowerCase();
    return text !== "" && text !== "." && text !== "0" && text !== "empty";
  }
  if (!isRemoteObjectLike(remoteValue) || depth >= 1) {
    return true;
  }
  const propertyMap = propertiesToMap(await getRemoteProperties(cdp, remoteValue, context));
  const empty = remotePrimitiveValue(propertyMap.get("empty"));
  if (typeof empty === "boolean") {
    return !empty;
  }
  for (const key of ["type", "mino", "value", "id", "cell"]) {
    if (propertyMap.has(key)) {
      return await isRemoteCellFilled(cdp, propertyMap.get(key), context, depth + 1);
    }
  }
  return true;
}

async function extractRemoteBoardShape(cdp, remoteValue, context, depth = 0) {
  if (depth > 2 || !remoteValue) {
    return null;
  }
  if (isRemoteArrayLike(remoteValue)) {
    const items = await getRemoteArrayItems(cdp, remoteValue, context);
    if ((items.length === 20 || items.length === 40) && items.length > 0) {
      const rows = [];
      for (const item of items) {
        const cells = await getRemoteRowCells(cdp, item, context, depth + 1);
        if (!Array.isArray(cells) || cells.length !== 10) {
          rows.length = 0;
          break;
        }
        rows.push(await Promise.all(cells.slice(0, 10).map((cell) => isRemoteCellFilled(cdp, cell, context))));
      }
      if (rows.length === items.length) {
        return {
          board: rows,
          boardShape: `${rows.length}x10`
        };
      }
    }
    if (items.length === 10) {
      const columns = [];
      for (const item of items) {
        const cells = await getRemoteRowCells(cdp, item, context, depth + 1);
        if (!Array.isArray(cells) || (cells.length !== 20 && cells.length !== 40)) {
          columns.length = 0;
          break;
        }
        columns.push(cells);
      }
      if (columns.length === 10) {
        const height = columns[0].length;
        const rows = [];
        for (let rowIndex = 0; rowIndex < height; rowIndex++) {
          const row = [];
          for (let columnIndex = 0; columnIndex < 10; columnIndex++) {
            row.push(
              await isRemoteCellFilled(cdp, columns[columnIndex][rowIndex], context)
            );
          }
          rows.push(row);
        }
        return {
          board: rows,
          boardShape: `${height}x10`
        };
      }
    }
  }
  if (!isRemoteObjectLike(remoteValue)) {
    return null;
  }
  const propertyMap = propertiesToMap(await getRemoteProperties(cdp, remoteValue, context));
  for (const key of ["board", "field", "rows", "grid", "matrix", "cells", "entries", "b"]) {
    if (!propertyMap.has(key)) {
      continue;
    }
    const nested = await extractRemoteBoardShape(cdp, propertyMap.get(key), context, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function normalizePiecePrimitive(value) {
  if (value === null || value === undefined || value === false) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return VS_PIECE_NAMES[Math.floor(value)] ?? null;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (!text) {
      return null;
    }
    if (VS_PIECE_NAMES.includes(text)) {
      return text;
    }
    for (const token of text.split(/[^a-z0-9]+/)) {
      if (VS_PIECE_NAMES.includes(token)) {
        return token;
      }
    }
  }
  return null;
}

async function normalizeRemotePiece(cdp, remoteValue, context, depth = 0) {
  const primitive = normalizePiecePrimitive(remotePrimitiveValue(remoteValue));
  if (primitive) {
    return primitive;
  }
  if (depth > 1 || !isRemoteObjectLike(remoteValue)) {
    return null;
  }
  if (isRemoteArrayLike(remoteValue)) {
    for (const item of (await getRemoteArrayItems(cdp, remoteValue, context)).slice(0, 12)) {
      const piece = await normalizeRemotePiece(cdp, item, context, depth + 1);
      if (piece) {
        return piece;
      }
    }
  }
  const propertyMap = propertiesToMap(await getRemoteProperties(cdp, remoteValue, context));
  for (const key of ["type", "symbol", "piece", "name", "mino", "id", "value", "kind"]) {
    if (!propertyMap.has(key)) {
      continue;
    }
    const piece = await normalizeRemotePiece(cdp, propertyMap.get(key), context, depth + 1);
    if (piece) {
      return piece;
    }
  }
  return null;
}

async function extractRemoteQueue(cdp, remoteValue, context, depth = 0) {
  if (depth > 1 || !remoteValue) {
    return [];
  }
  if (isRemoteArrayLike(remoteValue)) {
    const queue = [];
    for (const item of (await getRemoteArrayItems(cdp, remoteValue, context)).slice(0, 12)) {
      const piece = await normalizeRemotePiece(cdp, item, context, depth + 1);
      if (piece) {
        queue.push(piece);
      }
    }
    return queue;
  }
  if (!isRemoteObjectLike(remoteValue)) {
    return [];
  }
  const numericItems = await getRemoteArrayItems(cdp, remoteValue, context);
  if (numericItems.length > 0) {
    return await extractRemoteQueue(
      cdp,
      { ...remoteValue, subtype: "array" },
      context,
      depth + 1
    );
  }
  return [];
}

function readRemoteBoolean(remoteValue) {
  const primitive = remotePrimitiveValue(remoteValue);
  return typeof primitive === "boolean" ? primitive : null;
}

function readRemoteScalar(remoteValue) {
  const primitive = remotePrimitiveValue(remoteValue);
  if (typeof primitive === "string" || typeof primitive === "number" || typeof primitive === "boolean") {
    const text = String(primitive).trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

async function extractRemoteIdentity(cdp, seedObjects, context) {
  const queue = seedObjects
    .filter((remoteValue) => isRemoteObjectLike(remoteValue))
    .map((remoteValue) => ({ remoteValue, depth: 0 }));
  const visited = new Set();
  const found = {
    gameids: new Set(),
    userids: new Set(),
    usernames: new Set()
  };
  while (queue.length > 0) {
    const current = queue.shift();
    const objectId = remoteObjectId(current.remoteValue);
    if (!objectId || visited.has(objectId)) {
      continue;
    }
    visited.add(objectId);
    const properties = await getRemoteProperties(cdp, current.remoteValue, context);
    for (const property of properties) {
      const lowerName = property.name.toLowerCase();
      const scalar = readRemoteScalar(property.value);
      if (scalar) {
        if (lowerName === "gameid" || lowerName === "game_id") {
          found.gameids.add(scalar);
        } else if (lowerName === "userid" || lowerName === "user_id" || property.name === "_id") {
          found.userids.add(scalar);
        } else if (lowerName === "username" || lowerName === "name") {
          found.usernames.add(scalar);
        }
      }
      if (current.depth >= 2 || !isRemoteObjectLike(property.value)) {
        continue;
      }
      queue.push({
        remoteValue: property.value,
        depth: current.depth + 1
      });
      if (queue.length >= 64) {
        break;
      }
    }
  }
  return found;
}

function selectIdentityValue(values, preferred) {
  if (preferred && values.has(preferred)) {
    return preferred;
  }
  for (const value of values) {
    return value;
  }
  return null;
}

function scoreVsIdentity(identityValues, identity) {
  const localGameId = String(identity?.gameid ?? identity?.localGameId ?? "");
  const localUserId = String(identity?.userid ?? identity?.localUserId ?? "");
  const localUsername = String(identity?.username ?? identity?.localUsername ?? "").toLowerCase();
  const hasLocalGameId = localGameId && identityValues.gameids.has(localGameId);
  const hasLocalUserId = localUserId && identityValues.userids.has(localUserId);
  const hasLocalUsername =
    localUsername &&
    [...identityValues.usernames].some((value) => value.toLowerCase() === localUsername);
  const hasOpponentGameId =
    Boolean(localGameId) &&
    identityValues.gameids.size > 0 &&
    !identityValues.gameids.has(localGameId);
  return {
    hasLocalGameId: Boolean(hasLocalGameId),
    hasLocalUserId: Boolean(hasLocalUserId),
    hasLocalUsername: Boolean(hasLocalUsername),
    hasOpponentGameId: Boolean(hasOpponentGameId),
    score:
      (hasLocalGameId ? 120 : 0) +
      (hasLocalUserId ? 45 : 0) +
      (hasLocalUsername ? 20 : 0),
    gameid: selectIdentityValue(identityValues.gameids, localGameId || null),
    userid: selectIdentityValue(identityValues.userids, localUserId || null),
    username: selectIdentityValue(
      identityValues.usernames,
      hasLocalUsername ? selectIdentityValue(identityValues.usernames, null) : null
    )
  };
}

async function evaluateVsCandidateObject(cdp, remoteValue, details, context) {
  if (!isRemoteObjectLike(remoteValue) || isRemoteSkippable(remoteValue)) {
    return null;
  }
  ensureVsScopeCanContinue(context);
  const properties = await getRemoteProperties(cdp, remoteValue, context);
  const propertyMap = propertiesToMap(properties);
  const hasEjectState = propertyMap.has("ejectState") && propertyMap.get("ejectState")?.type === "function";
  const hasEjectBoardState =
    propertyMap.has("ejectBoardState") &&
    propertyMap.get("ejectBoardState")?.type === "function";
  const hasBoardKey =
    propertyMap.has("board") ||
    propertyMap.has("field") ||
    propertyMap.has("rows") ||
    propertyMap.has("grid") ||
    propertyMap.has("matrix") ||
    propertyMap.has("b");
  const hasCurrentKey =
    propertyMap.has("current") ||
    propertyMap.has("active") ||
    propertyMap.has("falling") ||
    propertyMap.has("piece") ||
    propertyMap.has("tetromino");
  const hasHoldKey =
    propertyMap.has("hold") || propertyMap.has("held") || propertyMap.has("reserve");
  const hasQueueKey =
    propertyMap.has("queue") ||
    propertyMap.has("next") ||
    propertyMap.has("preview") ||
    propertyMap.has("previews") ||
    propertyMap.has("pieces") ||
    propertyMap.has("bag") ||
    propertyMap.has("nextQueue");
  if (!hasEjectState && !hasEjectBoardState && !hasBoardKey && !hasCurrentKey && !hasQueueKey) {
    return null;
  }
  let boardInfo = null;
  for (const key of ["board", "field", "rows", "grid", "matrix", "b"]) {
    if (!propertyMap.has(key)) {
      continue;
    }
    boardInfo = await extractRemoteBoardShape(cdp, propertyMap.get(key), context);
    if (boardInfo) {
      break;
    }
  }
  const current = await normalizeRemotePiece(
    cdp,
    propertyMap.get("current") ??
      propertyMap.get("active") ??
      propertyMap.get("falling") ??
      propertyMap.get("piece") ??
      propertyMap.get("tetromino"),
    context
  );
  const hold = await normalizeRemotePiece(
    cdp,
    propertyMap.get("hold") ?? propertyMap.get("held") ?? propertyMap.get("reserve"),
    context
  );
  let queue = [];
  for (const key of ["queue", "next", "preview", "previews", "pieces", "bag", "nextQueue"]) {
    if (!propertyMap.has(key)) {
      continue;
    }
    queue = await extractRemoteQueue(cdp, propertyMap.get(key), context);
    if (queue.length > 0) {
      break;
    }
  }
  let active = readRemoteBoolean(
    propertyMap.get("active") ?? propertyMap.get("alive") ?? propertyMap.get("playing")
  );
  if (active === null) {
    const dead = readRemoteBoolean(
      propertyMap.get("dead") ??
        propertyMap.get("destroyed") ??
        propertyMap.get("gameover") ??
        propertyMap.get("gameOver")
    );
    if (dead !== null) {
      active = !dead;
    }
  }
  if (active === null) {
    const status = readRemoteScalar(
      propertyMap.get("state") ?? propertyMap.get("status") ?? propertyMap.get("phase")
    )?.toLowerCase();
    if (status) {
      if (["active", "alive", "playing", "running", "go"].includes(status)) {
        active = true;
      } else if (
        ["dead", "destroyed", "ended", "gameover", "finished", "over"].includes(status)
      ) {
        active = false;
      }
    }
  }
  const identityValues = await extractRemoteIdentity(
    cdp,
    [remoteValue, ...details.ancestors.slice(-2)],
    context
  );
  const identityScore = scoreVsIdentity(identityValues, details.identity);
  if (identityScore.hasOpponentGameId && !identityScore.hasLocalGameId) {
    return null;
  }
  let score = identityScore.score;
  if (hasEjectState) {
    score += 40;
  }
  if (hasEjectBoardState) {
    score += 30;
  }
  if (boardInfo?.board?.[0]?.length === 10) {
    score += 35;
  }
  if (current) {
    score += 18;
  }
  if (hold) {
    score += 8;
  }
  if (queue.length > 0) {
    score += 12;
  }
  if (typeof active === "boolean") {
    score += 10;
  }
  if (!hasEjectState && !hasEjectBoardState && !boardInfo && !hasCurrentKey && !hasQueueKey) {
    return null;
  }
  if (score < 35) {
    return null;
  }
  return {
    ok: true,
    objectId: remoteObjectId(remoteValue),
    frameIndex: details.frameIndex,
    functionName: details.functionName,
    scopeType: details.scopeType,
    scopePriority: VS_SCOPE_PRIORITY.get(details.scopeType) ?? VS_SCOPE_TYPES.length,
    variablePath: details.variablePath,
    score,
    gameid: identityScore.gameid,
    userid: identityScore.userid,
    username: identityScore.username,
    hasEjectState,
    hasEjectBoardState,
    board: boardInfo?.board ?? [],
    boardShape: boardInfo?.boardShape ?? "",
    current,
    hold,
    queue,
    active: typeof active === "boolean" ? active : false,
    capturedAt: Date.now(),
    identityScore: {
      hasLocalGameId: identityScore.hasLocalGameId,
      hasLocalUserId: identityScore.hasLocalUserId,
      hasLocalUsername: identityScore.hasLocalUsername
    }
  };
}

function isBetterVsCandidate(candidate, best) {
  if (!best) {
    return true;
  }
  if (candidate.score !== best.score) {
    return candidate.score > best.score;
  }
  if (candidate.identityScore.hasLocalGameId !== best.identityScore.hasLocalGameId) {
    return candidate.identityScore.hasLocalGameId;
  }
  if (candidate.scopePriority !== best.scopePriority) {
    return candidate.scopePriority < best.scopePriority;
  }
  if (candidate.frameIndex !== best.frameIndex) {
    return candidate.frameIndex < best.frameIndex;
  }
  return candidate.variablePath.length < best.variablePath.length;
}

async function scanVsScopeObject(cdp, scopeObject, details, log, context) {
  const queue = [];
  const visited = new Set();
  const properties = await getRemoteProperties(cdp, scopeObject, context);
  for (const property of properties) {
    if (!isRemoteObjectLike(property.value) || isRemoteSkippable(property.value)) {
      continue;
    }
    queue.push({
      remoteValue: property.value,
      variablePath: formatVsRootPath(property.name),
      ancestors: []
    });
  }
  let best = null;
  while (queue.length > 0) {
    ensureVsScopeCanContinue(context);
    const current = queue.shift();
    const objectId = remoteObjectId(current.remoteValue);
    if (!objectId || visited.has(objectId)) {
      continue;
    }
    visited.add(objectId);
    markVsObjectScanned(current.remoteValue, context);
    const candidate = await evaluateVsCandidateObject(
      cdp,
      current.remoteValue,
      {
        ...details,
        variablePath: current.variablePath,
        ancestors: current.ancestors
      },
      context
    );
    if (candidate) {
      logVsScopeCandidate(candidate, details.roundId, log);
      if (isBetterVsCandidate(candidate, best)) {
        best = candidate;
      }
    }
    if (current.ancestors.length >= VS_SCOPE_MAX_DEPTH - 1) {
      continue;
    }
    const childProperties = await getRemoteProperties(cdp, current.remoteValue, context);
    for (const property of childProperties) {
      if (!isRemoteObjectLike(property.value) || isRemoteSkippable(property.value)) {
        continue;
      }
      queue.push({
        remoteValue: property.value,
        variablePath: appendVsPath(current.variablePath, property.name),
        ancestors: [...current.ancestors, current.remoteValue].slice(-2)
      });
    }
  }
  return best;
}

async function inspectVsPausedScopes(cdp, pausedEvent, options) {
  const stats = createVsScopeStats();
  const context = {
    propertyCache: new Map(),
    seenObjectIds: new Set(),
    abortState: options.abortState,
    stats
  };
  let best = null;
  const callFrames = Array.isArray(pausedEvent?.callFrames) ? pausedEvent.callFrames : [];
  stats.framesScanned = callFrames.length;
  for (let frameIndex = 0; frameIndex < callFrames.length; frameIndex++) {
    const callFrame = callFrames[frameIndex];
    const functionName = callFrame?.functionName || "(anonymous)";
    const scopes = (callFrame?.scopeChain ?? [])
      .filter((scope) => VS_SCOPE_PRIORITY.has(scope.type))
      .sort(
        (left, right) =>
          (VS_SCOPE_PRIORITY.get(left.type) ?? VS_SCOPE_TYPES.length) -
          (VS_SCOPE_PRIORITY.get(right.type) ?? VS_SCOPE_TYPES.length)
      );
    for (const scope of scopes) {
      if (!isRemoteObjectLike(scope.object) || isRemoteSkippable(scope.object)) {
        continue;
      }
      stats.scopesScanned += 1;
      const candidate = await scanVsScopeObject(
        cdp,
        scope.object,
        {
          roundId: options.roundId,
          frameIndex,
          functionName,
          scopeType: scope.type,
          identity: options.identity
        },
        options.log,
        context
      );
      if (candidate && isBetterVsCandidate(candidate, best)) {
        best = candidate;
      }
    }
  }
  return { ok: Boolean(best), candidate: best, stats };
}

async function waitForVsPausedEvent(cdp, roundId, getVsRoundStatus, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (!isVsRoundStillActive(roundId, getVsRoundStatus)) {
        cleanup();
        reject(new Error("VS round is no longer active"));
      }
    }, 10);
    const cleanup = () => clearInterval(interval);
    cdp
      .waitForEvent(
        "Debugger.paused",
        () => true,
        timeoutMs
      )
      .then((event) => {
        cleanup();
        resolve(event);
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

export async function captureVsLocalGameObjectFromPausedScope(
  cdp,
  {
    roundId,
    identity,
    log = (message) => console.log(message),
    getVsRoundStatus = () => ({ active: true, roundId }),
    attempt = 1,
    afterReadyMs = 0,
    pauseBudgetMs = resolveVsScopePauseBudgetMs(),
    nowFn = () => Date.now()
  }
) {
  const stats = createVsScopeStats();
  let paused = false;
  let debuggerEnabled = false;
  let pauseStartedAt = 0;
  let pauseResumedAt = 0;
  let watchdog = null;
  const abortState = {
    aborted: false,
    reason: ""
  };
  const budgetMs = resolveVsScopePauseBudgetMs(pauseBudgetMs);
  const safeResume = async (reason = "finally") => {
    if (pauseResumedAt) {
      return false;
    }
    pauseResumedAt = nowFn();
    abortState.aborted = true;
    abortState.reason = reason;
    await cdp.send("Debugger.resume").catch(() => undefined);
    paused = false;
    return true;
  };
  if (!isVsRoundStillActive(roundId, getVsRoundStatus)) {
    return { ok: false, cancelled: true, reason: "VS round is no longer active", stats };
  }
  try {
    await cdp.send("Debugger.enable").catch(() => undefined);
    debuggerEnabled = true;
    pauseStartedAt = nowFn();
    log(
      `[vs-scope] pause started roundId=${roundId} attempt=${attempt} after_ready_ms=${Math.max(0, afterReadyMs)}`
    );
    watchdog = setTimeout(() => {
      const elapsedMs = measureVsPauseElapsedMs(pauseStartedAt, budgetMs, nowFn);
      log(`[vs-scope] resume watchdog fired elapsed_ms=${elapsedMs}`);
      void safeResume("watchdog");
    }, budgetMs);
    const pausedPromise = waitForVsPausedEvent(cdp, roundId, getVsRoundStatus, budgetMs);
    await cdp.send("Debugger.pause");
    const pausedEvent = await pausedPromise;
    paused = true;
    if (!isVsRoundStillActive(roundId, getVsRoundStatus)) {
      await safeResume("round_changed");
      return { ok: false, cancelled: true, reason: "VS round changed", stats };
    }
    const inspected = await Promise.race([
      inspectVsPausedScopes(cdp, pausedEvent, {
        roundId,
        identity,
        log,
        abortState
      }),
      new Promise((resolve) => {
        const interval = setInterval(() => {
          if (!isVsRoundStillActive(roundId, getVsRoundStatus)) {
            clearInterval(interval);
            abortState.aborted = true;
            abortState.reason = "round_inactive";
            resolve({
              ok: false,
              cancelled: true,
              reason: "VS round changed",
              stats
            });
          }
        }, 10);
        setTimeout(() => clearInterval(interval), budgetMs);
      }),
      new Promise((resolve) =>
        setTimeout(() => {
          abortState.aborted = true;
          abortState.reason = "timeout";
          resolve({
            ok: false,
            timedOut: true,
            stats
          });
        }, budgetMs)
      )
    ]);
    accumulateVsScopeStats(stats, inspected.stats);
    if (inspected?.cancelled) {
      await safeResume("round_inactive");
      return {
        ok: false,
        cancelled: true,
        reason: inspected.reason ?? "VS round changed",
        stats
      };
    }
    if (inspected?.timedOut) {
      log(`[vs-scope] scan timed out budget_ms=${budgetMs} objects_scanned=${stats.objectsScanned}`);
      await safeResume("timeout");
      return {
        ok: false,
        timedOut: true,
        reason: "VS paused scope scan timed out",
        stats
      };
    }
    if (!inspected.ok) {
      return {
        ok: false,
        reason: "TETR.IO VS local game object not found in paused scopes",
        stats
      };
    }
    logVsScopeCapture(inspected.candidate, roundId, log);
    return {
      ok: true,
      objectId: inspected.candidate.objectId,
      candidate: inspected.candidate,
      stats
    };
  } catch (error) {
    await safeResume("exception");
    return {
      ok: false,
      cancelled: String(error?.message ?? "").includes("no longer active"),
      reason: error?.message ?? String(error),
      stats
    };
  } finally {
    if (watchdog) {
      clearTimeout(watchdog);
    }
    if (paused || !pauseResumedAt) {
      await safeResume("finally");
    }
    if (pauseStartedAt) {
      const elapsedMs = measureVsPauseElapsedMs(
        pauseStartedAt,
        budgetMs,
        () => pauseResumedAt || nowFn()
      );
      log(`[vs-scope] pause resumed elapsed_ms=${elapsedMs}`);
    }
    if (debuggerEnabled) {
      await cdp.send("Debugger.disable").catch(() => undefined);
    }
  }
}

export async function readVsLocalGameObjectFromCachedHandle(
  cdp,
  {
    objectId
  }
) {
  try {
    const stats = createVsScopeStats();
    const context = {
      propertyCache: new Map(),
      seenObjectIds: new Set(),
      abortState: { aborted: false, reason: "" },
      stats
    };
    markVsObjectScanned({ type: "object", objectId }, context);
    const candidate = await evaluateVsCandidateObject(
      cdp,
      { type: "object", objectId },
      {
        frameIndex: -1,
        functionName: "cached",
        scopeType: "cached",
        variablePath: "cached_object",
        ancestors: [],
        identity: {}
      },
      context
    );
    if (!candidate) {
      return {
        ok: false,
        reason: "cached VS object is no longer readable"
      };
    }
    return {
      ...candidate,
      ok: true,
      source: "paused_scope"
    };
  } catch (error) {
    if (isInvalidRemoteObjectError(error)) {
      return {
        ok: false,
        invalidObjectId: true,
        reason: error?.message ?? String(error)
      };
    }
    throw error;
  }
}

export async function processVsObjectDiagnostics(
  cdp,
  {
    vsRoundStatus,
    tracking,
    liveSnapshotPath,
    vsObjectSnapshotPath = DEFAULT_VS_OBJECT_SNAPSHOT_PATH,
    traceEnabled = false,
    scopeTraceEnabled = false,
    log = (message) => console.log(message),
    getVsRoundStatus = () => vsRoundStatus,
    readVsObjectStateFn = readVsLocalGameObject,
    readVsCachedObjectStateFn = readVsLocalGameObjectFromCachedHandle,
    captureVsObjectFromPausedScopeFn = captureVsLocalGameObjectFromPausedScope,
    nowFn = () => Date.now()
  }
) {
  if (!scopeTraceEnabled && tracking.lastActiveRoundId) {
    clearVsScopeSchedule(tracking, "trace_disabled", log);
  }
  if (!vsRoundStatus?.active) {
    if (tracking.lastActiveRoundId) {
      clearVsScopeSchedule(tracking, "inactive", log);
    }
    return { handled: false, found: false };
  }

  const roundId = String(vsRoundStatus.roundId ?? "");
  const now = nowFn();
  tracking.lastActiveRoundId = roundId;
  if (tracking.roundId !== roundId) {
    if (tracking.roundId) {
      clearVsScopeSchedule(tracking, "round_changed", log);
    }
    tracking.roundId = roundId;
    tracking.lastSnapshotSignature = "";
    tracking.lastCandidateLogSignature = "";
    tracking.lastNotFoundRoundId = "";
    resetVsScopeRoundState(tracking, now);
    clearSnapshotFile(liveSnapshotPath);
    clearSnapshotFile(vsObjectSnapshotPath);
  }

  const identity = {
    roundId,
    gameid: vsRoundStatus.localGameId,
    userid: vsRoundStatus.localUserId,
    username: vsRoundStatus.localUsername
  };
  const readyAt = Number(vsRoundStatus.readyAt ?? 0) || 0;

  if (tracking.cachedObjectId) {
    const cachedCandidate = await readVsCachedObjectStateFn(cdp, {
      objectId: tracking.cachedObjectId
    });
    if (cachedCandidate?.ok) {
      const snapshot = buildVsObjectSnapshot(cachedCandidate, vsRoundStatus, "paused_scope");
      const signature = buildVsObjectSnapshotSignature(snapshot);
      if (signature !== tracking.lastSnapshotSignature) {
        writeSnapshot(vsObjectSnapshotPath, snapshot);
        tracking.lastSnapshotSignature = signature;
      }
      return {
        handled: true,
        found: true,
        candidate: cachedCandidate,
        snapshot
      };
    }
    if (cachedCandidate?.invalidObjectId) {
      clearVsCachedHandle(tracking);
      tracking.scopeCaptureLocked = true;
    }
    if (tracking.lastSnapshotSignature) {
      clearSnapshotFile(vsObjectSnapshotPath);
      tracking.lastSnapshotSignature = "";
      tracking.lastCandidateLogSignature = "";
    }
    return { handled: true, found: false, candidate: null };
  }

  let candidate = await readVsObjectStateFn(cdp, identity);
  let snapshotSource = "window_graph";

  if (
    !candidate?.ok &&
    scopeTraceEnabled &&
    !tracking.scopeCaptureLocked &&
    !tracking.scopeCaptureInFlight
  ) {
    const nextAttempt = tracking.scopeAttempts + 1;
    const nextAttemptAt = resolveVsScopeAttemptAt(readyAt, nextAttempt);
    tracking.nextScopeAttemptAt = nextAttemptAt;
    if (
      Number.isFinite(nextAttemptAt) &&
      nextAttempt <= VS_SCOPE_MAX_ATTEMPTS &&
      tracking.scopeLastScheduledAttempt !== nextAttempt
    ) {
      logVsScopeScheduled(nextAttempt, nextAttemptAt - now, log);
      tracking.scopeLastScheduledAttempt = nextAttempt;
      tracking.scopeLastCancelReason = "";
    }
    const readyForScopeAttempt =
      tracking.scopeAttempts < VS_SCOPE_MAX_ATTEMPTS &&
      Number.isFinite(nextAttemptAt) &&
      now >= nextAttemptAt &&
      isVsRoundStillActive(roundId, getVsRoundStatus);
    if (readyForScopeAttempt) {
      tracking.scopeAttempts += 1;
      const afterReadyMs = Math.max(0, now - readyAt);
      logVsScopeGameplayProbeStarted(tracking.scopeAttempts, afterReadyMs, log);
      tracking.scopeCaptureInFlight = true;
      const scopeCapture = await captureVsObjectFromPausedScopeFn(cdp, {
        roundId,
        identity,
        log,
        getVsRoundStatus,
        attempt: tracking.scopeAttempts,
        afterReadyMs,
        nowFn
      }).finally(() => {
        tracking.scopeCaptureInFlight = false;
      });
      accumulateVsScopeStats(tracking.scopeStats, scopeCapture.stats);
      if (scopeCapture.ok) {
        tracking.cachedObjectId = scopeCapture.objectId;
        tracking.cachedPath = scopeCapture.candidate.variablePath;
        tracking.cachedScore = scopeCapture.candidate.score;
        candidate = scopeCapture.candidate;
        snapshotSource = "paused_scope";
      } else {
        tracking.nextScopeAttemptAt = resolveVsScopeAttemptAt(
          readyAt,
          tracking.scopeAttempts + 1
        );
        if (scopeCapture.cancelled) {
          return { handled: true, found: false, candidate: null };
        }
        if (
          tracking.scopeAttempts >= VS_SCOPE_MAX_ATTEMPTS &&
          !tracking.scopeFailureLogged
        ) {
          tracking.scopeFailureLogged = true;
          tracking.scopeCaptureLocked = true;
          logVsScopeNotFound(roundId, tracking.scopeAttempts, tracking.scopeStats, log);
        }
      }
    }
  }

  if (!candidate?.ok) {
    if (tracking.lastSnapshotSignature) {
      clearSnapshotFile(vsObjectSnapshotPath);
      tracking.lastSnapshotSignature = "";
      tracking.lastCandidateLogSignature = "";
    }
    if (tracking.lastNotFoundRoundId !== roundId) {
      tracking.lastNotFoundRoundId = roundId;
      log("[vs-object] local game object not found");
    }
    return { handled: true, found: false, candidate: null };
  }

  tracking.lastNotFoundRoundId = "";
  const snapshot = buildVsObjectSnapshot(candidate, vsRoundStatus, snapshotSource);
  const signature = buildVsObjectSnapshotSignature(snapshot);
  if (signature !== tracking.lastSnapshotSignature) {
    writeSnapshot(vsObjectSnapshotPath, snapshot);
    tracking.lastSnapshotSignature = signature;
  }

  if (traceEnabled && signature !== tracking.lastCandidateLogSignature) {
    tracking.lastCandidateLogSignature = signature;
    logVsObjectCandidate(candidate, log);
  }

  return { handled: true, found: true, candidate, snapshot };
}

function logVsObjectCandidate(candidate, log = (message) => console.log(message)) {
  log("[vs-object] candidate");
  log(`path=${candidate.path ?? ""}`);
  log(`gameid=${candidate.gameid ?? ""}`);
  log(`userid=${candidate.userid ?? ""}`);
  log(`board_width=${candidate.boardWidth ?? 0}`);
  log(`board_height=${candidate.boardHeight ?? 0}`);
  log(`occupied_cells=${candidate.occupiedCells ?? 0}`);
  log(`current=${candidate.current ? String(candidate.current).toUpperCase() : "null"}`);
  log(`hold=${candidate.hold ? String(candidate.hold).toUpperCase() : "null"}`);
  log(
    `queue_first5=${Array.isArray(candidate.queue) ? candidate.queue.slice(0, 5).map((piece) => String(piece).toUpperCase()).join(",") : ""}`
  );
  log(`active=${candidate.active ?? false}`);
}

export async function readTetrioState(cdp, options) {
  const read = async () => {
    const raw = await safeRuntimeEvaluate(cdp, {
      expression: tetrioStateExpression(),
      returnByValue: true,
      awaitPromise: true
    }, {
      result: {
        value: {
          ok: false,
          ready: false,
          reason: "browser execution context not ready yet"
        }
      }
    });
    return raw.result?.value ?? { ok: false, ready: false, reason: "page probe returned empty" };
  };

  let state = await read();
  const now = Date.now();
  const shouldCapture = shouldAttemptClosureCapture({
    probePageState: options.probePageState,
    suppressClosureCapture: options.suppressClosureCapture,
    stateOk: state.ok,
    lastCaptureAt: options.probeState?.lastCaptureAt ?? 0,
    lastPageProbeAt: options.network?.lastPageProbeAt ?? 0,
    now
  });

  if (shouldCapture) {
    const captureStartedAt = Date.now();
    options.probeState.lastCaptureAt = captureStartedAt;
    if (options.network) {
      options.network.lastPageProbeAt = captureStartedAt;
    }
    const captureFn = options.captureGameFn ?? captureTetrioGame;
    const capture = await captureFn(cdp).catch((error) => ({
      ok: false,
      reason: error?.message ?? String(error)
    }));
    if (options.perfEnabled) {
      console.log(
        `[browser-perf] closure_capture elapsed_ms=${Math.max(0, Date.now() - captureStartedAt)}`
      );
    }
    if (capture.ok) {
      console.log(`[browser] page probe exposed game object via ${capture.source}`);
      state = await read();
    } else if (state.reason) {
      state = {
        ...state,
        reason: `${state.reason}; page probe: ${capture.reason}`
      };
    }
  }

  if (options.suppressClosureCapture && !state.ok) {
    return {
      ...state,
      reason: options.suppressedReason ?? DEFAULT_SUPPRESSED_REASON
    };
  }

  if (state.ok) {
    return state;
  }
  if (!options.useSeedSimulationFallback || !options.network.seed) {
    return state;
  }
  return buildSeedFallbackState(options.network);
}

async function captureTetrioGame(cdp) {
  const breakpointIds = [];
  let paused = false;

  try {
    await cdp.send("Debugger.enable");
    for (const expression of ["window.requestAnimationFrame", "window.setTimeout"]) {
      const evaluated = await safeRuntimeEvaluate(cdp, {
        expression,
        objectGroup: "fusion-tetrio-probe",
        silent: true
      }, null).catch(() => null);
      const objectId = evaluated?.result?.objectId;
      if (!objectId) continue;
      const breakpoint = await cdp.send("Debugger.setBreakpointOnFunctionCall", {
        objectId
      }).catch(() => null);
      if (breakpoint?.breakpointId) {
        breakpointIds.push(breakpoint.breakpointId);
      }
    }

    if (breakpointIds.length === 0) {
      return { ok: false, reason: "TETR.IO probe could not attach function breakpoints" };
    }

    const deadline = Date.now() + 900;
    while (Date.now() < deadline) {
      let event;
      try {
        event = await cdp.waitForEvent(
          "Debugger.paused",
          () => true,
          Math.max(50, deadline - Date.now())
        );
      } catch {
        break;
      }

      paused = true;
      const exposed = await exposeTetrioGameFromPausedCallFrames(cdp, event);
      await cdp.send("Debugger.resume").catch(() => undefined);
      paused = false;
      if (exposed.ok) return exposed;
    }

    return { ok: false, reason: "TETR.IO game closure not visible yet" };
  } finally {
    if (paused) {
      await cdp.send("Debugger.resume").catch(() => undefined);
    }
    for (const breakpointId of breakpointIds) {
      await cdp.send("Debugger.removeBreakpoint", { breakpointId }).catch(() => undefined);
    }
    await cdp.send("Runtime.releaseObjectGroup", {
      objectGroup: "fusion-tetrio-probe"
    }).catch(() => undefined);
    await cdp.send("Debugger.disable").catch(() => undefined);
  }
}

async function safeRuntimeEvaluate(cdp, params, fallbackResult = null) {
  try {
    return await cdp.send("Runtime.evaluate", params);
  } catch (error) {
    if (isMissingExecutionContextError(error)) {
      return fallbackResult;
    }
    throw error;
  }
}

function isMissingExecutionContextError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("cannot find default execution context") ||
    message.includes("execution context was destroyed") ||
    message.includes("inspected target navigated or closed") ||
    message.includes("no frame with given id")
  );
}

async function exposeTetrioGameFromPausedCallFrames(cdp, pausedEvent) {
  for (const callFrame of pausedEvent.callFrames ?? []) {
    const result = await cdp.send("Debugger.evaluateOnCallFrame", {
      callFrameId: callFrame.callFrameId,
      expression: pausedFrameExposureExpression(),
      returnByValue: true,
      silent: true
    }).catch(() => null);

    const value = result?.result?.value;
    if (value?.ok) return value;
  }
  return { ok: false, reason: "TETR.IO active game variable was not in paused scopes" };
}

export function pausedFrameExposureExpression() {
  return `(() => {
    try {
      if (
        typeof Ai !== "undefined" &&
        Ai &&
        typeof Ai.ejectState === "function" &&
        typeof Ai.ejectBoardState === "function"
      ) {
        if (Ai === window.__fusionEndedTetrioGame) {
          try {
            const exported = Ai.ejectState();
            const state =
              exported && typeof exported === "object" && exported.game
                ? exported.game
                : exported;
            if (state?.destroyed || state?.dead || state?.gameover) {
              return { ok: false };
            }
          } catch {
            return { ok: false };
          }

          delete window.__fusionEndedTetrioGame;
        }

        window.__fusionTetrioGame = Ai;
        window.__fusionTetrioBridge = {
          ok: true,
          source: "closure:Ai",
          at: Date.now(),
          href: location.href
        };
        return window.__fusionTetrioBridge;
      }
    } catch {}
    return { ok: false };
  })()`;
}

function buildSeedFallbackState(network) {
  const now = Date.now();
  const ready = network.readyAt > 0 && now >= network.readyAt;
  const generated = getCurrentAndNext(network.seed, 0, network.nextCount);
  return {
    ok: Boolean(generated.current),
    ready,
    reason: ready ? null : "TETR.IO seed captured; waiting for countdown timing",
    field: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => false)),
    current: generated.current,
    hold: null,
    queue: generated.queue,
    b2b: false,
    combo: 0,
    incoming: 0,
    pieceCounter: 0,
    playing: ready,
    countdown: !ready
  };
}

function createPrng(seed) {
  let value = Number.parseInt(seed, 10) % 2147483647;
  if (value <= 0) value += 2147483646;
  return {
    next() {
      value = (16807 * value) % 2147483647;
      return value;
    },
    nextFloat() {
      return (this.next() - 1) / 2147483646;
    }
  };
}

function generate7BagQueue(seed, count) {
  const rng = createPrng(seed);
  const pieces = ["z", "l", "o", "s", "i", "j", "t"];
  const bag = [];
  const queue = [];
  while (queue.length < count) {
    const nextBag = [...pieces];
    for (let index = nextBag.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(rng.nextFloat() * (index + 1));
      [nextBag[index], nextBag[swapIndex]] = [nextBag[swapIndex], nextBag[index]];
    }
    bag.push(...nextBag);
    while (bag.length > 0 && queue.length < count) {
      queue.push(bag.shift());
    }
  }
  return queue;
}

function getCurrentAndNext(seed, pieceIndex, nextCount = DEFAULT_NEXT_COUNT) {
  const queue = generate7BagQueue(seed, pieceIndex + nextCount + 1);
  return {
    current: queue[pieceIndex] ?? null,
    queue: queue.slice(pieceIndex + 1, pieceIndex + 1 + nextCount)
  };
}

export function vsObjectStateExpression(identity) {
  const requestJson = JSON.stringify({
    roundId: String(identity?.roundId ?? ""),
    gameid: identity?.gameid ?? identity?.localGameId ?? "",
    userid: identity?.userid ?? identity?.localUserId ?? "",
    username: identity?.username ?? identity?.localUsername ?? ""
  });

  return `(() => {
    const request = ${requestJson};
    const MAX_DEPTH = 8;
    const MAX_VISITED = 5000;
    const MAX_CHILDREN = 120;
    const pieceNames = ["i", "o", "t", "s", "z", "j", "l"];
    const safeScalar = (value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        const text = String(value).trim();
        return text.length > 0 ? text : null;
      }
      return null;
    };
    const normalizedIdentity = {
      roundId: safeScalar(request.roundId) ?? "",
      gameid: safeScalar(request.gameid),
      userid: safeScalar(request.userid),
      username: safeScalar(request.username)
    };
    const lower = (value) => safeScalar(value)?.toLowerCase() ?? null;
    const isObjectLike = (value) =>
      (typeof value === "object" && value !== null) || typeof value === "function";
    const isDomLike = (value) =>
      !!value &&
      typeof value === "object" &&
      (typeof value.nodeType === "number" || typeof value.ownerDocument === "object");
    const isTypedArray = (value) =>
      typeof ArrayBuffer !== "undefined" &&
      typeof ArrayBuffer.isView === "function" &&
      ArrayBuffer.isView(value);
    const isSkippable = (value) =>
      !isObjectLike(value) ||
      isDomLike(value) ||
      isTypedArray(value) ||
      value instanceof Date ||
      value instanceof RegExp ||
      value === window ||
      (typeof document !== "undefined" && value === document);
    const descriptorEntries = (value) => {
      try {
        return Object.entries(Object.getOwnPropertyDescriptors(value));
      } catch {
        return [];
      }
    };
    const ownValueEntries = (value, pathLabel, limit = MAX_CHILDREN) => {
      if (!isObjectLike(value)) return [];
      if (Array.isArray(value)) {
        const entries = [];
        for (let index = 0; index < Math.min(value.length, limit); index++) {
          entries.push({
            key: String(index),
            value: value[index],
            path: \`\${pathLabel}[\${index}]\`
          });
        }
        return entries;
      }
      if (value instanceof Map) {
        const entries = [];
        let index = 0;
        for (const [key, child] of value.entries()) {
          entries.push({
            key: String(key),
            value: child,
            path: \`\${pathLabel}[map:\${index}]\`
          });
          index += 1;
          if (index >= limit) break;
        }
        return entries;
      }
      if (value instanceof Set) {
        const entries = [];
        let index = 0;
        for (const child of value.values()) {
          entries.push({
            key: String(index),
            value: child,
            path: \`\${pathLabel}[set:\${index}]\`
          });
          index += 1;
          if (index >= limit) break;
        }
        return entries;
      }
      const entries = [];
      for (const [key, descriptor] of descriptorEntries(value)) {
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          continue;
        }
        if (key === "length") {
          continue;
        }
        const child = descriptor.value;
        const keyLabel =
          /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
            ? \`.\${key}\`
            : \`[\${JSON.stringify(key)}]\`;
        entries.push({
          key,
          value: child,
          path: \`\${pathLabel}\${keyLabel}\`
        });
        if (entries.length >= limit) {
          break;
        }
      }
      return entries;
    };
    const ownValue = (value, keys) => {
      for (const key of keys) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")) {
            return descriptor.value;
          }
        } catch {}
      }
      return undefined;
    };
    const rowCells = (row) => {
      if (Array.isArray(row)) return row;
      if (!row || typeof row !== "object") return null;
      const direct = ownValue(row, ["cells", "row", "data", "cols", "entries"]);
      return Array.isArray(direct) ? direct : null;
    };
    const filled = (cell) => {
      if (cell === null || cell === undefined || cell === false || cell === 0 || cell === "") {
        return false;
      }
      if (typeof cell === "string") {
        const text = cell.trim().toLowerCase();
        return text !== "" && text !== "." && text !== "0" && text !== "empty";
      }
      if (typeof cell === "object") {
        const empty = ownValue(cell, ["empty"]);
        if (typeof empty === "boolean") return !empty;
        const type = ownValue(cell, ["type", "mino", "value", "id", "cell"]);
        if (type !== undefined) return filled(type);
      }
      return true;
    };
    const boardFromMatrix = (value) => {
      if (Array.isArray(value)) {
        if ((value.length === 20 || value.length === 40) && value.every((row) => {
          const cells = rowCells(row);
          return Array.isArray(cells) && cells.length === 10;
        })) {
          return value.map((row) => rowCells(row).slice(0, 10).map(filled));
        }
        if (
          value.length === 10 &&
          value.every((column) => {
            const cells = rowCells(column);
            return Array.isArray(cells) && (cells.length === 20 || cells.length === 40);
          })
        ) {
          const height = rowCells(value[0]).length;
          return Array.from({ length: height }, (_, y) =>
            Array.from({ length: 10 }, (_, x) => filled(rowCells(value[x])[y]))
          );
        }
      }
      if (value && typeof value === "object") {
        for (const key of ["board", "field", "rows", "grid", "matrix", "cells", "entries", "b"]) {
          const nested = ownValue(value, [key]);
          if (nested !== undefined) {
            const board = boardFromMatrix(nested);
            if (board) return board;
          }
        }
      }
      return null;
    };
    const normalizePiece = (value) => {
      if (value === null || value === undefined || value === false) return null;
      if (typeof value === "number" && Number.isFinite(value)) {
        return pieceNames[Math.floor(value)] ?? null;
      }
      if (typeof value === "string") {
        const text = value.trim().toLowerCase();
        if (!text) return null;
        if (pieceNames.includes(text)) return text;
        for (const token of text.split(/[^a-z0-9]+/)) {
          if (pieceNames.includes(token)) return token;
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
        for (const key of ["type", "symbol", "piece", "name", "mino", "id", "value", "kind"]) {
          const piece = normalizePiece(ownValue(value, [key]));
          if (piece) return piece;
        }
      }
      return null;
    };
    const queueFrom = (value) => {
      if (!Array.isArray(value)) return [];
      return value.map((item) => normalizePiece(item)).filter(Boolean).slice(0, 12);
    };
    const collectIdentity = (source, target) => {
      if (!source || !isObjectLike(source)) return target;
      const assign = (key, value) => {
        const scalar = safeScalar(value);
        if (scalar !== null && target[key] === null) {
          target[key] = scalar;
        }
      };
      assign("gameid", ownValue(source, ["gameid", "game_id"]));
      assign("userid", ownValue(source, ["userid", "user_id", "_id"]));
      assign("username", ownValue(source, ["username", "name"]));
      for (const key of ["local", "self", "player", "user", "owner", "profile", "meta"]) {
        const nested = ownValue(source, [key]);
        if (!nested || !isObjectLike(nested)) continue;
        assign("gameid", ownValue(nested, ["gameid", "game_id"]));
        assign("userid", ownValue(nested, ["userid", "user_id", "_id"]));
        assign("username", ownValue(nested, ["username", "name"]));
      }
      return target;
    };
    const extractShape = (source) => {
      const board = boardFromMatrix(source);
      if (!board) return null;
      const current = normalizePiece(
        ownValue(source, ["current", "active", "falling", "piece", "tetromino"])
      );
      if (!current) return null;
      const hold = normalizePiece(ownValue(source, ["hold", "held", "reserve"]));
      const queue = queueFrom(
        ownValue(source, ["queue", "next", "preview", "previews", "pieces", "bag", "nextQueue"])
      );
      let active = ownValue(source, ["active", "alive", "playing"]);
      if (typeof active !== "boolean") {
        const dead = ownValue(source, ["dead", "destroyed", "gameover", "gameOver"]);
        if (typeof dead === "boolean") {
          active = !dead;
        }
      }
      if (typeof active !== "boolean") {
        const status = ownValue(source, ["state", "status", "phase"]);
        if (typeof status === "string") {
          const text = status.trim().toLowerCase();
          if (["active", "alive", "playing", "running", "go"].includes(text)) {
            active = true;
          } else if (["dead", "destroyed", "ended", "gameover", "finished", "over"].includes(text)) {
            active = false;
          }
        }
      }
      if (typeof active !== "boolean") {
        active = true;
      }
      const occupiedCells = board.reduce(
        (sum, row) => sum + row.filter(Boolean).length,
        0
      );
      return {
        board,
        boardWidth: board[0]?.length ?? 0,
        boardHeight: board.length,
        occupiedCells,
        current,
        hold,
        queue,
        active
      };
    };
    const matchIdentity = (candidateIdentity) => {
      let score = 0;
      let matched = false;
      if (normalizedIdentity.gameid) {
        if (candidateIdentity.gameid) {
          if (candidateIdentity.gameid !== normalizedIdentity.gameid) return null;
          score += 100;
          matched = true;
        }
      }
      if (normalizedIdentity.userid) {
        if (candidateIdentity.userid) {
          if (candidateIdentity.userid !== normalizedIdentity.userid) return null;
          score += 40;
          matched = true;
        }
      }
      if (normalizedIdentity.username) {
        if (candidateIdentity.username) {
          if (lower(candidateIdentity.username) !== lower(normalizedIdentity.username)) {
            return null;
          }
          score += 10;
          matched = true;
        }
      }
      return matched ? score : null;
    };
    const candidateFromShape = (shapeEntry, contextRefs) => {
      const shape = extractShape(shapeEntry.value);
      if (!shape) return null;
      if (shape.boardWidth !== 10 || (shape.boardHeight !== 20 && shape.boardHeight !== 40)) {
        return null;
      }
      const identityValues = { gameid: null, userid: null, username: null };
      for (const ref of contextRefs) {
        collectIdentity(ref, identityValues);
      }
      const score = matchIdentity(identityValues);
      if (score === null) return null;
      return {
        ok: true,
        path: shapeEntry.path,
        gameid: identityValues.gameid,
        userid: identityValues.userid,
        username: identityValues.username,
        board: shape.board,
        boardWidth: shape.boardWidth,
        boardHeight: shape.boardHeight,
        occupiedCells: shape.occupiedCells,
        current: shape.current,
        hold: shape.hold,
        queue: shape.queue,
        active: shape.active,
        score,
        shapeRef: shapeEntry.value,
        contextRefs
      };
    };
    const inspectNode = (value, pathLabel, lineage) => {
      const contextRefs = [...lineage, value].filter(isObjectLike).slice(-6);
      const direct = candidateFromShape({ value, path: pathLabel }, contextRefs);
      if (direct) return direct;
      for (const child of ownValueEntries(value, pathLabel, 24)) {
        if (!isObjectLike(child.value)) continue;
        const nested = candidateFromShape(child, contextRefs);
        if (nested) return nested;
      }
      return null;
    };
    const ensureCache = () => {
      if (!window.__fusionVsObjectCache || typeof window.__fusionVsObjectCache !== "object") {
        window.__fusionVsObjectCache = {
          roundId: "",
          winnerPath: "",
          winnerShapeRef: null,
          winnerContextRefs: [],
          objectMeta: new WeakMap(),
          nextObjectId: 1
        };
      }
      const cache = window.__fusionVsObjectCache;
      if (!(cache.objectMeta instanceof WeakMap)) {
        cache.objectMeta = new WeakMap();
      }
      return cache;
    };
    const cache = ensureCache();
    if (cache.roundId !== normalizedIdentity.roundId) {
      cache.roundId = normalizedIdentity.roundId;
      cache.winnerPath = "";
      cache.winnerShapeRef = null;
      cache.winnerContextRefs = [];
    }
    const serializeCandidate = (candidate) => {
      if (!candidate) {
        return {
          ok: false,
          reason: "TETR.IO VS local game object not found"
        };
      }
      return {
        ok: true,
        path: candidate.path,
        gameid: candidate.gameid,
        userid: candidate.userid,
        username: candidate.username,
        board: candidate.board,
        boardWidth: candidate.boardWidth,
        boardHeight: candidate.boardHeight,
        occupiedCells: candidate.occupiedCells,
        current: candidate.current,
        hold: candidate.hold,
        queue: candidate.queue,
        active: candidate.active,
        capturedAt: Date.now()
      };
    };
    const touchMeta = (value) => {
      if (!isObjectLike(value)) return;
      const current = cache.objectMeta.get(value);
      if (current) return current;
      const meta = { id: cache.nextObjectId++ };
      cache.objectMeta.set(value, meta);
      return meta;
    };
    if (cache.winnerShapeRef && Array.isArray(cache.winnerContextRefs)) {
      const cached = candidateFromShape(
        { value: cache.winnerShapeRef, path: cache.winnerPath || "window.__fusionVsObjectCache.winner" },
        cache.winnerContextRefs.filter(isObjectLike)
      );
      if (cached) {
        touchMeta(cache.winnerShapeRef);
        return serializeCandidate(cached);
      }
    }
    const queue = [];
    const pushRoot = (value, pathLabel) => {
      if (!isObjectLike(value) || isSkippable(value)) return;
      queue.push({ value, path: pathLabel, lineage: [] });
    };
    pushRoot(window.__fusionTetrioGame, "window.__fusionTetrioGame");
    pushRoot(window.tetrioGame, "window.tetrioGame");
    pushRoot(window.TETRIO_GAME, "window.TETRIO_GAME");
    pushRoot(window.game, "window.game");
    pushRoot(window.app, "window.app");
    pushRoot(window.tetrio, "window.tetrio");
    for (const entry of ownValueEntries(window, "window", 1500)) {
      if (!isObjectLike(entry.value) || isSkippable(entry.value)) continue;
      queue.push({ value: entry.value, path: entry.path, lineage: [] });
    }
    const visited = new WeakSet();
    let visitedCount = 0;
    let best = null;
    while (queue.length > 0 && visitedCount < MAX_VISITED) {
      const current = queue.shift();
      if (!current || !isObjectLike(current.value) || isSkippable(current.value)) continue;
      if (visited.has(current.value)) continue;
      visited.add(current.value);
      visitedCount += 1;
      touchMeta(current.value);
      const candidate = inspectNode(current.value, current.path, current.lineage);
      if (
        candidate &&
        (!best ||
          candidate.score > best.score ||
          (candidate.score === best.score && candidate.path.length < best.path.length))
      ) {
        best = candidate;
      }
      if (current.lineage.length >= MAX_DEPTH) {
        continue;
      }
      const nextLineage = [...current.lineage, current.value].slice(-6);
      for (const child of ownValueEntries(current.value, current.path)) {
        if (!isObjectLike(child.value) || isSkippable(child.value)) continue;
        queue.push({
          value: child.value,
          path: child.path,
          lineage: nextLineage
        });
      }
    }
    if (best) {
      cache.winnerPath = best.path;
      cache.winnerShapeRef = best.shapeRef;
      cache.winnerContextRefs = best.contextRefs.filter(isObjectLike);
    }
    return serializeCandidate(best);
  })()`;
}

export function tetrioStateExpression() {
  return `(() => {
    const pieceNames = ["i", "o", "t", "s", "z", "j", "l"];
    const normalizePiece = (value) => {
      if (value === null || value === undefined || value === false) return null;
      if (typeof value === "number") return pieceNames[value] ?? null;
      if (typeof value === "string") {
        const text = value.trim().toLowerCase();
        if (!text) return null;
        for (const token of text.split(/[^a-z0-9]+/)) {
          if (pieceNames.includes(token)) return token;
        }
        return pieceNames.includes(text) ? text : null;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const piece = normalizePiece(item);
          if (piece) return piece;
        }
        return null;
      }
      if (typeof value === "object") {
        for (const key of ["type", "symbol", "id", "piece", "name", "mino", "value"]) {
          const piece = normalizePiece(value[key]);
          if (piece) return piece;
        }
      }
      return null;
    };
    const filled = (cell) => {
      if (cell === null || cell === undefined || cell === false || cell === 0 || cell === "") return false;
      if (typeof cell === "string") {
        const text = cell.trim().toLowerCase();
        return text !== "" && text !== "." && text !== "0" && text !== "empty";
      }
      if (typeof cell === "object") {
        if ("empty" in cell) return !cell.empty;
        if ("type" in cell) return filled(cell.type);
        if ("mino" in cell) return filled(cell.mino);
      }
      return true;
    };
    const rowCells = (row) =>
      Array.isArray(row)
        ? row
        : Array.isArray(row?.cells)
          ? row.cells
          : Array.isArray(row?.row)
            ? row.row
            : null;
    const queueFrom = (...values) => {
      for (const value of values) {
        if (!Array.isArray(value)) continue;
        const queue = value.map(normalizePiece).filter(Boolean);
        if (queue.length > 0) return queue.slice(0, 12);
      }
      return [];
    };
    const numberFrom = (...values) => {
      for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
      }
      return null;
    };
    const integerFrom = (...values) => {
      const number = numberFrom(...values);
      return number === null ? null : Math.floor(number);
    };
    const rotationFrom = (...values) => {
      for (const value of values) {
        if (value === null || value === undefined) continue;
        if (typeof value === "number" && Number.isFinite(value)) {
          const normalized = ((Math.floor(value) % 4) + 4) % 4;
          return ["north", "east", "south", "west"][normalized] ?? null;
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
    };
    const looksLikeGame = (value) =>
      value &&
      typeof value === "object" &&
      typeof value.ejectState === "function" &&
      typeof value.ejectBoardState === "function";
    const candidateEnded = (candidate) => {
      if (!looksLikeGame(candidate)) return false;

      try {
        const exported = candidate.ejectState();
        const state =
          exported && typeof exported === "object" && exported.game
            ? exported.game
            : exported;

        return Boolean(
          state?.destroyed ||
          state?.dead ||
          state?.gameover
        );
      } catch {
        return false;
      }
    };
    const usableGame = (candidate) => {
      if (!looksLikeGame(candidate)) return false;

      if (candidate === window.__fusionEndedTetrioGame) {
        if (candidateEnded(candidate)) {
          return false;
        }

        delete window.__fusionEndedTetrioGame;
      }

      return true;
    };
    const scanObject = (root, limit = 200) => {
      if (!root || typeof root !== "object") return null;
      let names = [];
      try { names = Object.getOwnPropertyNames(root).slice(0, limit); } catch {}
      for (const name of names) {
        try {
          const value = root[name];
          if (usableGame(value)) return value;
        } catch {}
      }
      return null;
    };
    const findGame = () => {
      const direct = [window.__fusionTetrioGame, window.tetrioGame, window.TETRIO_GAME, window.game, window.app, window.tetrio];
      for (const candidate of direct) {
        if (usableGame(candidate)) return candidate;
        const nested = scanObject(candidate);
        if (nested) return nested;
      }
      const names = Object.getOwnPropertyNames(window).slice(0, 1500);
      for (const name of names) {
        try {
          const value = window[name];
          if (usableGame(value)) return value;
        } catch {}
      }
      return null;
    };

    const game = findGame();
    if (!game) {
      return { ok: false, ready: false, reason: "TETR.IO game instance not captured yet" };
    }
    window.__fusionTetrioGame = game;
    const exported = typeof game.ejectState === "function" ? game.ejectState() : null;
    const boardState = typeof game.ejectBoardState === "function" ? game.ejectBoardState() : null;
    const state = exported && typeof exported === "object" && exported.game ? exported.game : exported;
    if (!state || typeof state !== "object") {
      return { ok: false, ready: false, reason: "TETR.IO game state is not available" };
    }

    const board =
      Array.isArray(state.board) ? state.board :
      Array.isArray(boardState?.b) ? boardState.b :
      null;
    if (!Array.isArray(board) || board.length === 0) {
      return { ok: false, ready: false, reason: "TETR.IO board is not available" };
    }

    const activeState = state.falling ?? state.active ?? state.current ?? state.piece;
    const current = normalizePiece(activeState);
    const hold = normalizePiece(state.hold ?? state.held);
    const queue = queueFrom(state.bag, state.queue, state.next, state.preview, state.previews, state.pieces);
    const stats = state.stats ?? {};
    const pieceCounter = Math.max(0, Math.floor(numberFrom(
      stats.piecesplaced,
      stats.piecesPlaced,
      stats.pieces,
      state.piecesplaced,
      state.piecesPlaced,
      state.pieceCounter,
      state.piececount
    ) ?? -1));
    const linesClearedRaw = numberFrom(
      stats.lines,
      stats.linesCleared,
      stats.lines_cleared,
      state?.stats?.lines,
      state?.stats?.linesCleared,
      state?.stats?.lines_cleared
    );
    const linesCleared =
      linesClearedRaw === null ? null : Math.max(0, Math.floor(linesClearedRaw));
    if (!current || pieceCounter < 0) {
      return { ok: false, ready: false, reason: "TETR.IO current piece or piece counter is not available" };
    }

    const activeX = integerFrom(
      activeState?.x,
      activeState?.col,
      activeState?.column,
      activeState?.cx
    );
    const activeY = integerFrom(
      activeState?.y,
      activeState?.row,
      activeState?.cy
    );
    const activeRotation = rotationFrom(
      activeState?.rotation,
      activeState?.rot,
      activeState?.orientation,
      activeState?.dir,
      activeState?.state
    );

    const playing =
      typeof game.isPlaying === "function" ? Boolean(game.isPlaying()) :
      typeof state.playing === "boolean" ? state.playing :
      typeof state.paused === "boolean" ? !state.paused :
      true;
    const started =
      typeof game.isStarted === "function" ? Boolean(game.isStarted()) :
      Boolean(state.started ?? true);
    const destroyed = Boolean(state.destroyed || state.dead || state.gameover);
    const countdown = started && !destroyed && !playing;
    const ready = started && !destroyed;
    const field = Array.from({ length: 40 }, (_, rowIndex) => {
      const sourceRow = board[board.length - 1 - rowIndex];
      const cells = rowCells(sourceRow);
      return Array.from({ length: 10 }, (_, x) => filled(cells ? cells[x] : null));
    });
    return {
      ok: true,
      ready,
      reason: ready ? null : !started ? "TETR.IO game is not started" : "TETR.IO game ended",
      field,
      current,
      hold,
      queue,
      b2b: Math.max(0, numberFrom(stats.b2b, state.b2b, 0) ?? 0) > 0,
      combo: Math.max(0, numberFrom(stats.combo, state.combo, 0) ?? 0),
      incoming: Math.max(0, numberFrom(stats.impendingdamage, state.incoming, 0) ?? 0),
      pieceCounter,
      linesCleared: linesCleared ?? undefined,
      playing,
      countdown,
      activeX,
      activeY,
      activeRotation
    };
  })()`;
}

function writeSnapshot(snapshotPath, payload) {
  const directory = path.dirname(snapshotPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${snapshotPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2));
  rmSync(snapshotPath, { force: true });
  renameSync(temporaryPath, snapshotPath);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error("[browser] fatal:", error?.message ?? error);
    process.exit(1);
  });
}
