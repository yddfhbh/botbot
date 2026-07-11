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

export function buildSnapshotSignature(gameEpoch, state) {
  const queueText = state.queue.join(",");
  return `${gameEpoch}|${state.pieceCounter}|${state.current}|${state.hold ?? "-"}|${queueText}|${state.activeX ?? "-"}|${state.activeY ?? "-"}|${state.activeRotation ?? "-"}`;
}

export function buildSnapshotToken(gameEpoch, pieceCounter) {
  return `browser-${gameEpoch}-${pieceCounter}`;
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
  try {
    const { installDddWsObserver } =
      await import("./ddd-ws-observer.mjs");

    dddWsObserverCleanup = await installDddWsObserver(cdp, {
      unpack: msgpack?.unpack ?? null,
      log: message => console.log(message),
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
  const probeState = {
    lastCaptureAt: 0
  };

  const stop = async () => {
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
    const state = await readTetrioState(cdp, {
      probePageState,
      useSeedSimulationFallback,
      network,
      probeState
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
      await sleep(pollMs);
      continue;
    }

    if (!state.ok || !state.ready || !state.playing || state.countdown) {
      const reason =
        state.reason ??
        (!state.playing ? "page is not playing" : state.countdown ? "countdown active" : "state not ready");
      if (reason !== lastReason || Date.now() - lastReasonAt >= DEFAULT_STATUS_MS) {
        console.log(`[browser] ${reason}`);
        lastReason = reason;
        lastReasonAt = Date.now();
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
        console.log(
          `[browser-perf] piece_change_to_snapshot_ms=${Math.max(0, Date.now() - snapshotTracking.pendingPieceDetectedAt)}`
        );
      }
      if (snapshot.token !== snapshotTracking.lastLoggedToken) {
        snapshotTracking.lastLoggedToken = snapshot.token;
        console.log(
          `[browser] page state ready pieceCounter=${state.pieceCounter} current=${snapshot.current} hold=${snapshot.hold ?? "-"} queue=${snapshot.queue.join(",")}`
        );
      }
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

async function readTetrioState(cdp, options) {
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
  const shouldCapture =
    options.probePageState &&
    !state.ok &&
    Date.now() - (options.probeState?.lastCaptureAt ?? 0) >= 2000 &&
    Date.now() - (options.network?.lastPageProbeAt ?? 0) >= 2000;

  if (shouldCapture) {
    options.probeState.lastCaptureAt = Date.now();
    if (options.network) {
      options.network.lastPageProbeAt = Date.now();
    }
    const capture = await captureTetrioGame(cdp).catch((error) => ({
      ok: false,
      reason: error?.message ?? String(error)
    }));
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
