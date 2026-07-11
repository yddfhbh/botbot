import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveGameStateSnapshot, writeDebugDump } from "./tetrio-state.mjs";
import { inspectPayloadForGameOptions } from "./tetrio-ws-seed.mjs";

const DEFAULT_URL = "https://tetr.io/";
const DEFAULT_PORT = 9222;
const DEFAULT_NEXT_COUNT = 6;
const DEFAULT_STATUS_MS = 2500;
const DEFAULT_STATE_POLL_MS = 40;
const DEFAULT_MIN_STATE_POLL_MS = 16;
const DIRECT_SCAN_COOLDOWN_MS = 1500;
const DIRECT_SCAN_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;
const PROBE_TIMEOUT_MS = 900;
const PROBE_RETRY_COOLDOWN_MS = 750;
const MAX_PROBE_ATTEMPTS = 4;
const PERF_LOG_INTERVAL_MS = 5000;
const DISCOVERY_RESET_DEBOUNCE_MS = 250;
const TARGET_WAIT_TIMEOUT_MS = 10_000;
const TARGET_WAIT_POLL_MS = 250;
const PAGE_LOAD_TIMEOUT_MS = 15_000;
const CLOSURE_PROBE_BREAKPOINTS = [
  { label: "raf", expression: "window.requestAnimationFrame" },
  { label: "setTimeout", expression: "window.setTimeout" }
];

export function normalizeDebuggerProbeMode(value) {
  return value === "manual" || value === "disabled" || value === "startup_only"
    ? value
    : "startup_only";
}

export function normalizeRibbonDecodeMode(value) {
  return value === "always_debug" || value === "off" || value === "until_seed"
    ? value
    : "until_seed";
}

export function computeEffectiveStatePollMs(statePollMs, minStatePollMs) {
  const configured = numberArg(statePollMs, DEFAULT_STATE_POLL_MS);
  const minimum = numberArg(minStatePollMs, DEFAULT_MIN_STATE_POLL_MS);
  return Math.max(configured, minimum);
}

export function shouldAttemptDebuggerProbe({
  mode,
  needsProbe,
  gameCaptured,
  now,
  lastAttemptAt = 0,
  cooldownMs = PROBE_RETRY_COOLDOWN_MS
}) {
  if (!needsProbe) return false;
  if (normalizeDebuggerProbeMode(mode) !== "startup_only") return false;
  if (gameCaptured) return false;
  if (lastAttemptAt === 0) return true;
  return now - lastAttemptAt >= cooldownMs;
}

export function shouldAttemptClosureProbe({
  probePageState,
  debuggerProbeMode,
  likelyGamePage,
  needsProbe,
  gameCaptured,
  probeAttempts = 0,
  maxAttempts = MAX_PROBE_ATTEMPTS,
  now,
  lastAttemptAt = 0,
  cooldownMs = PROBE_RETRY_COOLDOWN_MS
}) {
  if (!probePageState) return false;
  if (!likelyGamePage) return false;
  if (probeAttempts >= maxAttempts) return false;
  return shouldAttemptDebuggerProbe({
    mode: debuggerProbeMode,
    needsProbe,
    gameCaptured,
    now,
    lastAttemptAt,
    cooldownMs
  });
}

export function shouldDecodeRibbonFrame({ mode, seedCaptured, direction }) {
  const normalizedMode = normalizeRibbonDecodeMode(mode);
  if (normalizedMode === "off") {
    return false;
  }
  if (normalizedMode === "always_debug") {
    return true;
  }
  return !seedCaptured && direction === "received";
}

export function shouldAttemptStartupDirectScan({
  gameCaptured,
  quickGameAvailable = false,
  now,
  lastAttemptAt = 0,
  attempts = 0,
  maxAttempts = DIRECT_SCAN_MAX_ATTEMPTS,
  cooldownMs = DIRECT_SCAN_COOLDOWN_MS
}) {
  if (gameCaptured || quickGameAvailable) return false;
  if (Number.isFinite(maxAttempts) && attempts >= maxAttempts) return false;
  if (lastAttemptAt > 0 && now - lastAttemptAt < cooldownMs) return false;
  return true;
}

export function startupDirectScanDisabledReason({
  gameCaptured,
  quickGameAvailable = false,
  now,
  lastAttemptAt = 0,
  attempts = 0,
  maxAttempts = DIRECT_SCAN_MAX_ATTEMPTS,
  cooldownMs = DIRECT_SCAN_COOLDOWN_MS
}) {
  if (gameCaptured || quickGameAvailable) return "game_captured";
  if (Number.isFinite(maxAttempts) && attempts >= maxAttempts) return "max_attempts";
  if (lastAttemptAt > 0 && now - lastAttemptAt < cooldownMs) return "cooldown";
  return "no_game";
}

export function formatStateEvalPerfLog(rawState, elapsedMs) {
  if (rawState?.quick) {
    return `[perf][state] quick=true scan=false eval_ms=${elapsedMs}`;
  }
  if (rawState?.scanMode === "startup_direct") {
    return `[perf][state] quick=false scan=startup_direct eval_ms=${elapsedMs}`;
  }
  if (rawState?.scanMode === "disabled") {
    return `[perf][state] quick=false scan=disabled reason=${rawState?.scanReason ?? "no_game"}`;
  }
  return `[perf][state] quick=false scan=unknown eval_ms=${elapsedMs}`;
}

export function resetDiscoveryState(probeState) {
  probeState.startupDirectScanAttempts = 0;
  probeState.startupDirectScanLastAt = 0;
  probeState.lastAttemptAt = 0;
  probeState.gameCaptured = false;
  probeState.lastKnownPlaying = false;
  probeState.lastCaptureSource = null;
  probeState.probeAttempts = 0;
  probeState.lastLikelyGamePage = false;
}

