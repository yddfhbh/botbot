import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_URL = "https://tetr.io/";
export const DEFAULT_PORT = 9222;

export function resolveChromePath(chromePath = "") {
  const explicit = `${chromePath}`.trim();
  if (explicit) {
    return explicit;
  }
  return findChromiumExecutable();
}

export function buildChromeArgs({ port = DEFAULT_PORT, url = DEFAULT_URL, profileDir }) {
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

export function launchChromium({
  port = DEFAULT_PORT,
  url = DEFAULT_URL,
  chromePath = "",
  profileDir,
  spawnImpl = spawn
}) {
  const executable = resolveChromePath(chromePath);
  if (!executable) {
    throw new Error("Could not find Chrome/Edge. Set CHROME_PATH to the browser executable.");
  }
  const resolvedProfileDir = profileDir || path.join(os.tmpdir(), `botbot-tetrio-cdp-${port}`);
  mkdirSync(resolvedProfileDir, { recursive: true });
  return spawnImpl(executable, buildChromeArgs({ port, url, profileDir: resolvedProfileDir }), {
    detached: false,
    stdio: ["ignore", "ignore", "ignore"]
  });
}

export async function isCdpOpen(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForCdpReady(
  port,
  {
    timeoutMs = 15000,
    fetchImpl = fetch,
    sleepImpl = sleep
  } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpOpen(port, fetchImpl)) {
      return;
    }
    await sleepImpl(250);
  }
  throw new Error(`Chrome DevTools endpoint did not open on port ${port}`);
}

export async function shutdownChromium(browserProcess, { graceMs = 5000, sleepImpl = sleep } = {}) {
  if (!browserProcess?.pid) {
    return false;
  }
  if (browserProcess.exitCode !== null) {
    return true;
  }

  browserProcess.kill();
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (browserProcess.exitCode !== null) {
      return true;
    }
    await sleepImpl(100);
  }

  try {
    browserProcess.kill("SIGKILL");
  } catch {}

  const hardDeadline = Date.now() + 1000;
  while (Date.now() < hardDeadline) {
    if (browserProcess.exitCode !== null) {
      return true;
    }
    await sleepImpl(50);
  }
  return true;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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
