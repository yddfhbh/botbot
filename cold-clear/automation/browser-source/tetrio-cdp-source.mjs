import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
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

const DEFAULT_NEXT_COUNT = 6;
const DEFAULT_STATUS_MS = 2500;
const DEFAULT_CAPTURE_COOLDOWN_MS = 2000;
const DEFAULT_CAPTURE_ARMING_WINDOW_MS = 8000;
const DEFAULT_CAPTURE_SKIP_LOG_INTERVAL_MS = 60000;
const DEFAULT_CAPTURE_RETRY_SCHEDULE_MS = [750, 1000, 1500, 1500];
const DEFAULT_FULL_SCAN_PAUSE_BUDGET_MS = 350;
const DEFAULT_FULL_SCAN_CUMULATIVE_BUDGET_MS = 700;
const DEFAULT_FULL_SCAN_CONTINUATION_BACKOFF_MS = 100;
const DEFAULT_BOOTSTRAP_BLOCKED_LOG_INTERVAL_MS = 5000;
const DEFAULT_GAME_START_SIGNAL_OVERLAP_MS = 10000;
const DEFAULT_NEXT_GAME_FAST_LOCATOR_INTERVAL_MS = 350;
const DEFAULT_NEXT_GAME_FAST_LOCATOR_MISS_LOG_INTERVAL_MS = 5000;
const DEFAULT_NEXT_GAME_INTERACTION_POLL_MS = 75;
const DEFAULT_NEXT_GAME_INTERACTION_BURST_DEDUPE_MS = 150;
const DEFAULT_NEXT_GAME_INTERACTION_CAPTURE_DELAY_MS = 300;
const DEFAULT_TARGETED_PAUSED_PROBE_DELAY_MS = 450;
const DEFAULT_TARGETED_PAUSED_PROBE_BACKOFF_MS = 800;
const DEFAULT_FOLLOWUP_FAST_CAPTURE_TIMEOUT_MS = 100;
const DEFAULT_AGAIN_PROVISIONAL_HARD_FALLBACK_MS = 1200;
const MAX_GAME_START_SIGNALS = 16;
const MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW = 2;
const MAX_PAUSED_SCOPE_SCAN_CANDIDATES_PER_ATTEMPT = 400;
const MAX_SCOPE_PROPERTIES_PER_SCOPE = 80;
const DEFAULT_SUPPRESSED_REASON = "VS WebSocket simulation owns live state";
const PERF_LOG_INTERVAL_MS = 2000;
const DEFAULT_BOOTSTRAP_TRANSPORT_SETTLE_MS = 1500;
const DEFAULT_BOOTSTRAP_FALLBACK_MS = 15000;
const NEXT_GAME_INTERACTION_PHASE_INACTIVE = "inactive";
const NEXT_GAME_INTERACTION_PHASE_POST_GAME_WATCH = "post_game_watch";
const NEXT_GAME_INTERACTION_PHASE_REACQUIRING = "reacquiring";
const NEXT_GAME_INTERACTION_PHASE_WAITING_TRANSITION_READY = "waiting_transition_ready";
const NEXT_GAME_INTERACTION_PHASE_CAPTURE_ARMED = "capture_armed";
const NEXT_GAME_INTERACTION_PHASE_CAPTURED_WAITING_START = "captured_waiting_start";
const SESSION_MODE_CLOSURE_CAPTURE = "closure_capture";
const SESSION_MODE_VS_WS_SHADOW = "vs_ws_shadow";

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

function buildVsShadowSnapshotToken(gameEpoch, pieceCounter) {
  return `vsws-${gameEpoch}-${pieceCounter}`;
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

export function isVsWsSimEnvEnabled(env = process.env) {
  return env?.FUSION_VS_WS_SIM === "1";
}

export function shouldAttemptClosureCapture({
  probePageState,
  suppressClosureCapture,
  bootstrapReady = true,
  stateOk,
  gameplayExpected = false,
  nextAttemptAt = null,
  lastCaptureAt = 0,
  lastPageProbeAt = 0,
  now = Date.now(),
  cooldownMs = DEFAULT_CAPTURE_COOLDOWN_MS
}) {
  const retryReady =
    Number.isFinite(nextAttemptAt) && nextAttemptAt !== null
      ? now >= nextAttemptAt
      : now - lastCaptureAt >= cooldownMs &&
        now - lastPageProbeAt >= cooldownMs;
  return Boolean(
    probePageState &&
      gameplayExpected &&
      !suppressClosureCapture &&
      bootstrapReady &&
      !stateOk &&
      retryReady
  );
}

export function createClosureCaptureState() {
  return {
    armedUntil: 0,
    armedReason: "",
    lastSkippedLogAt: 0,
    nextAttemptAt: 0,
    retryCount: 0,
    lastSuccessfulLocator: "",
    pendingCaptureArm: null,
    firstAttemptLoggedForReason: "",
    captureAttemptsInWindow: 0,
    fullScanAttemptsInWindow: 0,
    cumulativePausedScanBudgetUsedMs: 0,
    pausedScopeScanCursor: null,
    windowSequence: 0,
    scanBudgetExhausted: false,
    fastLocatorAttempted: false,
    lastSuccessfulPausedLocation: null,
    pendingFollowupFullScan: false,
    pendingFollowupFastCapture: false,
    windowArmedAt: 0,
    windowFirstInteractionAt: 0,
    windowTargetedProbeAt: 0,
    provisionalNonHeavyAttemptConsumed: false
  };
}

function hasActiveClosureCaptureWindowState(closureCaptureState) {
  if (!closureCaptureState) {
    return false;
  }
  return Boolean(
    Number(closureCaptureState.armedUntil ?? 0) > 0 ||
      Number(closureCaptureState.captureAttemptsInWindow ?? 0) > 0 ||
      Number(closureCaptureState.fullScanAttemptsInWindow ?? 0) > 0 ||
      Number(closureCaptureState.cumulativePausedScanBudgetUsedMs ?? 0) > 0 ||
      closureCaptureState.pausedScopeScanCursor ||
      closureCaptureState.scanBudgetExhausted === true ||
      closureCaptureState.fastLocatorAttempted === true ||
      Number(closureCaptureState.nextAttemptAt ?? 0) > 0 ||
      Number(closureCaptureState.retryCount ?? 0) > 0 ||
      String(closureCaptureState.armedReason ?? "").trim() ||
      String(closureCaptureState.firstAttemptLoggedForReason ?? "").trim()
  );
}

function formatClosureWindowResetReason(reason = "") {
  if (reason === "next_game_carried_interaction") {
    return "carried interaction";
  }
  if (reason === "next_game_user_interaction") {
    return "next-game interaction";
  }
  return String(reason || "gameplay_signal");
}

export function initializeFreshClosureCaptureWindow(
  closureCaptureState,
  {
    reason = "gameplay_signal",
    log = console.log
  } = {}
) {
  if (!closureCaptureState) {
    return false;
  }
  const previousCaptureAttempts = Math.max(
    0,
    Number(closureCaptureState.captureAttemptsInWindow ?? 0)
  );
  const previousFullScanAttempts = Math.max(
    0,
    Number(closureCaptureState.fullScanAttemptsInWindow ?? 0)
  );
  const previousPausedUsedMs = Math.max(
    0,
    Number(closureCaptureState.cumulativePausedScanBudgetUsedMs ?? 0)
  );
  const hadActiveState = hasActiveClosureCaptureWindowState(closureCaptureState);
  if (hadActiveState && typeof log === "function") {
    log(
      `[browser] resetting closure window for ${formatClosureWindowResetReason(reason)} previous_capture_attempts=${previousCaptureAttempts} previous_full_scan_attempts=${previousFullScanAttempts} previous_paused_used_ms=${previousPausedUsedMs}`
    );
  }
  closureCaptureState.armedUntil = 0;
  closureCaptureState.armedReason = "";
  closureCaptureState.lastSkippedLogAt = 0;
  closureCaptureState.nextAttemptAt = 0;
  closureCaptureState.retryCount = 0;
  closureCaptureState.pendingCaptureArm = null;
  closureCaptureState.firstAttemptLoggedForReason = "";
  closureCaptureState.captureAttemptsInWindow = 0;
  closureCaptureState.pendingFollowupFullScan = false;
  closureCaptureState.pendingFollowupFastCapture = false;
  closureCaptureState.windowArmedAt = 0;
  closureCaptureState.windowFirstInteractionAt = 0;
  closureCaptureState.windowTargetedProbeAt = 0;
  closureCaptureState.provisionalNonHeavyAttemptConsumed = false;
  resetClosureCaptureScanWindowState(closureCaptureState, {
    nextAttemptAt: 0,
    cursor: createPausedScopeScanCursor()
  });
  return true;
}

export function createNextGameReacquireState() {
  return {
    active: false,
    interactionPhase: NEXT_GAME_INTERACTION_PHASE_INACTIVE,
    startedAt: 0,
    lastFastAttemptAt: 0,
    lastFastMissLoggedAt: 0,
    lastEndedObjectCheckAt: 0,
    lastEndedObjectProbeStatus: "",
    lastEndedObjectProbeLogAt: 0,
    lastCheapSignalState: false,
    lastCheapSignalLogAt: 0,
    lastCheapSignalLabel: "",
    lastCheapSampledAt: 0,
    lastCheapAggregateState: "",
    interactionBaselineGeneration: 0,
    lastInteractionGenerationSeen: 0,
    lastInteractionGenerationHandled: 0,
    interactionWindowGeneration: 0,
    interactionWindowArmedAt: 0,
    pendingInteractionGeneration: 0,
    pendingInteractionTimestamp: 0,
    pendingInteractionSource: "",
    pendingArmReason: "",
    pendingInteractionType: "",
    pendingInteractionKey: "",
    pendingInteractionTargetTag: "",
    pendingInteractionTargetId: "",
    pendingInteractionTargetClass: "",
    pendingInteractionKind: "",
    provisionalInteractionGeneration: 0,
    provisionalInteractionTimestamp: 0,
    provisionalInteractionKey: "",
    provisionalInteractionTrusted: false,
    provisionalInteractionKind: "",
    provisionalTransitionReady: false,
    provisionalTransitionReadyLoggedAt: 0
  };
}

export function createPostGameInteractionWatchState() {
  return {
    active: false,
    firstNotPlayingAt: 0,
    interactionBaselineGeneration: 0,
    lastInteractionGenerationSeen: 0,
    lastPollAt: 0,
    pendingGeneration: 0,
    pendingTimestamp: 0,
    pendingType: "",
    pendingKey: "",
    pendingTargetTag: "",
    pendingTargetId: "",
    pendingTargetClass: "",
    provisionalArmedGeneration: 0
  };
}

function setNextGameInteractionPhase(
  nextGameReacquireState,
  phase = NEXT_GAME_INTERACTION_PHASE_INACTIVE
) {
  if (!nextGameReacquireState) {
    return phase;
  }
  nextGameReacquireState.interactionPhase = String(phase || NEXT_GAME_INTERACTION_PHASE_INACTIVE);
  return nextGameReacquireState.interactionPhase;
}

function clearPostGameInteractionPending(postGameInteractionWatchState) {
  if (!postGameInteractionWatchState) {
    return false;
  }
  postGameInteractionWatchState.pendingGeneration = 0;
  postGameInteractionWatchState.pendingTimestamp = 0;
  postGameInteractionWatchState.pendingType = "";
  postGameInteractionWatchState.pendingKey = "";
  postGameInteractionWatchState.pendingTargetTag = "";
  postGameInteractionWatchState.pendingTargetId = "";
  postGameInteractionWatchState.pendingTargetClass = "";
  return true;
}

export function resetPostGameInteractionWatch(
  postGameInteractionWatchState,
  {
    clearPending = true
  } = {}
) {
  if (!postGameInteractionWatchState) {
    return null;
  }
  postGameInteractionWatchState.active = false;
  postGameInteractionWatchState.firstNotPlayingAt = 0;
  postGameInteractionWatchState.interactionBaselineGeneration = 0;
  postGameInteractionWatchState.lastInteractionGenerationSeen = 0;
  postGameInteractionWatchState.lastPollAt = 0;
  if (clearPending) {
    clearPostGameInteractionPending(postGameInteractionWatchState);
  }
  return postGameInteractionWatchState;
}

export function startPostGameInteractionWatch(
  postGameInteractionWatchState,
  {
    now = Date.now(),
    baselineGeneration = 0,
    log = console.log
  } = {}
) {
  if (!postGameInteractionWatchState) {
    return false;
  }
  postGameInteractionWatchState.active = true;
  postGameInteractionWatchState.firstNotPlayingAt = now;
  postGameInteractionWatchState.interactionBaselineGeneration = Math.max(
    0,
    Number(baselineGeneration ?? 0)
  );
  postGameInteractionWatchState.lastInteractionGenerationSeen =
    postGameInteractionWatchState.interactionBaselineGeneration;
  postGameInteractionWatchState.lastPollAt = 0;
  clearPostGameInteractionPending(postGameInteractionWatchState);
  if (typeof log === "function") {
    log(
      `[browser] post-game interaction watch started baseline=${postGameInteractionWatchState.interactionBaselineGeneration} first_not_playing_at=${now}`
    );
  }
  return true;
}

export function cancelPostGameInteractionWatch(
  postGameInteractionWatchState,
  {
    reason = "cancelled",
    log = console.log
  } = {}
) {
  if (!postGameInteractionWatchState?.active && !postGameInteractionWatchState?.pendingGeneration) {
    return false;
  }
  resetPostGameInteractionWatch(postGameInteractionWatchState);
  if (typeof log === "function") {
    log(`[browser] post-game interaction watch cancelled reason=${reason}`);
  }
  return true;
}

export function resetNextGameReacquireInteractionState(
  nextGameReacquireState,
  {
    baselineGeneration = 0
  } = {}
) {
  if (!nextGameReacquireState) {
    return null;
  }
  const normalizedBaseline = Math.max(0, Number(baselineGeneration ?? 0));
  nextGameReacquireState.interactionBaselineGeneration = normalizedBaseline;
  nextGameReacquireState.lastInteractionGenerationSeen = normalizedBaseline;
  nextGameReacquireState.lastInteractionGenerationHandled = normalizedBaseline;
  nextGameReacquireState.interactionWindowGeneration = 0;
  nextGameReacquireState.interactionWindowArmedAt = 0;
  nextGameReacquireState.pendingInteractionGeneration = 0;
  nextGameReacquireState.pendingInteractionTimestamp = 0;
  nextGameReacquireState.pendingInteractionSource = "";
  nextGameReacquireState.pendingArmReason = "";
  nextGameReacquireState.pendingInteractionType = "";
  nextGameReacquireState.pendingInteractionKey = "";
  nextGameReacquireState.pendingInteractionTargetTag = "";
  nextGameReacquireState.pendingInteractionTargetId = "";
  nextGameReacquireState.pendingInteractionTargetClass = "";
  nextGameReacquireState.pendingInteractionKind = "";
  nextGameReacquireState.provisionalInteractionGeneration = 0;
  nextGameReacquireState.provisionalInteractionTimestamp = 0;
  nextGameReacquireState.provisionalInteractionKey = "";
  nextGameReacquireState.provisionalInteractionTrusted = false;
  nextGameReacquireState.provisionalInteractionKind = "";
  nextGameReacquireState.provisionalTransitionReady = false;
  nextGameReacquireState.provisionalTransitionReadyLoggedAt = 0;
  return nextGameReacquireState;
}

export function setNextGameInteractionBaseline(
  nextGameReacquireState,
  interactionState = null
) {
  const generation = Math.max(
    0,
    Number(interactionState?.generation ?? interactionState ?? 0)
  );
  resetNextGameReacquireInteractionState(nextGameReacquireState, {
    baselineGeneration: generation
  });
  return generation;
}

export function createEndedGameCandidateState() {
  return {
    objectId: "",
    locator: "",
    epoch: 0,
    endedAt: 0,
    lastPlaying: false,
    lastPieceCounter: -1,
    lastSignature: "",
    releaseReason: ""
  };
}

export function startNextGameReacquire(
  nextGameReacquireState,
  {
    now = Date.now(),
    locator = "",
    epoch = null,
    interactionBaselineGeneration = 0,
    log = console.log
  } = {}
) {
  if (!nextGameReacquireState) {
    return false;
  }
  nextGameReacquireState.active = true;
  setNextGameInteractionPhase(
    nextGameReacquireState,
    NEXT_GAME_INTERACTION_PHASE_REACQUIRING
  );
  nextGameReacquireState.startedAt = now;
  nextGameReacquireState.lastFastAttemptAt = 0;
  nextGameReacquireState.lastFastMissLoggedAt = 0;
  nextGameReacquireState.lastEndedObjectCheckAt = 0;
  nextGameReacquireState.lastEndedObjectProbeStatus = "";
  nextGameReacquireState.lastEndedObjectProbeLogAt = 0;
  nextGameReacquireState.lastCheapSignalState = false;
  nextGameReacquireState.lastCheapSignalLogAt = 0;
  nextGameReacquireState.lastCheapSignalLabel = "";
  nextGameReacquireState.lastCheapSampledAt = 0;
  nextGameReacquireState.lastCheapAggregateState = "";
  resetNextGameReacquireInteractionState(nextGameReacquireState, {
    baselineGeneration: interactionBaselineGeneration
  });
  if (typeof log === "function") {
    const epochLabel = Number.isFinite(epoch) ? ` epoch=${epoch}` : "";
    const locatorLabel = locator ? ` locator=${locator}` : "";
    log(`[browser] next-game reacquire started${epochLabel}${locatorLabel}`);
  }
  return true;
}

export function cancelNextGameReacquire(
  nextGameReacquireState,
  {
    reason = "cancelled",
    log = console.log
  } = {}
) {
  if (!nextGameReacquireState?.active) {
    return false;
  }
  nextGameReacquireState.active = false;
  setNextGameInteractionPhase(
    nextGameReacquireState,
    NEXT_GAME_INTERACTION_PHASE_INACTIVE
  );
  nextGameReacquireState.startedAt = 0;
  nextGameReacquireState.lastFastAttemptAt = 0;
  nextGameReacquireState.lastEndedObjectCheckAt = 0;
  nextGameReacquireState.lastEndedObjectProbeStatus = "";
  nextGameReacquireState.lastEndedObjectProbeLogAt = 0;
  nextGameReacquireState.lastCheapSignalState = false;
  nextGameReacquireState.lastCheapSignalLogAt = 0;
  nextGameReacquireState.lastCheapSignalLabel = "";
  nextGameReacquireState.lastCheapSampledAt = 0;
  nextGameReacquireState.lastCheapAggregateState = "";
  resetNextGameReacquireInteractionState(nextGameReacquireState);
  if (typeof log === "function") {
    log(`[browser] next-game reacquire cancelled reason=${reason}`);
  }
  return true;
}

export function completeNextGameReacquire(
  nextGameReacquireState,
  {
    epoch = null,
    log = console.log
  } = {}
) {
  if (!nextGameReacquireState) {
    return false;
  }
  const wasActive = nextGameReacquireState.active;
  nextGameReacquireState.active = false;
  setNextGameInteractionPhase(
    nextGameReacquireState,
    NEXT_GAME_INTERACTION_PHASE_INACTIVE
  );
  nextGameReacquireState.startedAt = 0;
  nextGameReacquireState.lastFastAttemptAt = 0;
  nextGameReacquireState.lastEndedObjectCheckAt = 0;
  nextGameReacquireState.lastEndedObjectProbeStatus = "";
  nextGameReacquireState.lastEndedObjectProbeLogAt = 0;
  nextGameReacquireState.lastCheapSignalState = false;
  nextGameReacquireState.lastCheapSignalLogAt = 0;
  nextGameReacquireState.lastCheapSignalLabel = "";
  nextGameReacquireState.lastCheapSampledAt = 0;
  nextGameReacquireState.lastCheapAggregateState = "";
  resetNextGameReacquireInteractionState(nextGameReacquireState);
  if (wasActive && typeof log === "function" && Number.isFinite(epoch)) {
    log(`[browser] next-game reacquire completed epoch=${epoch}`);
  }
  return wasActive;
}

export function clearEndedGameCandidate(endedGameCandidate, reason = "") {
  if (!endedGameCandidate) {
    return "";
  }
  const previousObjectId = String(endedGameCandidate.objectId ?? "");
  endedGameCandidate.objectId = "";
  endedGameCandidate.locator = "";
  endedGameCandidate.epoch = 0;
  endedGameCandidate.endedAt = 0;
  endedGameCandidate.lastPlaying = false;
  endedGameCandidate.lastPieceCounter = -1;
  endedGameCandidate.lastSignature = "";
  endedGameCandidate.releaseReason = reason ? String(reason) : "";
  return previousObjectId;
}

export async function releaseEndedGameCandidateHandle(
  cdp,
  endedGameCandidate,
  {
    reason = "released",
    log = console.log
  } = {}
) {
  const objectId = clearEndedGameCandidate(endedGameCandidate, reason);
  if (!objectId || !cdp?.send) {
    return false;
  }
  await cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  await cdp.send("Runtime.releaseObjectGroup", {
    objectGroup: "fusion-ended-game"
  }).catch(() => undefined);
  if (typeof log === "function") {
    log(`[browser] ended game object released reason=${reason}`);
  }
  return true;
}

function createPausedScopeScanCursor() {
  return {
    frameIndex: 0,
    scopeIndex: 0,
    propertyIndex: 0,
    completedScopeKeys: [],
    seenCandidateKeys: []
  };
}

function clearPausedScopeScanCursor(closureCaptureState) {
  if (!closureCaptureState) {
    return false;
  }
  closureCaptureState.pausedScopeScanCursor = null;
  return true;
}

function resetClosureCaptureScanWindowState(
  closureCaptureState,
  { nextAttemptAt = 0, cursor = null } = {}
) {
  if (!closureCaptureState) {
    return false;
  }
  closureCaptureState.fullScanAttemptsInWindow = 0;
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 0;
  closureCaptureState.pausedScopeScanCursor = cursor;
  closureCaptureState.scanBudgetExhausted = false;
  closureCaptureState.fastLocatorAttempted = false;
  closureCaptureState.nextAttemptAt = nextAttemptAt;
  return true;
}

export function resetPausedScopeScanProgress(closureCaptureState) {
  if (!closureCaptureState) {
    return false;
  }
  closureCaptureState.cumulativePausedScanBudgetUsedMs = 0;
  clearPausedScopeScanCursor(closureCaptureState);
  closureCaptureState.scanBudgetExhausted = false;
  return true;
}

export function createGameStartSignalState() {
  return {
    generation: 0,
    latestKey: "",
    latestSource: "",
    latestSeenAt: 0,
    latestDetails: null,
    consumedKey: "",
    signals: []
  };
}

export function resetGameStartSignalState(gameStartSignalState) {
  if (!gameStartSignalState) {
    return false;
  }
  gameStartSignalState.generation = 0;
  gameStartSignalState.latestKey = "";
  gameStartSignalState.latestSource = "";
  gameStartSignalState.latestSeenAt = 0;
  gameStartSignalState.latestDetails = null;
  gameStartSignalState.consumedKey = "";
  gameStartSignalState.signals = [];
  return true;
}

function buildGameStartSignalKey(generation, source, baseKey) {
  return `${Math.max(0, Number(generation ?? 0))}:${String(source || "unknown")}:${String(baseKey || "")}`;
}

function refreshLatestGameStartSignalState(gameStartSignalState) {
  if (!gameStartSignalState) {
    return false;
  }
  const signals = Array.isArray(gameStartSignalState.signals)
    ? gameStartSignalState.signals
    : [];
  const latest = signals.at(-1) ?? null;
  gameStartSignalState.latestKey = latest?.key ?? "";
  gameStartSignalState.latestSource = latest?.source ?? "";
  gameStartSignalState.latestSeenAt = latest?.seenAt ?? 0;
  gameStartSignalState.latestDetails = latest?.details ?? null;
  return true;
}

export function advanceGameStartSignalGeneration(
  gameStartSignalState,
  { preserveSince = 0 } = {}
) {
  if (!gameStartSignalState) {
    return false;
  }
  const nextGeneration = Math.max(
    0,
    Number(gameStartSignalState.generation ?? 0)
  ) + 1;
  const nextSignals = [];
  for (const signal of Array.isArray(gameStartSignalState.signals)
    ? gameStartSignalState.signals
    : []) {
    if (Number(signal?.seenAt ?? 0) < preserveSince) {
      continue;
    }
    nextSignals.push({
      ...signal,
      generation: nextGeneration,
      key: buildGameStartSignalKey(
        nextGeneration,
        signal?.source ?? "unknown",
        signal?.baseKey ?? signal?.key ?? ""
      )
    });
  }
  gameStartSignalState.generation = nextGeneration;
  gameStartSignalState.consumedKey = "";
  gameStartSignalState.signals = nextSignals;
  refreshLatestGameStartSignalState(gameStartSignalState);
  return true;
}

export function noteGameStartSignal(
  gameStartSignalState,
  {
    key,
    source = "unknown",
    now = Date.now(),
    details = null
  } = {}
) {
  if (!gameStartSignalState || !key) {
    return false;
  }
  const normalizedBaseKey = String(key);
  const generation = Math.max(0, Number(gameStartSignalState.generation ?? 0));
  const normalizedKey = buildGameStartSignalKey(
    generation,
    source,
    normalizedBaseKey
  );
  if ((gameStartSignalState.signals ?? []).some((signal) => signal.key === normalizedKey)) {
    return false;
  }
  const nextSignal = {
    key: normalizedKey,
    baseKey: normalizedBaseKey,
    source: String(source || "unknown"),
    generation,
    seenAt: now,
    details: details ?? null
  };
  const signals = Array.isArray(gameStartSignalState.signals)
    ? gameStartSignalState.signals
    : [];
  signals.push(nextSignal);
  while (signals.length > MAX_GAME_START_SIGNALS) {
    signals.shift();
  }
  gameStartSignalState.signals = signals;
  refreshLatestGameStartSignalState(gameStartSignalState);
  return true;
}

function logSoloSignalCandidate(
  log,
  {
    source = "unknown",
    key = "",
    details = null
  } = {}
) {
  if (typeof log !== "function") {
    return;
  }
  log(
    `[browser] solo signal candidate type=${source} path=${source} seed=${String(
      details?.seed ?? "missing"
    )} bagtype=${String(details?.bagtype ?? "missing")} nextcount=${String(
      details?.nextCount ?? "missing"
    )} signature=${key || "missing"}`
  );
}

function noteSoloGameStartSignal(
  gameStartSignalState,
  {
    key,
    source = "unknown",
    now = Date.now(),
    details = null,
    log = console.log
  } = {}
) {
  logSoloSignalCandidate(log, { source, key, details });
  const queued = noteGameStartSignal(gameStartSignalState, {
    key,
    source,
    now,
    details
  });
  if (!queued) {
    if (typeof log === "function") {
      log(
        `[browser] solo signal ignored reason=duplicate_key signature=${String(key || "missing")}`
      );
    }
    return false;
  }
  if (typeof log === "function") {
    log(`[browser] solo signal queued key=${key} source=${source}`);
  }
  return true;
}

export function hasUnconsumedGameStartSignal(
  gameStartSignalState,
  { since = 0 } = {}
) {
  if (!Array.isArray(gameStartSignalState?.signals)) {
    return false;
  }
  return gameStartSignalState.signals.some((signal) => signal.seenAt >= since);
}

export function consumeGameStartSignal(
  gameStartSignalState,
  { since = 0 } = {}
) {
  if (!Array.isArray(gameStartSignalState?.signals)) {
    return null;
  }
  const index = gameStartSignalState.signals.findIndex((signal) => signal.seenAt >= since);
  if (index < 0) {
    return null;
  }
  const [signal] = gameStartSignalState.signals.splice(index, 1);
  gameStartSignalState.consumedKey = signal.key;
  return {
    key: signal.key,
    source: signal.source,
    seenAt: signal.seenAt,
    details: signal.details
  };
}

export function applyGameStartSignalToNetwork(
  network,
  signal,
  now = Date.now()
) {
  if (!network || !signal?.details || signal.details.seed === undefined || signal.details.seed === null) {
    return false;
  }
  network.seed = String(signal.details.seed);
  const nextCount = Number.parseInt(
    signal.details.nextCount ?? `${DEFAULT_NEXT_COUNT}`,
    10
  );
  network.nextCount = Number.isFinite(nextCount) && nextCount > 0
    ? nextCount
    : DEFAULT_NEXT_COUNT;
  const readyAt = Number(signal.details.readyAt);
  const countdownMs = Number(signal.details.countdownMs);
  if (Number.isFinite(readyAt) && readyAt > 0) {
    network.readyAt = readyAt;
  } else if (Number.isFinite(countdownMs) && countdownMs >= 0) {
    network.readyAt = now + countdownMs;
  } else {
    network.readyAt = 0;
  }
  return true;
}

export function isClosureCaptureArmed(
  closureCaptureState,
  now = Date.now()
) {
  return Boolean(closureCaptureState && closureCaptureState.armedUntil > now);
}

export function armClosureCaptureWindow(
  closureCaptureState,
  {
    reason = "gameplay_signal",
    now = Date.now(),
    windowMs = DEFAULT_CAPTURE_ARMING_WINDOW_MS,
    log = console.log,
    restartWindow = false
  } = {}
) {
  if (!closureCaptureState) {
    return false;
  }
  const nextUntil = now + Math.max(0, windowMs);
  const wasArmed = isClosureCaptureArmed(closureCaptureState, now);
  const reasonChanged = closureCaptureState.armedReason !== reason;
  closureCaptureState.armedUntil = restartWindow
    ? nextUntil
    : Math.max(closureCaptureState.armedUntil, nextUntil);
  closureCaptureState.armedReason = reason;
  closureCaptureState.lastSkippedLogAt = 0;
  closureCaptureState.firstAttemptLoggedForReason = "";
  if (!wasArmed || reasonChanged || restartWindow) {
    closureCaptureState.retryCount = 0;
    closureCaptureState.captureAttemptsInWindow = 0;
    resetClosureCaptureScanWindowState(closureCaptureState, {
      nextAttemptAt: now,
      cursor: createPausedScopeScanCursor()
    });
    closureCaptureState.windowSequence += 1;
  }
  if (!wasArmed || reasonChanged || restartWindow) {
    log(`[browser] closure capture armed reason=${reason}`);
    logClosureCaptureWindowInitialized(closureCaptureState, reason, log);
  }
  return true;
}

export function disarmClosureCaptureWindow(
  closureCaptureState,
  {
    reason = "gameplay_inactive",
    log = console.log,
    clearPending = false
  } = {}
) {
  if (!closureCaptureState) {
    return false;
  }
  const hadPending = Boolean(closureCaptureState.pendingCaptureArm);
  if (clearPending) {
    clearPendingClosureCaptureArm(closureCaptureState);
  }
  if (closureCaptureState.armedUntil === 0) {
    return hadPending;
  }
  closureCaptureState.armedUntil = 0;
  closureCaptureState.armedReason = "";
  closureCaptureState.lastSkippedLogAt = 0;
  closureCaptureState.nextAttemptAt = 0;
  closureCaptureState.retryCount = 0;
  closureCaptureState.firstAttemptLoggedForReason = "";
  closureCaptureState.captureAttemptsInWindow = 0;
  closureCaptureState.pendingFollowupFullScan = false;
  closureCaptureState.pendingFollowupFastCapture = false;
  closureCaptureState.windowArmedAt = 0;
  closureCaptureState.windowFirstInteractionAt = 0;
  closureCaptureState.windowTargetedProbeAt = 0;
  closureCaptureState.provisionalNonHeavyAttemptConsumed = false;
  resetClosureCaptureScanWindowState(closureCaptureState);
  log(`[browser] closure capture disarmed reason=${reason}`);
  return true;
}

export function clearPendingClosureCaptureArm(closureCaptureState) {
  if (!closureCaptureState?.pendingCaptureArm) {
    return false;
  }
  closureCaptureState.pendingCaptureArm = null;
  return true;
}

export function hasPendingClosureCaptureArm(closureCaptureState) {
  return Boolean(closureCaptureState?.pendingCaptureArm);
}

export function requestClosureCaptureArm(
  closureCaptureState,
  {
    reason = "gameplay_signal",
    now = Date.now(),
    bootstrapReady = true,
    windowMs = DEFAULT_CAPTURE_ARMING_WINDOW_MS,
    log = console.log
  } = {}
) {
  if (!closureCaptureState) {
    return false;
  }
  if (bootstrapReady) {
    clearPendingClosureCaptureArm(closureCaptureState);
    return armClosureCaptureWindow(closureCaptureState, {
      reason,
      now,
      windowMs,
      log
    });
  }
  if (!closureCaptureState.pendingCaptureArm) {
    closureCaptureState.pendingCaptureArm = {
      reason,
      requestedAt: now
    };
    log(`[browser] closure capture pending reason=${reason} bootstrap_not_ready`);
    return true;
  }
  return false;
}

export function activatePendingClosureCaptureArm(
  closureCaptureState,
  {
    now = Date.now(),
    windowMs = DEFAULT_CAPTURE_ARMING_WINDOW_MS,
    log = console.log
  } = {}
) {
  const pending = closureCaptureState?.pendingCaptureArm;
  if (!pending) {
    return false;
  }
  clearPendingClosureCaptureArm(closureCaptureState);
  log(`[browser] bootstrap ready; activating pending arm reason=${pending.reason}`);
  return armClosureCaptureWindow(closureCaptureState, {
    reason: `${pending.reason}_after_bootstrap`,
    now,
    windowMs,
    log,
    restartWindow: true
  });
}

export function reactivateClosureCaptureArmAfterBootstrap(
  closureCaptureState,
  {
    now = Date.now(),
    windowMs = DEFAULT_CAPTURE_ARMING_WINDOW_MS,
    log = console.log
  } = {}
) {
  if (!closureCaptureState || closureCaptureState.armedUntil === 0) {
    return false;
  }
  const baseReason = String(closureCaptureState.armedReason || "gameplay_signal");
  const nextReason = baseReason.endsWith("_after_bootstrap")
    ? baseReason
    : `${baseReason}_after_bootstrap`;
  return armClosureCaptureWindow(closureCaptureState, {
    reason: nextReason,
    now,
    windowMs,
    log,
    restartWindow: true
  });
}

export function deriveGameplayPhase(state) {
  if (state?.playing === true) {
    return "playing";
  }
  if (state?.countdown === true) {
    return "countdown";
  }
  return "inactive";
}

export function isGameplayExpectedForClosureCapture({
  state,
  activeRoundId = "",
  closureCaptureState = null,
  carriedInteractionExpected = false,
  now = Date.now()
}) {
  return Boolean(
    activeRoundId ||
      carriedInteractionExpected ||
      state?.countdown === true ||
      state?.playing === true ||
      isClosureCaptureArmed(closureCaptureState, now)
  );
}

function hasUnhandledCarriedPostGameInteraction(nextGameReacquireState) {
  if (!nextGameReacquireState?.active) {
    return false;
  }
  const pendingGeneration = Math.max(
    0,
    Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)
  );
  const handledGeneration = Math.max(
    0,
    Number(nextGameReacquireState.lastInteractionGenerationHandled ?? 0)
  );
  return (
    nextGameReacquireState.interactionPhase ===
      NEXT_GAME_INTERACTION_PHASE_REACQUIRING &&
    String(nextGameReacquireState.pendingInteractionSource ?? "") === "post_game" &&
    pendingGeneration > handledGeneration
  );
}

