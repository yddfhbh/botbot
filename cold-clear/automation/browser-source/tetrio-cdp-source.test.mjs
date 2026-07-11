import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  attachBrowserDiagnostics,
  buildChromiumLaunchArgs,
  captureTetrioGame,
  captureTetrioExportExpression,
  computeEffectiveStatePollMs,
  exposeTetrioGameFromPausedCallFrames,
  formatStateEvalPerfLog,
  getClosureProbeBreakpoints,
  isMainFrameDocumentNavigation,
  isLikelyGamePage,
  isTopFrameNavigation,
  readTetrioState,
  resetDiscoveryState,
  resetProbeRetryState,
  selectExistingTarget,
  shouldInstallBackgroundInputKeepalive,
  shouldResetDiscoveryOnExecutionContextsCleared,
  shouldAttemptClosureProbe,
  shouldAttemptDebuggerProbe,
  shouldAttemptStartupDirectScan,
  startupDirectScanDisabledReason,
  shouldDecodeRibbonFrame,
  updateLikelyGamePageState,
  waitForExistingTarget
} from "./tetrio-cdp-source.mjs";

function createMockGame() {
  return {
    ejectState() {
      return { game: { stub: true } };
    },
    ejectBoardState() {
      return { stub: true };
    }
  };
}

function runCaptureExpression(windowOverrides, options = {}, contextOverrides = {}) {
  const windowObject = { ...windowOverrides };
  windowObject.window = windowObject;
  const context = {
    window: windowObject,
    document: {
      title: "TETR.IO",
      querySelectorAll: () => [],
      body: { className: "" },
      ...contextOverrides.document
    },
    location: {
      href: "https://tetr.io/",
      pathname: "/",
      hash: "",
      ...contextOverrides.location
    }
  };
  const result = vm.runInNewContext(captureTetrioExportExpression(options), context);
  return { result, windowObject };
}

function createProbePerfStub() {
  return {
    enabled: false,
    recordProbe() {},
    recordStateEval() {}
  };
}

function createMockBrowserStateExport() {
  return {
    game: {
      board: Array.from({ length: 20 }, () => Array.from({ length: 10 }, () => 0)),
      current: "t",
      queue: ["i", "o", "l", "s", "z"],
      playing: true,
      countdown: false,
      pieceCounter: 7
    }
  };
}

function createMockBoardState() {
  return {
    b: Array.from({ length: 20 }, () => Array.from({ length: 10 }, () => 0))
  };
}

function createMockProbeCdp(options = {}) {
  const evaluateOnCallFrameQueue = [...(options.evaluateOnCallFrameQueue ?? [])];
  const runtimeEvaluateValues = [...(options.runtimeEvaluateValues ?? [])];
  const pausedEvents = [...(options.pausedEvents ?? [{ callFrames: [{ callFrameId: "frame-1", scopeChain: [] }] }])];
  const breakpoints = [];
  const removedBreakpoints = [];
  const sentMethods = [];
  const listeners = new Map();
  let nextBreakpointId = 1;

  return {
    breakpoints,
    removedBreakpoints,
    sentMethods,
    on(method, handler) {
      const current = listeners.get(method) ?? [];
      current.push(handler);
      listeners.set(method, current);
      return () => {
        const next = (listeners.get(method) ?? []).filter((entry) => entry !== handler);
        listeners.set(method, next);
      };
    },
    emit(method, payload) {
      for (const handler of listeners.get(method) ?? []) {
        handler(payload);
      }
    },
    async send(method, params = {}) {
      sentMethods.push({ method, params });
      if (method === "Debugger.enable" || method === "Debugger.disable" || method === "Debugger.resume") {
        return {};
      }
      if (method === "Runtime.releaseObjectGroup") {
        return {};
      }
      if (method === "Runtime.evaluate") {
        if (params.expression === "window.requestAnimationFrame") {
          return { result: { objectId: "raf-object" } };
        }
        if (params.expression === "window.setTimeout") {
          return { result: { objectId: "timeout-object" } };
        }
        const value = runtimeEvaluateValues.shift();
        if (value !== undefined) {
          return value;
        }
        return { result: { value: { ok: false, reason: "mock evaluate missing" } } };
      }
      if (method === "Debugger.setBreakpointOnFunctionCall") {
        breakpoints.push(params.objectId);
        return { breakpointId: `bp-${nextBreakpointId++}` };
      }
      if (method === "Debugger.removeBreakpoint") {
        removedBreakpoints.push(params.breakpointId);
        return {};
      }
      if (method === "Debugger.evaluateOnCallFrame") {
        return evaluateOnCallFrameQueue.shift() ?? { result: { value: { ok: false, reason: "Ai not visible" } } };
      }
      if (method === "Runtime.callFunctionOn") {
        return options.callFunctionOnResult ?? { result: { value: { ok: false } } };
      }
      throw new Error(`Unhandled method ${method}`);
    },
    async waitForEvent(method) {
      if (typeof options.waitForEventImpl === "function") {
        return options.waitForEventImpl({ method, cdp: this });
      }
      if (method !== "Debugger.paused") {
        throw new Error(`Unhandled event ${method}`);
      }
      if (!pausedEvents.length) {
        throw new Error("Timed out waiting for CDP event Debugger.paused");
      }
      return pausedEvents.shift();
    }
  };
}

