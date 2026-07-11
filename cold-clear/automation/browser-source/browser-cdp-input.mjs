import readline from "node:readline";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_PORT,
  DEFAULT_URL,
  isCdpOpen,
  launchChromium,
  shutdownChromium,
  waitForCdpReady
} from "./chromium-launch.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url ?? DEFAULT_URL;
  const port = numberArg(args.port, DEFAULT_PORT);
  const targetHint = args.target ?? "TETR.IO";
  const connectOnly = args.connectOnly === "1";
  const chromePath = process.env.CHROME_PATH || "";

  let browserProcess = null;
  let ownsChromium = false;
  if (!connectOnly) {
    const alreadyOpen = await isCdpOpen(port);
    if (!alreadyOpen) {
      browserProcess = launchChromium({ port, url, chromePath });
      ownsChromium = true;
    }
  }

  await waitForCdpReady(port);
  let cdp = await connectToTarget({ port, url, targetHint });
  writeResponse({ type: "ready", ok: true });

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
      if (ownsChromium && browserProcess) {
        await shutdownChromium(browserProcess);
      }
      process.exit(0);
      return;
    }

    try {
      if (message.type === "releaseAll") {
        cdp = await ensureConnected(cdp, { port, url, targetHint });
        await releaseAllKeys(cdp);
        writeResponse({
          ok: true,
          id: message.id ?? null,
          type: "releaseAll"
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
        await dispatchWithReconnect(cdp, spec, "keyDown", { port, url, targetHint }, (nextCdp) => {
          cdp = nextCdp;
        });
        await sleep(numberArg(message.durationMs, 55));
        await dispatchWithReconnect(cdp, spec, "keyUp", { port, url, targetHint }, (nextCdp) => {
          cdp = nextCdp;
        });
        writeResponse({
          ok: true,
          id: message.id ?? null,
          type: "tap",
          key: message.key,
          durationMs: numberArg(message.durationMs, 55)
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
    if (ownsChromium && browserProcess) {
      await shutdownChromium(browserProcess);
    }
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

async function focusPage(cdp) {
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      window.focus();
      const active = document.activeElement;
      if (active && typeof active.blur === "function") active.blur();
      if (document.body && typeof document.body.focus === "function") document.body.focus();
      return true;
    })()`,
    returnByValue: true,
    awaitPromise: true
  }).catch(() => undefined);
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
  await cdp.send("Page.bringToFront").catch(() => undefined);
  await installBackgroundInputKeepalive(cdp);
  await focusPage(cdp);
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

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error("[input:cdp] fatal:", error?.message ?? error);
    process.exit(1);
  });
}