function isProvisionalClosureCaptureReason(reason = "") {
  return String(reason ?? "").startsWith("next_game_provisional_interaction");
}

function isCarriedClosureCaptureReason(reason = "") {
  return String(reason ?? "").startsWith("next_game_carried_interaction");
}

export function shouldLogClosureCaptureSkipped({
  gameplayExpected,
  lastSkippedLogAt = 0,
  now = Date.now(),
  intervalMs = DEFAULT_CAPTURE_SKIP_LOG_INTERVAL_MS
}) {
  return !gameplayExpected && now - lastSkippedLogAt >= intervalMs;
}

export function createBrowserControlState() {
  return {
    botEnabled: false
  };
}

export function createSessionModeState() {
  return {
    mode: SESSION_MODE_CLOSURE_CAPTURE,
    selectedGameId: "",
    selectedSignature: "",
    orphanSignature: "",
    staleSnapshotClearedAt: 0,
    selectedLoggedAt: 0,
    suppressionLoggedAt: 0
  };
}

export function selectVsWsShadowMode(
  sessionModeState,
  {
    gameId,
    signature,
    closureCaptureState = null,
    log = console.log
  }
) {
  if (!sessionModeState || !gameId) {
    return false;
  }
  const nextGameId = String(gameId);
  if (
    sessionModeState.mode === SESSION_MODE_VS_WS_SHADOW &&
    sessionModeState.selectedGameId === nextGameId &&
    sessionModeState.selectedSignature === String(signature ?? "")
  ) {
    return false;
  }
  sessionModeState.mode = SESSION_MODE_VS_WS_SHADOW;
  sessionModeState.selectedGameId = nextGameId;
  sessionModeState.selectedSignature = String(signature ?? "");
  sessionModeState.selectedLoggedAt = Date.now();
  if (closureCaptureState) {
    const hadPending = Boolean(closureCaptureState.pendingCaptureArm);
    const disarmed = disarmClosureCaptureWindow(closureCaptureState, {
      reason: "vs_ws_shadow_selected",
      log,
      clearPending: true
    });
    if (!disarmed && hadPending && typeof log === "function") {
      log("[browser] closure capture disarmed reason=vs_ws_shadow_selected");
    }
  }
  log(`[browser] VS WebSocket shadow mode selected gameid=${nextGameId}`);
  log("[browser] closure capture suppressed for VS WebSocket session");
  return true;
}

function resetSessionModeState(sessionModeState) {
  if (!sessionModeState) {
    return;
  }
  sessionModeState.mode = SESSION_MODE_CLOSURE_CAPTURE;
  sessionModeState.selectedGameId = "";
  sessionModeState.selectedSignature = "";
  sessionModeState.orphanSignature = "";
  sessionModeState.staleSnapshotClearedAt = 0;
  sessionModeState.selectedLoggedAt = 0;
  sessionModeState.suppressionLoggedAt = 0;
}

export function handleDddGameOptions({
  sessionModeState,
  gameStartSignalState,
  closureCaptureState = null,
  signature,
  options,
  capturedAt,
  log = console.log
}) {
  const now = Number.isFinite(capturedAt) ? capturedAt : Date.now();
  const countdownMs = estimateCountdownWait(options);
  const hasGameId =
    options?.gameid !== undefined && options?.gameid !== null && options?.gameid !== "";
  if (hasGameId) {
    return {
      classification: "vs",
      selectedVsShadow: selectVsWsShadowMode(sessionModeState, {
        gameId: options.gameid,
        signature,
        closureCaptureState,
        log
      }),
      queuedSolo: false
    };
  }
  if (sessionModeState?.mode === SESSION_MODE_VS_WS_SHADOW) {
    if (signature && sessionModeState.orphanSignature !== signature) {
      sessionModeState.orphanSignature = signature;
      log(
        `[browser] orphan multiplayer options ignored seed=${String(options?.seed ?? "missing")} gameid=missing`
      );
    }
    return {
      classification: "orphan_ignored",
      selectedVsShadow: false,
      queuedSolo: false
    };
  }
  return {
    classification: "solo",
    selectedVsShadow: false,
    queuedSolo: noteSoloGameStartSignal(gameStartSignalState, {
      key: `ddd:${signature}`,
      source: "ddd_game_options",
      now,
      log,
      details: {
        seed: options?.seed ?? null,
        bagtype: options?.bagtype ?? null,
        gameid: options?.gameid ?? null,
        nextCount: options?.nextcount ?? DEFAULT_NEXT_COUNT,
        countdownMs,
        readyAt: now + countdownMs
      }
    })
  };
}

export function resetClosureCaptureLocatorHint(closureCaptureState) {
  if (!closureCaptureState) {
    return false;
  }
  closureCaptureState.lastSuccessfulLocator = "";
  closureCaptureState.lastSuccessfulPausedLocation = null;
  return true;
}

function shouldAttemptNextGameFastLocator(
  nextGameReacquireState,
  now = Date.now(),
  intervalMs = DEFAULT_NEXT_GAME_FAST_LOCATOR_INTERVAL_MS
) {
  if (!nextGameReacquireState?.active) {
    return false;
  }
  return now - Number(nextGameReacquireState.lastFastAttemptAt ?? 0) >= intervalMs;
}

function shouldLogNextGameFastLocatorMiss(
  nextGameReacquireState,
  now = Date.now(),
  intervalMs = DEFAULT_NEXT_GAME_FAST_LOCATOR_MISS_LOG_INTERVAL_MS
) {
  if (!nextGameReacquireState) {
    return false;
  }
  return now - Number(nextGameReacquireState.lastFastMissLoggedAt ?? 0) >= intervalMs;
}

function shouldLogReacquireStatus(
  previousStatus,
  nextStatus,
  lastLoggedAt,
  now = Date.now(),
  intervalMs = DEFAULT_NEXT_GAME_FAST_LOCATOR_MISS_LOG_INTERVAL_MS
) {
  return previousStatus !== nextStatus || now - Number(lastLoggedAt ?? 0) >= intervalMs;
}

