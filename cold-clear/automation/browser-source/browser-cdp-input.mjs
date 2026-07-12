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
  const pressedKeys = new Set();
  const focusLogState = createFocusLogState();
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
      await releaseTrackedKeys(cdp, pressedKeys).catch(() => undefined);
      await cdp.close().catch(() => undefined);
      if (ownsChromium && browserProcess) {
        await shutdownChromium(browserProcess);
      }
      process.exit(0);
      return;
    }

    cdp = await handleMessage(message, {
      cdp,
      port,
      url,
      targetHint,
      pressedKeys,
      focusLogState,
      writeResponse
    });
  });

  process.on("SIGINT", async () => {
    await releaseTrackedKeys(cdp, pressedKeys).catch(() => undefined);
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

export async function handleMessage(
  message,
  {
    cdp,
    port,
    url,
    targetHint,
    pressedKeys,
    focusLogState = createFocusLogState(),
    writeResponse: sendResponse
  }
) {
  const targetInfo = { port, url, targetHint };
  try {
    if (message.type === "releaseAll") {
      cdp = await ensureConnected(cdp, targetInfo, pressedKeys);
      await releaseTrackedKeys(cdp, pressedKeys);
      sendResponse({
        ok: true,
        id: message.id ?? null,
        type: "releaseAll"
      });
      return cdp;
    }

    if (message.type === "tap") {
      const action = normalizeTapAction(message);
      cdp = await ensureConnected(cdp, targetInfo, pressedKeys);
      await prepareInputTarget(cdp, focusLogState);
      await executeInputAction(cdp, action, targetInfo, (nextCdp) => {
        cdp = nextCdp;
      }, pressedKeys);
      sendResponse({
        ok: true,
        id: message.id ?? null,
        type: "tap",
        key: action.key,
        durationMs: action.durationMs
      });
      return cdp;
    }

    if (message.type === "sequence") {
      const actions = normalizeSequenceActions(message.actions);
      cdp = await ensureConnected(cdp, targetInfo, pressedKeys);
      await prepareInputTarget(cdp, focusLogState);
      await executeSequence(cdp, actions, targetInfo, (nextCdp) => {
        cdp = nextCdp;
      }, pressedKeys);
      sendResponse({
        ok: true,
        id: message.id ?? null,
        type: "sequence",
        actionCount: actions.length
      });
      return cdp;
    }

    return cdp;
  } catch (error) {
    const payload = {
      ok: false,
      id: message.id ?? null,
      type: message.type ?? "unknown",
      error: error?.code ?? error?.message ?? String(error)
    };
    Object.assign(payload, error?.details ?? {});
    sendResponse(payload);
    return cdp;
  }
}

function normalizeTapAction(message) {
  const spec = KEY_MAP[message.key];
  if (!spec) {
    throw new Error(`unknown key: ${message.key ?? ""}`);
  }
  return {
    key: message.key,
    spec,
    durationMs: numberArg(message.durationMs, 55),
    afterMs: 0
  };
}

export function normalizeSequenceActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("sequence requires at least one action");
  }
  return actions.map((action) => {
    const spec = KEY_MAP[action?.key];
    if (!spec) {
      throw new Error(`unknown key: ${action?.key ?? ""}`);
    }
    return {
      key: action.key,
      spec,
      durationMs: numberArg(action.durationMs, 55),
      afterMs: numberArg(action.afterMs, 0)
    };
  });
}

