import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveGameStateSnapshot } from "./tetrio-state.mjs";

const DEFAULT_URL = "https://tetr.io/";
const DEFAULT_PORT = 9222;
const DEFAULT_NEXT_COUNT = 6;
const DEFAULT_STATUS_MS = 2500;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotPath = args.snapshotPath ?? "automation/live-snapshot.json";
  const url = args.url ?? DEFAULT_URL;
  const port = numberArg(args.port, DEFAULT_PORT);
  const targetHint = args.target ?? "TETR.IO";
  const pollMs = numberArg(args.pollMs, 40);
  const connectOnly = args.connectOnly === "1";
  const chromePath = process.env.CHROME_PATH || "";
  const msgpack = await loadOptionalMsgpack();
  const selector = {
    playerSelector: args.playerSelector ?? "auto",
    playerNickname: args.playerNickname ?? "",
    playerUserId: args.playerUserId ?? "",
    dumpStateOnFail: args.dumpStateOnFail !== "0",
    dumpStatePath: args.dumpStatePath ?? "automation/debug/tetrio-state-dump.json"
  };

  let browserProcess = null;
  if (!connectOnly) {
    const alreadyOpen = await isCdpOpen(port);
    if (!alreadyOpen) {
      browserProcess = launchChromium({ port, url, chromePath });
    }
  }

  await waitForCdp(port);
  const target = await findOrCreateTarget({ port, url, targetHint });
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable").catch(() => undefined);
  await cdp.send("Runtime.enable").catch(() => undefined);
  await cdp.send("Page.bringToFront").catch(() => undefined);
  await installBackgroundInputKeepalive(cdp);
  await safeRuntimeEvaluate(
    cdp,
    {
      expression: "window.focus(); document.body && document.body.focus && document.body.focus(); true"
    },
    null
  ).catch(() => undefined);

  console.log(`[browser] connected to ${target.title || target.url} on port ${port}`);
  console.log(
    `[browser] selector=${selector.playerSelector} nickname=${selector.playerNickname || "-"} userId=${selector.playerUserId || "-"}`
  );

  const network = createTetrioNetworkState();
  if (msgpack && args.useRibbonWebsocket !== "0") {
    await installRibbonMonitor(cdp, network, msgpack);
  }

  let lastReason = "";
  let lastReasonAt = 0;
  let stableSignature = "";
  let stableCount = 0;
  let lastWrittenSignature = "";
  let lastLoggedToken = "";
  let lastSelectedPath = "";
  let lastSelectionReason = "";
  const probeState = {
    lastCaptureAt: 0
  };

  const stop = async () => {
    await cdp.close().catch(() => undefined);
    browserProcess?.kill();
  };
  process.on("SIGINT", () => stop().finally(() => process.exit(0)));
  process.on("SIGTERM", () => stop().finally(() => process.exit(0)));

  while (true) {
    const state = await readTetrioState(cdp, {
      selector,
      targetTitle: target.title ?? "",
      targetUrl: target.url ?? "",
      probePageState: args.probePageState !== "0",
      useSeedSimulationFallback: args.useSeedSimulationFallback !== "0",
      network,
      probeState
    });

    if (!state.ok || !state.ready || !state.playing || state.countdown) {
      const reason =
        state.reason ??
        (!state.playing ? "page is not playing" : state.countdown ? "countdown active" : "state not ready");
      if (reason !== lastReason || Date.now() - lastReasonAt >= DEFAULT_STATUS_MS) {
        for (const line of state.logs ?? []) {
          console.log(line);
        }
        lastReason = reason;
        lastReasonAt = Date.now();
      }
      await sleep(pollMs);
      continue;
    }

    lastReason = "";
    lastReasonAt = 0;

    const signature = `${state.token}|${state.playing}|${state.countdown}`;
    if (signature === stableSignature) {
      stableCount += 1;
    } else {
      stableSignature = signature;
      stableCount = 1;
    }
    if (stableCount < 2) {
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
      pieceCounter: Number.isFinite(state.pieceCounter) ? state.pieceCounter : undefined,
      token: state.token,
      playing: state.playing,
      countdown: state.countdown,
      activeX: Number.isFinite(state.activeX) ? state.activeX : undefined,
      activeY: Number.isFinite(state.activeY) ? state.activeY : undefined,
      activeRotation: state.activeRotation ?? undefined
    };

    if (signature !== lastWrittenSignature) {
      writeSnapshot(snapshotPath, snapshot);
      lastWrittenSignature = signature;
      const selectionChanged =
        state.selectedPath !== lastSelectedPath || state.selectionReason !== lastSelectionReason;
      if (snapshot.token !== lastLoggedToken || selectionChanged) {
        lastLoggedToken = snapshot.token;
        lastSelectedPath = state.selectedPath;
        lastSelectionReason = state.selectionReason;
        for (const line of state.logs ?? []) {
          console.log(line);
        }
      }
    }

    await sleep(pollMs);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }
    parsed[key] = next;
    i += 1;
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

function launchChromium({ port, url, chromePath }) {
  const executable = chromePath || findChromiumExecutable();
  if (!executable) {
    throw new Error("Could not find Chrome/Edge. Set CHROME_PATH to the browser executable.");
  }
  const profileDir = path.join(os.tmpdir(), `botbot-tetrio-cdp-${port}`);
  mkdirSync(profileDir, { recursive: true });
  return spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=Translate,CalculateNativeWinOcclusion",
      url
    ],
    {
      detached: false,
      stdio: ["ignore", "ignore", "ignore"]
    }
  );
}