export function nextGameInteractionTrackerExpression() {
  return `(() => {
    try {
      if (window.__fusionNextGameInteractionTrackerInstalled) {
        return { ok: true, installed: true, deduped: true };
      }
      const state = window.__fusionNextGameInteraction = window.__fusionNextGameInteraction || {
        generation: 0,
        type: null,
        key: null,
        interactionKind: null,
        timestamp: 0,
        targetTag: null,
        targetId: null,
        targetClass: null
      };
      const capture = (event) => {
        try {
          const type = String(event?.type || "");
          if (!type) return;
          if (type === "keydown") {
            if (event?.repeat === true) {
              return;
            }
            const key = String(event?.key || "");
            if (!["Enter", " ", "Spacebar", "Space", "r", "R"].includes(key)) {
              return;
            }
          }
          const now = Date.now();
          if (
            now - Number(state.timestamp || 0) <= ${DEFAULT_NEXT_GAME_INTERACTION_BURST_DEDUPE_MS} &&
            (
              (type === "click" && state.type === "pointerup") ||
              (type === "click" && state.type === "pointerdown") ||
              (type === "pointerup" && state.type === "click") ||
              (type === "pointerup" && state.type === "pointerdown") ||
              (type === "pointerdown" && state.type === "pointerup") ||
              (type === "pointerdown" && state.type === "click") ||
              type === state.type
            )
          ) {
            state.timestamp = now;
            return;
          }
          const target = event?.target && typeof event.target === "object" ? event.target : null;
          const targetTag = String(target?.tagName || "");
          const targetId = String(target?.id || "");
          let interactionKind = "other";
          if ((type === "pointerdown" || type === "click") && targetTag === "DIV" && targetId === "start_results") {
            interactionKind = "again_button";
          } else if (type === "keydown" && (String(event?.key || "") === "r" || String(event?.key || "") === "R")) {
            interactionKind = "restart_key";
          }
          state.generation = Math.max(0, Number(state.generation || 0)) + 1;
          state.type = type;
          state.key = type === "keydown" ? String(event?.key || "") : null;
          state.interactionKind = interactionKind;
          state.timestamp = now;
          state.targetTag = targetTag;
          state.targetId = targetId;
          state.targetClass =
            typeof target?.className === "string" ? target.className : "";
        } catch {}
      };
      document.addEventListener("pointerdown", capture, true);
      document.addEventListener("click", capture, true);
      document.addEventListener("pointerup", capture, true);
      document.addEventListener("keydown", capture, true);
      window.__fusionNextGameInteractionTrackerInstalled = true;
      return { ok: true, installed: true, deduped: false };
    } catch (error) {
      return { ok: false, reason: String(error?.message || error || "install_failed") };
    }
  })()`;
}

export function createInteractionTrackerInstallState() {
  return {
    futureDocumentsRegistered: false,
    currentDocumentInstalls: 0
  };
}

export async function registerNextGameInteractionTrackerForFutureDocuments(
  cdp
) {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: nextGameInteractionTrackerExpression()
  }).catch(() => undefined);
  return true;
}

export async function installNextGameInteractionTracker(
  cdp,
  {
    transientState = null,
    log = console.log
  } = {}
) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: nextGameInteractionTrackerExpression(),
    returnByValue: true
  }, {
    result: {
      value: { ok: false, reason: "install_failed" }
    }
  }, {
    transientState,
    log
  });
  return raw?.result?.value ?? { ok: false, reason: "install_failed" };
}

export async function ensureNextGameInteractionTrackerInstalled(
  cdp,
  interactionTrackerInstallState,
  {
    transientState = null,
    log = console.log
  } = {}
) {
  if (!interactionTrackerInstallState?.futureDocumentsRegistered) {
    await registerNextGameInteractionTrackerForFutureDocuments(cdp);
    if (interactionTrackerInstallState) {
      interactionTrackerInstallState.futureDocumentsRegistered = true;
    }
  }
  if (interactionTrackerInstallState) {
    interactionTrackerInstallState.currentDocumentInstalls = Math.max(
      0,
      Number(interactionTrackerInstallState.currentDocumentInstalls ?? 0)
    ) + 1;
  }
  return installNextGameInteractionTracker(cdp, {
    transientState,
    log
  });
}

function nextGameInteractionStateExpression() {
  return `(() => {
    const state = window.__fusionNextGameInteraction || null;
    return {
      generation: Math.max(0, Number(state?.generation || 0)),
      type: state?.type || null,
      key: state?.key || null,
      interactionKind: state?.interactionKind || null,
      timestamp: Math.max(0, Number(state?.timestamp || 0)),
      targetTag: state?.targetTag || null,
      targetId: state?.targetId || null,
      targetClass: state?.targetClass || null
    };
  })()`;
}

export async function readNextGameInteractionState(
  cdp,
  {
    transientState = null,
    log = console.log
  } = {}
) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: nextGameInteractionStateExpression(),
    returnByValue: true
  }, {
    result: {
      value: {
        generation: 0,
        type: null,
        key: null,
        interactionKind: null,
        timestamp: 0,
        targetTag: null,
        targetId: null,
        targetClass: null
      }
    }
  }, {
    transientState,
    log
  });
  return raw?.result?.value ?? {
    generation: 0,
    type: null,
    key: null,
    interactionKind: null,
    timestamp: 0,
    targetTag: null,
    targetId: null,
    targetClass: null
  };
}

export async function primeNextGameInteractionBaseline(
  cdp,
  nextGameReacquireState,
  {
    transientState = null,
    log = console.log,
    readNextGameInteractionStateFn = readNextGameInteractionState
  } = {}
) {
  const interaction = await readNextGameInteractionStateFn(cdp, {
    transientState,
    log
  }).catch(() => ({
    generation: 0
  }));
  const baselineGeneration = setNextGameInteractionBaseline(
    nextGameReacquireState,
    interaction
  );
  if (typeof log === "function") {
    log(`[browser] next-game interaction baseline generation=${baselineGeneration}`);
  }
  return baselineGeneration;
}

export async function primePostGameInteractionWatchBaseline(
  cdp,
  postGameInteractionWatchState,
  {
    now = Date.now(),
    transientState = null,
    log = console.log,
    readNextGameInteractionStateFn = readNextGameInteractionState,
    nextGameReacquireState = null
  } = {}
) {
  const interaction = await readNextGameInteractionStateFn(cdp, {
    transientState,
    log
  }).catch(() => ({
    generation: 0
  }));
  const baselineGeneration = Math.max(
    0,
    Number(interaction?.generation ?? 0)
  );
  startPostGameInteractionWatch(postGameInteractionWatchState, {
    now,
    baselineGeneration,
    log
  });
  setNextGameInteractionPhase(
    nextGameReacquireState,
    NEXT_GAME_INTERACTION_PHASE_POST_GAME_WATCH
  );
  return baselineGeneration;
}

function rememberPendingNextGameInteraction(
  nextGameReacquireState,
  interaction = null
) {
  if (!nextGameReacquireState) {
    return false;
  }
  const generation = Math.max(0, Number(interaction?.generation ?? 0));
  if (
    generation <= 0 ||
    generation <= Math.max(0, Number(nextGameReacquireState.pendingInteractionGeneration ?? 0))
  ) {
    return false;
  }
  nextGameReacquireState.pendingInteractionGeneration = generation;
  nextGameReacquireState.pendingInteractionTimestamp = Math.max(
    0,
    Number(interaction?.timestamp ?? 0)
  );
  nextGameReacquireState.pendingInteractionSource = "rearm";
  nextGameReacquireState.pendingArmReason = "";
  nextGameReacquireState.pendingInteractionType = String(interaction?.type ?? "");
  nextGameReacquireState.pendingInteractionKey = String(interaction?.key ?? "");
  nextGameReacquireState.pendingInteractionKind = deriveInteractionKind(interaction);
  nextGameReacquireState.pendingInteractionTargetTag = String(
    interaction?.targetTag ?? ""
  );
  nextGameReacquireState.pendingInteractionTargetId = String(
    interaction?.targetId ?? ""
  );
  nextGameReacquireState.pendingInteractionTargetClass = String(
    interaction?.targetClass ?? ""
  );
  return true;
}

function clearPendingNextGameInteraction(nextGameReacquireState) {
  if (!nextGameReacquireState) {
    return false;
  }
  nextGameReacquireState.pendingInteractionGeneration = 0;
  nextGameReacquireState.pendingInteractionTimestamp = 0;
  nextGameReacquireState.pendingInteractionSource = "";
  nextGameReacquireState.pendingArmReason = "";
  nextGameReacquireState.pendingInteractionType = "";
  nextGameReacquireState.pendingInteractionKey = "";
  nextGameReacquireState.pendingInteractionKind = "";
  nextGameReacquireState.pendingInteractionTargetTag = "";
  nextGameReacquireState.pendingInteractionTargetId = "";
  nextGameReacquireState.pendingInteractionTargetClass = "";
  return true;
}

function rememberPendingPostGameInteraction(
  postGameInteractionWatchState,
  interaction = null
) {
  if (!postGameInteractionWatchState?.active) {
    return false;
  }
  const generation = Math.max(0, Number(interaction?.generation ?? 0));
  const timestamp = Math.max(0, Number(interaction?.timestamp ?? 0));
  if (
    generation <= Math.max(0, Number(postGameInteractionWatchState.interactionBaselineGeneration ?? 0)) ||
    generation <= Math.max(0, Number(postGameInteractionWatchState.pendingGeneration ?? 0)) ||
    timestamp <= Math.max(0, Number(postGameInteractionWatchState.firstNotPlayingAt ?? 0))
  ) {
    return false;
  }
  postGameInteractionWatchState.pendingGeneration = generation;
  postGameInteractionWatchState.pendingTimestamp = timestamp;
  postGameInteractionWatchState.pendingType = String(interaction?.type ?? "");
  postGameInteractionWatchState.pendingKey = String(interaction?.key ?? "");
  postGameInteractionWatchState.pendingTargetTag = String(interaction?.targetTag ?? "");
  postGameInteractionWatchState.pendingTargetId = String(interaction?.targetId ?? "");
  postGameInteractionWatchState.pendingTargetClass = String(interaction?.targetClass ?? "");
  return true;
}

function isTrustedNextGameInteraction(interaction = null) {
  const kind = deriveInteractionKind(interaction);
  return kind === "again_button" || kind === "restart_key";
}

function deriveInteractionKind(interaction = null) {
  const type = String(interaction?.type ?? "");
  const key = String(interaction?.key ?? "");
  const targetTag = String(interaction?.targetTag ?? "").toUpperCase();
  const targetId = String(interaction?.targetId ?? "");
  if ((type === "pointerdown" || type === "click") && targetTag === "DIV" && targetId === "start_results") {
    return "again_button";
  }
  if (type === "keydown" && (key === "r" || key === "R")) {
    return "restart_key";
  }
  return "other";
}

function recordProvisionalInteraction(
  nextGameReacquireState,
  interaction = null
) {
  if (!nextGameReacquireState) {
    return false;
  }
  const generation = Math.max(0, Number(interaction?.generation ?? 0));
  if (generation <= 0) {
    return false;
  }
  nextGameReacquireState.provisionalInteractionGeneration = generation;
  nextGameReacquireState.provisionalInteractionTimestamp = Math.max(
    0,
    Number(interaction?.timestamp ?? 0)
  );
  nextGameReacquireState.provisionalInteractionKey = String(interaction?.key ?? "");
  nextGameReacquireState.provisionalInteractionTrusted = true;
  nextGameReacquireState.provisionalInteractionKind = deriveInteractionKind(interaction);
  nextGameReacquireState.provisionalTransitionReady = false;
  nextGameReacquireState.provisionalTransitionReadyLoggedAt = 0;
  return true;
}

function isAgainButtonProvisionalInteraction(nextGameReacquireState) {
  return (
    nextGameReacquireState?.provisionalInteractionTrusted === true &&
    String(nextGameReacquireState?.provisionalInteractionKind ?? "") === "again_button"
  );
}

function isTransitionReadyForAgainProvisional(cheapSignal = null) {
  const sources = Array.isArray(cheapSignal?.sources) ? cheapSignal.sources : [];
  const byName = new Map(
    sources.map((entry) => [String(entry?.source ?? ""), Boolean(entry?.value)])
  );
  const resultHidden = byName.get("result_dom") === false;
  const countdownVisible = byName.get("countdown_dom") === true;
  const gameplayVisible = byName.get("gameplay_dom") === true;
  const routeGame = byName.get("route_game") === true;
  if (countdownVisible || gameplayVisible) {
    return true;
  }
  return resultHidden && routeGame;
}

export function carryPendingPostGameInteractionIntoReacquire(
  postGameInteractionWatchState,
  nextGameReacquireState,
  {
    log = console.log
  } = {}
) {
  if (
    !postGameInteractionWatchState ||
    !nextGameReacquireState ||
    Math.max(0, Number(postGameInteractionWatchState.pendingGeneration ?? 0)) <= 0
  ) {
    return false;
  }
  nextGameReacquireState.lastInteractionGenerationSeen = Math.max(
    Math.max(0, Number(nextGameReacquireState.lastInteractionGenerationSeen ?? 0)),
    Math.max(0, Number(postGameInteractionWatchState.pendingGeneration ?? 0))
  );
  nextGameReacquireState.pendingInteractionGeneration = Math.max(
    0,
    Number(postGameInteractionWatchState.pendingGeneration ?? 0)
  );
  nextGameReacquireState.pendingInteractionTimestamp = Math.max(
    0,
    Number(postGameInteractionWatchState.pendingTimestamp ?? 0)
  );
  nextGameReacquireState.pendingInteractionSource = "post_game";
  nextGameReacquireState.pendingArmReason = "";
  nextGameReacquireState.pendingInteractionType = String(
    postGameInteractionWatchState.pendingType ?? ""
  );
  nextGameReacquireState.pendingInteractionKey = String(
    postGameInteractionWatchState.pendingKey ?? ""
  );
  nextGameReacquireState.pendingInteractionKind = deriveInteractionKind({
    type: postGameInteractionWatchState.pendingType,
    key: postGameInteractionWatchState.pendingKey,
    targetTag: postGameInteractionWatchState.pendingTargetTag,
    targetId: postGameInteractionWatchState.pendingTargetId
  });
  nextGameReacquireState.pendingInteractionTargetTag = String(
    postGameInteractionWatchState.pendingTargetTag ?? ""
  );
  nextGameReacquireState.pendingInteractionTargetId = String(
    postGameInteractionWatchState.pendingTargetId ?? ""
  );
  nextGameReacquireState.pendingInteractionTargetClass = String(
    postGameInteractionWatchState.pendingTargetClass ?? ""
  );
  if (typeof log === "function") {
    log(
      `[browser] pending post-game interaction carried into reacquire generation=${nextGameReacquireState.pendingInteractionGeneration}`
    );
  }
  return true;
}

function armNextGameInteractionWindow(
  closureCaptureState,
  nextGameReacquireState,
  {
    generation = 0,
    now = Date.now(),
    bootstrapReady = true,
    armReason = "next_game_user_interaction",
    log = console.log
  } = {}
) {
  if (
    nextGameReacquireState?.interactionPhase !== NEXT_GAME_INTERACTION_PHASE_REACQUIRING
  ) {
    return false;
  }
  if (
    nextGameReacquireState?.interactionWindowGeneration === generation &&
    isClosureCaptureArmed(closureCaptureState, now) &&
    (
      closureCaptureState?.armedReason === "next_game_user_interaction" ||
      closureCaptureState?.armedReason === "next_game_carried_interaction"
    )
  ) {
    return false;
  }
  initializeFreshClosureCaptureWindow(closureCaptureState, {
    reason: armReason,
    log
  });
  const armed = requestClosureCaptureArm(closureCaptureState, {
    reason: armReason,
    now,
    bootstrapReady,
    log: () => {}
  });
  if (!armed) {
    return false;
  }
  const initialDelayMs =
    isProvisionalClosureCaptureReason(armReason)
      ? DEFAULT_TARGETED_PAUSED_PROBE_DELAY_MS
      : armReason === "bot_on"
        ? 600
        : DEFAULT_NEXT_GAME_INTERACTION_CAPTURE_DELAY_MS;
  closureCaptureState.nextAttemptAt = now + initialDelayMs;
  closureCaptureState.windowArmedAt = now;
  if (nextGameReacquireState) {
    nextGameReacquireState.interactionWindowGeneration = generation;
    nextGameReacquireState.interactionWindowArmedAt = now;
    setNextGameInteractionPhase(
      nextGameReacquireState,
      NEXT_GAME_INTERACTION_PHASE_CAPTURE_ARMED
    );
  }
  if (typeof log === "function") {
    log(
      `[browser] closure capture armed reason=${armReason} generation=${generation}`
    );
    logClosureCaptureWindowInitialized(closureCaptureState, armReason, log);
  }
  return true;
}

function consumeNextGameInteractionWindow(
  closureCaptureState,
  nextGameReacquireState,
  {
    reason = "completed",
    log = console.log
  } = {}
) {
  if (!nextGameReacquireState) {
    return false;
  }
  const generation = Math.max(
    0,
    Number(nextGameReacquireState.interactionWindowGeneration ?? 0)
  );
  const armedReason = String(closureCaptureState?.armedReason ?? "");
  const isCarriedWindow = isCarriedClosureCaptureReason(armedReason);
  if (generation > 0) {
    nextGameReacquireState.lastInteractionGenerationHandled = Math.max(
      Math.max(0, Number(nextGameReacquireState.lastInteractionGenerationHandled ?? 0)),
      generation
    );
  }
  if (
    generation > 0 &&
    Math.max(0, Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)) === generation
  ) {
    clearPendingNextGameInteraction(nextGameReacquireState);
  }
  nextGameReacquireState.pendingArmReason = "";
  nextGameReacquireState.interactionWindowGeneration = 0;
  nextGameReacquireState.interactionWindowArmedAt = 0;
  if (
    nextGameReacquireState.interactionPhase ===
    NEXT_GAME_INTERACTION_PHASE_CAPTURE_ARMED
  ) {
    setNextGameInteractionPhase(
      nextGameReacquireState,
      NEXT_GAME_INTERACTION_PHASE_REACQUIRING
    );
  }
  if (typeof log === "function" && generation > 0 && reason === "scan_budget_exhausted") {
    if (isCarriedWindow) {
      log(`[browser] carried interaction capture exhausted generation=${generation}`);
    }
    log("[browser] waiting for fresh next-game interaction after capture exhaustion");
  }
  return generation > 0;
}

function armPendingNextGameInteractionWindow(
  closureCaptureState,
  nextGameReacquireState,
  {
    now = Date.now(),
    bootstrapReady = true,
    log = console.log,
    logPrefix = "",
    armReason = ""
  } = {}
) {
  if (
    !nextGameReacquireState ||
    nextGameReacquireState.interactionPhase !== NEXT_GAME_INTERACTION_PHASE_REACQUIRING
  ) {
    return false;
  }
  const pendingGeneration = Math.max(
    0,
    Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)
  );
  const pendingSource = String(nextGameReacquireState.pendingInteractionSource ?? "");
  if (
    pendingGeneration <=
      Math.max(0, Number(nextGameReacquireState.lastInteractionGenerationHandled ?? 0)) ||
    Math.max(0, Number(nextGameReacquireState.pendingInteractionTimestamp ?? 0)) <=
      Math.max(0, Number(nextGameReacquireState.startedAt ?? 0))
  ) {
    return { armed: false, reason: "already_handled_or_stale" };
  }
  if (!bootstrapReady) {
    nextGameReacquireState.pendingArmReason =
      armReason || (
        pendingSource === "post_game"
          ? "next_game_carried_interaction"
          : "next_game_user_interaction"
      );
    if (typeof log === "function") {
      log(
        `[browser] carried interaction arm deferred generation=${pendingGeneration} reason=bootstrap_not_ready`
      );
    }
    return { armed: false, reason: "bootstrap_not_ready" };
  }
  const armed = armNextGameInteractionWindow(
    closureCaptureState,
    nextGameReacquireState,
    {
      generation: pendingGeneration,
      now,
      bootstrapReady,
      armReason:
        armReason || (
          pendingSource === "post_game"
            ? "next_game_carried_interaction"
            : "next_game_user_interaction"
        ),
      log
    }
  );
  if (!armed) {
    if (typeof log === "function") {
      log(
        `[browser] carried interaction arm blocked generation=${pendingGeneration} reason=arm_request_rejected`
      );
    }
    return { armed: false, reason: "arm_request_rejected" };
  }
  nextGameReacquireState.lastInteractionGenerationHandled = pendingGeneration;
  nextGameReacquireState.pendingArmReason = "";
  clearPendingNextGameInteraction(nextGameReacquireState);
  if (typeof log === "function") {
    const nextLogPrefix = logPrefix || (
      pendingSource === "post_game"
        ? "carried interaction armed"
        : "closure capture armed reason=next_game_user_interaction"
    );
    log(`[browser] ${nextLogPrefix} generation=${pendingGeneration}`);
  }
  return { armed: true, reason: "armed" };
}

export function expireClosureCaptureWindow(
  closureCaptureState,
  now = Date.now(),
  { log = null } = {}
) {
  if (!closureCaptureState || closureCaptureState.armedUntil === 0) {
    return false;
  }
  if (closureCaptureState.armedUntil > now) {
    return false;
  }
  const previousReason = closureCaptureState.armedReason || "gameplay_signal";
  closureCaptureState.armedUntil = 0;
  closureCaptureState.armedReason = "";
  closureCaptureState.lastSkippedLogAt = 0;
  closureCaptureState.nextAttemptAt = 0;
  closureCaptureState.retryCount = 0;
  closureCaptureState.firstAttemptLoggedForReason = "";
  closureCaptureState.captureAttemptsInWindow = 0;
  resetClosureCaptureScanWindowState(closureCaptureState);
  if (typeof log === "function") {
    log(
      `[browser] closure capture disarmed reason=window_expired previous_reason=${previousReason}`
    );
  }
  return true;
}