export function isTopFrameNavigation(event) {
  const frame = event?.frame;
  if (!frame?.id) return false;
  return !frame.parentId;
}

export function isMainFrameDocumentNavigation(event, mainFrameId) {
  if (!mainFrameId) return true;
  return event?.frameId === mainFrameId;
}

export function shouldResetDiscoveryOnExecutionContextsCleared(probeState) {
  return Boolean(probeState?.gameCaptured || probeState?.lastCaptureSource);
}

export function resetProbeRetryState(probeState) {
  probeState.lastAttemptAt = 0;
  probeState.probeAttempts = 0;
}

export function updateLikelyGamePageState(probeState, likelyGamePage, now = Date.now()) {
  const transitionedToGamePage = Boolean(likelyGamePage) && !probeState.lastLikelyGamePage;
  if (transitionedToGamePage) {
    resetProbeRetryState(probeState);
    probeState.lastLikelyGamePageAt = now;
  }
  probeState.lastLikelyGamePage = Boolean(likelyGamePage);
  return transitionedToGamePage;
}

export function isLikelyGamePage({
  href = "",
  pathname = "",
  hash = "",
  pageTitle = "",
  bodyClass = "",
  largeCanvasCount = 0
} = {}) {
  const text = [href, pathname, hash, pageTitle, bodyClass].join(" ").toLowerCase();
  if (/(play|solo|custom|room|league|match|game|blitz|40l|zen|replay|sandbox)/.test(text)) {
    return true;
  }
  return Number(largeCanvasCount) >= 2;
}

export function getClosureProbeBreakpoints() {
  return [...CLOSURE_PROBE_BREAKPOINTS];
}

export function shouldInstallBackgroundInputKeepalive({
  enabled,
  installed,
  state
}) {
  if (!enabled || installed) return false;
  return Boolean(state?.ok && state?.ready && state?.playing && !state?.countdown);
}

async function clearCachedGameHandle(cdp) {
  await safeRuntimeEvaluate(
    cdp,
    {
      expression: `(() => {
        try { delete window.__fusionTetrioGame; } catch {}
        try { window.__fusionTetrioGame = undefined; } catch {}
        return true;
      })()`,
      returnByValue: true,
      awaitPromise: true
    },
    null
  ).catch(() => undefined);
}

