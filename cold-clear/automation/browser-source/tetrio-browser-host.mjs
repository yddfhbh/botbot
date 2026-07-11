import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_PORT,
  DEFAULT_URL,
  isCdpOpen,
  launchChromium,
  shutdownChromium,
  waitForCdpReady
} from "./chromium-launch.mjs";

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

export function numberArg(value, fallback) {
  const parsed = Number.parseInt(value ?? `${fallback}`, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isShutdownCommand(line) {
  if (!line?.trim()) {
    return false;
  }
  try {
    return JSON.parse(line).type === "shutdown";
  } catch {
    return false;
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const port = numberArg(args.port, DEFAULT_PORT);
  const url = args.url ?? DEFAULT_URL;
  const chromePath = args.chromePath ?? process.env.CHROME_PATH ?? "";
  const profileDir = args.profileDir;

  if (await isCdpOpen(port)) {
    throw new Error(`Chrome DevTools endpoint is already open on port ${port}`);
  }

  console.log("[browser-host] launching Chromium");
  const browserProcess = launchChromium({ port, url, chromePath, profileDir });
  let shuttingDown = false;

  const cleanup = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await shutdownChromium(browserProcess);
  };

  process.on("SIGINT", () => cleanup().finally(() => process.exit(0)));
  process.on("SIGTERM", () => cleanup().finally(() => process.exit(0)));

  browserProcess.once("exit", () => {
    console.log("[browser-host] Chromium exited");
    process.exit(0);
  });

  await waitForCdpReady(port);
  console.log(`[browser-host] cdp ready port=${port}`);
  console.log(`[browser-host] opened ${url}`);

  const control = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false
  });

  control.on("line", (line) => {
    if (!isShutdownCommand(line)) {
      return;
    }
    cleanup().finally(() => control.close());
  });

  control.on("close", () => {
    cleanup().finally(() => process.exit(0));
  });
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error("[browser-host] fatal:", error?.message ?? error);
    process.exit(1);
  });
}