function isClosureCaptureWindowExhausted(closureCaptureState) {
  if (!closureCaptureState) {
    return false;
  }
  return Boolean(
    closureCaptureState.scanBudgetExhausted === true ||
      Math.max(0, Number(closureCaptureState.fullScanAttemptsInWindow ?? 0)) >=
        MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW
  );
}

export function scheduleNextClosureCaptureAttempt(
  closureCaptureState,
  now = Date.now(),
  retryScheduleMs = DEFAULT_CAPTURE_RETRY_SCHEDULE_MS
) {
  if (!closureCaptureState) {
    return 0;
  }
  const index = Math.min(
    closureCaptureState.retryCount,
    Math.max(0, retryScheduleMs.length - 1)
  );
  const delayMs = Math.max(0, retryScheduleMs[index] ?? DEFAULT_CAPTURE_COOLDOWN_MS);
  closureCaptureState.retryCount += 1;
  closureCaptureState.nextAttemptAt = now + delayMs;
  return delayMs;
}

export function scheduleClosureCaptureContinuation(
  closureCaptureState,
  now = Date.now(),
  delayMs = DEFAULT_FULL_SCAN_CONTINUATION_BACKOFF_MS
) {
  if (!closureCaptureState) {
    return 0;
  }
  const nextDelayMs = Math.max(0, delayMs);
  closureCaptureState.nextAttemptAt = now + nextDelayMs;
  return nextDelayMs;
}

function saveClosureCaptureContinuationCursor(
  closureCaptureState,
  resumeCursor,
  log = console.log
) {
  if (!closureCaptureState || !resumeCursor) {
    return false;
  }
  closureCaptureState.pausedScopeScanCursor = {
    frameIndex: Math.max(0, Number(resumeCursor.frameIndex ?? 0)),
    scopeIndex: Math.max(0, Number(resumeCursor.scopeIndex ?? 0)),
    propertyIndex: Math.max(
      0,
      Number(resumeCursor.propertyIndex ?? resumeCursor.candidateIndex ?? 0)
    ),
    completedScopeKeys: Array.from(closureCaptureState.pausedScopeScanCursor?.completedScopeKeys ?? []),
    seenCandidateKeys: Array.from(closureCaptureState.pausedScopeScanCursor?.seenCandidateKeys ?? [])
  };
  if (typeof log === "function") {
    log(
      `[browser] full closure scan continuation saved cursor=${formatClosureCaptureCursorLabel(
        closureCaptureState.pausedScopeScanCursor
      )}`
    );
  }
  return true;
}

function formatScanCursor(cursor = null) {
  return {
    frameIndex: Math.max(0, Number(cursor?.frameIndex ?? 0)),
    scopeIndex: Math.max(0, Number(cursor?.scopeIndex ?? 0)),
    candidateIndex: Math.max(
      0,
      Number(cursor?.candidateIndex ?? cursor?.propertyIndex ?? 0)
    )
  };
}

function formatClosureCaptureCursorLabel(cursor = null) {
  if (!cursor) {
    return "none";
  }
  const formatted = formatScanCursor(cursor);
  return `${formatted.frameIndex}:${formatted.scopeIndex}:${formatted.candidateIndex}`;
}

function getPausedScopeScanFrameOrder(callFrames = []) {
  return Array.from({ length: callFrames.length }, (_, index) => callFrames.length - 1 - index);
}

function nextPausedScopeScanFrameIndex(callFrames = [], frameIndex = 0) {
  const order = getPausedScopeScanFrameOrder(callFrames);
  const currentOrderIndex = order.indexOf(frameIndex);
  if (currentOrderIndex < 0) {
    return null;
  }
  return order[currentOrderIndex + 1] ?? null;
}

function computePausedScopeScanResumeCursor(
  callFrames = [],
  {
    frameIndex = 0,
    scopeIndex = 0,
    propertyIndex = 0,
    descriptorsLength = 0,
    advancePastCurrentProperty = false
  } = {}
) {
  const currentFrame = callFrames[frameIndex];
  const currentScopeChain = currentFrame?.scopeChain ?? [];
  const currentPropertyIndex =
    Math.max(0, Number(propertyIndex ?? 0)) + (advancePastCurrentProperty ? 1 : 0);
  if (currentPropertyIndex < Math.max(0, Number(descriptorsLength ?? 0))) {
    return {
      frameIndex,
      scopeIndex,
      propertyIndex: currentPropertyIndex
    };
  }
  if (scopeIndex + 1 < currentScopeChain.length) {
    return {
      frameIndex,
      scopeIndex: scopeIndex + 1,
      propertyIndex: 0
    };
  }
  const nextFrameIndex = nextPausedScopeScanFrameIndex(callFrames, frameIndex);
  if (nextFrameIndex === null || nextFrameIndex === undefined) {
    return null;
  }
  return {
    frameIndex: nextFrameIndex,
    scopeIndex: 0,
    propertyIndex: 0
  };
}

async function probeTargetedPausedLocation(
  cdp,
  pausedEvent,
  closureCaptureState,
  {
    log = console.log,
    requireActiveGame = false
  } = {}
) {
  const hint = closureCaptureState?.lastSuccessfulPausedLocation ?? null;
  if (!hint) {
    return { ok: false, reason: "missing_hint" };
  }
  const callFrames = pausedEvent?.callFrames ?? [];
  const callFrame = callFrames[hint.frameIndex];
  const scope = callFrame?.scopeChain?.[hint.scopeIndex];
  const scopeObjectId = scope?.object?.objectId;
  if (!scopeObjectId) {
    if (typeof log === "function") {
      log("[browser] targeted paused locator miss reason=scope_missing");
    }
    return { ok: false, reason: "scope_missing" };
  }
  const properties = await cdp.send("Runtime.getProperties", {
    objectId: scopeObjectId,
    ownProperties: true,
    accessorPropertiesOnly: false,
    generatePreview: false
  }).catch(() => null);
  const descriptors = (properties?.result ?? [])
    .slice(0, MAX_SCOPE_PROPERTIES_PER_SCOPE)
    .map((descriptor, index) => ({ descriptor, index }))
    .sort((left, right) => {
      const scoreDelta =
        scorePausedScopeDescriptor(right.descriptor) -
        scorePausedScopeDescriptor(left.descriptor);
      return scoreDelta !== 0 ? scoreDelta : left.index - right.index;
    })
    .map(({ descriptor }) => descriptor);
  const expectedLocator = String(hint.locator ?? "");
  const candidates = [];
  if (Number.isFinite(hint.candidateIndex) && descriptors[hint.candidateIndex]) {
    candidates.push({
      descriptor: descriptors[hint.candidateIndex],
      candidateIndex: hint.candidateIndex
    });
  }
  for (let index = 0; index < descriptors.length; index += 1) {
    if (index === hint.candidateIndex) {
      continue;
    }
    const descriptor = descriptors[index];
    if (String(descriptor?.name ?? "") === expectedLocator) {
      candidates.push({ descriptor, candidateIndex: index });
      break;
    }
  }
  for (const candidate of candidates) {
    const valueObjectId = candidate.descriptor?.value?.objectId;
    const locator = String(candidate.descriptor?.name ?? "").trim();
    if (!valueObjectId || !locator || locator !== expectedLocator) {
      continue;
    }
    const exposed = await exposeTetrioCandidateObjectWithOptions(
      cdp,
      valueObjectId,
      locator,
      { requireActiveGame }
    );
    if (exposed.ok) {
      if (typeof log === "function") {
        log(
          `[browser] targeted paused locator hit frame=${hint.frameIndex} scope=${hint.scopeIndex} candidate=${candidate.candidateIndex}`
        );
      }
      return {
        ...exposed,
        outcome: "targeted_hint_found",
        progress: {
          frameIndex: hint.frameIndex,
          scopeIndex: hint.scopeIndex,
          candidateIndex: candidate.candidateIndex,
          inspectedObjects: 1,
          pausedMs: 0
        }
      };
    }
  }
  if (typeof log === "function") {
    log(
      `[browser] targeted paused locator miss frame=${hint.frameIndex} scope=${hint.scopeIndex} candidate=${hint.candidateIndex}`
    );
  }
  return { ok: false, reason: "targeted_hint_miss" };
}

function logClosureCaptureWindowInitialized(
  closureCaptureState,
  reason,
  log = console.log
) {
  if (typeof log !== "function" || !closureCaptureState) {
    return;
  }
  const pausedUsedMs = Math.max(
    0,
    Number(closureCaptureState.cumulativePausedScanBudgetUsedMs ?? 0)
  );
  const remainingPausedMs = Math.max(
    0,
    DEFAULT_FULL_SCAN_CUMULATIVE_BUDGET_MS - pausedUsedMs
  );
  log(
    `[browser] closure window initialized reason=${reason} capture_attempts=${Math.max(
      0,
      Number(closureCaptureState.captureAttemptsInWindow ?? 0)
    )} full_scan_attempts=${Math.max(
      0,
      Number(closureCaptureState.fullScanAttemptsInWindow ?? 0)
    )} paused_used_ms=${pausedUsedMs} cursor=${formatClosureCaptureCursorLabel(
      closureCaptureState.pausedScopeScanCursor
    )} exhausted=${closureCaptureState.scanBudgetExhausted ? "true" : "false"} remaining_paused_ms=${remainingPausedMs}`
  );
}

function logPausedScopeScanProgress(log, progress) {
  if (typeof log !== "function" || !progress) {
    return;
  }
  log(
    `[browser] full closure scan progress attempt=${progress.attempt}/${MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW} frame=${progress.frameIndex} scope=${progress.scopeIndex} candidate=${progress.candidateIndex} inspected_objects=${progress.inspectedObjects} paused_ms=${progress.pausedMs}`
  );
}

function logPausedScopeScanContinuation(log, cursor) {
  if (typeof log !== "function" || !cursor) {
    return;
  }
  const formatted = formatScanCursor(cursor);
  log(
    `[browser] full closure scan continuation from frame=${formatted.frameIndex} scope=${formatted.scopeIndex} candidate=${formatted.candidateIndex}`
  );
}

function scorePausedScopeDescriptor(descriptor) {
  const locator = String(descriptor?.name ?? "").trim().toLowerCase();
  if (!locator) {
    return Number.NEGATIVE_INFINITY;
  }
  let score = 0;
  if (locator === "game") score += 200;
  if (locator.includes("game")) score += 120;
  if (locator.includes("field")) score += 50;
  if (locator.includes("queue")) score += 50;
  if (locator.includes("hold")) score += 50;
  if (locator.includes("board")) score += 35;
  if (locator.includes("current")) score += 35;
  if (locator.includes("piece")) score += 20;
  if (locator.length >= 4) score += 5;
  return score;
}

export function applyBrowserControlMessage({
  message,
  controlState,
  sessionModeState = null,
  closureCaptureState,
  nextGameReacquireState = null,
  now = Date.now(),
  log = console.log,
  windowMs = DEFAULT_CAPTURE_ARMING_WINDOW_MS,
  bootstrapReady = true
}) {
  if (
    !message ||
    typeof message !== "object" ||
    message.type !== "bot_enabled" ||
    typeof message.enabled !== "boolean"
  ) {
    return false;
  }
  if (!controlState) {
    return false;
  }
  if (controlState.botEnabled === message.enabled) {
    return false;
  }
  controlState.botEnabled = message.enabled;
  if (message.enabled) {
    if (sessionModeState?.mode === SESSION_MODE_VS_WS_SHADOW) {
      log(
        sessionModeState.selectedGameId
          ? `[browser] closure capture suppressed for VS WebSocket session`
          : "[browser] closure capture suppressed for VS WebSocket session"
      );
      return true;
    }
    requestClosureCaptureArm(closureCaptureState, {
      reason: "bot_on",
      now,
      bootstrapReady,
      windowMs,
      log
    });
  } else {
    cancelNextGameReacquire(nextGameReacquireState, {
      reason: "bot_off",
      log
    });
    disarmClosureCaptureWindow(closureCaptureState, {
      reason: "bot_off",
      log,
      clearPending: true
    });
  }
  return true;
}

export function createBootstrapState(now = Date.now()) {
  return {
    connectedAt: now,
    documentCompleteAt: 0,
    transportReadyAt: 0,
    waitingLogged: false,
    readyLogged: false,
    lastDocumentReadyState: "loading",
    lastReadHref: "",
    lastBlockedReason: "",
    lastBlockedLogAt: 0,
    lastReady: false
  };
}

export function resetBootstrapState(
  bootstrapState,
  { resetConnectedAt = false, now = Date.now() } = {}
) {
  if (resetConnectedAt) {
    bootstrapState.connectedAt = now;
  }
  bootstrapState.documentCompleteAt = 0;
  bootstrapState.transportReadyAt = 0;
  bootstrapState.waitingLogged = false;
  bootstrapState.readyLogged = false;
  bootstrapState.lastDocumentReadyState = "loading";
  bootstrapState.lastReadHref = "";
  bootstrapState.lastBlockedReason = "";
  bootstrapState.lastBlockedLogAt = 0;
  bootstrapState.lastReady = false;
  return bootstrapState;
}

export function markBootstrapTransportReady(
  bootstrapState,
  now = Date.now()
) {
  if (!bootstrapState || bootstrapState.transportReadyAt > 0) {
    return bootstrapState;
  }
  bootstrapState.transportReadyAt = now;
  return bootstrapState;
}

export function updateBootstrapDocumentState(
  bootstrapState,
  pageState,
  now = Date.now()
) {
  if (bootstrapState) {
    bootstrapState.lastDocumentReadyState = String(
      pageState?.readyState ?? "loading"
    );
    bootstrapState.lastReadHref = String(pageState?.href ?? "");
  }
  if (
    bootstrapState &&
    pageState?.readyState &&
    pageState.readyState !== "loading" &&
    bootstrapState.documentCompleteAt === 0
  ) {
    bootstrapState.documentCompleteAt = now;
  }
  return bootstrapState;
}

export function getBootstrapReadinessStatus(
  bootstrapState,
  now = Date.now(),
  {
    transportSettleMs = DEFAULT_BOOTSTRAP_TRANSPORT_SETTLE_MS,
    fallbackMs = DEFAULT_BOOTSTRAP_FALLBACK_MS
  } = {}
) {
  if (!bootstrapState?.documentCompleteAt) {
    return {
      ready: false,
      reason: `document_ready_state_${bootstrapState?.lastDocumentReadyState ?? "loading"}`
    };
  }
  if (bootstrapState.transportReadyAt > 0) {
    const elapsedMs = now - bootstrapState.transportReadyAt;
    if (elapsedMs >= transportSettleMs) {
      return { ready: true, reason: "transport_settled" };
    }
    return {
      ready: false,
      reason: `transport_settling_${Math.max(0, transportSettleMs - elapsedMs)}ms_remaining`
    };
  }
  const elapsedSinceConnectMs = now - bootstrapState.connectedAt;
  if (elapsedSinceConnectMs >= fallbackMs) {
    return { ready: true, reason: "fallback_elapsed" };
  }
  return {
    ready: false,
    reason: `fallback_waiting_${Math.max(0, fallbackMs - elapsedSinceConnectMs)}ms_remaining`
  };
}

export function isBootstrapReadyForClosureCapture(
  bootstrapState,
  now = Date.now(),
  options = {}
) {
  return getBootstrapReadinessStatus(bootstrapState, now, options).ready;
}

export function shouldLogBootstrapBlocked(
  bootstrapState,
  reason,
  now = Date.now(),
  intervalMs = DEFAULT_BOOTSTRAP_BLOCKED_LOG_INTERVAL_MS
) {
  if (!bootstrapState) {
    return false;
  }
  return (
    bootstrapState.lastBlockedReason !== reason ||
    now - bootstrapState.lastBlockedLogAt >= intervalMs
  );
}

export function markBootstrapBlockedLogged(
  bootstrapState,
  reason,
  now = Date.now()
) {
  if (!bootstrapState) {
    return false;
  }
  bootstrapState.lastBlockedReason = reason;
  bootstrapState.lastBlockedLogAt = now;
  return true;
}

export function isTransientRuntimeError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("promise was collected") ||
    message.includes("cannot find default execution context") ||
    message.includes("execution context was destroyed") ||
    message.includes("cannot find context with specified id") ||
    message.includes("inspected target navigated or closed") ||
    message.includes("no frame with given id")
  );
}

function maybeLogTransientRuntimeError(error, transientState, log = console.log) {
  const message = String(error?.message ?? error ?? "");
  if (!transientState || transientState.lastRuntimeError === message) {
    return;
  }
  transientState.lastRuntimeError = message;
  log(`[browser] transient Runtime.evaluate failure: ${message}; retrying`);
}

export function shouldLogStateReason({
  reason,
  lastReason,
  lastReasonAt,
  now = Date.now(),
  statusMs = DEFAULT_STATUS_MS,
  suppressRepeatedReason = false
}) {
  if (reason !== lastReason) {
    return true;
  }
  if (suppressRepeatedReason) {
    return false;
  }
  return now - lastReasonAt >= statusMs;
}