function attachDiscoveryLifecycleHooks(cdp, probeState) {
  let mainFrameId = null;
  let lastResetAt = 0;

  const reset = (reason) => {
    const now = Date.now();
    if (now - lastResetAt < DISCOVERY_RESET_DEBOUNCE_MS) {
      return;
    }
    lastResetAt = now;
    resetDiscoveryState(probeState);
    clearCachedGameHandle(cdp).catch(() => undefined);
    console.log(`[browser] discovery reset reason=${reason}`);
  };

  cdp.on("Page.frameNavigated", (event) => {
    if (!isTopFrameNavigation(event)) {
      return;
    }
    mainFrameId = event.frame.id;
    reset("frame_navigated");
  });
  cdp.on("Page.navigatedWithinDocument", (event) => {
    if (!isMainFrameDocumentNavigation(event, mainFrameId)) {
      return;
    }
    reset("navigated_within_document");
  });
  cdp.on("Runtime.executionContextsCleared", () => {
    resetProbeRetryState(probeState);
    if (!shouldResetDiscoveryOnExecutionContextsCleared(probeState)) {
      return;
    }
    reset("execution_contexts_cleared");
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotPath = args.snapshotPath ?? "automation/live-snapshot.json";
  const url = args.url ?? DEFAULT_URL;
  const port = numberArg(args.port, DEFAULT_PORT);
  const targetHint = args.target ?? "TETR.IO";
  const pollMs = computeEffectiveStatePollMs(
    args.statePollMs ?? args.pollMs,
    args.minStatePollMs ?? args.minPollMs
  );
  const connectOnly = args.connectOnly === "1";
  const chromePath = process.env.CHROME_PATH || "";
  const debuggerProbeMode = normalizeDebuggerProbeMode(args.debuggerProbeMode ?? "startup_only");
  const ribbonDecodeMode = normalizeRibbonDecodeMode(args.ribbonDecodeMode ?? "until_seed");
  const perfLogEnabled = args.perfLogEnabled !== "0";
  const manualCaptureOnce = args.manualCaptureOnce === "1";
  const backgroundInputKeepalive = args.backgroundInputKeepalive === "1";
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
      browserProcess = launchChromium({ port, url, chromePath, profileDir: args.profileDir ?? "" });
    }
  }

  await waitForCdp(port, browserProcess);
  const target = await findOrCreateTarget({ port, url, targetHint });
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable").catch(() => undefined);
  await cdp.send("Runtime.enable").catch(() => undefined);
  await cdp.send("Log.enable").catch(() => undefined);
  await cdp.send("Network.enable").catch(() => undefined);
  await cdp.send("Page.bringToFront").catch(() => undefined);
  attachBrowserDiagnostics(cdp);
  console.log("[browser] waiting for TETR.IO page load");
  const loadStatus = await waitForTetrioPageLoad(cdp, { url, timeoutMs: PAGE_LOAD_TIMEOUT_MS });
  if (!loadStatus.ok) {
    console.log("[browser] TETR.IO bootstrap failed; see browser exception/chrome stderr logs");
    await cdp.close().catch(() => undefined);
    browserProcess?.kill();
    process.exit(1);
  }
  console.log(`[browser] page loaded readyState=${loadStatus.readyState} href=${loadStatus.href}`);
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
  console.log(
    `[browser] config probePageState=${args.probePageState !== "0"} debuggerProbeMode=${debuggerProbeMode}`
  );
  console.log(`[browser] directScanCooldownMs=${DIRECT_SCAN_COOLDOWN_MS}`);
  console.log("[browser] directScanMaxAttempts=unlimited");
  console.log(`[browser] statePollMs=${pollMs}`);

  const perf = createBrowserPerfTracker({ enabled: perfLogEnabled });
  const network = createTetrioNetworkState();
  if (msgpack && args.useRibbonWebsocket !== "0") {
    await installRibbonMonitor(cdp, network, msgpack, ribbonDecodeMode);
  }

  let lastReason = "";
  let lastReasonAt = 0;
  let lastWrittenSignature = "";
  let lastLoggedToken = "";
  let lastSelectedPath = "";
  let lastSelectionReason = "";
  let keepaliveInstalled = false;
  const probeState = {
    startupDirectScanAttempts: 0,
    startupDirectScanLastAt: 0,
    lastAttemptAt: 0,
    probeAttempts: 0,
    gameCaptured: false,
    lastKnownPlaying: false,
    lastDumpAt: 0,
    lastCaptureSource: null,
    lastLikelyGamePage: false,
    lastLikelyGamePageAt: 0
  };
  attachDiscoveryLifecycleHooks(cdp, probeState);

  const stop = async () => {
    await cdp.close().catch(() => undefined);
    browserProcess?.kill();
  };
  process.on("SIGINT", () => stop().finally(() => process.exit(0)));
  process.on("SIGTERM", () => stop().finally(() => process.exit(0)));

  const stopEventLoopLag = perf.startEventLoopLagTracker();

  if (manualCaptureOnce) {
    const capture = await captureTetrioGame(cdp, perf).catch((error) => ({
      ok: false,
      reason: error?.message ?? String(error)
    }));
    stopEventLoopLag();
    await stop();
    if (capture.ok) {
      console.log(`[browser] manual capture ok source=${capture.source}`);
      process.exit(0);
    }
    console.log(`[browser] manual capture failed reason=${capture.reason}`);
    process.exit(1);
  }

  while (true) {
    const state = await readTetrioState(cdp, {
      selector,
      targetTitle: target.title ?? "",
      targetUrl: target.url ?? "",
      probePageState: args.probePageState !== "0",
      debuggerProbeMode,
      useSeedSimulationFallback: args.useSeedSimulationFallback !== "0",
      network,
      probeState,
      perf
    });
    perf.flushIfDue();

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

    if (shouldInstallBackgroundInputKeepalive({
      enabled: backgroundInputKeepalive,
      installed: keepaliveInstalled,
      state
    })) {
      await installBackgroundInputKeepalive(cdp);
      keepaliveInstalled = true;
      console.log("[browser] background input keepalive enabled");
    }

    const signature = `${state.token}|${state.playing}|${state.countdown}`;
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
      perf.recordSnapshotWrite();
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
        console.log(
          `[browser] page state ready pieceCounter=${state.pieceCounter ?? "-"} current=${snapshot.current} queue=${snapshot.queue.join(",")}`
        );
        console.log(`[browser] wrote snapshot token=${snapshot.token}`);
      }
    } else {
      perf.recordDuplicateSkip();
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
    if (next === undefined || next.startsWith("--")) {
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

function launchChromium({ port, url, chromePath, profileDir = "" }) {
  const executable = chromePath || findChromiumExecutable();
  if (!executable) {
    throw new Error("Could not find Chrome/Edge. Set CHROME_PATH to the browser executable.");
  }
  const resolvedProfileDir = resolveChromiumProfileDir({ port, profileDir });
  const browserProcess = spawn(
    executable,
    buildChromiumLaunchArgs({ port, url, profileDir: resolvedProfileDir }),
    {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  browserProcess.launchState = {
    exited: false,
    code: null,
    signal: null,
    profileDir: resolvedProfileDir
  };
  browserProcess.once("exit", (code, signal) => {
    browserProcess.launchState.exited = true;
    browserProcess.launchState.code = code;
    browserProcess.launchState.signal = signal;
  });
  pipeProcessStream(browserProcess.stdout, "[chrome][out]");
  pipeProcessStream(browserProcess.stderr, "[chrome][err]", "automation/debug/chrome-stderr.log");
  return browserProcess;
}

export function buildChromiumLaunchArgs({ port, url, profileDir }) {
  return [
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
  ];
}

function resolveChromiumProfileDir({ port, profileDir = "" }) {
  const resolved =
    `${profileDir}`.trim() || path.join(os.tmpdir(), `botbot-tetrio-cdp-${port}-profile`);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

function pipeProcessStream(stream, prefix, outputPath = "") {
  if (!stream) {
    return;
  }
  let buffer = "";
  if (outputPath) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
  }
  const fileStream = outputPath
    ? createWriteStream(outputPath, { flags: "a", encoding: "utf8" })
    : null;
  const flush = () => {
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = `${prefix} ${line}`;
      console.log(message);
      fileStream?.write(`${message}\n`);
    }
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    flush();
  });
  stream.on("close", () => {
    if (buffer.trim()) {
      const message = `${prefix} ${buffer.trim()}`;
      console.log(message);
      fileStream?.write(`${message}\n`);
    }
    fileStream?.end();
  });
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

async function waitForCdp(port, browserProcess = null) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await isCdpOpen(port)) return;
    if (browserProcess?.launchState?.exited) {
      throw new Error(
        `Chrome exited before CDP opened (profile=${browserProcess.launchState.profileDir}, code=${browserProcess.launchState.code ?? "unknown"})`
      );
    }
    await sleep(250);
  }
  throw new Error(`Chrome DevTools endpoint did not open on port ${port}`);
}

async function findOrCreateTarget({ port, url, targetHint }) {
  const existing = await waitForExistingTarget({
    port,
    url,
    targetHint,
    timeoutMs: TARGET_WAIT_TIMEOUT_MS,
    pollMs: TARGET_WAIT_POLL_MS
  });
  if (existing?.webSocketDebuggerUrl) return existing;
  return await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT"
  });
}