function createEventEmitterCdp() {
  const listeners = new Map();
  return {
    on(method, handler) {
      const current = listeners.get(method) ?? [];
      current.push(handler);
      listeners.set(method, current);
    },
    emit(method, payload) {
      for (const handler of listeners.get(method) ?? []) {
        handler(payload);
      }
    }
  };
}

test("debugger_probe_mode disabled never probes", () => {
  assert.equal(
    shouldAttemptDebuggerProbe({
      mode: "disabled",
      needsProbe: true,
      gameCaptured: false,
      playing: false,
      lastKnownPlaying: false,
      now: 20_000,
      lastAttemptAt: 0
    }),
    false
  );
});

test("startup_only stops probing after the game object is captured", () => {
  assert.equal(
    shouldAttemptDebuggerProbe({
      mode: "startup_only",
      needsProbe: true,
      gameCaptured: true,
      playing: true,
      lastKnownPlaying: true,
      now: 20_000,
      lastAttemptAt: 0
    }),
    false
  );
});

test("manual mode never auto probes while playing", () => {
  assert.equal(
    shouldAttemptDebuggerProbe({
      mode: "manual",
      needsProbe: true,
      gameCaptured: false,
      playing: true,
      lastKnownPlaying: true,
      now: 20_000,
      lastAttemptAt: 0
    }),
    false
  );
});

test("startup_only allows one initial probe while already playing", () => {
  assert.equal(
    shouldAttemptDebuggerProbe({
      mode: "startup_only",
      needsProbe: true,
      gameCaptured: false,
      playing: true,
      lastKnownPlaying: true,
      now: 20_000,
      lastAttemptAt: 0
    }),
    true
  );
  assert.equal(
    shouldAttemptDebuggerProbe({
      mode: "startup_only",
      needsProbe: true,
      gameCaptured: false,
      playing: true,
      lastKnownPlaying: true,
      now: 20_000,
      lastAttemptAt: 19_500
    }),
    false
  );
});

test("closure probe policy requires likely game page and allows cooldown retries", () => {
  assert.equal(
    shouldAttemptClosureProbe({
      probePageState: true,
      debuggerProbeMode: "startup_only",
      likelyGamePage: false,
      needsProbe: true,
      gameCaptured: false,
      probeAttempts: 0,
      now: 20_000,
      lastAttemptAt: 0
    }),
    false
  );
  assert.equal(
    shouldAttemptClosureProbe({
      probePageState: true,
      debuggerProbeMode: "startup_only",
      likelyGamePage: true,
      needsProbe: true,
      gameCaptured: false,
      probeAttempts: 1,
      now: 20_000,
      lastAttemptAt: 19_000
    }),
    true
  );
  assert.equal(
    shouldAttemptClosureProbe({
      probePageState: true,
      debuggerProbeMode: "startup_only",
      likelyGamePage: true,
      needsProbe: true,
      gameCaptured: false,
      probeAttempts: 3,
      now: 20_000,
      lastAttemptAt: 0
    }),
    false
  );
});

test("ribbon until_seed stops deep decode after seed capture", () => {
  assert.equal(
    shouldDecodeRibbonFrame({
      mode: "until_seed",
      seedCaptured: true,
      direction: "received"
    }),
    false
  );
  assert.equal(
    shouldDecodeRibbonFrame({
      mode: "until_seed",
      seedCaptured: false,
      direction: "received"
    }),
    true
  );
});