async function focusPage(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      window.focus();
      const active = document.activeElement;
      if (active && typeof active.blur === "function") active.blur();
      if (document.body && typeof document.body.focus === "function") document.body.focus();
      const nextActive = document.activeElement;
      return {
        visibilityState: document.visibilityState ?? null,
        activeTag: nextActive?.tagName ?? null,
        contentEditable: Boolean(
          nextActive?.isContentEditable ||
          nextActive?.getAttribute?.("contenteditable") === "true"
        )
      };
    })()`,
    returnByValue: true,
    awaitPromise: true
  }).catch(() => undefined);
  return result?.result?.value ?? {
    visibilityState: null,
    activeTag: null,
    contentEditable: false
  };
}

function createFocusLogState() {
  return {
    lastKey: ""
  };
}

class InputCommandError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

async function prepareInputTarget(cdp, focusLogState) {
  await cdp.send("Page.bringToFront");
  const focusState = await focusPage(cdp);
  const visibilityState = `${focusState?.visibilityState ?? ""}`;
  const activeTag = `${focusState?.activeTag ?? ""}`.toUpperCase();
  const isContentEditable = Boolean(focusState?.contentEditable);

  if (visibilityState && visibilityState !== "visible") {
    logFocusStateOnce(
      focusLogState,
      `hidden:${visibilityState}`,
      `[input] blocked hidden page visibility=${visibilityState}`
    );
    throw new InputCommandError("page_not_visible", { visibilityState });
  }

  if (isUnsafeActiveElement(activeTag, isContentEditable)) {
    const details = { activeTag: activeTag || "UNKNOWN" };
    if (isContentEditable) {
      details.contentEditable = true;
    }
    logFocusStateOnce(
      focusLogState,
      `unsafe:${details.activeTag}:${isContentEditable ? "contenteditable" : "plain"}`,
      `[input] blocked unsafe active element tag=${details.activeTag}`
    );
    throw new InputCommandError("unsafe_active_element", details);
  }

  logFocusStateOnce(
    focusLogState,
    `safe:${activeTag || "NONE"}`,
    `[input] focus prepared active=${activeTag || "NONE"}`
  );
}

function isUnsafeActiveElement(activeTag, isContentEditable) {
  if (isContentEditable) {
    return true;
  }
  return (
    activeTag === "INPUT" ||
    activeTag === "TEXTAREA" ||
    activeTag === "SELECT" ||
    activeTag === "BUTTON" ||
    activeTag === "A" ||
    activeTag === "IFRAME"
  );
}

function logFocusStateOnce(focusLogState, nextKey, message) {
  if (!focusLogState || focusLogState.lastKey === nextKey) {
    return;
  }
  focusLogState.lastKey = nextKey;
  console.log(message);
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

async function dispatchTrackedKey(cdp, spec, type, pressedKeys) {
  await dispatchKey(cdp, spec, type);
  if (type === "keyDown") {
    pressedKeys.add(spec.code);
    return;
  }
  pressedKeys.delete(spec.code);
}

export async function releaseTrackedKeys(cdp, pressedKeys) {
  let firstError = null;
  for (const code of [...pressedKeys]) {
    const spec = Object.values(KEY_MAP).find((candidate) => candidate.code === code);
    if (!spec) {
      pressedKeys.delete(code);
      continue;
    }
    try {
      await dispatchKey(cdp, spec, "keyUp");
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
    } finally {
      pressedKeys.delete(code);
    }
  }
  if (firstError) {
    throw firstError;
  }
}

async function executeInputAction(cdp, action, targetInfo, setClient, pressedKeys) {
  try {
    await dispatchTrackedKey(cdp, action.spec, "keyDown", pressedKeys);
    await sleep(action.durationMs);
    await dispatchTrackedKey(cdp, action.spec, "keyUp", pressedKeys);
    if (action.afterMs > 0) {
      await sleep(action.afterMs);
    }
  } catch (error) {
    await recoverInputState(cdp, error, targetInfo, setClient, pressedKeys);
  }
}

export async function executeSequence(cdp, actions, targetInfo, setClient, pressedKeys) {
  for (const action of actions) {
    await executeInputAction(cdp, action, targetInfo, setClient, pressedKeys);
  }
}

async function recoverInputState(cdp, error, targetInfo, setClient, pressedKeys) {
  if (isSocketClosedError(error)) {
    const reconnected = await connectToTarget(targetInfo);
    setClient(reconnected);
    await releaseTrackedKeys(reconnected, pressedKeys).catch(() => undefined);
    throw new Error(`CDP reconnected during input; released tracked keys (${error.message ?? error})`);
  }

  try {
    await releaseTrackedKeys(cdp, pressedKeys);
  } catch (releaseError) {
    throw new Error(
      `${error?.message ?? error}; additionally failed to release tracked keys: ${releaseError?.message ?? releaseError}`
    );
  }
  throw error;
}

async function ensureConnected(cdp, targetInfo, pressedKeys) {
  if (cdp?.isOpen()) {
    return cdp;
  }
  const reconnected = await connectToTarget(targetInfo);
  await releaseTrackedKeys(reconnected, pressedKeys).catch(() => undefined);
  return reconnected;
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