function maybeLogBrowserPerf({
  browserPerfEnabled,
  lastPerfLoggedAt,
  maxEventLoopDelayMs
}) {
  if (!browserPerfEnabled || Date.now() - lastPerfLoggedAt < PERF_LOG_INTERVAL_MS) {
    return null;
  }
  console.log(`[browser-perf] max_event_loop_delay_ms=${maxEventLoopDelayMs}`);
  return {
    lastPerfLoggedAt: Date.now(),
    maxEventLoopDelayMs: 0
  };
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
  const vsBridgePath = path.join(path.dirname(snapshotPath), "vs-ws-bridge.json");
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
  const vsWsSimEnabled = isVsWsSimEnvEnabled();
  const browserPerfEnabled = process.env.FUSION_BROWSER_PERF === "1";
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
  let vsRoundActive = false;
  let vsRoundId = "";
  const browserControlState = createBrowserControlState();
  const sessionModeState = createSessionModeState();
  const closureCaptureState = createClosureCaptureState();
  const gameStartSignalState = createGameStartSignalState();
  const nextGameReacquireState = createNextGameReacquireState();
  const postGameInteractionWatchState = createPostGameInteractionWatchState();
  const endedGameCandidate = createEndedGameCandidateState();
  let lastPerfLoggedAt = Date.now();
  let loopStartedAt = Date.now();
  let maxEventLoopDelayMs = 0;
  try {
    const { installDddWsObserver } =
      await import("./ddd-ws-observer.mjs");

    dddWsObserverCleanup = await installDddWsObserver(cdp, {
      unpack: msgpack?.unpack ?? null,
      log: message => console.log(message),
      vsSimEnabled: true,
      vsBridgePath,
      onVsRoundStatus: (status) => {
        const nextActive = Boolean(status?.active);
        const nextRoundId = nextActive ? String(status?.roundId ?? "") : "";
        const changed =
          nextActive !== vsRoundActive || nextRoundId !== vsRoundId;
        vsRoundActive = nextActive;
        vsRoundId = nextRoundId;
        if (!changed || !vsWsSimEnabled) {
          return;
        }
        if (vsRoundActive) {
          disarmClosureCaptureWindow(closureCaptureState, {
            reason: "vs_round_active"
          });
          if (sessionModeState.mode === SESSION_MODE_VS_WS_SHADOW) {
            console.log("[browser] closure capture suppressed for VS WebSocket session");
          } else {
            console.log(
              `[browser] VS round active; closure capture probe suspended roundId=${vsRoundId}`
            );
          }
        } else {
          disarmClosureCaptureWindow(closureCaptureState, {
            reason: "vs_round_inactive"
          });
          console.log("[browser] VS round inactive; closure capture probe restored");
        }
      },
      onGameOptions: ({ signature, options, capturedAt }) => {
        handleDddGameOptions({
          sessionModeState,
          gameStartSignalState,
          closureCaptureState,
          signature,
          options,
          capturedAt,
          log: (message) => console.log(message)
        });
      },
      perfEnabled: browserPerfEnabled
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
  const bootstrapState = createBootstrapState();
  const transientState = { lastRuntimeError: "" };
  const interactionTrackerInstallState = createInteractionTrackerInstallState();
  const installInteractionTrackerForCurrentDocument = () =>
    ensureNextGameInteractionTrackerInstalled(cdp, interactionTrackerInstallState, {
      transientState,
      log: (message) => console.log(message)
    }).catch(() => undefined);
  await installInteractionTrackerForCurrentDocument();
  console.log("[browser] browser target state reset");
  if (useRibbonWebsocket) {
    await installRibbonMonitor(cdp, network, msgpack, bootstrapState, {
      onGameplaySignal: ({ key, source, details }) =>
        noteSoloGameStartSignal(gameStartSignalState, {
          key,
          source,
          now: Date.now(),
          details,
          log: (message) => console.log(message)
        })
    });
  }
  const resetBrowserTargetState = ({ resetConnectedAt = false } = {}) => {
    resetBootstrapState(bootstrapState, { resetConnectedAt });
    resetTetrioNetworkState(network);
    resetClosureCaptureLocatorHint(closureCaptureState);
    resetPausedScopeScanProgress(closureCaptureState);
    clearPendingClosureCaptureArm(closureCaptureState);
    resetGameStartSignalState(gameStartSignalState);
    void releaseEndedGameCandidateHandle(cdp, endedGameCandidate, {
      reason: resetConnectedAt ? "navigation" : "execution_context_reset",
      log: (message) => console.log(message)
    }).catch(() => undefined);
    cancelNextGameReacquire(nextGameReacquireState, {
      reason: "browser_reset",
      log: (message) => console.log(message)
    });
    cancelPostGameInteractionWatch(postGameInteractionWatchState, {
      reason: "browser_reset",
      log: (message) => console.log(message)
    });
    resetSessionModeState(sessionModeState);
    console.log("[browser] browser target state reset");
  };
  cdp.on("Page.frameNavigated", (event) => {
    if (event?.frame?.parentId) {
      return;
    }
    resetBrowserTargetState({ resetConnectedAt: true });
    disarmClosureCaptureWindow(closureCaptureState, {
      reason: "page_navigated"
    });
    void installInteractionTrackerForCurrentDocument();
  });
  cdp.on("Runtime.executionContextsCleared", () => {
    resetBrowserTargetState();
    disarmClosureCaptureWindow(closureCaptureState, {
      reason: "execution_context_cleared"
    });
    void installInteractionTrackerForCurrentDocument();
  });
  cdp.on("Runtime.executionContextCreated", (event) => {
    const auxData = event?.context?.auxData ?? null;
    if (auxData && auxData.isDefault === false) {
      return;
    }
    void installInteractionTrackerForCurrentDocument();
  });
  const control = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false
  });
  control.on("line", (line) => {
    if (!line?.trim()) {
      return;
    }
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    applyBrowserControlMessage({
      message,
      controlState: browserControlState,
      sessionModeState,
      closureCaptureState,
      nextGameReacquireState,
      bootstrapReady: isBootstrapReadyForClosureCapture(bootstrapState),
      log: (entry) => console.log(entry)
    });
    if (message?.type === "bot_enabled" && message.enabled === false) {
      cancelPostGameInteractionWatch(postGameInteractionWatchState, {
        reason: "bot_off",
        log: (entry) => console.log(entry)
      });
      void releaseEndedGameCandidateHandle(cdp, endedGameCandidate, {
        reason: "bot_off",
        log: (entry) => console.log(entry)
      }).catch(() => undefined);
    }
  });

  let gameEpoch = 1;
  let waitingForNextGame = false;
  let waitingForNextGameSignalCutoffAt = 0;
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
    resetBrowserTargetState();
    clearPendingClosureCaptureArm(closureCaptureState);
    await releaseEndedGameCandidateHandle(cdp, endedGameCandidate, {
      reason: "chromium_shutdown",
      log: (message) => console.log(message)
    }).catch(() => undefined);
    await cdp.close().catch(() => undefined);
    if (ownsChromium && browserProcess) {
      await shutdownChromium(browserProcess);
    }
  };
  process.on("SIGINT", () => stop().finally(() => process.exit(0)));
  process.on("SIGTERM", () => stop().finally(() => process.exit(0)));

  while (true) {
    try {
      const loopNow = Date.now();
      maxEventLoopDelayMs = Math.max(
        maxEventLoopDelayMs,
        Math.max(0, loopNow - (loopStartedAt + pollMs))
      );
      loopStartedAt = loopNow;
      const previousGameplayPhase = String(probeState.lastGameplayPhase ?? "inactive");
      const state = await readTetrioState(cdp, {
        probePageState,
        useSeedSimulationFallback,
        network,
        probeState,
        bootstrapState,
        transientState,
        browserControlState,
        suppressClosureCapture:
          sessionModeState.mode === SESSION_MODE_VS_WS_SHADOW ||
          (vsWsSimEnabled && vsRoundActive),
        activeRoundId: vsRoundActive ? vsRoundId : "",
        closureCaptureState,
        nextGameReacquireState,
        postGameInteractionWatchState,
        endedGameCandidate,
        waitingForNextGame,
        suppressedReason:
          sessionModeState.mode === SESSION_MODE_VS_WS_SHADOW
            ? "VS WebSocket shadow session selected"
            : DEFAULT_SUPPRESSED_REASON,
        perfEnabled: browserPerfEnabled
      });

      if (sessionModeState.mode === SESSION_MODE_VS_WS_SHADOW) {
        if (sessionModeState.staleSnapshotClearedAt === 0) {
          clearSnapshotFile(snapshotPath);
          resetSnapshotTracking(snapshotTracking);
          sessionModeState.staleSnapshotClearedAt = Date.now();
        }
        const perfUpdate = maybeLogBrowserPerf({
          browserPerfEnabled,
          lastPerfLoggedAt,
          maxEventLoopDelayMs
        });
        if (perfUpdate) {
          lastPerfLoggedAt = perfUpdate.lastPerfLoggedAt;
          maxEventLoopDelayMs = perfUpdate.maxEventLoopDelayMs;
        }
        await sleep(pollMs);
        continue;
      }

      if (
        browserControlState.botEnabled &&
        !waitingForNextGame &&
        !postGameInteractionWatchState.active &&
        previousGameplayPhase === "playing" &&
        state?.playing !== true
      ) {
        await primePostGameInteractionWatchBaseline(cdp, postGameInteractionWatchState, {
          now: Date.now(),
          transientState,
          log: (message) => console.log(message),
          nextGameReacquireState
        });
      }

      if (
        postGameInteractionWatchState.active &&
        !waitingForNextGame &&
        state?.playing === true
      ) {
        setNextGameInteractionPhase(
          nextGameReacquireState,
          NEXT_GAME_INTERACTION_PHASE_INACTIVE
        );
        cancelPostGameInteractionWatch(postGameInteractionWatchState, {
          reason: "playing_resumed",
          log: (message) => console.log(message)
        });
      }

      if (shouldHandleEndedGame(state, endedHandled)) {
        endedHandled = true;
        waitingForNextGame = true;
        const preserveProvisionalWindow =
          isClosureCaptureArmed(closureCaptureState, Date.now()) &&
          isAgainButtonProvisionalInteraction(nextGameReacquireState) &&
          Math.max(0, Number(nextGameReacquireState.interactionWindowGeneration ?? 0)) > 0;
        const preservedWindowGeneration = Math.max(
          0,
          Number(nextGameReacquireState.interactionWindowGeneration ?? 0)
        );
        const preservedWindowArmedAt = Math.max(
          0,
          Number(nextGameReacquireState.interactionWindowArmedAt ?? 0)
        );
        const preservedProvisionalInteraction = {
          generation: Math.max(0, Number(nextGameReacquireState.provisionalInteractionGeneration ?? 0)),
          timestamp: Math.max(0, Number(nextGameReacquireState.provisionalInteractionTimestamp ?? 0)),
          key: String(nextGameReacquireState.provisionalInteractionKey ?? ""),
          trusted: nextGameReacquireState.provisionalInteractionTrusted === true,
          kind: String(nextGameReacquireState.provisionalInteractionKind ?? ""),
          transitionReady: nextGameReacquireState.provisionalTransitionReady === true,
          transitionReadyLoggedAt: Math.max(0, Number(nextGameReacquireState.provisionalTransitionReadyLoggedAt ?? 0))
        };

        await markCurrentGameAsEnded(cdp);

        resetSnapshotTracking(snapshotTracking);
        probeState.lastCaptureAt = 0;
        resetTetrioNetworkState(network);
        if (!preserveProvisionalWindow) {
          disarmClosureCaptureWindow(closureCaptureState, {
            reason: "game_ended"
          });
        }
        clearSnapshotFile(snapshotPath);
        waitingForNextGameSignalCutoffAt =
          Math.max(0, Date.now() - DEFAULT_GAME_START_SIGNAL_OVERLAP_MS);
        advanceGameStartSignalGeneration(gameStartSignalState, {
          preserveSince: waitingForNextGameSignalCutoffAt
        });

        console.log(`[browser] game session ended epoch=${gameEpoch}`);
        console.log("[browser] cleared ended game cache; waiting for next game");
        await retainEndedGameCandidateHandle(cdp, endedGameCandidate, {
          locator: closureCaptureState.lastSuccessfulLocator,
          epoch: gameEpoch,
          endedAt: Date.now(),
          lastPlaying: false,
          lastPieceCounter: Number(state.pieceCounter ?? -1),
          lastSignature: snapshotTracking.lastWrittenSignature,
          transientState,
          log: (message) => console.log(message)
        });
        if (browserControlState.botEnabled) {
          startNextGameReacquire(nextGameReacquireState, {
            now: Date.now(),
            epoch: gameEpoch,
            locator: endedGameCandidate.locator
              ? `closure:${endedGameCandidate.locator}`
              : "",
            interactionBaselineGeneration: Math.max(
              0,
              Number(postGameInteractionWatchState.interactionBaselineGeneration ?? 0)
            ),
            log: (message) => console.log(message)
          });
          const carriedPending = carryPendingPostGameInteractionIntoReacquire(
            postGameInteractionWatchState,
            nextGameReacquireState,
            {
              log: (message) => console.log(message)
            }
          );
          if (!carriedPending && !postGameInteractionWatchState.active) {
            await primeNextGameInteractionBaseline(cdp, nextGameReacquireState, {
              transientState,
              log: (message) => console.log(message)
            });
          } else {
            nextGameReacquireState.lastInteractionGenerationSeen = Math.max(
              Math.max(0, Number(nextGameReacquireState.lastInteractionGenerationSeen ?? 0)),
              Math.max(0, Number(postGameInteractionWatchState.lastInteractionGenerationSeen ?? 0))
            );
          }
          if (preserveProvisionalWindow) {
            nextGameReacquireState.interactionWindowGeneration = preservedWindowGeneration;
            nextGameReacquireState.interactionWindowArmedAt = preservedWindowArmedAt;
            nextGameReacquireState.provisionalInteractionGeneration = preservedProvisionalInteraction.generation;
            nextGameReacquireState.provisionalInteractionTimestamp = preservedProvisionalInteraction.timestamp;
            nextGameReacquireState.provisionalInteractionKey = preservedProvisionalInteraction.key;
            nextGameReacquireState.provisionalInteractionTrusted = preservedProvisionalInteraction.trusted;
            nextGameReacquireState.provisionalInteractionKind = preservedProvisionalInteraction.kind;
            nextGameReacquireState.provisionalTransitionReady = preservedProvisionalInteraction.transitionReady;
            nextGameReacquireState.provisionalTransitionReadyLoggedAt = preservedProvisionalInteraction.transitionReadyLoggedAt;
            setNextGameInteractionPhase(
              nextGameReacquireState,
              preservedProvisionalInteraction.transitionReady
                ? NEXT_GAME_INTERACTION_PHASE_REACQUIRING
                : NEXT_GAME_INTERACTION_PHASE_WAITING_TRANSITION_READY
            );
            console.log(
              `[browser] provisional capture promoted after end confirmation generation=${preservedWindowGeneration}`
            );
            console.log(
              `[browser] provisional window preserved across game end confirmation generation=${preservedWindowGeneration}`
            );
          }
          if (carriedPending && isBootstrapReadyForClosureCapture(bootstrapState)) {
            console.log(
              `[browser] carried interaction requesting capture generation=${Math.max(
                0,
                Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)
              )}`
            );
            armPendingNextGameInteractionWindow(
              closureCaptureState,
              nextGameReacquireState,
              {
                now: Date.now(),
                bootstrapReady: true,
                log: (message) => console.log(message),
                logPrefix: "carried interaction armed"
              }
            );
          } else if (carriedPending) {
            nextGameReacquireState.pendingArmReason = "next_game_carried_interaction";
            console.log(
              `[browser] carried interaction arm deferred generation=${Math.max(
                0,
                Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)
              )} reason=bootstrap_not_ready`
            );
          }
        }
        resetPostGameInteractionWatch(postGameInteractionWatchState);
      }

      if (
        browserControlState.botEnabled &&
        waitingForNextGame &&
        hasUnconsumedGameStartSignal(gameStartSignalState, {
          since: waitingForNextGameSignalCutoffAt
        })
      ) {
        const signal = consumeGameStartSignal(gameStartSignalState, {
          since: waitingForNextGameSignalCutoffAt
        });
        if (signal) {
          console.log(
            `[browser] solo signal consumed key=${signal.key} source=${signal.source}`
          );
          console.log(`[browser] game-start signal source=${signal.source}`);
          applyGameStartSignalToNetwork(network, signal);
          requestClosureCaptureArm(closureCaptureState, {
            reason: "game_start_signal",
            now: Date.now(),
            bootstrapReady: isBootstrapReadyForClosureCapture(bootstrapState),
            log: (message) => console.log(message)
          });
          console.log(
            `[browser] game-start transition armed epoch_candidate=${gameEpoch + 1}`
          );
        }
      }

      if (isTetrioGameEndedState(state)) {
        const perfUpdate = maybeLogBrowserPerf({
          browserPerfEnabled,
          lastPerfLoggedAt,
          maxEventLoopDelayMs
        });
        if (perfUpdate) {
          lastPerfLoggedAt = perfUpdate.lastPerfLoggedAt;
          maxEventLoopDelayMs = perfUpdate.maxEventLoopDelayMs;
        }
        await sleep(pollMs);
        continue;
      }

      if (!state.ok || !state.ready || !state.playing || state.countdown) {
        const reason =
          state.reason ??
          (!state.playing
            ? "page is not playing"
            : state.countdown
              ? "countdown active"
              : "state not ready");
        const now = Date.now();
        if (shouldLogStateReason({
          reason,
          lastReason,
          lastReasonAt,
          now,
          suppressRepeatedReason: state.reason === DEFAULT_SUPPRESSED_REASON
        })) {
          console.log(`[browser] ${reason}`);
          lastReason = reason;
          lastReasonAt = now;
        }
        const perfUpdate = maybeLogBrowserPerf({
          browserPerfEnabled,
          lastPerfLoggedAt,
          maxEventLoopDelayMs
        });
        if (perfUpdate) {
          lastPerfLoggedAt = perfUpdate.lastPerfLoggedAt;
          maxEventLoopDelayMs = perfUpdate.maxEventLoopDelayMs;
        }
        await sleep(pollMs);
        continue;
      }

      if (shouldAdvanceGameEpoch(state, waitingForNextGame)) {
        gameEpoch += 1;
        waitingForNextGame = false;
        waitingForNextGameSignalCutoffAt = 0;
        endedHandled = false;
        setNextGameInteractionPhase(
          nextGameReacquireState,
          NEXT_GAME_INTERACTION_PHASE_INACTIVE
        );
        resetPostGameInteractionWatch(postGameInteractionWatchState);
        resetSnapshotTracking(snapshotTracking);
        console.log(`[browser] new game detected epoch=${gameEpoch}`);
        completeNextGameReacquire(nextGameReacquireState, {
          epoch: gameEpoch,
          log: (message) => console.log(message)
        });
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
          if (browserPerfEnabled) {
            console.log(
              `[browser-perf] piece_change_to_snapshot_ms=${Math.max(0, Date.now() - snapshotTracking.pendingPieceDetectedAt)}`
            );
          }
        }
        if (snapshot.token !== snapshotTracking.lastLoggedToken) {
          snapshotTracking.lastLoggedToken = snapshot.token;
          console.log(
            `[browser] page state ready pieceCounter=${state.pieceCounter} current=${snapshot.current} hold=${snapshot.hold ?? "-"} queue=${snapshot.queue.join(",")}`
          );
        }
      }

      const perfUpdate = maybeLogBrowserPerf({
        browserPerfEnabled,
        lastPerfLoggedAt,
        maxEventLoopDelayMs
      });
      if (perfUpdate) {
        lastPerfLoggedAt = perfUpdate.lastPerfLoggedAt;
        maxEventLoopDelayMs = perfUpdate.maxEventLoopDelayMs;
      }

      await sleep(pollMs);
    } catch (error) {
      if (isTransientRuntimeError(error)) {
        maybeLogTransientRuntimeError(error, transientState);
        await sleep(Math.max(50, pollMs));
        continue;
      }
      throw error;
    }
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
    returnByValue: true
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

export function resetTetrioNetworkState(network) {
  if (!network) {
    return false;
  }
  network.seed = null;
  network.nextCount = DEFAULT_NEXT_COUNT;
  network.readyAt = 0;
  network.ribbonSeen = false;
  network.lastPageProbeAt = 0;
  return true;
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
    returnByValue: true
  }).catch(() => undefined);
}

async function installRibbonMonitor(
  cdp,
  network,
  msgpack,
  bootstrapState,
  { onGameplaySignal = null } = {}
) {
  await cdp.send("Network.enable").catch(() => undefined);
  cdp.on("Network.webSocketCreated", (event) => {
    if (/spool\.tetr\.io\/ribbon/i.test(event?.url ?? "")) {
      network.ribbonSeen = true;
      markBootstrapTransportReady(bootstrapState);
      console.log("[browser] ribbon websocket opened");
    }
  });
  if (!msgpack?.unpack) return;
  const handleFrame = (event) => {
    const payload = event?.response?.payloadData;
    if (!payload) return;
    const buffer = event?.response?.opcode === 2 ? Buffer.from(payload, "base64") : Buffer.from(payload, "utf8");
    inspectRibbonPayload(buffer, network, msgpack.unpack, onGameplaySignal);
  };
  cdp.on("Network.webSocketFrameReceived", handleFrame);
  cdp.on("Network.webSocketFrameSent", handleFrame);
}

function inspectRibbonPayload(
  payload,
  network,
  unpack,
  onGameplaySignal = null
) {
  const candidates = [];
  for (let offset = 0; offset <= Math.min(24, payload.length - 1); offset++) {
    try {
      candidates.push(unpack(payload.subarray(offset)));
    } catch {}
  }
  for (const decoded of candidates) {
    const options = findOptionsObject(decoded);
    if (options?.seed !== undefined && options?.bagtype !== undefined) {
      const countdownMs = estimateCountdownWait(options);
      network.seed = String(options.seed);
      network.nextCount = Math.max(
        1,
        Number.parseInt(options.nextcount ?? `${DEFAULT_NEXT_COUNT}`, 10) || DEFAULT_NEXT_COUNT
      );
      network.readyAt = Date.now() + countdownMs;
      console.log(`[browser] ribbon seed captured seed=${network.seed}`);
      onGameplaySignal?.({
        key: `ribbon:${String(options.seed)}:${String(options.gameid ?? "")}`,
        source: "ribbon_seed",
        details: {
          seed: String(options.seed),
          gameid: options.gameid ?? null,
          nextCount: network.nextCount,
          countdownMs,
          readyAt: network.readyAt
        }
      });
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

async function readBootstrapPageState(
  cdp,
  bootstrapState,
  now,
  transientState,
  log = console.log
) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: `(() => ({
      readyState: document.readyState,
      href: location.href
    }))()`,
    returnByValue: true
  }, {
    result: {
      value: {
        readyState: "loading",
        href: ""
      }
    }
  }, {
    transientState,
    log
  });
  const pageState = raw?.result?.value ?? { readyState: "loading", href: "" };
  updateBootstrapDocumentState(bootstrapState, pageState, now);
  return pageState;
}

async function retainEndedGameCandidateHandle(
  cdp,
  endedGameCandidate,
  {
    locator = "",
    epoch = 0,
    endedAt = Date.now(),
    lastPlaying = false,
    lastPieceCounter = -1,
    lastSignature = "",
    transientState = null,
    log = console.log
  } = {}
) {
  if (!endedGameCandidate) {
    return false;
  }
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: "window.__fusionEndedTetrioGame || window.__fusionTetrioGame || null",
    objectGroup: "fusion-ended-game",
    silent: true
  }, null, {
    transientState,
    log
  });
  const objectId = String(raw?.result?.objectId ?? "");
  if (!objectId) {
    if (typeof log === "function") {
      log("[browser] ended game object retained epoch=0 object_id_present=false locator=");
    }
    return false;
  }
  endedGameCandidate.objectId = objectId;
  endedGameCandidate.locator = String(locator ?? "");
  endedGameCandidate.epoch = Math.max(0, Number(epoch ?? 0));
  endedGameCandidate.endedAt = endedAt;
  endedGameCandidate.lastPlaying = Boolean(lastPlaying);
  endedGameCandidate.lastPieceCounter = Number.isFinite(lastPieceCounter)
    ? Math.max(0, Math.floor(lastPieceCounter))
    : -1;
  endedGameCandidate.lastSignature = String(lastSignature ?? "");
  if (typeof log === "function") {
    log(
      `[browser] ended game object retained epoch=${endedGameCandidate.epoch} object_id_present=true locator=${
        endedGameCandidate.locator ? `closure:${endedGameCandidate.locator}` : ""
      }`
    );
  }
  return true;
}