test("effective state poll never runs faster than the minimum", () => {
  assert.equal(computeEffectiveStatePollMs(8, 16), 16);
  assert.equal(computeEffectiveStatePollMs(40, 16), 40);
});

test("chromium launch args open the requested url directly", () => {
  const args = buildChromiumLaunchArgs({
    port: 9222,
    url: "https://tetr.io/",
    profileDir: "C:/temp/botbot-profile"
  });

  assert.equal(args.at(-1), "https://tetr.io/");
  assert.equal(args.includes("about:blank"), false);
});

test("startup direct scan finds nested game under window.game", () => {
  const mockGame = createMockGame();
  const { result, windowObject } = runCaptureExpression(
    {
      game: {
        nested: mockGame
      }
    },
    { allowStartupDirectScan: true }
  );

  assert.equal(result.ok, true);
  assert.equal(result.quick, false);
  assert.equal(result.scanMode, "startup_direct");
  assert.equal(result.captureSource, "window.game.nested");
  assert.equal(windowObject.__fusionTetrioGame, mockGame);
});

test("startup direct scan finds top-level window property game", () => {
  const mockGame = createMockGame();
  const { result, windowObject } = runCaptureExpression(
    {
      hiddenFusionSlot: mockGame
    },
    { allowStartupDirectScan: true },
    {
      location: {
        href: "https://tetr.io/#solo",
        hash: "#solo"
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.captureSource, "window.hiddenFusionSlot");
  assert.equal(windowObject.__fusionTetrioGame, mockGame);
});

test("likely game page heuristic stays false on the root home page", () => {
  assert.equal(
    isLikelyGamePage({
      href: "https://tetr.io/",
      pathname: "/",
      hash: "",
      pageTitle: "TETR.IO",
      bodyClass: "",
      largeCanvasCount: 0
    }),
    false
  );
});

test("likely game page heuristic turns true for solo routes", () => {
  assert.equal(
    isLikelyGamePage({
      href: "https://tetr.io/#solo",
      pathname: "/",
      hash: "#solo",
      pageTitle: "TETR.IO",
      bodyClass: "",
      largeCanvasCount: 0
    }),
    true
  );
});

test("target selection does not fall back to unrelated about:blank pages", () => {
  const selected = selectExistingTarget(
    [
      {
        type: "page",
        title: "New Tab",
        url: "about:blank",
        webSocketDebuggerUrl: "ws://blank"
      }
    ],
    "https://tetr.io/",
    "TETR.IO"
  );

  assert.equal(selected, undefined);
});

test("target selection prefers explicit tetrio matches", () => {
  const selected = selectExistingTarget(
    [
      {
        type: "page",
        title: "New Tab",
        url: "about:blank",
        webSocketDebuggerUrl: "ws://blank"
      },
      {
        type: "page",
        title: "TETR.IO",
        url: "https://tetr.io/",
        webSocketDebuggerUrl: "ws://tetrio"
      }
    ],
    "https://tetr.io/",
    "TETR.IO"
  );

  assert.equal(selected?.webSocketDebuggerUrl, "ws://tetrio");
});

test("waitForExistingTarget returns a tetrio tab without needing a new blank tab", async () => {
  let pollCount = 0;
  const result = await waitForExistingTarget({
    port: 9222,
    url: "https://tetr.io/",
    targetHint: "TETR.IO",
    timeoutMs: 1000,
    pollMs: 1,
    fetchTargets: async () => {
      pollCount += 1;
      if (pollCount < 2) {
        return [
          {
            type: "page",
            title: "New Tab",
            url: "about:blank",
            webSocketDebuggerUrl: "ws://blank"
          }
        ];
      }
      return [
        {
          type: "page",
          title: "TETR.IO",
          url: "https://tetr.io/",
          webSocketDebuggerUrl: "ws://tetrio"
        }
      ];
    },
    sleepFn: async () => undefined
  });

  assert.equal(result?.webSocketDebuggerUrl, "ws://tetrio");
  assert.equal(pollCount >= 2, true);
});

test("background input keepalive stays off until an active game state exists", () => {
  assert.equal(
    shouldInstallBackgroundInputKeepalive({
      enabled: false,
      installed: false,
      state: { ok: true, ready: true, playing: true, countdown: false }
    }),
    false
  );
  assert.equal(
    shouldInstallBackgroundInputKeepalive({
      enabled: true,
      installed: false,
      state: { ok: false, ready: false, playing: false, countdown: false }
    }),
    false
  );
  assert.equal(
    shouldInstallBackgroundInputKeepalive({
      enabled: true,
      installed: false,
      state: { ok: true, ready: true, playing: true, countdown: false }
    }),
    true
  );
});

test("root home page skips expensive top-level discovery", () => {
  const mockGame = createMockGame();
  const { result, windowObject } = runCaptureExpression(
    {
      hiddenFusionSlot: mockGame
    },
    { allowStartupDirectScan: true }
  );

  assert.equal(result.ok, false);
  assert.equal(result.scanMode, "startup_direct");
  assert.equal(result.scanReason, "not_game_page");
  assert.equal(result.pageHints.likelyGamePage, false);
  assert.equal(windowObject.__fusionTetrioGame, undefined);
});

test("closure probe breakpoints include requestAnimationFrame and setTimeout", () => {
  assert.deepEqual(
    getClosureProbeBreakpoints().map((entry) => entry.label),
    ["raf", "setTimeout"]
  );
  assert.deepEqual(
    getClosureProbeBreakpoints().map((entry) => entry.expression),
    ["window.requestAnimationFrame", "window.setTimeout"]
  );
});

test("paused call frame captures Ai before scope fallback", async () => {
  const cdp = createMockProbeCdp({
    evaluateOnCallFrameQueue: [
      {
        result: {
          value: {
            ok: true,
            source: "closure:Ai"
          }
        }
      }
    ]
  });

  const result = await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [{ callFrameId: "frame-1", scopeChain: [] }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "closure:Ai");
  const aiExpression = cdp.sentMethods.find((entry) => entry.method === "Debugger.evaluateOnCallFrame");
  assert.match(aiExpression?.params?.expression ?? "", /window\.__fusionTetrioGame = Ai/);
  assert.equal(
    cdp.sentMethods.some((entry) => entry.method === "Runtime.callFunctionOn"),
    false
  );
});

test("paused call frame does not run generalized scope scan when Ai is missing", async () => {
  const cdp = createMockProbeCdp({
    evaluateOnCallFrameQueue: [
      {
        result: {
          value: {
            ok: false,
            reason: "Ai not visible"
          }
        }
      }
    ]
  });

  const result = await exposeTetrioGameFromPausedCallFrames(cdp, {
    callFrames: [
      {
        callFrameId: "frame-1",
        scopeChain: [{ type: "local", object: { objectId: "scope-object-1" } }]
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(
    cdp.sentMethods.some((entry) => entry.method === "Runtime.callFunctionOn"),
    false
  );
});

test("captureTetrioGame registers both raf and setTimeout breakpoints", async () => {
  const cdp = createMockProbeCdp({
    evaluateOnCallFrameQueue: [
      {
        result: {
          value: {
            ok: true,
            source: "closure:Ai"
          }
        }
      }
    ]
  });

  const result = await captureTetrioGame(cdp, createProbePerfStub());

  assert.equal(result.ok, true);
  assert.deepEqual(result.breakpoints, ["raf", "setTimeout"]);
  assert.deepEqual(cdp.breakpoints, ["raf-object", "timeout-object"]);
});

test("captureTetrioGame resumes within 150ms even when Ai is missing", async () => {
  const cdp = createMockProbeCdp({
    evaluateOnCallFrameQueue: [
      new Promise((resolve) => {
        setTimeout(() => resolve({ result: { value: { ok: false, reason: "Ai not visible" } } }), 200);
      })
    ]
  });

  const startedAt = Date.now();
  const result = await captureTetrioGame(cdp, createProbePerfStub());
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.equal(elapsedMs < 150, true);
  assert.equal(result.pausedMs < 150, true);
  assert.equal(
    cdp.sentMethods.some((entry) => entry.method === "Debugger.resume"),
    true
  );
  assert.equal(
    cdp.sentMethods.some((entry) => entry.method === "Runtime.callFunctionOn"),
    false
  );
});

test("captureTetrioGame is cancelled immediately when navigation happens during probe", async () => {
  const cdp = createMockProbeCdp({
    evaluateOnCallFrameQueue: [
      new Promise((resolve) => {
        setTimeout(() => resolve({ result: { value: { ok: false, reason: "Ai not visible" } } }), 200);
      })
    ],
    waitForEventImpl: ({ method }) => {
      if (method !== "Debugger.paused") {
        throw new Error(`Unhandled event ${method}`);
      }
      return Promise.resolve({ callFrames: [{ callFrameId: "frame-1", scopeChain: [] }] });
    }
  });

  const startedAt = Date.now();
  const capturePromise = captureTetrioGame(cdp, createProbePerfStub(), { attempt: 1 });
  setTimeout(() => {
    cdp.emit("Page.frameNavigated", { frame: { id: "root-frame" } });
  }, 10);
  const result = await capturePromise;
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.match(result.reason, /Page\.frameNavigated/);
  assert.equal(elapsedMs < 1500, true);
  assert.equal(
    cdp.sentMethods.some((entry) => entry.method === "Debugger.resume"),
    true
  );
});

test("captureTetrioGame rejects a second probe while one is already in flight", async () => {
  const cdp = createMockProbeCdp({
    waitForEventImpl: ({ method }) => {
      if (method !== "Debugger.paused") {
        throw new Error(`Unhandled event ${method}`);
      }
      return new Promise(() => undefined);
    }
  });

  const firstCapture = captureTetrioGame(cdp, createProbePerfStub(), { attempt: 1 });
  const secondCapture = await captureTetrioGame(cdp, createProbePerfStub(), { attempt: 2 });

  assert.equal(secondCapture.ok, false);
  assert.equal(secondCapture.reason, "probe already in progress");

  await new Promise((resolve) => setTimeout(resolve, 10));
  cdp.emit("Page.frameNavigated", { frame: { id: "root-frame" } });
  await firstCapture;
});

test("readTetrioState falls through direct scan failure into closure probe capture", async () => {
  const cdp = createMockProbeCdp({
    runtimeEvaluateValues: [
      {
        result: {
          value: {
            ok: false,
            quick: false,
            scanMode: "startup_direct",
            scanAttempted: true,
            scanReason: "no_game",
            reason: "TETR.IO game instance not captured yet",
            href: "https://tetr.io/#solo",
            pageTitle: "TETR.IO",
            pageHints: {
              likelyGamePage: true,
              canvasCount: 3,
              largeCanvasCount: 2,
              hash: "#solo"
            }
          }
        }
      },
      {
        result: {
          value: {
            ok: true,
            quick: true,
            scanMode: false,
            scanAttempted: false,
            captureSource: "window.__fusionTetrioGame",
            href: "https://tetr.io/#solo",
            pageTitle: "TETR.IO",
            pageHints: {
              likelyGamePage: true,
              canvasCount: 3,
              largeCanvasCount: 2,
              hash: "#solo"
            },
            exported: createMockBrowserStateExport(),
            boardState: createMockBoardState()
          }
        }
      }
    ],
    evaluateOnCallFrameQueue: [
      {
        result: {
          value: {
            ok: true,
            source: "closure:Ai"
          }
        }
      }
    ]
  });
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

  const result = await readTetrioState(cdp, {
    selector: {
      playerSelector: "auto",
      playerNickname: "",
      playerUserId: "",
      dumpStateOnFail: false,
      dumpStatePath: "automation/debug/tetrio-state-dump.json"
    },
    targetTitle: "TETR.IO",
    targetUrl: "https://tetr.io/#solo",
    probePageState: true,
    debuggerProbeMode: "startup_only",
    useSeedSimulationFallback: false,
    network: {
      seed: null,
      nextCount: 6,
      readyAt: 0,
      ribbonSeen: false,
      lastPageProbeAt: 0,
      frameCounts: { received: 0, sent: 0, decoded: 0 }
    },
    probeState,
    perf: createProbePerfStub()
  });

  assert.equal(result.ok, true);
  assert.equal(result.current, "t");
  assert.equal(probeState.gameCaptured, true);
  assert.equal(probeState.probeAttempts, 1);
  assert.equal(
    cdp.sentMethods.some((entry) => entry.method === "Debugger.enable"),
    true
  );
});

test("readTetrioState skips re-registering debugger probe after capture succeeds", async () => {
  const cdp = createMockProbeCdp({
    runtimeEvaluateValues: [
      {
        result: {
          value: {
            ok: false,
            quick: false,
            scanMode: "startup_direct",
            scanAttempted: true,
            scanReason: "no_game",
            reason: "TETR.IO game instance not captured yet",
            href: "https://tetr.io/#solo",
            pageTitle: "TETR.IO",
            pageHints: {
              likelyGamePage: true,
              canvasCount: 3,
              largeCanvasCount: 2,
              hash: "#solo"
            }
          }
        }
      },
      {
        result: {
          value: {
            ok: true,
            quick: true,
            scanMode: false,
            scanAttempted: false,
            captureSource: "window.__fusionTetrioGame",
            href: "https://tetr.io/#solo",
            pageTitle: "TETR.IO",
            pageHints: {
              likelyGamePage: true,
              canvasCount: 3,
              largeCanvasCount: 2,
              hash: "#solo"
            },
            exported: createMockBrowserStateExport(),
            boardState: createMockBoardState()
          }
        }
      },
      {
        result: {
          value: {
            ok: true,
            quick: true,
            scanMode: false,
            scanAttempted: false,
            captureSource: "window.__fusionTetrioGame",
            href: "https://tetr.io/#solo",
            pageTitle: "TETR.IO",
            pageHints: {
              likelyGamePage: true,
              canvasCount: 3,
              largeCanvasCount: 2,
              hash: "#solo"
            },
            exported: createMockBrowserStateExport(),
            boardState: createMockBoardState()
          }
        }
      }
    ],
    evaluateOnCallFrameQueue: [
      {
        result: {
          value: {
            ok: true,
            source: "closure:Ai"
          }
        }
      }
    ]
  });
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
  const options = {
    selector: {
      playerSelector: "auto",
      playerNickname: "",
      playerUserId: "",
      dumpStateOnFail: false,
      dumpStatePath: "automation/debug/tetrio-state-dump.json"
    },
    targetTitle: "TETR.IO",
    targetUrl: "https://tetr.io/#solo",
    probePageState: true,
    debuggerProbeMode: "startup_only",
    useSeedSimulationFallback: false,
    network: {
      seed: null,
      nextCount: 6,
      readyAt: 0,
      ribbonSeen: false,
      lastPageProbeAt: 0,
      frameCounts: { received: 0, sent: 0, decoded: 0 }
    },
    probeState,
    perf: createProbePerfStub()
  };

  const first = await readTetrioState(cdp, options);
  const enableCallsAfterFirst = cdp.sentMethods.filter((entry) => entry.method === "Debugger.enable").length;
  const second = await readTetrioState(cdp, options);
  const enableCallsAfterSecond = cdp.sentMethods.filter((entry) => entry.method === "Debugger.enable").length;

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(enableCallsAfterFirst, 1);
  assert.equal(enableCallsAfterSecond, 1);
});

test("captured game uses quick path on later polls", () => {
  const mockGame = createMockGame();
  const first = runCaptureExpression(
    {
      game: {
        nested: mockGame
      }
    },
    { allowStartupDirectScan: true }
  );
  const second = runCaptureExpression(
    {
      __fusionTetrioGame: first.windowObject.__fusionTetrioGame
    },
    { allowStartupDirectScan: false }
  );

  assert.equal(first.result.captureSource, "window.game.nested");
  assert.equal(second.result.ok, true);
  assert.equal(second.result.quick, true);
  assert.equal(second.result.scanMode, false);
  assert.equal(second.result.captureSource, "window.__fusionTetrioGame");
});

test("disabled mode still allows startup direct scan helper decisions", () => {
  assert.equal(
    shouldAttemptStartupDirectScan({
      gameCaptured: false,
      now: 20_000,
      lastAttemptAt: 0,
      attempts: 0
    }),
    true
  );
  assert.equal(
    shouldAttemptStartupDirectScan({
      gameCaptured: true,
      now: 20_000,
      lastAttemptAt: 0,
      attempts: 0
    }),
    false
  );
});

test("startup direct scan does not permanently expire after three failures or twenty seconds", () => {
  assert.equal(
    shouldAttemptStartupDirectScan({
      gameCaptured: false,
      now: 20_000,
      lastAttemptAt: 18_000,
      attempts: 3
    }),
    true
  );
  assert.equal(
    startupDirectScanDisabledReason({
      gameCaptured: false,
      now: 20_000,
      lastAttemptAt: 19_200,
      attempts: 3
    }),
    "cooldown"
  );
});

test("resetDiscoveryState re-enables direct discovery after lifecycle reset", () => {
  const probeState = {
    startupDirectScanAttempts: 9,
    startupDirectScanLastAt: 19_000,
    lastAttemptAt: 10_000,
    probeAttempts: 1,
    gameCaptured: true,
    lastKnownPlaying: true,
    lastCaptureSource: "window.game",
    lastLikelyGamePage: true
  };

  resetDiscoveryState(probeState);

  assert.equal(probeState.startupDirectScanAttempts, 0);
  assert.equal(probeState.startupDirectScanLastAt, 0);
  assert.equal(probeState.lastAttemptAt, 0);
  assert.equal(probeState.probeAttempts, 0);
  assert.equal(probeState.gameCaptured, false);
  assert.equal(probeState.lastKnownPlaying, false);
  assert.equal(probeState.lastCaptureSource, null);
  assert.equal(probeState.lastLikelyGamePage, false);
});

test("resetProbeRetryState clears only retry counters", () => {
  const probeState = {
    lastAttemptAt: 10_000,
    probeAttempts: 3,
    gameCaptured: false,
    lastLikelyGamePage: true
  };

  resetProbeRetryState(probeState);

  assert.equal(probeState.lastAttemptAt, 0);
  assert.equal(probeState.probeAttempts, 0);
  assert.equal(probeState.lastLikelyGamePage, true);
});

test("likely game page transition resets retry budget", () => {
  const probeState = {
    lastAttemptAt: 10_000,
    probeAttempts: 2,
    lastLikelyGamePage: false,
    lastLikelyGamePageAt: 0
  };

  const transitioned = updateLikelyGamePageState(probeState, true, 20_000);

  assert.equal(transitioned, true);
  assert.equal(probeState.lastAttemptAt, 0);
  assert.equal(probeState.probeAttempts, 0);
  assert.equal(probeState.lastLikelyGamePage, true);
  assert.equal(probeState.lastLikelyGamePageAt, 20_000);
});

test("top frame navigation ignores child frames", () => {
  assert.equal(
    isTopFrameNavigation({
      frame: { id: "root-frame" }
    }),
    true
  );
  assert.equal(
    isTopFrameNavigation({
      frame: { id: "child-frame", parentId: "root-frame" }
    }),
    false
  );
});

test("document navigation only resets for the main frame once known", () => {
  assert.equal(
    isMainFrameDocumentNavigation({ frameId: "root-frame" }, "root-frame"),
    true
  );
  assert.equal(
    isMainFrameDocumentNavigation({ frameId: "child-frame" }, "root-frame"),
    false
  );
  assert.equal(isMainFrameDocumentNavigation({}, null), true);
});

test("execution context clears only reset captured discovery state", () => {
  assert.equal(
    shouldResetDiscoveryOnExecutionContextsCleared({
      gameCaptured: false,
      lastCaptureSource: null
    }),
    false
  );
  assert.equal(
    shouldResetDiscoveryOnExecutionContextsCleared({
      gameCaptured: true,
      lastCaptureSource: null
    }),
    true
  );
  assert.equal(
    shouldResetDiscoveryOnExecutionContextsCleared({
      gameCaptured: false,
      lastCaptureSource: "window.game"
    }),
    true
  );
});

test("browser diagnostics forward runtime exceptions", () => {
  const cdp = createEventEmitterCdp();
  const lines = [];
  attachBrowserDiagnostics(cdp, (line) => lines.push(line));

  cdp.emit("Runtime.exceptionThrown", {
    exceptionDetails: {
      text: "ReferenceError: foo is not defined"
    }
  });

  assert.equal(
    lines.some((line) => line.includes("[browser][exception] ReferenceError: foo is not defined")),
    true
  );
});

test("state perf logs show quick, startup scan, and disabled modes", () => {
  assert.equal(
    formatStateEvalPerfLog({ quick: true }, 3),
    "[perf][state] quick=true scan=false eval_ms=3"
  );
  assert.equal(
    formatStateEvalPerfLog({ quick: false, scanMode: "startup_direct" }, 9),
    "[perf][state] quick=false scan=startup_direct eval_ms=9"
  );
  assert.equal(
    formatStateEvalPerfLog({ quick: false, scanMode: "disabled", scanReason: "no_game" }, 1),
    "[perf][state] quick=false scan=disabled reason=no_game"
  );
});
