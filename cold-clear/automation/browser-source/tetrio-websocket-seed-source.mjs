import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getCurrentAndNext, isSevenBagBagType } from "./tetrio-queue.mjs";
import { createCaptureQueue, installWebSocketSeedMonitor } from "./tetrio-ws-seed.mjs";

const DEFAULT_URL = "https://tetr.io/";
const DEFAULT_PORT = 9222;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotPath = args.snapshotPath ?? "automation/live-snapshot.json";
  const url = args.url ?? DEFAULT_URL;
  const port = numberArg(args.port, DEFAULT_PORT);
  const targetHint = args.target ?? "TETR.IO";
  const connectOnly = args.connectOnly === "1";
  const chromePath = process.env.CHROME_PATH || "";
  const { unpack } = await import("msgpackr");

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
  await cdp.send("Network.enable").catch(() => undefined);

  const stop = async () => {
    await cdp.close().catch(() => undefined);
    browserProcess?.kill();
  };
  process.on("SIGINT", () => stop().finally(() => process.exit(0)));
  process.on("SIGTERM", () => stop().finally(() => process.exit(0)));

  const captureQueue = createCaptureQueue();
  let lastCaptureSignature = "";

  const enqueueCapture = (capture) => {
    const signature = [
      capture.seed,
      capture.bagtype,
      capture.nextcount ?? "",
      capture.boardwidth ?? "",
      capture.boardheight ?? ""
    ].join("|");
    if (signature === lastCaptureSignature) {
      return;
    }
    lastCaptureSignature = signature;
    captureQueue.push(capture);
  };

  installWebSocketSeedMonitor(cdp, unpack, {
    onWebSocketOpen(wsUrl) {
      console.log(`[ws-seed] websocket open url=${wsUrl}`);
    },
    onCapture: enqueueCapture
  });

  while (true) {
    const capture = await captureQueue.next();

    if (!isSevenBagBagType(capture.bagtype)) {
      console.log(`[ws-seed] unsupported bagtype=${capture.bagtype}; waiting for 7-bag`);
      continue;
    }

    const pieceIndex = 0;
    const currentAndNext = getCurrentAndNext(capture.seed, pieceIndex, 6);
    const token = `seed-${pieceIndex}-${currentAndNext.current}${currentAndNext.queue.join("")}`;
    const field = createEmptyField();
    const snapshot = {
      ok: true,
      source: "websocket_seed",
      field,
      current: currentAndNext.current,
      hold: null,
      queue: currentAndNext.queue,
      b2b: false,
      combo: 0,
      incoming: 0,
      pieceCounter: pieceIndex,
      token,
      playing: true,
      countdown: false,
      seedCaptured: true,
      seed: capture.seed,
      bagtype: capture.bagtype,
      nextcount: capture.nextcount,
      boardwidth: capture.boardwidth,
      boardheight: capture.boardheight,
      pieceIndex,
      localBoardHash: hashField(field),
      garbageSupport: "unsupported",
      options: capture.options
    };

    console.log(
      `[ws-seed] game options captured seed=${capture.seed} bagtype=${capture.bagtype} nextcount=${capture.nextcount ?? "-"}`
    );
    console.log(
      `[ws-seed] pieceIndex=${pieceIndex} current=${snapshot.current} queue=${snapshot.queue.join(",")} hold=-`
    );
    writeSnapshot(snapshotPath, snapshot);
    console.log(`[ws-seed] wrote snapshot token=${token}`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function numberArg(value, fallback) {
  const parsed = Number.parseInt(value ?? `${fallback}`, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function launchChromium({ port, url, chromePath }) {
  const executable = chromePath || findChromiumExecutable();
  if (!executable) {
    throw new Error("Could not find Chrome/Edge. Set CHROME_PATH to the browser executable.");
  }
  const profileDir = path.join(os.tmpdir(), `botbot-tetrio-ws-seed-${port}`);
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
  if (hinted?.webSocketDebuggerUrl) return hinted;

  const existing = pages.find((item) => item.url === url);
  if (existing?.webSocketDebuggerUrl) return existing;

  await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT"
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const refreshed = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const page = refreshed.find((item) => item.type === "page" && item.url?.startsWith(url));
    if (page?.webSocketDebuggerUrl) {
      return page;
    }
    await sleep(100);
  }
  throw new Error(`Could not find or create target for ${url}`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

class CdpClient {
  static connect(webSocketDebuggerUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketDebuggerUrl);
      socket.addEventListener("open", () => resolve(new CdpClient(socket)));
      socket.addEventListener("error", (event) => reject(event.error ?? new Error("Failed to open CDP socket")));
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
        if (message.method) {
          this.emit(message.method, message.params ?? {});
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
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
    if (listeners.size === 0) {
      this.listeners.delete(method);
    }
  }

  emit(method, params) {
    const listeners = this.listeners.get(method);
    if (!listeners) return;
    for (const handler of [...listeners]) {
      handler(params);
    }
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

function createEmptyField() {
  return Array.from({ length: 40 }, () => Array(10).fill(false));
}

function hashField(field) {
  const bits = field.map((row) => row.map((cell) => (cell ? "1" : "0")).join("")).join("|");
  let hash = 2166136261;
  for (let index = 0; index < bits.length; index += 1) {
    hash ^= bits.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

function writeSnapshot(snapshotPath, snapshot) {
  const absolutePath = path.resolve(snapshotPath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(tempPath, absolutePath);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
