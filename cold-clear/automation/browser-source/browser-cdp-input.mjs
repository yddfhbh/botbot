import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_URL = "https://tetr.io/";
const DEFAULT_PORT = 9222;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url ?? DEFAULT_URL;
  const port = numberArg(args.port, DEFAULT_PORT);
  const targetHint = args.target ?? "TETR.IO";
  const connectOnly = args.connectOnly === "1";
  const chromePath = process.env.CHROME_PATH || "";

  let browserProcess = null;
  if (!connectOnly) {
    const alreadyOpen = await isCdpOpen(port);
    if (!alreadyOpen) {
      browserProcess = launchChromium({ port, url, chromePath });
    }
  }

  await waitForCdp(port);
  let cdp = await connectToTarget({ port, url, targetHint });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (message.type === "quit") {
      await cdp.close().catch(() => undefined);
      browserProcess?.kill();
      process.exit(0);
      return;
    }

    try {
      if (message.type === "releaseAll") {
        cdp = await ensureConnected(cdp, { port, url, targetHint });
        await releaseAllKeys(cdp);
        logInput("releaseAll ok");
        writeResponse({
          ok: true,
          id: message.id ?? null,
          type: "releaseAll",
          focus: null
        });
        return;
      }

      if (message.type === "tap") {
        const spec = KEY_MAP[message.key];
        if (!spec) {
          writeResponse({
            ok: false,
            id: message.id ?? null,
            type: "tap",
            error: `unknown key: ${message.key ?? ""}`
          });
          return;
        }
        cdp = await ensureConnected(cdp, { port, url, targetHint });
        const durationMs = numberArg(message.durationMs, 55);
        const preKeyDownFocus = await preparePageForInput(cdp);
        logInput(
          `prepare activeBefore=${preKeyDownFocus.activeBefore} activeAfter=${preKeyDownFocus.activeAfter} blurred=${preKeyDownFocus.blurred} forcedFocus=${preKeyDownFocus.forcedFocus}`
        );
        await dispatchWithReconnect(cdp, spec, "keyDown", { port, url, targetHint }, (nextCdp) => {
          cdp = nextCdp;
        });
        logInput(`dispatch keyDown key=${message.key}`);
        await sleep(durationMs);
        await dispatchWithReconnect(cdp, spec, "keyUp", { port, url, targetHint }, (nextCdp) => {
          cdp = nextCdp;
        });
        logInput(`dispatch keyUp key=${message.key}`);
        logInput(`tap key=${message.key} durationMs=${durationMs}`);
        writeResponse({
          ok: true,
          id: message.id ?? null,
          type: "tap",
          key: message.key,
          durationMs,
          focus: preKeyDownFocus
        });
      }
    } catch (error) {
      writeResponse({
        ok: false,
        id: message.id ?? null,
        type: message.type ?? "unknown",
        error: error?.message ?? String(error)
      });
    }
  });

  process.on("SIGINT", async () => {
    await cdp.close().catch(() => undefined);
    process.exit(0);
  });
}

const KEY_MAP = {
  moveLeft: keySpec("ArrowLeft", "ArrowLeft", 37),
  moveRight: keySpec("ArrowRight", "ArrowRight", 39),
  softDrop: keySpec("ArrowDown", "ArrowDown", 40),
  hardDrop: keySpec(" ", "Space", 32),
  rotateCW: keySpec("x", "KeyX", 88, "x"),
  rotateCCW: keySpec("z", "KeyZ", 90, "z"),
  rotate180: keySpec("a", "KeyA", 65, "a"),
  hold: keySpec("c", "KeyC", 67, "c")
};

function keySpec(key, code, windowsVirtualKeyCode, text = "") {
  return {
    key,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    text
  };
}

async function releaseAllKeys(cdp) {
  for (const spec of Object.values(KEY_MAP)) {
    await dispatchKey(cdp, spec, "keyUp");
  }
}

async function preparePageForInput(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const describe = (element) => {
        if (!element) return "NONE";
        const tag = element.tagName || "UNKNOWN";
        if (element.isContentEditable) return tag + "[contenteditable]";
        return tag;
      };
      const activeBefore = document.activeElement;
      let blurred = false;
      if (
        activeBefore &&
        (
          activeBefore.tagName === "INPUT" ||
          activeBefore.tagName === "TEXTAREA" ||
          activeBefore.isContentEditable
        ) &&
        typeof activeBefore.blur === "function"
      ) {
        activeBefore.blur();
        blurred = true;
      }
      return {
        activeBefore: describe(activeBefore),
        activeAfter: describe(document.activeElement),
        blurred,
        forcedFocus: false
      };
    })()`,
    returnByValue: true,
    awaitPromise: true
  });
  return result?.result?.value ?? {
    activeBefore: "UNKNOWN",
    activeAfter: "UNKNOWN",
    blurred: false,
    forcedFocus: false
  };
}

async function dispatchKey(cdp, spec, type) {
  await cdp.send("Input.dispatchKeyEvent", {
    type,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.nativeVirtualKeyCode,
    text: type === "keyDown" ? spec.text ?? "" : "",
    unmodifiedText: type === "keyDown" ? spec.text ?? "" : ""
  });
}

async function dispatchWithReconnect(cdp, spec, type, targetInfo, setClient) {
  try {
    await dispatchKey(cdp, spec, type);
  } catch (error) {
    if (!isSocketClosedError(error)) {
      throw error;
    }
    const reconnected = await connectToTarget(targetInfo);
    setClient(reconnected);
    await dispatchKey(reconnected, spec, type);
  }
}

async function ensureConnected(cdp, targetInfo) {
  if (cdp?.isOpen()) {
    return cdp;
  }
  return await connectToTarget(targetInfo);
}

async function connectToTarget({ port, url, targetHint }) {
  const target = await findOrCreateTarget({ port, url, targetHint });
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable").catch(() => undefined);
  await cdp.send("Runtime.enable").catch(() => undefined);
  await installBackgroundInputKeepalive(cdp);
  const focus = await preparePageForInput(cdp).catch(() => ({
    activeBefore: "UNKNOWN",
    activeAfter: "UNKNOWN",
    blurred: false,
    forcedFocus: false
  }));
  logInput(
    `prepare activeBefore=${focus.activeBefore} activeAfter=${focus.activeAfter} blurred=${focus.blurred} forcedFocus=${focus.forcedFocus}`
  );
  return cdp;
}

function isSocketClosedError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("cdp socket is not open") ||
    message.includes("inspected target navigated or closed") ||
    message.includes("session closed")
  );
}

function writeResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logInput(message) {
  process.stderr.write(`[input:cdp] ${message}\n`);
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

function launchChromium({ port, url, chromePath }) {
  const executable = chromePath || findChromiumExecutable();
  if (!executable) {
    throw new Error("Could not find Chrome/Edge. Set CHROME_PATH to the browser executable.");
  }
  const profileDir = path.join(os.tmpdir(), `botbot-tetrio-input-${port}`);
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
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
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

  isOpen() {
    return this.socket.readyState === WebSocket.OPEN;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

main().catch((error) => {
  console.error("[input:cdp] fatal:", error?.message ?? error);
  process.exit(1);
});