function endedGameCandidateProbeExpression() {
  return `function(lastEndedPieceCounter, lastSignature) {
    try {
      const normalizePiece = (piece) => {
        if (typeof piece === "string") {
          const token = piece.trim().toLowerCase();
          return ["i", "o", "t", "s", "z", "j", "l"].includes(token) ? token : null;
        }
        if (piece && typeof piece === "object") {
          return normalizePiece(piece.type ?? piece.name ?? piece.kind ?? piece.id);
        }
        return null;
      };
      const numberFrom = (...values) => {
        for (const value of values) {
          const next = Number(value);
          if (Number.isFinite(next)) return next;
        }
        return null;
      };
      const rowCells = (row) => Array.isArray(row) ? row : Array.isArray(row?.cells) ? row.cells : null;
      const filled = (cell) => cell !== null && cell !== undefined && cell !== 0 && cell !== false;
      const queueFrom = (...sources) => {
        for (const source of sources) {
          if (!Array.isArray(source)) continue;
          const queue = source.map((piece) => normalizePiece(piece)).filter(Boolean);
          if (queue.length > 0) return queue;
        }
        return [];
      };
      if (
        !this ||
        typeof this !== "object" ||
        typeof this.ejectState !== "function" ||
        typeof this.ejectBoardState !== "function"
      ) {
        return { status: "invalid_shape" };
      }
      const exported = this.ejectState();
      const boardState = this.ejectBoardState();
      const state = exported && typeof exported === "object" && exported.game ? exported.game : exported;
      if (!state || typeof state !== "object") {
        return { status: "invalid_shape" };
      }
      const activeState = state.falling ?? state.active ?? state.current ?? state.piece;
      const current = normalizePiece(activeState);
      const hold = normalizePiece(state.hold ?? state.held);
      const queue = queueFrom(state.bag, state.queue, state.next, state.preview, state.previews, state.pieces);
      const board = Array.isArray(state.board) ? state.board : Array.isArray(boardState?.b) ? boardState.b : null;
      const playing =
        typeof this.isPlaying === "function" ? Boolean(this.isPlaying()) :
        typeof state.playing === "boolean" ? state.playing :
        typeof state.paused === "boolean" ? !state.paused :
        true;
      const started =
        typeof this.isStarted === "function" ? Boolean(this.isStarted()) :
        Boolean(state.started ?? true);
      const destroyed = Boolean(state.destroyed || state.dead || state.gameover);
      const countdown = started && !destroyed && !playing;
      const ready = started && !destroyed;
      const pieceCounter = Math.max(0, Math.floor(numberFrom(
        state?.stats?.piecesplaced,
        state?.stats?.piecesPlaced,
        state?.stats?.pieces,
        state.piecesplaced,
        state.piecesPlaced,
        state.pieceCounter,
        state.piececount,
        0
      ) ?? 0));
      if (!ready || (!playing && !countdown)) {
        return {
          status: "valid_ended",
          playing,
          countdown,
          pieceCounter
        };
      }
      if (!current || queue.length === 0 || !Array.isArray(board) || board.length === 0) {
        return { status: "invalid_shape" };
      }
      const field = Array.from({ length: 40 }, (_, rowIndex) => {
        const sourceRow = board[board.length - 1 - rowIndex];
        const cells = rowCells(sourceRow);
        return Array.from({ length: 10 }, (_, x) => filled(cells ? cells[x] : null));
      });
      const signature =
        String(pieceCounter) + "|" + String(current) + "|" + String(hold ?? "-") + "|" + queue.join(",");
      return {
        status: playing ? "valid_playing" : "valid_countdown",
        reactivated:
          pieceCounter <= 3 ||
          (Number.isFinite(lastEndedPieceCounter) && lastEndedPieceCounter >= 0 && pieceCounter < lastEndedPieceCounter) ||
          signature !== String(lastSignature || ""),
        state: {
          ok: true,
          ready,
          reason: null,
          field,
          current,
          hold,
          queue,
          b2b: Math.max(0, numberFrom(state?.stats?.b2b, state.b2b, 0) ?? 0) > 0,
          combo: Math.max(0, numberFrom(state?.stats?.combo, state.combo, 0) ?? 0),
          incoming: Math.max(0, numberFrom(state?.stats?.impendingdamage, state.incoming, 0) ?? 0),
          pieceCounter,
          playing,
          countdown
        }
      };
    } catch {
      return { status: "transient_error" };
    }
  }`;
}

async function readEndedGameCandidateState(
  cdp,
  endedGameCandidate,
  {
    log = console.log
  } = {}
) {
  const objectId = String(endedGameCandidate?.objectId ?? "");
  if (!objectId) {
    return { status: "object_released" };
  }
  try {
    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: endedGameCandidateProbeExpression(),
      arguments: [
        { value: endedGameCandidate?.lastPieceCounter ?? -1 },
        { value: endedGameCandidate?.lastSignature ?? "" }
      ],
      returnByValue: true,
      silent: true
    });
    return result?.result?.value ?? { status: "transient_error" };
  } catch (error) {
    const message = String(error?.message ?? error ?? "");
    if (/Cannot find context with specified id|Execution context was destroyed/i.test(message)) {
      return { status: "execution_context_destroyed" };
    }
    if (/objectId|object id/i.test(message) && /invalid|missing|null|undefined/i.test(message)) {
      return { status: "invalid_object_id" };
    }
    if (/Could not find object with given id|Cannot find object with id|Invalid remote object id/i.test(message)) {
      return { status: "object_released" };
    }
    return { status: "transient_error", reason: message };
  }
}

export function cheapGameSignalExpression() {
  return `(() => {
      const isVisible = (node, depth = 2) => {
        if (!node || typeof node !== "object" || node.isConnected !== true) return false;
        let current = node;
        let remaining = depth;
        while (current && remaining >= 0) {
          const style = window.getComputedStyle ? window.getComputedStyle(current) : null;
          if (!style) return false;
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            Number(style.opacity) <= 0
          ) {
            return false;
          }
          current = current.parentElement;
          remaining -= 1;
        }
        const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const firstVisible = (selector) =>
        Array.from(document.querySelectorAll(selector)).find((node) => isVisible(node)) || null;
      const textIncludes = (tokens) => {
        const text = String(document.body?.innerText ?? "").toLowerCase();
        return tokens.some((token) => text.includes(token));
      };
      const routeText = (String(location.pathname || "") + String(location.hash || "")).toLowerCase();
      const countdownNode = firstVisible("[class*='countdown'],[class*='ready'],[class*='start']");
      const resultNode = firstVisible("[class*='result'],[class*='summary'],[class*='finish']");
      const retryNode = firstVisible(
        "[class*='retry'],[data-action*='retry'],button[id*='retry'],button[class*='restart']"
      );
      const canvasNode = firstVisible("canvas");
      const gameplayNode = firstVisible("[class*='board'],[class*='matrix'],[class*='playfield'],[class*='hud'],[data-screen='game']");
      const countdownByText = textIncludes(["go!", "ready"]);
      const resultByText = textIncludes(["result", "finished"]);
      const routeGame = /play|solo|40l/.test(routeText) && !/result|summary|finish/.test(routeText);
      const routeResult = /result|summary|finish/.test(routeText);
      const resultVisible = Boolean(resultNode) || Boolean(retryNode) || resultByText || routeResult;
      const countdownVisible = Boolean(countdownNode) || countdownByText;
      const gameplayVisible = Boolean(gameplayNode) && routeGame;
      const canvasVisible = Boolean(canvasNode);
      const sources = [
        { source: "route_game", value: routeGame, state: routeGame ? "playing" : "inactive" },
        { source: "countdown_dom", value: countdownVisible, state: countdownVisible ? "countdown" : "inactive" },
        { source: "result_dom", value: resultVisible, state: resultVisible ? "result" : "inactive" },
        { source: "gameplay_dom", value: gameplayVisible, state: gameplayVisible ? "playing" : "inactive" },
        { source: "canvas_visible", value: canvasVisible, state: canvasVisible ? "visible" : "inactive" }
      ];
      let active = false;
      let source = "none";
      let label = "inactive";
      if (resultVisible && countdownVisible) {
        label = "ambiguous";
      } else if (resultVisible) {
        label = "result";
      } else if (countdownVisible) {
        active = true;
        source = "countdown_dom";
        label = "countdown";
      } else if (gameplayVisible) {
        active = true;
        source = "gameplay_dom";
        label = "playing";
      }
      return { active, source, label, sources };
    })()`;
}

async function readCheapGameSignal(
  cdp,
  {
    transientState = null,
    log = console.log
  } = {}
) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: cheapGameSignalExpression(),
    returnByValue: true
  }, {
    result: {
      value: { active: false, source: "none", label: "inactive", sources: [] }
    }
  }, {
    transientState,
    log
  });
  return raw?.result?.value ?? { active: false, source: "none", label: "inactive", sources: [] };
}

function nextGameFastLocatorExpression(locatorName = "closure:Ai") {
  return `(() => {
    const normalizePiece = (piece) => {
      if (typeof piece === "string") {
        const token = piece.trim().toLowerCase();
        return ["i", "o", "t", "s", "z", "j", "l"].includes(token) ? token : null;
      }
      if (piece && typeof piece === "object") {
        return normalizePiece(piece.type ?? piece.name ?? piece.kind ?? piece.id);
      }
      return null;
    };
    const numberFrom = (...values) => {
      for (const value of values) {
        const next = Number(value);
        if (Number.isFinite(next)) return next;
      }
      return null;
    };
    const rowCells = (row) => Array.isArray(row) ? row : Array.isArray(row?.cells) ? row.cells : null;
    const filled = (cell) => cell !== null && cell !== undefined && cell !== 0 && cell !== false;
    const queueFrom = (...sources) => {
      for (const source of sources) {
        if (!Array.isArray(source)) continue;
        const queue = source.map((piece) => normalizePiece(piece)).filter(Boolean);
        if (queue.length > 0) return queue;
      }
      return [];
    };
    const readCandidate = (game) => {
      if (!game || typeof game !== "object" || typeof game.ejectState !== "function" || typeof game.ejectBoardState !== "function") {
        return null;
      }
      const exported = game.ejectState();
      const boardState = game.ejectBoardState();
      const state = exported && typeof exported === "object" && exported.game ? exported.game : exported;
      if (!state || typeof state !== "object") return null;
      const activeState = state.falling ?? state.active ?? state.current ?? state.piece;
      const current = normalizePiece(activeState);
      const queue = queueFrom(state.bag, state.queue, state.next, state.preview, state.previews, state.pieces);
      const board = Array.isArray(state.board) ? state.board : Array.isArray(boardState?.b) ? boardState.b : null;
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
      if (!ready || (!playing && !countdown) || !current || queue.length === 0 || !Array.isArray(board) || board.length === 0) {
        return null;
      }
      const stats = state.stats ?? {};
      const field = Array.from({ length: 40 }, (_, rowIndex) => {
        const sourceRow = board[board.length - 1 - rowIndex];
        const cells = rowCells(sourceRow);
        return Array.from({ length: 10 }, (_, x) => filled(cells ? cells[x] : null));
      });
      return {
        ok: true,
        ready,
        reason: null,
        field,
        current,
        hold: normalizePiece(state.hold ?? state.held),
        queue,
        b2b: Math.max(0, numberFrom(stats.b2b, state.b2b, 0) ?? 0) > 0,
        combo: Math.max(0, numberFrom(stats.combo, state.combo, 0) ?? 0),
        incoming: Math.max(0, numberFrom(stats.impendingdamage, state.incoming, 0) ?? 0),
        pieceCounter: Math.max(0, Math.floor(numberFrom(
          stats.piecesplaced,
          stats.piecesPlaced,
          stats.pieces,
          state.piecesplaced,
          state.piecesPlaced,
          state.pieceCounter,
          state.piececount,
          0
        ) ?? 0)),
        playing,
        countdown
      };
    };
    for (const candidate of [window.__fusionEndedTetrioGame, window.__fusionTetrioGame]) {
      const state = readCandidate(candidate);
      if (!state) continue;
      window.__fusionTetrioGame = candidate;
      if (candidate === window.__fusionEndedTetrioGame) {
        delete window.__fusionEndedTetrioGame;
      }
      return {
        ok: true,
        locator: ${JSON.stringify(locatorName)},
        source: ${JSON.stringify(locatorName)},
        state
      };
    }
    return { ok: false };
  })()`;
}

async function probeNextGameViaFastLocator(
  cdp,
  {
    locator = "",
    transientState = null,
    log = console.log
  } = {}
) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: nextGameFastLocatorExpression(`closure:${locator}`),
    returnByValue: true
  }, {
    result: {
      value: { ok: false }
    }
  }, {
    transientState,
    log
  });
  return raw?.result?.value ?? { ok: false };
}

async function readNextGameCheapSignal(
  cdp,
  {
    transientState = null,
    log = console.log
  } = {}
) {
  const raw = await safeRuntimeEvaluate(cdp, {
    expression: `(() => {
      try {
        const candidate = window.__fusionEndedTetrioGame || window.__fusionTetrioGame || null;
        if (!candidate || typeof candidate.ejectState !== "function") {
          return { active: false };
        }
        const exported = candidate.ejectState();
        const state = exported && typeof exported === "object" && exported.game ? exported.game : exported;
        const playing =
          typeof candidate.isPlaying === "function" ? Boolean(candidate.isPlaying()) :
          typeof state?.playing === "boolean" ? state.playing :
          typeof state?.paused === "boolean" ? !state.paused :
          false;
        const started =
          typeof candidate.isStarted === "function" ? Boolean(candidate.isStarted()) :
          Boolean(state?.started ?? false);
        const destroyed = Boolean(state?.destroyed || state?.dead || state?.gameover);
        return { active: Boolean(started && !destroyed && playing) };
      } catch {
        return { active: false };
      }
    })()`,
    returnByValue: true
  }, {
    result: {
      value: { active: false }
    }
  }, {
    transientState,
    log
  });
  return raw?.result?.value ?? { active: false };
}