function findChromiumExecutable() {
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const candidates = [
    programFiles && path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    programFilesX86 && path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    localAppData && path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    programFiles && path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    programFilesX86 && path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function isCdpOpen(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await isCdpOpen(port)) return;
    await sleep(250);
  }
  throw new Error(`Chrome DevTools endpoint did not open on port ${port}`);
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
  for (let offset = 0; offset <= Math.min(24, payload.length - 1); offset += 1) {
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
  const readRawState = async () => {
    const raw = await safeRuntimeEvaluate(
      cdp,
      {
        expression: captureTetrioExportExpression(),
        returnByValue: true,
        awaitPromise: true
      },
      {
        result: {
          value: {
            ok: false,
            reason: "browser execution context not ready yet"
          }
        }
      }
    );
    return raw?.result?.value ?? { ok: false, reason: "page probe returned empty" };
  };

  let rawState = await readRawState();
  const snapshotFromRaw = (value) =>
    resolveGameStateSnapshot({
      exported: value?.exported ?? null,
      boardState: value?.boardState ?? null,
      pageHints: value?.pageHints ?? {},
      selector: options.selector,
      href: value?.href ?? "",
      targetTitle: options.targetTitle,
      targetUrl: options.targetUrl
    });

  let state = rawState.ok ? snapshotFromRaw(rawState) : { ok: false, ready: false, reason: rawState.reason, logs: [`[browser] reject reason=${rawState.reason}`] };
  const shouldRecaptureGame =
    !state.ok || !state.ready || !state.playing || state.countdown;
  const shouldCapture =
    options.probePageState &&
    shouldRecaptureGame &&
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
      rawState = await readRawState();
      state = rawState.ok
        ? snapshotFromRaw(rawState)
        : { ok: false, ready: false, reason: rawState.reason, logs: [`[browser] reject reason=${rawState.reason}`] };
    } else if (state.reason) {
      state = {
        ...state,
        reason: `${state.reason}; page probe: ${capture.reason}`,
        logs: [...(state.logs ?? []), `[browser] reject reason=${capture.reason}`]
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

function captureTetrioExportExpression() {
  return `(() => {
    const looksLikeGame = (value) =>
      value &&
      typeof value === "object" &&
      typeof value.ejectState === "function" &&
      typeof value.ejectBoardState === "function";
    const scanObject = (root, limit = 200) => {
      if (!root || typeof root !== "object") return null;
      let names = [];
      try { names = Object.getOwnPropertyNames(root).slice(0, limit); } catch {}
      for (const name of names) {
        try {
          const value = root[name];
          if (looksLikeGame(value)) return value;
        } catch {}
      }
      return null;
    };
    const findGame = () => {
      const direct = [window.__fusionTetrioGame, window.tetrioGame, window.TETRIO_GAME, window.game, window.app, window.tetrio];
      for (const candidate of direct) {
        if (looksLikeGame(candidate)) return candidate;
        const nested = scanObject(candidate);
        if (nested) return nested;
      }
      const names = Object.getOwnPropertyNames(window).slice(0, 1500);
      for (const name of names) {
        try {
          const value = window[name];
          if (looksLikeGame(value)) return value;
        } catch {}
      }
      return null;
    };

    const game = findGame();
    if (!game) {
      return { ok: false, reason: "TETR.IO game instance not captured yet" };
    }
    window.__fusionTetrioGame = game;
    const exported = typeof game.ejectState === "function" ? game.ejectState() : null;
    const boardState = typeof game.ejectBoardState === "function" ? game.ejectBoardState() : null;
    return {
      ok: true,
      href: location.href,
      exported,
      boardState,
      pageHints: {
        gameIsPlaying: typeof game.isPlaying === "function" ? Boolean(game.isPlaying()) : null,
        gameIsStarted: typeof game.isStarted === "function" ? Boolean(game.isStarted()) : null
      }
    };
  })()`;
}

async function captureTetrioGame(cdp) {
  const breakpointIds = [];
  let paused = false;

  try {
    await cdp.send("Debugger.enable");
    for (const expression of ["window.requestAnimationFrame", "window.setTimeout"]) {
      const evaluated = await safeRuntimeEvaluate(
        cdp,
        {
          expression,
          objectGroup: "fusion-tetrio-probe",
          silent: true
        },
        null
      ).catch(() => null);
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
      expression: `(() => {
        try {
          if (
            typeof Ai !== "undefined" &&
            Ai &&
            typeof Ai.ejectState === "function" &&
            typeof Ai.ejectBoardState === "function"
          ) {
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
      })()`,
      returnByValue: true,
      silent: true
    }).catch(() => null);

    const value = result?.result?.value;
    if (value?.ok) return value;
  }
  return { ok: false, reason: "TETR.IO active game variable was not in paused scopes" };
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
    token: "browser-0",
    playing: ready,
    countdown: !ready,
    logs: [
      `[browser] mode=unknown candidates=0 selector=auto`,
      `[browser] reject reason=${ready ? "seed fallback ready" : "seed fallback waiting"}`
    ]
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
    for (let index = nextBag.length - 1; index > 0; index -= 1) {
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

function writeSnapshot(snapshotPath, payload) {
  const directory = path.dirname(snapshotPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${snapshotPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2));
  try {
    renameSync(temporaryPath, snapshotPath);
  } catch {
    copyFileSync(temporaryPath, snapshotPath);
    rmSync(temporaryPath, { force: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

main().catch((error) => {
  console.error("[browser] fatal:", error?.message ?? error);
  process.exit(1);
});