export async function waitForExistingTarget({
  port,
  url,
  targetHint,
  timeoutMs = TARGET_WAIT_TIMEOUT_MS,
  pollMs = TARGET_WAIT_POLL_MS,
  fetchTargets = null,
  sleepFn = sleep
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = fetchTargets
      ? await fetchTargets()
      : await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const pages = list.filter((item) => item.type === "page");
    const existing = selectExistingTarget(pages, url, targetHint);
    if (existing?.webSocketDebuggerUrl) {
      return existing;
    }
    await sleepFn(pollMs);
  }
  return null;
}

export function selectExistingTarget(pages, url, targetHint) {
  const hinted = pages.find(
    (item) =>
      item.url?.toLowerCase().includes(targetHint.toLowerCase()) ||
      item.title?.toLowerCase().includes(targetHint.toLowerCase())
  );
  if (hinted) return hinted;
  const matchingUrl = pages.find((item) => item.url === url);
  if (matchingUrl) return matchingUrl;
  return pages.find((item) => {
    try {
      return new URL(item.url).host === new URL(url).host;
    } catch {
      return false;
    }
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

export function attachBrowserDiagnostics(cdp, logger = console.log) {
  cdp.on("Runtime.exceptionThrown", (event) => {
    const details = event?.exceptionDetails;
    const text = details?.text ?? details?.exception?.description ?? "unknown exception";
    logger(`[browser][exception] ${text}`);
  });
  cdp.on("Log.entryAdded", (event) => {
    const entry = event?.entry;
    logger(
      `[browser][console] ${entry?.level ?? "info"} ${entry?.source ?? "log"} ${entry?.text ?? ""}`.trim()
    );
  });
  cdp.on("Network.loadingFailed", (event) => {
    logger(
      `[browser][network] failed url=${event?.url ?? "-"} reason=${event?.errorText ?? event?.blockedReason ?? "unknown"}`
    );
  });
  cdp.on("Inspector.targetCrashed", () => {
    logger("[browser][target] crashed");
  });
}

function pageLoadStatusExpression() {
  return `(() => {
    const bodyText = typeof document.body?.innerText === "string"
      ? document.body.innerText.slice(0, 2000)
      : "";
    const canvasCount = (() => {
      try { return document.querySelectorAll("canvas").length; } catch { return 0; }
    })();
    const hasAppElement = (() => {
      try {
        return Boolean(document.querySelector("#app, #js-app, canvas"));
      } catch {
        return false;
      }
    })();
    return {
      href: location.href,
      hostname: location.hostname,
      readyState: document.readyState,
      title: document.title,
      canvasCount,
      hasAppElement,
      bootstrapFailed: bodyText.includes("ERROR LOADING TETR.IO"),
      bodyText
    };
  })()`;
}

export async function waitForTetrioPageLoad(cdp, { url, timeoutMs = PAGE_LOAD_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await safeRuntimeEvaluate(
      cdp,
      {
        expression: pageLoadStatusExpression(),
        returnByValue: true,
        awaitPromise: true
      },
      {
        result: {
          value: {
            href: "",
            hostname: "",
            readyState: "loading",
            title: "",
            canvasCount: 0,
            hasAppElement: false,
            bootstrapFailed: false,
            bodyText: ""
          }
        }
      }
    );
    const value = status?.result?.value ?? {};
    if (value.bootstrapFailed) {
      return { ok: false, ...value };
    }
    if (
      value.hostname === "tetr.io" &&
      value.readyState === "complete" &&
      (value.hasAppElement || value.canvasCount > 0 || value.href.startsWith(url))
    ) {
      return { ok: true, ...value };
    }
    await sleep(TARGET_WAIT_POLL_MS);
  }
  return { ok: false, reason: "Timed out waiting for TETR.IO page load" };
}

function createTetrioNetworkState() {
  return {
    seed: null,
    nextCount: DEFAULT_NEXT_COUNT,
    readyAt: 0,
    ribbonSeen: false,
    lastPageProbeAt: 0,
    frameCounts: {
      received: 0,
      sent: 0,
      decoded: 0
    }
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

  await cdp.send("Runtime.evaluate", {
    expression: source,
    returnByValue: true,
    awaitPromise: true
  }).catch(() => undefined);
}

async function installRibbonMonitor(cdp, network, msgpack, decodeMode) {
  await cdp.send("Network.enable").catch(() => undefined);
  cdp.on("Network.webSocketCreated", (event) => {
    if (/spool\.tetr\.io\/ribbon/i.test(event?.url ?? "")) {
      network.ribbonSeen = true;
      console.log("[browser] ribbon websocket opened");
    }
  });
  if (!msgpack?.unpack) return;
  const handleFrame = (direction) => (event) => {
    network.frameCounts[direction] += 1;
    if (
      !shouldDecodeRibbonFrame({
        mode: decodeMode,
        seedCaptured: Boolean(network.seed),
        direction
      })
    ) {
      return;
    }
    const payload = event?.response?.payloadData;
    if (!payload) return;
    const buffer = event?.response?.opcode === 2 ? Buffer.from(payload, "base64") : Buffer.from(payload, "utf8");
    const capture = inspectPayloadForGameOptions(buffer, msgpack.unpack);
    if (!capture?.seed) return;
    network.frameCounts.decoded += 1;
    network.seed = String(capture.seed);
    network.nextCount = Math.max(1, capture.nextcount || DEFAULT_NEXT_COUNT);
    network.readyAt = Date.now() + estimateCountdownWait(capture.options ?? capture);
    console.log(`[browser] ribbon seed captured seed=${network.seed}`);
  };
  cdp.on("Network.webSocketFrameReceived", handleFrame("received"));
  cdp.on("Network.webSocketFrameSent", handleFrame("sent"));
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

export async function readTetrioState(cdp, options) {
  const readRawState = async () => {
    const now = Date.now();
    const allowStartupDirectScan = shouldAttemptStartupDirectScan({
      gameCaptured: options.probeState.gameCaptured,
      quickGameAvailable: false,
      now,
      lastAttemptAt: options.probeState.startupDirectScanLastAt,
      attempts: options.probeState.startupDirectScanAttempts
    });
    const directDisabledReason = startupDirectScanDisabledReason({
      gameCaptured: options.probeState.gameCaptured,
      quickGameAvailable: false,
      now,
      lastAttemptAt: options.probeState.startupDirectScanLastAt,
      attempts: options.probeState.startupDirectScanAttempts
    });
    if (allowStartupDirectScan) {
      options.probeState.startupDirectScanAttempts += 1;
      options.probeState.startupDirectScanLastAt = now;
    }
    const startedAt = Date.now();
    const raw = await safeRuntimeEvaluate(
      cdp,
      {
        expression: captureTetrioExportExpression({
          allowStartupDirectScan,
          directDisabledReason
        }),
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
    const value = raw?.result?.value ?? { ok: false, reason: "page probe returned empty" };
    const elapsedMs = Date.now() - startedAt;
    options.perf?.recordStateEval(elapsedMs);
    if (options.perf?.enabled) {
      const perfLog = formatStateEvalPerfLog(value, elapsedMs);
      if (perfLog) {
        console.log(perfLog);
      }
    }
    if (value?.scanMode === "startup_direct") {
      if (value?.ok) {
        console.log(
          `[browser] direct discovery attempt=${options.probeState.startupDirectScanAttempts} source=${value.captureSource}`
        );
      } else {
        console.log(
          `[browser] direct discovery attempt=${options.probeState.startupDirectScanAttempts} reason=${value.scanReason ?? "no_game"}`
        );
      }
    }
    return value;
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

  if (rawState?.ok) {
    options.probeState.gameCaptured = true;
    if (
      rawState.captureSource &&
      rawState.captureSource !== options.probeState.lastCaptureSource
    ) {
      options.probeState.lastCaptureSource = rawState.captureSource;
      console.log(`[browser] game captured source=${rawState.captureSource}`);
    }
  }

  if (rawState?.cacheInvalidated) {
    resetDiscoveryState(options.probeState);
  }

  let state = rawState.ok ? snapshotFromRaw(rawState) : buildNoGameFailure(rawState, options);
  options.probeState.lastKnownPlaying = Boolean(state?.playing);
  let probeStatus = "skipped";
  const likelyGamePage = Boolean(rawState?.pageHints?.likelyGamePage);
  updateLikelyGamePageState(options.probeState, likelyGamePage, Date.now());
  const closureProbeAttempt = options.probeState.probeAttempts + 1;

  const shouldCapture = shouldAttemptClosureProbe({
      probePageState: options.probePageState,
      debuggerProbeMode: options.debuggerProbeMode,
      likelyGamePage,
      needsProbe: !state.ok || !state.ready || !state.playing || state.countdown,
      gameCaptured: options.probeState.gameCaptured,
      probeAttempts: options.probeState.probeAttempts,
      now: Date.now(),
      lastAttemptAt: options.probeState.lastAttemptAt
    });

  if (shouldCapture) {
    probeStatus = "attempted";
    options.probeState.lastAttemptAt = Date.now();
    options.probeState.probeAttempts += 1;
    if (options.network) {
      options.network.lastPageProbeAt = Date.now();
    }
    const capture = await captureTetrioGame(cdp, options.perf, { attempt: closureProbeAttempt }).catch((error) => ({
      ok: false,
      reason: error?.message ?? String(error)
    }));
    if (capture.ok) {
      console.log(`[browser] closure probe captured source=${capture.source}`);
      options.probeState.gameCaptured = true;
      if (capture.source && capture.source !== options.probeState.lastCaptureSource) {
        options.probeState.lastCaptureSource = capture.source;
        console.log(`[browser] game captured source=${capture.source}`);
      }
      rawState = await readRawState();
      if (rawState?.ok) {
        options.probeState.gameCaptured = true;
      }
      state = rawState.ok ? snapshotFromRaw(rawState) : buildNoGameFailure(rawState, options);
    } else if (state.reason) {
      console.log(
        `[browser] closure probe failed ai_frames_checked=${capture.aiFramesChecked ?? 0} scope_objects_checked=${capture.scopeObjectsChecked ?? 0} reason=${capture.reason}`
      );
      if (options.probeState.probeAttempts < MAX_PROBE_ATTEMPTS && likelyGamePage && !options.probeState.gameCaptured) {
        console.log(`[browser] closure probe retry in ${PROBE_RETRY_COOLDOWN_MS}ms`);
      }
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
  const rejectReason = rawState?.reason ?? state.reason ?? "page probe returned empty";
  const retainedLogs = (state.logs ?? []).filter((line) => !line.startsWith("[browser] reject reason="));
  state.logs = [
    ...retainedLogs,
    `[browser] pageHints likelyGamePage=${Boolean(rawState?.pageHints?.likelyGamePage)} canvasCount=${rawState?.pageHints?.canvasCount ?? 0} largeCanvasCount=${rawState?.pageHints?.largeCanvasCount ?? 0} hash=${rawState?.pageHints?.hash || "-"}`,
    `[browser] discovery gameCaptured=${options.probeState.gameCaptured} directAttempts=${options.probeState.startupDirectScanAttempts} directDisabledReason=${rawState?.scanReason ?? "none"} probeMode=${options.debuggerProbeMode} probePageState=${options.probePageState} probeStatus=${probeStatus}`,
    `[browser] reject reason=${rejectReason} scan=${rawState?.scanMode ?? "disabled"} attempted=${Boolean(rawState?.scanAttempted)} probe=${probeStatus}`
  ];
  if (!options.useSeedSimulationFallback || !options.network.seed) {
    return state;
  }
  return buildSeedFallbackState(options.network);
}

function buildNoGameFailure(rawState, options) {
  if (options.selector?.dumpStateOnFail && Date.now() - (options.probeState?.lastDumpAt ?? 0) >= 2000) {
    options.probeState.lastDumpAt = Date.now();
    writeDebugDump(options.selector.dumpStatePath, {
      href: rawState?.href ?? "",
      pageTitle: rawState?.pageTitle ?? "",
      target: {
        title: options.targetTitle,
        url: options.targetUrl
      },
      lastReason: rawState?.reason ?? "page probe returned empty",
      pageHints: rawState?.pageHints ?? null,
      windowKeys: rawState?.windowKeys ?? [],
      directCandidatePaths: rawState?.directCandidatePaths ?? [],
      gameSearchStats: rawState?.gameSearchStats ?? null
    });
  }
  return {
    ok: false,
    ready: false,
    reason: rawState?.reason ?? "page probe returned empty",
    logs: [
      `[browser] reject reason=${rawState?.reason ?? "page probe returned empty"}`,
      ...(options.selector?.dumpStateOnFail
        ? [`[browser] dumpStatePath=${options.selector.dumpStatePath}`]
        : [])
    ]
  };
}

export function captureTetrioExportExpression({
  allowStartupDirectScan = false,
  directDisabledReason = "no_game",
  startupWindowPropertyLimit = 1500
} = {}) {
  return `(() => {
    const allowStartupDirectScan = ${allowStartupDirectScan ? "true" : "false"};
    const directDisabledReason = ${JSON.stringify(directDisabledReason)};
    const startupWindowPropertyLimit = ${startupWindowPropertyLimit};
    const looksLikeGame = (value) =>
      value &&
      typeof value === "object" &&
      typeof value.ejectState === "function" &&
      typeof value.ejectBoardState === "function";
    const scanObject = (root, basePath, maxProperties = 200) => {
      if (!root || typeof root !== "object") return null;
      let names = [];
      try {
        names = Object.getOwnPropertyNames(root).slice(0, maxProperties);
      } catch {}
      for (const name of names) {
        try {
          const value = root[name];
          if (looksLikeGame(value)) {
            return { game: value, source: basePath ? basePath + "." + name : name };
          }
        } catch {}
      }
      return null;
    };
    const canvasElements = (() => {
      try {
        return Array.from(document.querySelectorAll("canvas")).slice(0, 8);
      } catch {
        return [];
      }
    })();
    const largeCanvasCount = canvasElements.filter((canvas) => {
      const width = Math.max(Number(canvas?.width) || 0, Number(canvas?.clientWidth) || 0);
      const height = Math.max(Number(canvas?.height) || 0, Number(canvas?.clientHeight) || 0);
      return width >= 240 && height >= 180;
    }).length;
    const bodyClass =
      typeof document.body?.className === "string" ? document.body.className.slice(0, 120) : "";
    const pathText = [location.href, location.pathname, location.hash, document.title, bodyClass]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const likelyGamePage =
      /(play|solo|custom|room|league|match|game|blitz|40l|zen|replay|sandbox)/.test(pathText) ||
      largeCanvasCount >= 2;
    const pageHints = {
      likelyGamePage,
      pathname: location.pathname,
      hash: location.hash,
      bodyClass,
      canvasCount: canvasElements.length,
      largeCanvasCount
    };
    const directCandidates = [
      ["window.__fusionTetrioGame", window.__fusionTetrioGame],
      ["window.tetrioGame", window.tetrioGame],
      ["window.TETRIO_GAME", window.TETRIO_GAME],
      ["window.game", window.game],
      ["window.app", window.app],
      ["window.tetrio", window.tetrio]
    ];
    const quickCandidate = directCandidates[0]?.[1];
    if (looksLikeGame(quickCandidate)) {
      const game = quickCandidate;
      try {
        const exported = typeof game.ejectState === "function" ? game.ejectState() : null;
        const boardState = typeof game.ejectBoardState === "function" ? game.ejectBoardState() : null;
        return {
          ok: true,
          quick: true,
          scanMode: false,
          scanAttempted: false,
          captureSource: "window.__fusionTetrioGame",
          href: location.href,
          pageTitle: document.title,
          exported,
          boardState,
          pageHints: {
            ...pageHints,
            gameIsPlaying: typeof game.isPlaying === "function" ? Boolean(game.isPlaying()) : null,
            gameIsStarted: typeof game.isStarted === "function" ? Boolean(game.isStarted()) : null
          }
        };
      } catch (error) {
        try { delete window.__fusionTetrioGame; } catch {}
        try { window.__fusionTetrioGame = undefined; } catch {}
        return {
          ok: false,
          quick: false,
          scanMode: "disabled",
          scanAttempted: false,
          scanReason: "cache_invalidated",
          cacheInvalidated: true,
          reason: error?.message || "cached TETR.IO game object became invalid",
          href: location.href,
          pageTitle: document.title,
          pageHints
        };
      }
    }

    let located = null;
    if (allowStartupDirectScan) {
      for (const [source, candidate] of directCandidates.slice(1)) {
        if (looksLikeGame(candidate)) {
          located = { game: candidate, source };
          break;
        }
        const nested = scanObject(candidate, source);
        if (nested?.game) {
          located = nested;
          break;
        }
      }
      if (!located && likelyGamePage) {
        let names = [];
        try {
          names = Object.getOwnPropertyNames(window).slice(0, startupWindowPropertyLimit);
        } catch {}
        for (const name of names) {
          try {
            const value = window[name];
            if (looksLikeGame(value)) {
              located = { game: value, source: "window." + name };
              break;
            }
          } catch {}
        }
      }
    }

    if (!located?.game) {
      return {
        ok: false,
        quick: false,
        scanMode: allowStartupDirectScan ? "startup_direct" : "disabled",
        scanAttempted: allowStartupDirectScan,
        scanReason: allowStartupDirectScan
          ? likelyGamePage
            ? "no_game"
            : "not_game_page"
          : directDisabledReason,
        reason: "TETR.IO game instance not captured yet",
        href: location.href,
        pageTitle: document.title,
        pageHints
      };
    }

    const game = located.game;
    window.__fusionTetrioGame = game;
    const exported = typeof game.ejectState === "function" ? game.ejectState() : null;
    const boardState = typeof game.ejectBoardState === "function" ? game.ejectBoardState() : null;
    return {
      ok: true,
      quick: false,
      scanMode: "startup_direct",
      scanAttempted: true,
      captureSource: located.source,
      href: location.href,
      pageTitle: document.title,
      exported,
      boardState,
      pageHints: {
        ...pageHints,
        gameIsPlaying: typeof game.isPlaying === "function" ? Boolean(game.isPlaying()) : null,
        gameIsStarted: typeof game.isStarted === "function" ? Boolean(game.isStarted()) : null
      }
    };
  })()`;
}

export async function captureTetrioGame(cdp, perf, options = {}) {
  const breakpointIds = [];
  let paused = false;
  const startedAt = Date.now();
  const attachedBreakpointLabels = [];
  let totalAiFramesChecked = 0;
  let totalScopeObjectsChecked = 0;
  let totalCallFramesChecked = 0;
  let cancelReason = null;
  let cancelResolver = () => undefined;
  const cancelPromise = new Promise((resolve) => {
    cancelResolver = resolve;
  });
  const removeListeners = [];
  const cancelProbe = (reason) => {
    if (cancelReason) return;
    cancelReason = reason;
    cancelResolver({ cancelled: true, reason });
  };

  try {
    await cdp.send("Debugger.enable");
    for (const breakpointSpec of getClosureProbeBreakpoints()) {
      const evaluated = await safeRuntimeEvaluate(
        cdp,
        {
          expression: breakpointSpec.expression,
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
        attachedBreakpointLabels.push(breakpointSpec.label);
      }
    }
    console.log(
      `[browser] closure probe attempt=${options.attempt ?? "?"} breakpoints_registered=${attachedBreakpointLabels.join(",") || "none"}`
    );

    if (breakpointIds.length === 0) {
      return { ok: false, reason: "TETR.IO probe could not attach function breakpoints" };
    }

    for (const eventName of [
      "Page.frameNavigated",
      "Page.navigatedWithinDocument",
      "Runtime.executionContextsCleared",
      "Runtime.executionContextDestroyed"
    ]) {
      const off = cdp.on?.(eventName, () => cancelProbe(`probe cancelled by ${eventName}`));
      if (typeof off === "function") {
        removeListeners.push(off);
      }
    }

    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const outcome = await Promise.race([
        cdp.waitForEvent(
          "Debugger.paused",
          () => true,
          Math.max(50, deadline - Date.now())
        )
          .then((event) => ({ kind: "paused", event }))
          .catch(() => ({ kind: "timeout" })),
        cancelPromise
      ]);

      if (outcome?.cancelled) {
        return {
          ok: false,
          reason: outcome.reason,
          breakpoints: attachedBreakpointLabels,
          aiFramesChecked: totalAiFramesChecked,
          scopeObjectsChecked: totalScopeObjectsChecked,
          callFramesChecked: totalCallFramesChecked
        };
      }
      if (outcome?.kind !== "paused") {
        break;
      }
      const event = outcome.event;

      paused = true;
      console.log(`[browser] callframes=${event?.callFrames?.length ?? 0}`);
      const exposed = await exposeTetrioGameFromPausedCallFrames(cdp, event);
      totalAiFramesChecked += exposed.aiFramesChecked ?? 0;
      totalScopeObjectsChecked += exposed.scopeObjectsChecked ?? 0;
      totalCallFramesChecked += exposed.callFramesChecked ?? 0;
      console.log(`[browser] direct Ai evaluation frames_checked=${exposed.aiFramesChecked ?? 0}`);
      await cdp.send("Debugger.resume").catch(() => undefined);
      paused = false;
      if (exposed.ok) {
        return {
          ...exposed,
          aiFramesChecked: totalAiFramesChecked,
          scopeObjectsChecked: totalScopeObjectsChecked,
          callFramesChecked: totalCallFramesChecked,
          breakpoints: attachedBreakpointLabels
        };
      }
    }

    return {
      ok: false,
      reason: "Ai not visible",
      breakpoints: attachedBreakpointLabels,
      aiFramesChecked: totalAiFramesChecked,
      scopeObjectsChecked: totalScopeObjectsChecked,
      callFramesChecked: totalCallFramesChecked
    };
  } finally {
    const elapsedMs = Date.now() - startedAt;
    perf?.recordProbe(elapsedMs);
    if (perf?.enabled) {
      console.log(`[perf][state] quick=false scan=debugger_probe eval_ms=${elapsedMs}`);
    }
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
    for (const off of removeListeners.splice(0)) {
      off();
    }
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

export async function exposeTetrioGameFromPausedCallFrames(cdp, pausedEvent) {
  let aiFramesChecked = 0;
  let scopeObjectsChecked = 0;
  let callFramesChecked = 0;
  for (const callFrame of pausedEvent.callFrames ?? []) {
    callFramesChecked += 1;
    const aiCapture = await exposeTetrioGameFromAiCallFrame(cdp, callFrame);
    aiFramesChecked += 1;
    if (aiCapture.ok) {
      return {
        ...aiCapture,
        aiFramesChecked,
        scopeObjectsChecked,
        callFramesChecked
      };
    }
    const scopeCapture = await exposeTetrioGameFromScopeChain(cdp, callFrame);
    scopeObjectsChecked += scopeCapture.scopeObjectsChecked ?? 0;
    if (scopeCapture.ok) {
      return {
        ...scopeCapture,
        aiFramesChecked,
        scopeObjectsChecked,
        callFramesChecked
      };
    }
  }
  return {
    ok: false,
    reason: "Ai not visible",
    aiFramesChecked,
    scopeObjectsChecked,
    callFramesChecked
  };
}

async function exposeTetrioGameFromAiCallFrame(cdp, callFrame) {
  const result = await cdp.send("Debugger.evaluateOnCallFrame", {
    callFrameId: callFrame.callFrameId,
    expression: `(() => {
      try {
        if (
          typeof Ai !== "undefined" &&
          Ai &&
          Ai.ejectState instanceof Function &&
          Ai.ejectBoardState instanceof Function
        ) {
          window.__fusionTetrioGame = Ai;
          window.__fusionTetrioBridge = {
            ok: true,
            source: "closure:Ai",
            at: Date.now(),
            href: location.href
          };
          return {
            ok: true,
            source: "closure:Ai",
            at: Date.now(),
            href: location.href
          };
        }
      } catch {}
      return { ok: false, reason: "Ai not visible" };
    })()`,
    returnByValue: true,
    silent: true
  }).catch(() => null);

  return result?.result?.value ?? { ok: false, reason: "Ai not visible" };
}

async function exposeTetrioGameFromScopeChain(cdp, callFrame) {
  let scopeObjectsChecked = 0;
  for (const scope of callFrame.scopeChain ?? []) {
    const objectId = scope?.object?.objectId;
    if (!objectId) {
      continue;
    }
    const captured = await captureTetrioGameFromScopeObject(
      cdp,
      objectId,
      `scope:${scope.type ?? "unknown"}`
    );
    scopeObjectsChecked += captured.objectsChecked ?? 0;
    if (captured.ok) {
      return {
        ...captured,
        scopeObjectsChecked
      };
    }
  }
  return { ok: false, scopeObjectsChecked };
}

async function captureTetrioGameFromScopeObject(cdp, objectId, sourceLabel) {
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      const sourceLabel = ${JSON.stringify(sourceLabel)};
      const looksLikeGame = (value) =>
        value &&
        typeof value === "object" &&
        typeof value.ejectState === "function" &&
        typeof value.ejectBoardState === "function";
      const visited = new WeakSet();
      let objectsChecked = 0;
      const scanObject = (root, path, depth = 0) => {
        if (!root || typeof root !== "object") return null;
        if (visited.has(root) || depth > 3) return null;
        visited.add(root);
        objectsChecked += 1;
        if (looksLikeGame(root)) {
          return { game: root, path };
        }
        let names = [];
        try { names = Object.getOwnPropertyNames(root).slice(0, 80); } catch {}
        for (const name of names) {
          try {
            const value = root[name];
            const nested = scanObject(value, path ? path + "." + name : name, depth + 1);
            if (nested) return nested;
          } catch {}
        }
        return null;
      };
      try {
        const found = scanObject(this, sourceLabel, 0);
        if (!found?.game) {
          return { ok: false, objectsChecked };
        }
        window.__fusionTetrioGame = found.game;
        return {
          ok: true,
          source: found.path,
          objectsChecked,
          at: Date.now(),
          href: location.href
        };
      } catch {
        return { ok: false, objectsChecked };
      }
    }`,
    returnByValue: true,
    awaitPromise: true,
    silent: true
  }).catch(() => null);

  return result?.result?.value ?? { ok: false, objectsChecked: 0 };
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

function createBrowserPerfTracker({ enabled }) {
  const stateEvalSamples = [];
  let probeCount = 0;
  let probeTotalMs = 0;
  let snapshotsWritten = 0;
  let duplicateSkips = 0;
  let eventLoopLagMaxMs = 0;
  let lastFlushAt = Date.now();

  return {
    enabled,
    recordStateEval(elapsedMs) {
      stateEvalSamples.push(elapsedMs);
    },
    recordProbe(elapsedMs) {
      probeCount += 1;
      probeTotalMs += elapsedMs;
    },
    recordSnapshotWrite() {
      snapshotsWritten += 1;
    },
    recordDuplicateSkip() {
      duplicateSkips += 1;
    },
    startEventLoopLagTracker() {
      if (!enabled) {
        return () => undefined;
      }
      let expectedAt = Date.now() + 1000;
      const interval = setInterval(() => {
        const now = Date.now();
        eventLoopLagMaxMs = Math.max(eventLoopLagMaxMs, Math.max(0, now - expectedAt));
        expectedAt = now + 1000;
      }, 1000);
      return () => clearInterval(interval);
    },
    flushIfDue() {
      if (!enabled || Date.now() - lastFlushAt < PERF_LOG_INTERVAL_MS) {
        return;
      }
      const avg = average(stateEvalSamples);
      const p95 = percentile(stateEvalSamples, 95);
      console.log(
        `[perf] cdp_eval_avg=${avg.toFixed(1)}ms cdp_eval_p95=${p95.toFixed(1)}ms probe_count=${probeCount} probe_ms=${probeTotalMs} snapshots_written=${snapshotsWritten} duplicate_skips=${duplicateSkips} event_loop_lag_ms=${eventLoopLagMaxMs.toFixed(1)}`
      );
      stateEvalSamples.length = 0;
      probeCount = 0;
      probeTotalMs = 0;
      snapshotsWritten = 0;
      duplicateSkips = 0;
      eventLoopLagMaxMs = 0;
      lastFlushAt = Date.now();
    }
  };
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[browser] fatal:", error?.message ?? error);
    process.exit(1);
  });
}