export async function readTetrioState(cdp, options) {
  const now = options.now ?? Date.now();
  const log = options.log ?? console.log;
  const bootstrapState = options.bootstrapState ?? createBootstrapState(now);
  const browserControlState =
    options.browserControlState ?? createBrowserControlState();
  const closureCaptureState =
    options.closureCaptureState ?? createClosureCaptureState();
  const nextGameReacquireState =
    options.nextGameReacquireState ?? createNextGameReacquireState();
  const postGameInteractionWatchState =
    options.postGameInteractionWatchState ?? createPostGameInteractionWatchState();
  const endedGameCandidate =
    options.endedGameCandidate ?? createEndedGameCandidateState();
  const waitingForNextGame = Boolean(options.waitingForNextGame);
  const verboseReacquireLogs = options.verboseReacquireLogs === true;
  if (
    nextGameReacquireState.active &&
    nextGameReacquireState.interactionPhase === NEXT_GAME_INTERACTION_PHASE_INACTIVE
  ) {
    setNextGameInteractionPhase(
      nextGameReacquireState,
      NEXT_GAME_INTERACTION_PHASE_REACQUIRING
    );
  } else if (
    !nextGameReacquireState.active &&
    postGameInteractionWatchState.active &&
    nextGameReacquireState.interactionPhase === NEXT_GAME_INTERACTION_PHASE_INACTIVE
  ) {
    setNextGameInteractionPhase(
      nextGameReacquireState,
      NEXT_GAME_INTERACTION_PHASE_POST_GAME_WATCH
    );
  }
  expireClosureCaptureWindow(closureCaptureState, now, { log });
  if (
    nextGameReacquireState.active &&
    waitingForNextGame &&
    nextGameReacquireState.interactionPhase ===
      NEXT_GAME_INTERACTION_PHASE_CAPTURE_ARMED &&
    !isClosureCaptureArmed(closureCaptureState, now)
  ) {
    setNextGameInteractionPhase(
      nextGameReacquireState,
      NEXT_GAME_INTERACTION_PHASE_REACQUIRING
    );
  }
  const pageState = await readBootstrapPageState(
    cdp,
    bootstrapState,
    now,
    options.transientState,
    log
  );
  const bootstrapStatus = getBootstrapReadinessStatus(bootstrapState, now);
  const bootstrapReady = bootstrapStatus.ready;
  const bootstrapReason = bootstrapStatus.reason;
  const bootstrapJustBecameReady = bootstrapReady && !bootstrapState.lastReady;
  if (
    options.probePageState &&
    !options.suppressClosureCapture &&
    !bootstrapReady &&
    !bootstrapState.waitingLogged
  ) {
    log("[browser] waiting for TETR.IO bootstrap before closure capture");
    bootstrapState.waitingLogged = true;
  }
  if (
    options.probePageState &&
    !options.suppressClosureCapture &&
    !bootstrapReady &&
    (browserControlState.botEnabled ||
      hasPendingClosureCaptureArm(closureCaptureState) ||
      isClosureCaptureArmed(closureCaptureState, now)) &&
    shouldLogBootstrapBlocked(bootstrapState, bootstrapReason, now)
  ) {
    log("[browser] closure capture blocked reason=bootstrap_not_ready");
    log(`[browser] bootstrap readiness check failed reason=${bootstrapReason}`);
    markBootstrapBlockedLogged(bootstrapState, bootstrapReason, now);
  }
  if (
    options.probePageState &&
    !options.suppressClosureCapture &&
    bootstrapJustBecameReady &&
    !bootstrapState.readyLogged
  ) {
    log("[browser] TETR.IO bootstrap ready; closure capture enabled");
    bootstrapState.readyLogged = true;
  }
  if (
    nextGameReacquireState.active &&
    waitingForNextGame &&
    bootstrapReady &&
    nextGameReacquireState.interactionPhase ===
      NEXT_GAME_INTERACTION_PHASE_REACQUIRING &&
    Math.max(0, Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)) >
      Math.max(0, Number(nextGameReacquireState.lastInteractionGenerationHandled ?? 0)) &&
    Math.max(0, Number(nextGameReacquireState.pendingInteractionTimestamp ?? 0)) >
      Math.max(0, Number(nextGameReacquireState.startedAt ?? 0))
  ) {
    const forceCarriedInteractionArm =
      String(nextGameReacquireState.pendingInteractionSource ?? "") === "post_game";
    const preserveExistingProvisionalWindow =
      forceCarriedInteractionArm &&
      isAgainButtonProvisionalInteraction(nextGameReacquireState) &&
      isClosureCaptureArmed(closureCaptureState, now) &&
      Math.max(0, Number(nextGameReacquireState.interactionWindowGeneration ?? 0)) ===
        Math.max(0, Number(nextGameReacquireState.pendingInteractionGeneration ?? 0));
    if (!forceCarriedInteractionArm && isClosureCaptureArmed(closureCaptureState, now)) {
      // Keep the currently armed one-shot window alive for non-carried interactions.
    } else if (preserveExistingProvisionalWindow) {
      if (typeof log === "function") {
        log(
          `[browser] provisional window preserved across game end confirmation generation=${Math.max(
            0,
            Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)
          )}`
        );
      }
    } else {
    if (
      String(nextGameReacquireState.pendingInteractionSource ?? "") === "post_game"
    ) {
      log(
        `[browser] carried interaction requesting capture generation=${Math.max(
          0,
          Number(nextGameReacquireState.pendingInteractionGeneration ?? 0)
        )}`
      );
    }
    armPendingNextGameInteractionWindow(
      closureCaptureState,
      nextGameReacquireState,
      {
        now,
        bootstrapReady,
        log
      }
    );
    }
  }

  const read = async () => {
    const raw = await safeRuntimeEvaluate(cdp, {
      expression: tetrioStateExpression(),
      returnByValue: true
    }, {
      result: {
        value: {
          ok: false,
          ready: false,
          reason: "browser execution context not ready yet"
        }
      }
    }, {
      transientState: options.transientState,
      log
    });
    return raw.result?.value ?? { ok: false, ready: false, reason: "page probe returned empty" };
  };

  let state = await read();
  let skipCaptureThisPoll = false;
  const shouldPollInteraction =
    options.probePageState &&
    !options.suppressClosureCapture &&
    bootstrapReady &&
    browserControlState.botEnabled &&
    nextGameReacquireState.interactionPhase !==
      NEXT_GAME_INTERACTION_PHASE_CAPTURED_WAITING_START &&
    (
      (nextGameReacquireState.active && waitingForNextGame && !state.ok) ||
      (postGameInteractionWatchState.active && !nextGameReacquireState.active)
    );
  if (
    options.probePageState &&
    !options.suppressClosureCapture &&
    bootstrapReady &&
    browserControlState.botEnabled &&
    (
      (nextGameReacquireState.active && waitingForNextGame) ||
      (postGameInteractionWatchState.active &&
        isAgainButtonProvisionalInteraction(nextGameReacquireState))
    ) &&
    !state.ok
  ) {
    let fallbackEligible = !endedGameCandidate.objectId;
    if (endedGameCandidate.objectId) {
      if (
        now - Number(nextGameReacquireState.lastEndedObjectCheckAt ?? 0) >=
        DEFAULT_NEXT_GAME_FAST_LOCATOR_INTERVAL_MS
      ) {
        log("[browser] ended game object probe scheduled object_id_present=true");
        nextGameReacquireState.lastEndedObjectCheckAt = now;
        const endedProbeFn =
          options.readEndedGameCandidateStateFn ?? readEndedGameCandidateState;
        const endedProbe = await endedProbeFn(cdp, endedGameCandidate, {
          log
        }).catch((error) => ({
          status: "transient_error",
          reason: error?.message ?? String(error)
        }));
        if (
          shouldLogReacquireStatus(
            nextGameReacquireState.lastEndedObjectProbeStatus,
            String(endedProbe.status ?? "unknown"),
            nextGameReacquireState.lastEndedObjectProbeLogAt,
            now
          )
        ) {
          log(
            `[browser] ended game object probe status=${String(
              endedProbe.status ?? "unknown"
            )}`
          );
          nextGameReacquireState.lastEndedObjectProbeLogAt = now;
          nextGameReacquireState.lastEndedObjectProbeStatus = String(
            endedProbe.status ?? "unknown"
          );
        }
        if (
          (endedProbe.status === "valid_countdown" ||
            endedProbe.status === "valid_playing") &&
          endedProbe.reactivated &&
          endedProbe.state?.ok
        ) {
          log(
            `[browser] ended game object reactivated epoch=${Math.max(
              0,
              Number(endedGameCandidate.epoch ?? 0)
            )}->${Math.max(0, Number(endedGameCandidate.epoch ?? 0)) + 1}`
          );
          state = endedProbe.state;
        } else if (
          endedProbe.status === "object_released" ||
          endedProbe.status === "execution_context_destroyed" ||
          endedProbe.status === "invalid_object_id"
        ) {
          fallbackEligible = true;
          clearEndedGameCandidate(endedGameCandidate, endedProbe.status);
        }
      } else if (
        verboseReacquireLogs &&
        shouldLogReacquireStatus(
          nextGameReacquireState.lastEndedObjectProbeStatus,
          "interval_wait",
          nextGameReacquireState.lastEndedObjectProbeLogAt,
          now
        )
      ) {
        log("[browser] ended game object probe skipped reason=interval_wait");
        nextGameReacquireState.lastEndedObjectProbeLogAt = now;
        nextGameReacquireState.lastEndedObjectProbeStatus = "interval_wait";
      }
    } else if (
      shouldLogReacquireStatus(
        nextGameReacquireState.lastEndedObjectProbeStatus,
        "no_object_id",
        nextGameReacquireState.lastEndedObjectProbeLogAt,
        now
      )
    ) {
      log("[browser] ended game object probe skipped reason=no_object_id");
      nextGameReacquireState.lastEndedObjectProbeLogAt = now;
      nextGameReacquireState.lastEndedObjectProbeStatus = "no_object_id";
    }
    if (!state.ok) {
      if (
        now - Number(nextGameReacquireState.lastCheapSampledAt ?? 0) >=
        DEFAULT_NEXT_GAME_FAST_LOCATOR_INTERVAL_MS
      ) {
        nextGameReacquireState.lastCheapSampledAt = now;
      const cheapSignalFn =
          options.readCheapGameSignalFn ?? readCheapGameSignal;
        const cheapSignal = await cheapSignalFn(cdp, {
          transientState: options.transientState,
          log
        }).catch(() => ({ active: false, source: "none", label: "inactive", sources: [] }));
        if (
          now - Number(nextGameReacquireState.lastCheapSignalLogAt ?? 0) >= 5000 ||
          nextGameReacquireState.lastCheapSignalLabel !== String(cheapSignal?.label ?? "inactive")
        ) {
          for (const entry of Array.isArray(cheapSignal?.sources) ? cheapSignal.sources : []) {
            log(
              `[browser] cheap game signal source=${entry.source} value=${entry.value ? "true" : "false"} state=${entry.state}`
            );
          }
          nextGameReacquireState.lastCheapSignalLogAt = now;
          nextGameReacquireState.lastCheapSignalLabel = String(
            cheapSignal?.label ?? "inactive"
          );
        }
        const currentAggregate = String(cheapSignal?.label ?? "inactive");
        const previousAggregate = String(
          nextGameReacquireState.lastCheapAggregateState || ""
        );
        const cheapSignalActive = Boolean(cheapSignal?.active);
        const againTransitionReady =
          isAgainButtonProvisionalInteraction(nextGameReacquireState) &&
          isTransitionReadyForAgainProvisional(cheapSignal);
        const hardFallbackReady =
          isAgainButtonProvisionalInteraction(nextGameReacquireState) &&
          Math.max(0, Number(closureCaptureState.windowFirstInteractionAt ?? 0)) > 0 &&
          now - Math.max(0, Number(closureCaptureState.windowFirstInteractionAt ?? 0)) >=
            DEFAULT_AGAIN_PROVISIONAL_HARD_FALLBACK_MS;
        if (
          isAgainButtonProvisionalInteraction(nextGameReacquireState) &&
          (againTransitionReady || hardFallbackReady)
        ) {
          nextGameReacquireState.provisionalTransitionReady = true;
          if (
            nextGameReacquireState.interactionPhase ===
            NEXT_GAME_INTERACTION_PHASE_WAITING_TRANSITION_READY
          ) {
            setNextGameInteractionPhase(
              nextGameReacquireState,
              NEXT_GAME_INTERACTION_PHASE_REACQUIRING
            );
          }
          if (
            now - Number(nextGameReacquireState.provisionalTransitionReadyLoggedAt ?? 0) >= 1
          ) {
            log(
              againTransitionReady
                ? "[browser] AGAIN provisional transition ready; enabling targeted/broad fallback"
                : "[browser] AGAIN provisional hard fallback ready; enabling broad fallback"
            );
            nextGameReacquireState.provisionalTransitionReadyLoggedAt = now;
          }
          if (Number(closureCaptureState.nextAttemptAt ?? 0) > now) {
            closureCaptureState.nextAttemptAt = now;
          }
        }
        const qualifiesForArm =
          (previousAggregate === "result" || previousAggregate === "inactive") &&
          (currentAggregate === "countdown" || currentAggregate === "playing");
        if (qualifiesForArm) {
          log(
            `[browser] cheap game signal transition inactive->playing source=${String(
              cheapSignal?.source ?? "unknown"
            )}`
          );
          if (fallbackEligible) {
            requestClosureCaptureArm(closureCaptureState, {
              reason: "next_game_cheap_signal",
              now,
              bootstrapReady,
              log
            });
          }
        }
        nextGameReacquireState.lastCheapSignalState = cheapSignalActive;
        nextGameReacquireState.lastCheapAggregateState = currentAggregate;
      }
    }
  }
  if (
    shouldPollInteraction &&
    now - Number(nextGameReacquireState.lastFastAttemptAt ?? 0) >=
      DEFAULT_NEXT_GAME_INTERACTION_POLL_MS &&
    now - Number(postGameInteractionWatchState.lastPollAt ?? 0) >=
      DEFAULT_NEXT_GAME_INTERACTION_POLL_MS
  ) {
    nextGameReacquireState.lastFastAttemptAt = now;
    postGameInteractionWatchState.lastPollAt = now;
    const interactionStateFn =
      options.readNextGameInteractionStateFn ?? readNextGameInteractionState;
    const interaction = await interactionStateFn(cdp, {
      transientState: options.transientState,
      log
    }).catch(() => ({
      generation: 0,
      type: null,
      timestamp: 0,
      targetTag: null,
      targetId: null,
      targetClass: null
    }));
    const generation = Math.max(0, Number(interaction?.generation ?? 0));
    const timestamp = Math.max(0, Number(interaction?.timestamp ?? 0));
    if (generation > nextGameReacquireState.lastInteractionGenerationSeen) {
      nextGameReacquireState.lastInteractionGenerationSeen = generation;
      const keyLabel = interaction?.key ? ` key=${String(interaction.key)}` : "";
      const interactionKind = deriveInteractionKind(interaction);
      const kindLabel = interactionKind !== "other" ? ` interaction_kind=${interactionKind}` : "";
      log(
        `[browser] next-game interaction detected generation=${generation} type=${String(
          interaction?.type ?? "unknown"
        )}${keyLabel}${kindLabel} target=${String(interaction?.targetTag ?? "")}${
          interaction?.targetId ? `#${interaction.targetId}` : ""
        }`
      );
    }
    if (generation > postGameInteractionWatchState.lastInteractionGenerationSeen) {
      postGameInteractionWatchState.lastInteractionGenerationSeen = generation;
    }
    if (
      postGameInteractionWatchState.active &&
      rememberPendingPostGameInteraction(postGameInteractionWatchState, interaction)
    ) {
      log(
        `[browser] post-game interaction captured before end confirmation generation=${generation} type=${String(
          interaction?.type ?? "unknown"
        )}`
      );
      if (
        browserControlState.botEnabled &&
        isTrustedNextGameInteraction(interaction) &&
        generation > Math.max(0, Number(postGameInteractionWatchState.provisionalArmedGeneration ?? 0))
      ) {
        postGameInteractionWatchState.provisionalArmedGeneration = generation;
        recordProvisionalInteraction(nextGameReacquireState, interaction);
        closureCaptureState.windowFirstInteractionAt = timestamp;
        nextGameReacquireState.interactionWindowGeneration = generation;
        nextGameReacquireState.interactionWindowArmedAt = now;
        setNextGameInteractionPhase(
          nextGameReacquireState,
          deriveInteractionKind(interaction) === "again_button"
            ? NEXT_GAME_INTERACTION_PHASE_WAITING_TRANSITION_READY
            : NEXT_GAME_INTERACTION_PHASE_CAPTURE_ARMED
        );
        log(`[browser] trusted next-game interaction provisional arm generation=${generation}`);
        log(`[perf] next_game_interaction_to_arm_ms=${Math.max(0, now - timestamp)}`);
        requestClosureCaptureArm(closureCaptureState, {
          reason: "next_game_provisional_interaction",
          now,
          bootstrapReady,
          log
        });
        closureCaptureState.nextAttemptAt = now + DEFAULT_TARGETED_PAUSED_PROBE_DELAY_MS;
        skipCaptureThisPoll = true;
      }
    }
    const interactionIsFresh =
      nextGameReacquireState.interactionPhase ===
        NEXT_GAME_INTERACTION_PHASE_REACQUIRING &&
      generation >
        Math.max(
          0,
          Number(nextGameReacquireState.interactionBaselineGeneration ?? 0)
        ) &&
      timestamp > Math.max(0, Number(nextGameReacquireState.startedAt ?? 0));
    if (
      interactionIsFresh &&
      generation > nextGameReacquireState.lastInteractionGenerationHandled
    ) {
      const interactionWindowAlreadyArmed =
        isClosureCaptureArmed(closureCaptureState, now) &&
        closureCaptureState.armedReason === "next_game_user_interaction";
      if (!interactionWindowAlreadyArmed) {
        const armed = armNextGameInteractionWindow(
          closureCaptureState,
          nextGameReacquireState,
          {
            generation,
            now,
            bootstrapReady,
            log
          }
        );
        if (armed) {
          nextGameReacquireState.lastInteractionGenerationHandled = generation;
          clearPendingNextGameInteraction(nextGameReacquireState);
        }
      } else {
        rememberPendingNextGameInteraction(nextGameReacquireState, interaction);
      }
    }
  }
  if (
    options.probePageState &&
    !options.suppressClosureCapture &&
    bootstrapJustBecameReady &&
    browserControlState.botEnabled &&
    !state.ok &&
    closureCaptureState.armedReason !== "next_game_user_interaction" &&
    !isProvisionalClosureCaptureReason(closureCaptureState.armedReason) &&
    !isCarriedClosureCaptureReason(closureCaptureState.armedReason)
  ) {
    if (hasPendingClosureCaptureArm(closureCaptureState)) {
      activatePendingClosureCaptureArm(closureCaptureState, {
        now,
        log
      });
    } else if (isClosureCaptureArmed(closureCaptureState, now)) {
      reactivateClosureCaptureArmAfterBootstrap(closureCaptureState, {
        now,
        log
      });
    }
  }
  const carriedInteractionExpected =
    browserControlState.botEnabled &&
    waitingForNextGame &&
    nextGameReacquireState.active &&
    hasUnhandledCarriedPostGameInteraction(nextGameReacquireState);
  const gameplayExpected = isGameplayExpectedForClosureCapture({
    state,
    activeRoundId: options.activeRoundId ?? "",
    closureCaptureState,
    carriedInteractionExpected,
    now
  });
  if (
    options.probePageState &&
    !options.suppressClosureCapture &&
    bootstrapReady &&
    !state.ok &&
    shouldLogClosureCaptureSkipped({
      gameplayExpected,
      lastSkippedLogAt: closureCaptureState.lastSkippedLogAt,
      now
    })
  ) {
    log(
      `[browser] closure capture skipped; gameplay not expected phase=${String(
        nextGameReacquireState.interactionPhase ?? NEXT_GAME_INTERACTION_PHASE_INACTIVE
      )} carried_pending=${carriedInteractionExpected ? "true" : "false"} pending_source=${String(
        nextGameReacquireState.pendingInteractionSource ?? ""
      )}`
    );
    closureCaptureState.lastSkippedLogAt = now;
  }
  const shouldCapture = shouldAttemptClosureCapture({
    probePageState: options.probePageState,
    suppressClosureCapture: options.suppressClosureCapture,
    bootstrapReady,
    stateOk:
      isProvisionalClosureCaptureReason(closureCaptureState.armedReason)
        ? false
        : state.ok,
    gameplayExpected,
    nextAttemptAt: closureCaptureState.nextAttemptAt,
    lastCaptureAt: options.probeState?.lastCaptureAt ?? 0,
    lastPageProbeAt: options.network?.lastPageProbeAt ?? 0,
    now
  });
  const shouldCaptureWithWindow =
    shouldCapture &&
    !skipCaptureThisPoll &&
    !isClosureCaptureWindowExhausted(closureCaptureState);
  if (shouldCaptureWithWindow) {
    const pausedUsedMs = Math.max(
      0,
      Number(closureCaptureState.cumulativePausedScanBudgetUsedMs ?? 0)
    );
    log(
      `[browser] closure scan gate capture_attempts=${Math.max(
        0,
        Number(closureCaptureState.captureAttemptsInWindow ?? 0)
      )} full_scan_attempts=${Math.max(
        0,
        Number(closureCaptureState.fullScanAttemptsInWindow ?? 0)
      )} paused_used_ms=${pausedUsedMs} remaining_paused_ms=${Math.max(
        0,
        DEFAULT_FULL_SCAN_CUMULATIVE_BUDGET_MS - pausedUsedMs
      )} cursor=${formatClosureCaptureCursorLabel(
        closureCaptureState.pausedScopeScanCursor
      )} exhausted=${closureCaptureState.scanBudgetExhausted ? "true" : "false"} gameplay_expected=${gameplayExpected ? "true" : "false"}`
    );
  }

  if (shouldCaptureWithWindow) {
    if (closureCaptureState.firstAttemptLoggedForReason !== closureCaptureState.armedReason) {
      log(`[browser] closure capture first attempt reason=${closureCaptureState.armedReason}`);
      closureCaptureState.firstAttemptLoggedForReason = closureCaptureState.armedReason;
    }
    const captureStartedAt = Date.now();
    options.probeState.lastCaptureAt = now;
    if (options.network) {
      options.network.lastPageProbeAt = now;
    }
    const captureFn = options.captureGameFn ?? captureTetrioGame;
    const isProvisionalCapture = isProvisionalClosureCaptureReason(
      closureCaptureState.armedReason
    );
    const isAgainButtonProvisionalCapture =
      isProvisionalCapture && isAgainButtonProvisionalInteraction(nextGameReacquireState);
    const isFollowupFastCapture =
      closureCaptureState.pendingFollowupFastCapture === true;
    const allowBroadScan =
      !isAgainButtonProvisionalCapture ||
      nextGameReacquireState.provisionalTransitionReady === true;
    if (
      !closureCaptureState.windowTargetedProbeAt &&
      (closureCaptureState.lastSuccessfulPausedLocation || isProvisionalCapture)
    ) {
      closureCaptureState.windowTargetedProbeAt = now;
      if (closureCaptureState.windowArmedAt > 0) {
        log(
          `[perf] next_game_arm_to_targeted_probe_ms=${Math.max(
            0,
            now - Number(closureCaptureState.windowArmedAt ?? 0)
          )}`
        );
      }
    }
    const capture = await captureFn(cdp, {
      closureCaptureState,
      log,
      requireActiveGame: isProvisionalCapture,
      pauseTimeoutMs:
        isFollowupFastCapture || (isAgainButtonProvisionalCapture && !allowBroadScan)
          ? DEFAULT_FOLLOWUP_FAST_CAPTURE_TIMEOUT_MS
          : 900,
      allowBroadScan
    }).catch((error) => ({
      ok: false,
      reason: error?.message ?? String(error)
    }));
    closureCaptureState.pendingFollowupFastCapture = false;
    if (options.perfEnabled) {
      console.log(
        `[browser-perf] closure_capture elapsed_ms=${Math.max(0, Date.now() - captureStartedAt)}`
      );
    }
    if (capture.ok) {
      if (capture.locator) {
        closureCaptureState.lastSuccessfulLocator = String(capture.locator);
      }
      if (capture.progress) {
        closureCaptureState.lastSuccessfulPausedLocation = {
          frameIndex: Math.max(0, Number(capture.progress.frameIndex ?? 0)),
          scopeIndex: Math.max(0, Number(capture.progress.scopeIndex ?? 0)),
          candidateIndex: Math.max(0, Number(capture.progress.candidateIndex ?? 0)),
          locator: String(capture.locator ?? ""),
          propertyKey: String(capture.locator ?? "")
        };
      }
      if (closureCaptureState.windowArmedAt > 0) {
        log(
          `[perf] next_game_arm_to_capture_ms=${Math.max(
            0,
            now - Number(closureCaptureState.windowArmedAt ?? 0)
          )}`
        );
      }
      if (closureCaptureState.windowFirstInteractionAt > 0) {
        log(
          `[perf] next_game_interaction_to_capture_ms=${Math.max(
            0,
            now - Number(closureCaptureState.windowFirstInteractionAt ?? 0)
          )}`
        );
      }
      await releaseEndedGameCandidateHandle(cdp, endedGameCandidate, {
        reason: "new_capture_success",
        log
      }).catch(() => undefined);
      consumeNextGameInteractionWindow(closureCaptureState, nextGameReacquireState, {
        reason: "capture_success",
        log: () => {}
      });
      disarmClosureCaptureWindow(closureCaptureState, {
        reason: "capture_success",
        log
      });
      console.log(`[browser] page probe exposed game object via ${capture.source}`);
      state = await read();
      if (
        nextGameReacquireState.active &&
        waitingForNextGame &&
        state?.reason === "TETR.IO game is not started"
      ) {
        clearPendingNextGameInteraction(nextGameReacquireState);
        nextGameReacquireState.lastInteractionGenerationHandled = Math.max(
          Math.max(0, Number(nextGameReacquireState.lastInteractionGenerationHandled ?? 0)),
          Math.max(0, Number(nextGameReacquireState.interactionWindowGeneration ?? 0))
        );
        setNextGameInteractionPhase(
          nextGameReacquireState,
          NEXT_GAME_INTERACTION_PHASE_CAPTURED_WAITING_START
        );
      } else if (
        nextGameReacquireState.active &&
        waitingForNextGame &&
        !state?.ok
      ) {
        setNextGameInteractionPhase(
          nextGameReacquireState,
          NEXT_GAME_INTERACTION_PHASE_REACQUIRING
        );
      }
    } else if (state.reason) {
      const fullScanOutcome = String(capture.outcome ?? "");
      const hasResumeCursor = Boolean(capture.resumeCursor);
      const continuationEligible =
        fullScanOutcome === "continuation_required" &&
        hasResumeCursor &&
        !capture.windowBudgetExhausted &&
        closureCaptureState.fullScanAttemptsInWindow < MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW &&
        isClosureCaptureArmed(closureCaptureState, now);
      if (continuationEligible) {
        saveClosureCaptureContinuationCursor(
          closureCaptureState,
          capture.resumeCursor,
          log
        );
        const continuationDelayMs = DEFAULT_FULL_SCAN_CONTINUATION_BACKOFF_MS;
        scheduleClosureCaptureContinuation(
          closureCaptureState,
          now,
          continuationDelayMs
        );
        log(
          `[browser] full closure scan continuation resume cursor=${formatClosureCaptureCursorLabel(
            capture.resumeCursor
          )}`
        );
        if (capture.continuationReason === "paused_scope_limit_reached") {
          log("[browser] full closure scan paused scope limit reached; scheduling continuation");
        } else {
          log("[browser] full closure scan paused budget reached; scheduling continuation");
        }
      } else if (
        capture.outcome === "targeted_only_miss" &&
        isAgainButtonProvisionalCapture &&
        nextGameReacquireState.provisionalTransitionReady !== true
      ) {
        closureCaptureState.provisionalNonHeavyAttemptConsumed = true;
        setNextGameInteractionPhase(
          nextGameReacquireState,
          NEXT_GAME_INTERACTION_PHASE_WAITING_TRANSITION_READY
        );
        closureCaptureState.nextAttemptAt = now + DEFAULT_CAPTURE_ARMING_WINDOW_MS;
        log(
          `[browser] AGAIN provisional targeted miss; waiting for transition readiness generation=${Math.max(
            0,
            Number(nextGameReacquireState.interactionWindowGeneration ?? 0)
          )}`
        );
        log("[browser] broad scan suppressed while AGAIN transition is not ready");
      } else if (
        fullScanOutcome === "completed_not_found" &&
        !capture.windowBudgetExhausted &&
        closureCaptureState.fullScanAttemptsInWindow < MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW &&
        isClosureCaptureArmed(closureCaptureState, now)
      ) {
        closureCaptureState.pendingFollowupFastCapture = true;
        scheduleClosureCaptureContinuation(
          closureCaptureState,
          now,
          DEFAULT_TARGETED_PAUSED_PROBE_BACKOFF_MS
        );
      } else if (
        capture.reason === "TETR.IO full closure scan cumulative budget exhausted" ||
        capture.windowBudgetExhausted === true ||
        closureCaptureState.scanBudgetExhausted === true ||
        ((fullScanOutcome === "continuation_required" ||
          fullScanOutcome === "completed_not_found") &&
          closureCaptureState.fullScanAttemptsInWindow >= MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW)
      ) {
        consumeNextGameInteractionWindow(closureCaptureState, nextGameReacquireState, {
          reason: "scan_budget_exhausted",
          log
        });
        disarmClosureCaptureWindow(closureCaptureState, {
          reason: "scan_budget_exhausted",
          log
        });
      } else {
        scheduleNextClosureCaptureAttempt(closureCaptureState, now);
      }
      state = {
        ...state,
        reason: `${state.reason}; page probe: ${capture.reason}`
      };
    }
  }

  bootstrapState.lastReady = bootstrapReady;
  options.probeState.lastGameplayPhase = deriveGameplayPhase(state);

  if (options.suppressClosureCapture && !state.ok) {
    return {
      ...state,
      reason: options.suppressedReason ?? DEFAULT_SUPPRESSED_REASON
    };
  }

  if (state.ok) {
    return state;
  }
  if (!options.useSeedSimulationFallback || !options.network.seed) {
    return state;
  }
  return buildSeedFallbackState(options.network);
}

export async function captureTetrioGame(
  cdp,
  {
    closureCaptureState = null,
    log = console.log,
    requireActiveGame = false,
    pauseTimeoutMs = 900,
    allowBroadScan = true
  } = {}
) {
  const breakpointIds = [];
  let paused = false;

  try {
    if (closureCaptureState) {
      closureCaptureState.captureAttemptsInWindow += 1;
    }
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

    let event;
    try {
      event = await cdp.waitForEvent(
        "Debugger.paused",
        () => true,
        pauseTimeoutMs
      );
    } catch {
      event = null;
    }
    if (!event) {
      return {
        ok: false,
        reason: "TETR.IO game closure not visible yet",
        outcome: "preflight_not_visible"
      };
    }

    paused = true;
    const exposed = await exposeTetrioGameFromPausedCallFrames(cdp, event, {
      closureCaptureState,
      log,
      requireActiveGame,
      allowBroadScan
    });
    await cdp.send("Debugger.resume").catch(() => undefined);
    paused = false;
    if (exposed.ok) {
      return {
        ...exposed,
        outcome: exposed.outcome ?? "full_scan_found"
      };
    }

    return exposed.reason
      ? exposed
      : {
          ok: false,
          reason: "TETR.IO game closure not visible yet",
          outcome: "preflight_not_visible"
        };
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

export async function safeRuntimeEvaluate(
  cdp,
  params,
  fallbackResult = null,
  { transientState = null, log = console.log } = {}
) {
  try {
    return await cdp.send("Runtime.evaluate", params);
  } catch (error) {
    if (isTransientRuntimeError(error)) {
      maybeLogTransientRuntimeError(error, transientState, log);
      return fallbackResult;
    }
    throw error;
  }
}

export async function exposeTetrioGameFromPausedCallFrames(
  cdp,
  pausedEvent,
  {
    closureCaptureState = null,
    log = console.log,
    requireActiveGame = false,
    allowBroadScan = true
  } = {}
) {
  const locatorHint = String(closureCaptureState?.lastSuccessfulLocator ?? "").trim();
  const resumeCursorLabel = formatClosureCaptureCursorLabel(
    closureCaptureState?.pausedScopeScanCursor
  );
  if (locatorHint) {
    if (closureCaptureState) {
      closureCaptureState.fastLocatorAttempted = true;
    }
    const hinted = await exposeTetrioGameViaLocatorHint(cdp, pausedEvent, locatorHint);
    if (hinted.ok) {
      log(`[browser] fast closure locator succeeded locator=${locatorHint}`);
      return hinted;
    }
    if (closureCaptureState) {
      closureCaptureState.lastSuccessfulLocator = "";
    }
    log("[browser] fast closure locator failed; falling back to scan");
  }
  if (closureCaptureState?.lastSuccessfulPausedLocation) {
    const hinted = await probeTargetedPausedLocation(cdp, pausedEvent, closureCaptureState, {
      log,
      requireActiveGame
    });
    if (hinted.ok) {
      return hinted;
    }
  }
  if (!allowBroadScan) {
    return {
      ok: false,
      reason: "AGAIN provisional targeted miss before transition readiness",
      outcome: "targeted_only_miss"
    };
  }
  const nextFullScanAttempt = (closureCaptureState?.fullScanAttemptsInWindow ?? 0) + 1;
  if (closureCaptureState?.fullScanAttemptsInWindow >= MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW) {
    if (closureCaptureState) {
      closureCaptureState.scanBudgetExhausted = true;
    }
    return {
      ok: false,
      reason: "TETR.IO full closure scan cumulative budget exhausted",
      outcome: "continuation_required",
      continuationReason: "paused_budget_reached",
      windowBudgetExhausted: true
    };
  }
  log(
    resumeCursorLabel !== "none"
      ? `[browser] full closure scan attempt=${nextFullScanAttempt}/${MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW} resume_from=${resumeCursorLabel}`
      : `[browser] full closure scan attempt=${nextFullScanAttempt}/${MAX_FULL_SCAN_ATTEMPTS_PER_WINDOW}`
  );
  if (closureCaptureState) {
    closureCaptureState.fullScanAttemptsInWindow = nextFullScanAttempt;
  }
  const scanStartedAt = Date.now();
  const scanned = await exposeTetrioGameViaPausedScopeScan(cdp, pausedEvent, {
    closureCaptureState,
    requireActiveGame
  });
  logPausedScopeScanProgress(log, scanned.progress ?? null);
  if (!scanned.ok && scanned.outcome === "continuation_required") {
    if (scanned.resumeCursor) {
      logPausedScopeScanContinuation(log, scanned.resumeCursor);
    } else {
      log("[browser] invalid full closure scan continuation without cursor; treating as completed_not_found");
      scanned.outcome = "completed_not_found";
      scanned.continuationReason = "invalid_resume_cursor";
    }
  }
  if (!scanned.ok && scanned.outcome === "continuation_required") {
    log(
      `[browser] full closure scan aborted budget_ms=${Math.max(0, Date.now() - scanStartedAt)}`
    );
  }
  return scanned;
}

export async function exposeTetrioGameViaLocatorHint(cdp, pausedEvent, locatorName) {
  for (const callFrame of pausedEvent.callFrames ?? []) {
    const result = await cdp.send("Debugger.evaluateOnCallFrame", {
      callFrameId: callFrame.callFrameId,
      expression: pausedFrameExposureExpression(locatorName),
      returnByValue: true,
      silent: true
    }).catch(() => null);
    const value = result?.result?.value;
    if (value?.ok) {
      return value;
    }
  }
  return { ok: false, reason: `TETR.IO locator ${locatorName} was not visible in paused scopes` };
}

export async function exposeTetrioGameViaPausedScopeScan(
  cdp,
  pausedEvent,
  {
    closureCaptureState = null,
    perScanBudgetMs = DEFAULT_FULL_SCAN_PAUSE_BUDGET_MS,
    cumulativeBudgetMs = DEFAULT_FULL_SCAN_CUMULATIVE_BUDGET_MS,
    requireActiveGame = false
  } = {}
) {
  const callFrames = pausedEvent?.callFrames ?? [];
  const frameOrder = getPausedScopeScanFrameOrder(callFrames);
  const persistedCursor =
    closureCaptureState?.pausedScopeScanCursor ?? {
      ...createPausedScopeScanCursor(),
      frameIndex: frameOrder[0] ?? 0
    };
  const completedScopeKeys = new Set(persistedCursor.completedScopeKeys ?? []);
  const seenCandidateKeys = new Set(persistedCursor.seenCandidateKeys ?? []);
  const budgetUsedMs = Math.max(
    0,
    Number(closureCaptureState?.cumulativePausedScanBudgetUsedMs ?? 0)
  );
  const remainingWindowBudgetMs = Math.max(0, cumulativeBudgetMs - budgetUsedMs);
  if (remainingWindowBudgetMs <= 0) {
    if (closureCaptureState) {
      closureCaptureState.scanBudgetExhausted = true;
    }
    return {
      ok: false,
      reason: "TETR.IO full closure scan cumulative budget exhausted",
      outcome: "continuation_required",
      continuationReason: "paused_budget_reached",
      windowBudgetExhausted: true,
      progress: {
        attempt: Math.max(1, Number(closureCaptureState?.fullScanAttemptsInWindow ?? 1)),
        ...formatScanCursor(persistedCursor),
        inspectedObjects: seenCandidateKeys.size,
        pausedMs: 0
      },
      resumeCursor: formatScanCursor(persistedCursor)
    };
  }

  const scanStartedAt = Date.now();
  const scanBudgetMs = Math.max(
    1,
    Math.min(Math.max(1, perScanBudgetMs), remainingWindowBudgetMs)
  );
  let candidatesVisited = 0;

  const updateBudgetUsed = () => {
    if (closureCaptureState) {
      closureCaptureState.cumulativePausedScanBudgetUsedMs = Math.min(
        cumulativeBudgetMs,
        budgetUsedMs + Math.max(0, Date.now() - scanStartedAt)
      );
    }
  };

  const persistPartial = ({
    frameIndex,
    scopeIndex,
    propertyIndex,
    descriptorsLength = 0,
    continuationReason = "paused_budget_reached",
    advancePastCurrentProperty = false
  }) => {
    updateBudgetUsed();
    const windowBudgetExhausted =
      (closureCaptureState?.cumulativePausedScanBudgetUsedMs ?? 0) >= cumulativeBudgetMs;
    const resumeCursor = computePausedScopeScanResumeCursor(callFrames, {
      frameIndex,
      scopeIndex,
      propertyIndex,
      descriptorsLength,
      advancePastCurrentProperty
    });
    if (!resumeCursor && !windowBudgetExhausted) {
      if (closureCaptureState) {
        clearPausedScopeScanCursor(closureCaptureState);
        closureCaptureState.scanBudgetExhausted = false;
      }
      return {
        ok: false,
        reason: "TETR.IO active game variable was not in paused scopes",
        outcome: "completed_not_found",
        progress: {
          attempt: Math.max(1, Number(closureCaptureState?.fullScanAttemptsInWindow ?? 1)),
          frameIndex,
          scopeIndex,
          candidateIndex: propertyIndex,
          inspectedObjects: seenCandidateKeys.size,
          pausedMs: Math.max(0, Date.now() - scanStartedAt)
        }
      };
    }
    if (closureCaptureState) {
      closureCaptureState.pausedScopeScanCursor = resumeCursor ? {
        frameIndex: resumeCursor.frameIndex,
        scopeIndex: resumeCursor.scopeIndex,
        propertyIndex: resumeCursor.propertyIndex,
        completedScopeKeys: Array.from(completedScopeKeys),
        seenCandidateKeys: Array.from(seenCandidateKeys)
      } : null;
      closureCaptureState.scanBudgetExhausted = windowBudgetExhausted;
    }
    return {
      ok: false,
      reason: windowBudgetExhausted
        ? "TETR.IO full closure scan cumulative budget exhausted"
        : continuationReason === "paused_scope_limit_reached"
          ? "TETR.IO paused scope scan limit reached"
          : "TETR.IO paused scope scan pause budget reached",
      outcome: "continuation_required",
      continuationReason,
      windowBudgetExhausted,
      progress: {
        attempt: Math.max(1, Number(closureCaptureState?.fullScanAttemptsInWindow ?? 1)),
        frameIndex,
        scopeIndex,
        candidateIndex: propertyIndex,
        inspectedObjects: seenCandidateKeys.size,
        pausedMs: Math.max(0, Date.now() - scanStartedAt)
      },
      resumeCursor: resumeCursor ? formatScanCursor(resumeCursor) : null
    };
  };

  const isScanBudgetExhausted = () => Date.now() - scanStartedAt >= scanBudgetMs;

  const startFrameOrderIndex = Math.max(
    0,
    frameOrder.indexOf(persistedCursor.frameIndex ?? frameOrder[0] ?? 0)
  );
  for (let frameOrderIndex = startFrameOrderIndex; frameOrderIndex < frameOrder.length; frameOrderIndex += 1) {
    const frameIndex = frameOrder[frameOrderIndex];
    const callFrame = callFrames[frameIndex];
    const scopeChain = callFrame?.scopeChain ?? [];
    const initialScopeIndex =
      frameIndex === (persistedCursor.frameIndex ?? 0)
        ? persistedCursor.scopeIndex ?? 0
        : 0;
    for (let scopeIndex = initialScopeIndex; scopeIndex < scopeChain.length; scopeIndex += 1) {
      const scope = scopeChain[scopeIndex];
      const scopeObjectId = scope?.object?.objectId;
      const scopeKey = `${frameIndex}:${scopeIndex}:${scopeObjectId ?? ""}`;
      if (!scopeObjectId || completedScopeKeys.has(scopeKey)) {
        continue;
      }
      const initialPropertyIndex =
        frameIndex === (persistedCursor.frameIndex ?? 0) &&
        scopeIndex === (persistedCursor.scopeIndex ?? 0)
          ? persistedCursor.propertyIndex ?? 0
          : 0;
      if (isScanBudgetExhausted()) {
        return persistPartial({
          frameIndex,
          scopeIndex,
          propertyIndex: initialPropertyIndex,
          descriptorsLength: Number.MAX_SAFE_INTEGER,
          continuationReason: "paused_budget_reached"
        });
      }
      const properties = await cdp.send("Runtime.getProperties", {
        objectId: scopeObjectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
        generatePreview: false
      }).catch(() => null);
      const descriptors = (properties?.result ?? [])
        .slice(0, MAX_SCOPE_PROPERTIES_PER_SCOPE)
        .map((descriptor, index) => ({ descriptor, index }))
        .sort((left, right) => {
          const scoreDelta =
            scorePausedScopeDescriptor(right.descriptor) -
            scorePausedScopeDescriptor(left.descriptor);
          return scoreDelta !== 0 ? scoreDelta : left.index - right.index;
        })
        .map(({ descriptor }) => descriptor);
      for (
        let propertyIndex = initialPropertyIndex;
        propertyIndex < descriptors.length;
        propertyIndex += 1
      ) {
        if (isScanBudgetExhausted()) {
          return persistPartial({
            frameIndex,
            scopeIndex,
            propertyIndex,
            descriptorsLength: descriptors.length,
            continuationReason: "paused_budget_reached"
          });
        }
        const descriptor = descriptors[propertyIndex];
        if (descriptor?.get || descriptor?.set) {
          continue;
        }
        const valueObjectId = descriptor?.value?.objectId;
        const locator = String(descriptor?.name ?? "").trim();
        if (!valueObjectId || !locator) {
          continue;
        }
        const candidateKey =
          `${frameIndex}:${scopeIndex}:${scopeObjectId}:${locator}:${valueObjectId}`;
        if (seenCandidateKeys.has(candidateKey)) {
          continue;
        }
        candidatesVisited += 1;
        if (candidatesVisited > MAX_PAUSED_SCOPE_SCAN_CANDIDATES_PER_ATTEMPT) {
          return persistPartial({
            frameIndex,
            scopeIndex,
            propertyIndex,
            descriptorsLength: descriptors.length,
            continuationReason: "paused_scope_limit_reached",
            advancePastCurrentProperty: true
          });
        }
        seenCandidateKeys.add(candidateKey);
        const exposed = await exposeTetrioCandidateObjectWithOptions(
          cdp,
          valueObjectId,
          locator,
          { requireActiveGame }
        );
        if (exposed.ok) {
          updateBudgetUsed();
          clearPausedScopeScanCursor(closureCaptureState);
          if (closureCaptureState) {
            closureCaptureState.scanBudgetExhausted = false;
          }
          return {
            ...exposed,
            outcome: "full_scan_found",
            progress: {
              attempt: Math.max(1, Number(closureCaptureState?.fullScanAttemptsInWindow ?? 1)),
              frameIndex,
              scopeIndex,
              candidateIndex: propertyIndex,
              inspectedObjects: seenCandidateKeys.size,
              pausedMs: Math.max(0, Date.now() - scanStartedAt)
            }
          };
        }
      }
      completedScopeKeys.add(scopeKey);
    }
  }

  updateBudgetUsed();
  clearPausedScopeScanCursor(closureCaptureState);
  if (closureCaptureState) {
    closureCaptureState.scanBudgetExhausted = false;
  }
  return {
    ok: false,
    reason: "TETR.IO active game variable was not in paused scopes",
    outcome: "completed_not_found",
    progress: {
      attempt: Math.max(1, Number(closureCaptureState?.fullScanAttemptsInWindow ?? 1)),
      frameIndex: callFrames.length === 0 ? 0 : Math.max(0, callFrames.length - 1),
      scopeIndex: 0,
      candidateIndex: 0,
      inspectedObjects: seenCandidateKeys.size,
      pausedMs: Math.max(0, Date.now() - scanStartedAt)
    }
  };
}

export async function exposeTetrioCandidateObject(cdp, objectId, locatorName) {
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      try {
        if (
          !this ||
          typeof this !== "object" ||
          typeof this.ejectState !== "function" ||
          typeof this.ejectBoardState !== "function"
        ) {
          return { ok: false };
        }
        const exported = this.ejectState();
        const state =
          exported && typeof exported === "object" && exported.game
            ? exported.game
            : exported;
        const requireActiveGame = ${JSON.stringify(false)};
        if (state?.destroyed || state?.dead || state?.gameover) {
          return { ok: false };
        }
        window.__fusionTetrioGame = this;
        window.__fusionTetrioBridge = {
          ok: true,
          source: ${JSON.stringify("closure:" + locatorName)},
          locator: ${JSON.stringify(locatorName)},
          at: Date.now(),
          href: location.href
        };
        return window.__fusionTetrioBridge;
      } catch {
        return { ok: false };
      }
    }`,
    returnByValue: true,
    silent: true
  }).catch(() => null);
  return result?.result?.value ?? { ok: false };
}

async function exposeTetrioCandidateObjectWithOptions(
  cdp,
  objectId,
  locatorName,
  {
    requireActiveGame = false
  } = {}
) {
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      try {
        if (
          !this ||
          typeof this !== "object" ||
          typeof this.ejectState !== "function" ||
          typeof this.ejectBoardState !== "function"
        ) {
          return { ok: false };
        }
        const exported = this.ejectState();
        const state =
          exported && typeof exported === "object" && exported.game
            ? exported.game
            : exported;
        if (state?.destroyed || state?.dead || state?.gameover) {
          return { ok: false };
        }
        if (${requireActiveGame ? "true" : "false"} && state?.playing !== true && state?.countdown !== true) {
          return { ok: false };
        }
        window.__fusionTetrioGame = this;
        window.__fusionTetrioBridge = {
          ok: true,
          source: ${JSON.stringify("closure:" + locatorName)},
          locator: ${JSON.stringify(locatorName)},
          at: Date.now(),
          href: location.href
        };
        return window.__fusionTetrioBridge;
      } catch {
        return { ok: false };
      }
    }`,
    returnByValue: true,
    silent: true
  }).catch(() => null);
  return result?.result?.value ?? { ok: false };
}

export function pausedFrameExposureExpression(locatorName = "Ai") {
  return `(() => {
    try {
      const locator = ${JSON.stringify(locatorName)};
      const candidate = locator ? (() => {
        try {
          return eval(locator);
        } catch {
          return undefined;
        }
      })() : undefined;
      if (
        candidate &&
        typeof candidate.ejectState === "function" &&
        typeof candidate.ejectBoardState === "function"
      ) {
        if (candidate === window.__fusionEndedTetrioGame) {
          try {
            const exported = candidate.ejectState();
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

        window.__fusionTetrioGame = candidate;
        window.__fusionTetrioBridge = {
          ok: true,
          source: locator ? "closure:" + locator : "closure",
          locator: locator || null,
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
