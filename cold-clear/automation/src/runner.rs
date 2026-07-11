use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use cold_clear::evaluation::Standard;
use cold_clear::{Info, Interface};
use libtetris::{
    find_moves, Board, FallingPiece, Move, MovementMode, Piece, PieceMovement, Placement,
    RotationState, SpawnRule,
};

use crate::config::{
    AutomationConfig, HandlingConfig, MovementModeConfig, SoftDropModeConfig, SpawnRuleConfig,
};
use crate::driver::{
    execute_hard_drop_action, execute_plan_until_hard_drop, execute_single_action, ExecutionPlan,
    ExecutionTimings, GameAction, InputBackend,
};
use crate::scanner::{
    read_snapshot_file, GameSnapshot, PieceToken, RotationToken, SnapshotPollMetrics,
    SnapshotScanner,
};

const PERF_LOG_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Default)]
struct RunnerPerfTracker {
    snapshot_read_samples: Vec<u128>,
    planner_samples: Vec<u128>,
    input_samples: Vec<u128>,
    total_samples: Vec<u128>,
    processed_snapshots: u64,
    duplicate_skips: u64,
    same_token_skips: u64,
    last_flush_at: Option<Instant>,
}

#[allow(dead_code)]
pub fn run_loop<S: SnapshotScanner, D: InputBackend + ?Sized>(
    config: &AutomationConfig,
    scanner: &mut S,
    driver: &mut D,
) -> Result<()> {
    let stop = AtomicBool::new(false);
    let live_target_pps = Arc::new(AtomicU32::new(config.target_pps.to_bits()));
    run_loop_until(
        config,
        scanner,
        driver,
        live_target_pps.as_ref(),
        &stop,
        |line| {
            println!("{}", line);
        },
    )
}

pub fn run_loop_until<S, D, F>(
    config: &AutomationConfig,
    scanner: &mut S,
    driver: &mut D,
    live_target_pps: &AtomicU32,
    stop: &AtomicBool,
    mut log: F,
) -> Result<()>
where
    S: SnapshotScanner,
    D: InputBackend + ?Sized,
    F: FnMut(String),
{
    let poll_delay = Duration::from_millis(config.poll_interval_ms);
    let piece_interval = Duration::from_millis(config.piece_interval_ms);
    let mut last_piece_counter = None;
    let mut last_hard_drop_started_at = None;
    let execution_timings = ExecutionTimings {
        tap_duration: Duration::from_millis(config.tap_duration_ms),
        movement_tap_duration: Duration::from_millis(config.movement_tap_duration_ms),
        rotate_tap_duration: Duration::from_millis(config.rotate_tap_duration_ms),
        hold_tap_duration: Duration::from_millis(config.hold_tap_duration_ms),
        hard_drop_tap_duration: Duration::from_millis(config.hard_drop_tap_duration_ms),
        soft_drop_tap_duration: Duration::from_millis(config.soft_drop_tap_duration_ms),
        movement_interval: Duration::from_millis(config.movement_interval_ms),
        rotation_interval: Duration::from_millis(config.rotation_interval_ms),
        piece_interval,
        hard_drop_interval: Duration::from_millis(config.hard_drop_interval_ms),
    };
    let mut buffered_snapshot = None;
    let mut perf = RunnerPerfTracker {
        last_flush_at: Some(Instant::now()),
        ..RunnerPerfTracker::default()
    };

    loop {
        let loop_started_at = Instant::now();
        if stop.load(AtomicOrdering::Relaxed) {
            return Ok(());
        }
        let snapshot_option = if let Some(snapshot) = buffered_snapshot.take() {
            Some(snapshot)
        } else {
            scanner.next_snapshot()?
        };
        let poll_metrics = scanner.take_last_poll_metrics();
        record_snapshot_poll_metrics(&mut perf, &poll_metrics);
        maybe_log_snapshot_poll_metrics(config, &poll_metrics, &mut log);
        match snapshot_option {
            Some(snapshot) => {
                if let (Some(current), Some(previous)) =
                    (snapshot.piece_counter, last_piece_counter)
                {
                    if current < previous {
                        last_piece_counter = None;
                    }
                }
                if let Some(reason) = skip_snapshot_reason(&snapshot, last_piece_counter) {
                    log(format!(
                        "[automation] source={} token={} skip because {}",
                        snapshot.source, snapshot.token, reason
                    ));
                    record_total_cycle(&mut perf, loop_started_at.elapsed());
                    maybe_flush_perf(config, &mut perf, &mut log);
                    thread::sleep(poll_delay);
                    continue;
                }
                match prepare_execution(config, &snapshot, &mut log)? {
                    Some(prepared) => {
                        let current_piece = snapshot
                            .queue
                            .first()
                            .map(|piece| piece.label())
                            .unwrap_or("?");
                        let preview_queue = snapshot
                            .queue
                            .iter()
                            .skip(1)
                            .map(|piece| piece.label())
                            .collect::<Vec<_>>()
                            .join(",");
                        let plan_actions = full_plan_actions(&prepared.execution_plan);
                        log(format!(
                            "[runner] snapshot token={} current={} queue={} playing={} countdown={}",
                            snapshot.token,
                            current_piece,
                            preview_queue,
                            snapshot.playing,
                            snapshot.countdown
                        ));
                        log(format!(
                            "[runner] plan actions={:?} hold={}",
                            plan_actions, prepared.execution_plan.hold
                        ));
                        log(format!(
                            "[runner] input backend={} dry_run={}",
                            input_backend_label(config),
                            config.dry_run
                        ));
                        emit_move_logs(config, &snapshot, &prepared, &mut log);
                        if config.dry_run {
                            log("[runner] dry_run=true, skipping real input".to_owned());
                            record_execution_perf(
                                &mut perf,
                                prepared.planner_elapsed_ms,
                                0,
                                loop_started_at.elapsed().as_millis(),
                            );
                            maybe_log_execution_perf(
                                config,
                                &mut log,
                                poll_metrics.read_ms + poll_metrics.parse_ms,
                                prepared.planner_elapsed_ms,
                                0,
                                loop_started_at.elapsed().as_millis(),
                            );
                            maybe_flush_perf(config, &mut perf, &mut log);
                            thread::sleep(poll_delay);
                            continue;
                        }
                        if plan_actions.is_empty() {
                            log(format!(
                                "[runner] no executable actions, reason={}",
                                empty_plan_reason(&prepared.execution_plan)
                            ));
                            record_execution_perf(
                                &mut perf,
                                prepared.planner_elapsed_ms,
                                0,
                                loop_started_at.elapsed().as_millis(),
                            );
                            maybe_log_execution_perf(
                                config,
                                &mut log,
                                poll_metrics.read_ms + poll_metrics.parse_ms,
                                prepared.planner_elapsed_ms,
                                0,
                                loop_started_at.elapsed().as_millis(),
                            );
                            maybe_flush_perf(config, &mut perf, &mut log);
                            thread::sleep(poll_delay);
                            continue;
                        }
                        let input_started_at = Instant::now();
                        execute_plan_until_hard_drop(
                            driver,
                            &prepared.execution_plan,
                            &config.handling,
                            execution_timings,
                            |line| log(line),
                        )
                        .context("failed to execute bot move")?;
                        if prepared.execution_plan.hard_drop {
                            match maybe_finalize_hard_drop(
                                config,
                                &snapshot,
                                &prepared,
                                driver,
                                execution_timings,
                                &mut log,
                            )? {
                                HardDropDecision::Proceed => {
                                    let current_target_pps = f32::from_bits(
                                        live_target_pps.load(AtomicOrdering::Relaxed),
                                    );
                                    if !wait_for_target_pps(
                                        target_pps_interval(current_target_pps),
                                        last_hard_drop_started_at,
                                        current_target_pps,
                                        stop,
                                        &mut log,
                                    ) {
                                        return Ok(());
                                    }
                                    let hard_drop_started_at = Instant::now();
                                    execute_hard_drop_action(
                                        driver,
                                        &prepared.execution_plan.movement_actions,
                                        &config.handling,
                                        execution_timings,
                                        |line| log(line),
                                    )
                                    .context("failed to execute hard drop input")?;
                                    last_hard_drop_started_at = Some(hard_drop_started_at);
                                    if snapshot.piece_counter.is_some() {
                                        last_piece_counter = snapshot.piece_counter;
                                    }
                                }
                                HardDropDecision::Retry(retry_snapshot) => {
                                    let input_elapsed_ms = input_started_at.elapsed().as_millis();
                                    record_execution_perf(
                                        &mut perf,
                                        prepared.planner_elapsed_ms,
                                        input_elapsed_ms,
                                        loop_started_at.elapsed().as_millis(),
                                    );
                                    maybe_log_execution_perf(
                                        config,
                                        &mut log,
                                        poll_metrics.read_ms + poll_metrics.parse_ms,
                                        prepared.planner_elapsed_ms,
                                        input_elapsed_ms,
                                        loop_started_at.elapsed().as_millis(),
                                    );
                                    maybe_flush_perf(config, &mut perf, &mut log);
                                    buffered_snapshot = Some(retry_snapshot);
                                    thread::sleep(poll_delay);
                                    continue;
                                }
                            }

                            let input_elapsed_ms = input_started_at.elapsed().as_millis();
                            record_execution_perf(
                                &mut perf,
                                prepared.planner_elapsed_ms,
                                input_elapsed_ms,
                                loop_started_at.elapsed().as_millis(),
                            );
                            maybe_log_execution_perf(
                                config,
                                &mut log,
                                poll_metrics.read_ms + poll_metrics.parse_ms,
                                prepared.planner_elapsed_ms,
                                input_elapsed_ms,
                                loop_started_at.elapsed().as_millis(),
                            );

                            buffered_snapshot = wait_for_next_piece_snapshot(
                                scanner,
                                &snapshot,
                                stop,
                                poll_delay,
                                piece_interval,
                                &mut log,
                            )?;
                            maybe_flush_perf(config, &mut perf, &mut log);
                            if buffered_snapshot.is_none() && stop.load(AtomicOrdering::Relaxed) {
                                return Ok(());
                            }
                        } else {
                            let input_elapsed_ms = input_started_at.elapsed().as_millis();
                            record_execution_perf(
                                &mut perf,
                                prepared.planner_elapsed_ms,
                                input_elapsed_ms,
                                loop_started_at.elapsed().as_millis(),
                            );
                            maybe_log_execution_perf(
                                config,
                                &mut log,
                                poll_metrics.read_ms + poll_metrics.parse_ms,
                                prepared.planner_elapsed_ms,
                                input_elapsed_ms,
                                loop_started_at.elapsed().as_millis(),
                            );
                            maybe_flush_perf(config, &mut perf, &mut log);
                        }
                    }
                    None => {
                        record_total_cycle(&mut perf, loop_started_at.elapsed());
                        maybe_flush_perf(config, &mut perf, &mut log);
                        thread::sleep(poll_delay);
                    }
                }
            }
            None => {
                record_total_cycle(&mut perf, loop_started_at.elapsed());
                maybe_flush_perf(config, &mut perf, &mut log);
                thread::sleep(poll_delay);
            }
        }
    }
}

fn wait_for_next_piece_snapshot<S, F>(
    scanner: &mut S,
    previous_snapshot: &GameSnapshot,
    stop: &AtomicBool,
    poll_delay: Duration,
    piece_interval: Duration,
    log: &mut F,
) -> Result<Option<GameSnapshot>>
where
    S: SnapshotScanner,
    F: FnMut(String),
{
    scanner.arm_piece_transition(previous_snapshot);
    log(format!(
        "[automation] waiting_for_piece_transition token={} queue={}",
        previous_snapshot.token,
        queue_labels(&previous_snapshot.queue)
    ));
    let idle_threshold = Duration::from_millis(1500);
    let mut waited = Duration::ZERO;
    let mut idle_logged = false;

    loop {
        if stop.load(AtomicOrdering::Relaxed) {
            return Ok(None);
        }
        match scanner.next_snapshot()? {
            Some(snapshot) => {
                if idle_logged {
                    log(format!(
                        "[automation] live game resumed token={} queue={}",
                        snapshot.token,
                        queue_labels(&snapshot.queue)
                    ));
                }
                if !piece_interval.is_zero() {
                    log(format!(
                        "[automation] piece_interval {}ms before next token={}",
                        piece_interval.as_millis(),
                        snapshot.token
                    ));
                    thread::sleep(piece_interval);
                }
                log(format!(
                    "[automation] next_piece_ready token={} queue={}",
                    snapshot.token,
                    queue_labels(&snapshot.queue)
                ));
                return Ok(Some(snapshot));
            }
            None => {
                thread::sleep(poll_delay);
                waited = waited.saturating_add(poll_delay);
                if !idle_logged && waited >= idle_threshold {
                    log(format!(
                        "[automation] idle waiting for next live game after token={}",
                        previous_snapshot.token
                    ));
                    idle_logged = true;
                }
            }
        }
    }
}

fn maybe_finalize_hard_drop<D, F>(
    config: &AutomationConfig,
    snapshot: &GameSnapshot,
    prepared: &PreparedExecution,
    driver: &mut D,
    timings: ExecutionTimings,
    log: &mut F,
) -> Result<HardDropDecision>
where
    D: InputBackend + ?Sized,
    F: FnMut(String),
{
    let Some(live_snapshot) = read_live_snapshot_for_correction(config, snapshot, log)? else {
        return Ok(HardDropDecision::Proceed);
    };
    if snapshot.active.is_some()
        && snapshot.active == live_snapshot.active
        && !prepared.execution_plan.movement_actions.is_empty()
    {
        log(format!(
            "[automation] pre_hard_drop_probe_stale token={} active_state_unchanged=true",
            live_snapshot.token
        ));
        return Ok(HardDropDecision::Proceed);
    }
    let Some(active) = live_snapshot.active else {
        return Ok(HardDropDecision::Proceed);
    };

    let target = prepared.planned_move.expected_location.canonical();
    let target_rotation = rotation_token_from_state(target.kind.1);
    if active.rotation != target_rotation {
        log(format!(
            "[automation] pre_hard_drop_mismatch token={} active_x={} active_rot={:?} target_x={} target_rot={:?} -> skip/replan",
            live_snapshot.token,
            active.x,
            active.rotation,
            target.x,
            target_rotation
        ));
        return Ok(HardDropDecision::Retry(live_snapshot));
    }

    let x_diff = target.x - active.x;
    if x_diff == 0 {
        return Ok(HardDropDecision::Proceed);
    }

    if x_diff.abs() == 1 {
        let correction = if x_diff < 0 {
            GameAction::Left
        } else {
            GameAction::Right
        };
        log(format!(
            "[automation] pre_hard_drop_correction token={} active_x={} target_x={} action={:?}",
            live_snapshot.token, active.x, target.x, correction
        ));
        execute_single_action(driver, correction, &config.handling, timings, log)
            .with_context(|| format!("failed to execute correction action {:?}", correction))?;

        let corrected_snapshot =
            read_live_snapshot_for_correction(config, snapshot, log)?.unwrap_or(live_snapshot);
        if let Some(corrected_active) = corrected_snapshot.active {
            if corrected_active.rotation == target_rotation && corrected_active.x == target.x {
                log(format!(
                    "[automation] pre_hard_drop_correction_applied token={} corrected_x={} corrected_rot={:?}",
                    corrected_snapshot.token, corrected_active.x, corrected_active.rotation
                ));
                return Ok(HardDropDecision::Proceed);
            }
            log(format!(
                "[automation] pre_hard_drop_correction_failed token={} active_x={} active_rot={:?} target_x={} target_rot={:?} -> skip/replan",
                corrected_snapshot.token,
                corrected_active.x,
                corrected_active.rotation,
                target.x,
                target_rotation
            ));
            return Ok(HardDropDecision::Retry(corrected_snapshot));
        }

        log(format!(
            "[automation] pre_hard_drop_correction_missing_active token={} -> skip/replan",
            corrected_snapshot.token
        ));
        return Ok(HardDropDecision::Retry(corrected_snapshot));
    }

    log(format!(
        "[automation] pre_hard_drop_x_out_of_range token={} active_x={} target_x={} delta={} -> skip/replan",
        live_snapshot.token, active.x, target.x, x_diff
    ));
    Ok(HardDropDecision::Retry(live_snapshot))
}

fn read_live_snapshot_for_correction<F>(
    config: &AutomationConfig,
    snapshot: &GameSnapshot,
    log: &mut F,
) -> Result<Option<GameSnapshot>>
where
    F: FnMut(String),
{
    let live_snapshot = match read_snapshot_file(&config.snapshot_path) {
        Ok(snapshot) => snapshot,
        Err(err) => {
            log(format!(
                "[automation] pre_hard_drop_probe_unavailable token={} error={:#}",
                snapshot.token, err
            ));
            return Ok(None);
        }
    };

    if live_snapshot.token != snapshot.token {
        log(format!(
            "[automation] pre_hard_drop_probe_token_changed expected={} actual={}",
            snapshot.token, live_snapshot.token
        ));
        return Ok(None);
    }

    Ok(Some(live_snapshot))
}

fn skip_snapshot_reason(
    snapshot: &GameSnapshot,
    last_piece_counter: Option<u32>,
) -> Option<String> {
    if !snapshot.playing {
        return Some("playing=false".to_owned());
    }
    if snapshot.countdown {
        return Some("countdown=true".to_owned());
    }
    if let (Some(current), Some(previous)) = (snapshot.piece_counter, last_piece_counter) {
        if current == previous {
            return Some(format!("duplicate pieceCounter={current}"));
        }
    }
    None
}

fn target_pps_interval(target_pps: f32) -> Option<Duration> {
    if !target_pps.is_finite() || target_pps <= 0.0 {
        return None;
    }
    Some(Duration::from_secs_f64(1.0 / f64::from(target_pps)))
}

fn pps_wait_duration(target_piece_time: Option<Duration>, elapsed: Duration) -> Option<Duration> {
    let target_piece_time = target_piece_time?;
    let wait = target_piece_time.checked_sub(elapsed)?;
    if wait.is_zero() {
        None
    } else {
        Some(wait)
    }
}

fn wait_for_target_pps<F>(
    target_piece_time: Option<Duration>,
    last_hard_drop_started_at: Option<Instant>,
    target_pps: f32,
    stop: &AtomicBool,
    log: &mut F,
) -> bool
where
    F: FnMut(String),
{
    let Some(target_piece_time) = target_piece_time else {
        return true;
    };
    let Some(last_hard_drop_started_at) = last_hard_drop_started_at else {
        return true;
    };

    let elapsed = last_hard_drop_started_at.elapsed();
    let Some(wait) = pps_wait_duration(Some(target_piece_time), elapsed) else {
        return true;
    };

    log(format!(
        "[automation] pps_limit target_pps={:.2} cycle_ms={} elapsed_ms={} wait_ms={} before_hard_drop",
        target_pps,
        target_piece_time.as_millis(),
        elapsed.as_millis(),
        wait.as_millis()
    ));
    sleep_with_stop(stop, wait)
}

fn sleep_with_stop(stop: &AtomicBool, duration: Duration) -> bool {
    let step = Duration::from_millis(5);
    let deadline = Instant::now() + duration;
    loop {
        if stop.load(AtomicOrdering::Relaxed) {
            return false;
        }
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        thread::sleep(step.min(deadline.saturating_duration_since(now)));
    }
}

fn record_snapshot_poll_metrics(perf: &mut RunnerPerfTracker, metrics: &SnapshotPollMetrics) {
    perf.snapshot_read_samples
        .push(metrics.read_ms + metrics.parse_ms);
    if metrics.skipped_same_token {
        perf.same_token_skips += 1;
    }
    if metrics.skipped_same_mtime {
        perf.duplicate_skips += 1;
    }
}

fn record_execution_perf(
    perf: &mut RunnerPerfTracker,
    planner_ms: u128,
    input_ms: u128,
    total_ms: u128,
) {
    perf.planner_samples.push(planner_ms);
    perf.input_samples.push(input_ms);
    perf.total_samples.push(total_ms);
    perf.processed_snapshots += 1;
}

fn record_total_cycle(perf: &mut RunnerPerfTracker, total: Duration) {
    perf.total_samples.push(total.as_millis());
}

fn maybe_log_snapshot_poll_metrics<F>(
    config: &AutomationConfig,
    metrics: &SnapshotPollMetrics,
    log: &mut F,
) where
    F: FnMut(String),
{
    if !config.perf_log_enabled {
        return;
    }
    if metrics.read_ms == 0
        && metrics.parse_ms == 0
        && !metrics.skipped_same_token
        && !metrics.skipped_same_mtime
    {
        return;
    }
    log(format!(
        "[perf][runner] snapshot_read_ms={} snapshot_parse_ms={} skipped_same_token={} skipped_same_mtime={}",
        metrics.read_ms,
        metrics.parse_ms,
        metrics.skipped_same_token,
        metrics.skipped_same_mtime
    ));
}

fn maybe_log_execution_perf<F>(
    config: &AutomationConfig,
    log: &mut F,
    snapshot_read_ms: u128,
    planner_ms: u128,
    input_ms: u128,
    total_ms: u128,
) where
    F: FnMut(String),
{
    if !config.perf_log_enabled {
        return;
    }
    log(format!(
        "[perf][runner] snapshot_read_ms={} planner_ms={} input_ms={} total_ms={}",
        snapshot_read_ms, planner_ms, input_ms, total_ms
    ));
}

fn maybe_flush_perf<F>(config: &AutomationConfig, perf: &mut RunnerPerfTracker, log: &mut F)
where
    F: FnMut(String),
{
    if !config.perf_log_enabled {
        return;
    }
    let Some(last_flush_at) = perf.last_flush_at else {
        perf.last_flush_at = Some(Instant::now());
        return;
    };
    if last_flush_at.elapsed() < PERF_LOG_INTERVAL {
        return;
    }
    log(format!(
        "[perf] planner_avg={}ms planner_p95={}ms input_avg={}ms input_p95={}ms snapshots_processed={} duplicate_skips={}",
        average_u128(&perf.planner_samples),
        percentile_u128(&perf.planner_samples, 95),
        average_u128(&perf.input_samples),
        percentile_u128(&perf.input_samples, 95),
        perf.processed_snapshots,
        perf.duplicate_skips + perf.same_token_skips,
    ));
    perf.snapshot_read_samples.clear();
    perf.planner_samples.clear();
    perf.input_samples.clear();
    perf.total_samples.clear();
    perf.processed_snapshots = 0;
    perf.duplicate_skips = 0;
    perf.same_token_skips = 0;
    perf.last_flush_at = Some(Instant::now());
}

fn average_u128(values: &[u128]) -> u128 {
    if values.is_empty() {
        return 0;
    }
    values.iter().sum::<u128>() / values.len() as u128
}

fn percentile_u128(values: &[u128], percentile: usize) -> u128 {
    if values.is_empty() {
        return 0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let index = (((percentile as f64) / 100.0) * (sorted.len() as f64)).ceil() as usize;
    let bounded = index.saturating_sub(1).min(sorted.len() - 1);
    sorted[bounded]
}

#[derive(Clone, Debug)]
struct PreparedExecution {
    planned_move: Move,
    planner_info: Info,
    planner_elapsed_ms: u128,
    movement_mode_used: MovementModeConfig,
    spawn_rule_used: SpawnRuleConfig,
    fallback_from: Option<MovementModeConfig>,
    execution_plan: ExecutionPlan,
    route_selection: RouteSelection,
}

#[derive(Clone, Debug)]
enum HardDropDecision {
    Proceed,
    Retry(GameSnapshot),
}

#[derive(Clone, Debug)]
struct ExecutionPlanBuildResult {
    execution_plan: ExecutionPlan,
    route_selection: RouteSelection,
}

#[derive(Clone, Debug)]
struct RouteSelection {
    route_kind: &'static str,
    movement_actions: Vec<GameAction>,
    candidate_count: usize,
    rejected_count: usize,
    representative_reject_reason: Option<String>,
}

#[derive(Clone, Debug)]
struct RouteSelectionFailure {
    candidate_count: usize,
    rejected_count: usize,
    representative_reject_reason: Option<String>,
    rejected_route_samples: Vec<String>,
}

#[derive(Debug)]
enum BuildExecutionError {
    Fatal(anyhow::Error),
    NoSafeRoute(RouteSelectionFailure),
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct RouteScore {
    has_soft_drop: bool,
    post_softdrop_horizontal: bool,
    post_softdrop_horizontal_count: usize,
    action_count: usize,
    direction_changes: usize,
    rotation_before_drop: usize,
    soft_drop_count: usize,
    soft_drop_penalty: usize,
}

#[derive(Clone, Debug)]
struct CandidateRoute {
    score: RouteScore,
    route_kind: &'static str,
    movement_actions: Vec<GameAction>,
}

fn prepare_execution<F>(
    config: &AutomationConfig,
    snapshot: &GameSnapshot,
    log: &mut F,
) -> Result<Option<PreparedExecution>>
where
    F: FnMut(String),
{
    let planner_started_at = Instant::now();
    let Some((planned_move, planner_info)) =
        plan_move_for_mode(config, snapshot, config.bot.movement_mode)?
    else {
        log(format!(
            "[automation] source={} token={} planner produced no move for mode={}; waiting for fresher snapshot",
            snapshot.source,
            snapshot.token,
            movement_mode_label(config.bot.movement_mode),
        ));
        return Ok(None);
    };
    match build_execution_plan(config, snapshot, &planned_move, config.bot.movement_mode) {
        Ok(result) => Ok(Some(PreparedExecution {
            planned_move,
            planner_info,
            planner_elapsed_ms: planner_started_at.elapsed().as_millis(),
            movement_mode_used: config.bot.movement_mode,
            spawn_rule_used: config.bot.spawn_rule,
            fallback_from: None,
            execution_plan: result.execution_plan,
            route_selection: result.route_selection,
        })),
        Err(BuildExecutionError::Fatal(err)) => Err(err),
        Err(BuildExecutionError::NoSafeRoute(failure)) => {
            if config.bot.movement_mode == MovementModeConfig::HardDropOnly {
                log_route_skip(snapshot, config.bot.movement_mode, &failure, log);
                return Ok(None);
            }

            log(format!(
                "[automation] token={} no safe route for mode={} candidates={} rejected={} reason={}",
                snapshot.token,
                movement_mode_label(config.bot.movement_mode),
                failure.candidate_count,
                failure.rejected_count,
                failure
                    .representative_reject_reason
                    .as_deref()
                    .unwrap_or("unknown")
            ));
            if !failure.rejected_route_samples.is_empty() {
                log(format!(
                    "[automation] token={} reject_samples={}",
                    snapshot.token,
                    failure.rejected_route_samples.join(" | ")
                ));
            }

            let fallback_mode = MovementModeConfig::HardDropOnly;
            log(format!(
                "[automation] HARD_DROP_ONLY_FALLBACK token={} from={} to={} reason={}",
                snapshot.token,
                movement_mode_label(config.bot.movement_mode),
                movement_mode_label(fallback_mode),
                failure
                    .representative_reject_reason
                    .as_deref()
                    .unwrap_or("unknown")
            ));
            let fallback_started_at = Instant::now();
            let Some((fallback_move, fallback_info)) =
                plan_move_for_mode(config, snapshot, fallback_mode)?
            else {
                log(format!(
                    "[automation] source={} token={} planner produced no move for fallback mode={}; waiting for fresher snapshot",
                    snapshot.source,
                    snapshot.token,
                    movement_mode_label(fallback_mode),
                ));
                return Ok(None);
            };
            match build_execution_plan(config, snapshot, &fallback_move, fallback_mode) {
                Ok(result) => Ok(Some(PreparedExecution {
                    planned_move: fallback_move,
                    planner_info: fallback_info,
                    planner_elapsed_ms: fallback_started_at.elapsed().as_millis(),
                    movement_mode_used: fallback_mode,
                    spawn_rule_used: config.bot.spawn_rule,
                    fallback_from: Some(config.bot.movement_mode),
                    execution_plan: result.execution_plan,
                    route_selection: result.route_selection,
                })),
                Err(BuildExecutionError::Fatal(err)) => Err(err),
                Err(BuildExecutionError::NoSafeRoute(fallback_failure)) => {
                    log_route_skip(snapshot, fallback_mode, &fallback_failure, log);
                    Ok(None)
                }
            }
        }
    }
}

fn log_route_skip<F>(
    snapshot: &GameSnapshot,
    mode: MovementModeConfig,
    failure: &RouteSelectionFailure,
    log: &mut F,
) where
    F: FnMut(String),
{
    log(format!(
        "[automation] token={} skip move mode={} candidates={} rejected={} reason={}",
        snapshot.token,
        movement_mode_label(mode),
        failure.candidate_count,
        failure.rejected_count,
        failure
            .representative_reject_reason
            .as_deref()
            .unwrap_or("unknown")
    ));
    if !failure.rejected_route_samples.is_empty() {
        log(format!(
            "[automation] token={} reject_samples={}",
            snapshot.token,
            failure.rejected_route_samples.join(" | ")
        ));
    }
}

fn emit_move_logs<F>(
    config: &AutomationConfig,
    snapshot: &GameSnapshot,
    prepared: &PreparedExecution,
    log: &mut F,
) where
    F: FnMut(String),
{
    let active_piece = snapshot
        .queue
        .first()
        .map(|piece| piece.label())
        .unwrap_or("?");
    let hold_piece = snapshot.hold.map(|piece| piece.label()).unwrap_or("-");
    let target = prepared.planned_move.expected_location;
    let fallback_suffix = prepared
        .fallback_from
        .map(|mode| format!(" fallback_from={}", movement_mode_label(mode)))
        .unwrap_or_default();

    log(format!(
        "[automation] source={} token={} piece={} hold={} mode={} spawn={}{fallback_suffix}",
        snapshot.source,
        snapshot.token,
        active_piece,
        hold_piece,
        movement_mode_label(prepared.movement_mode_used),
        spawn_rule_label(prepared.spawn_rule_used),
    ));
    log(format!(
        "[automation] target=(x={},y={},rot={:?})",
        target.x, target.y, target.kind.1
    ));
    log(format!(
        "[automation] planner={} elapsed_ms={} threads={} min_nodes={} max_nodes={} use_hold={} speculate={}",
        format_planner_info(&prepared.planner_info),
        prepared.planner_elapsed_ms,
        config.bot.threads,
        config.bot.min_nodes,
        config.bot.max_nodes,
        config.bot.use_hold,
        config.bot.speculate
    ));
    log(format!(
        "[automation] routes={} chosen={} actions={:?}",
        prepared.route_selection.candidate_count,
        prepared.route_selection.route_kind,
        route_actions_with_hard_drop(&prepared.execution_plan)
    ));
    log(format!(
        "[automation] rejected_routes={} reject_reason={}",
        prepared.route_selection.rejected_count,
        prepared
            .route_selection
            .representative_reject_reason
            .as_deref()
            .unwrap_or("none")
    ));
}

fn route_actions_with_hard_drop(plan: &ExecutionPlan) -> Vec<GameAction> {
    let mut actions = plan.movement_actions.clone();
    if plan.hard_drop {
        actions.push(GameAction::HardDrop);
    }
    actions
}

fn full_plan_actions(plan: &ExecutionPlan) -> Vec<GameAction> {
    let mut actions = Vec::new();
    if plan.hold {
        actions.push(GameAction::Hold);
    }
    actions.extend(route_actions_with_hard_drop(plan));
    actions
}

fn empty_plan_reason(plan: &ExecutionPlan) -> String {
    format!(
        "hold={} movement_actions={} hard_drop={}",
        plan.hold,
        plan.movement_actions.len(),
        plan.hard_drop
    )
}

fn input_backend_label(config: &AutomationConfig) -> &'static str {
    match config.input_backend {
        crate::config::InputBackendConfig::BrowserCdp => "browser_cdp",
        crate::config::InputBackendConfig::ScanCode => "scan_code",
        crate::config::InputBackendConfig::VirtualKey => "virtual_key",
    }
}

fn queue_labels(queue: &[PieceToken]) -> String {
    queue
        .iter()
        .map(|piece| piece.label())
        .collect::<Vec<_>>()
        .join("")
}

fn movement_mode_label(mode: MovementModeConfig) -> &'static str {
    match mode {
        MovementModeConfig::ZeroG => "ZeroG",
        MovementModeConfig::ZeroGSafe => "ZeroGSafe",
        MovementModeConfig::ZeroGComplete => "ZeroGComplete",
        MovementModeConfig::TwentyG => "TwentyG",
        MovementModeConfig::HardDropOnly => "HardDropOnly",
    }
}

fn spawn_rule_label(rule: SpawnRuleConfig) -> &'static str {
    match rule {
        SpawnRuleConfig::Row19Or20 => "Row19Or20",
        SpawnRuleConfig::Row21AndFall => "Row21AndFall",
    }
}

fn rotation_token_from_state(rotation: RotationState) -> RotationToken {
    match rotation {
        RotationState::North => RotationToken::North,
        RotationState::East => RotationToken::East,
        RotationState::South => RotationToken::South,
        RotationState::West => RotationToken::West,
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn plan_move(config: &AutomationConfig, snapshot: &GameSnapshot) -> Result<(Move, &'static str)> {
    let movement_mode = config.bot.movement_mode;
    let (planned_move, _) = plan_move_for_mode(config, snapshot, movement_mode)?
        .context("bot failed to produce a move for the current snapshot")?;
    Ok((planned_move, movement_mode_label(movement_mode)))
}

fn plan_move_for_mode(
    config: &AutomationConfig,
    snapshot: &GameSnapshot,
    movement_mode: MovementModeConfig,
) -> Result<Option<(Move, Info)>> {
    let queue = snapshot.queue_pieces();
    if queue.is_empty() {
        anyhow::bail!("snapshot queue must include the active piece as the first element");
    }

    let mut board = Board::new_with_state(
        snapshot.field_array()?,
        enumset::EnumSet::all(),
        snapshot.hold_piece(),
        snapshot.b2b,
        snapshot.combo,
    );
    for piece in queue {
        board.add_next_piece(piece);
    }

    let interface = Interface::launch(
        board,
        cold_clear::Options {
            mode: movement_mode_for_planning(movement_mode),
            spawn_rule: match config.bot.spawn_rule {
                SpawnRuleConfig::Row19Or20 => libtetris::SpawnRule::Row19Or20,
                SpawnRuleConfig::Row21AndFall => libtetris::SpawnRule::Row21AndFall,
            },
            use_hold: config.bot.use_hold,
            speculate: config.bot.speculate && movement_mode != MovementModeConfig::HardDropOnly,
            pcloop: None,
            min_nodes: config.bot.min_nodes,
            max_nodes: config.bot.max_nodes,
            threads: config.bot.threads,
        },
        Standard::default(),
        Option::<Arc<cold_clear::Book>>::None,
    );
    interface.suggest_next_move(snapshot.incoming);
    let planned_move = interface
        .block_next_move()
        .map(|(planned_move, info)| (planned_move, info));
    Ok(planned_move)
}

fn format_planner_info(info: &Info) -> String {
    match info {
        Info::Book => "book".to_owned(),
        Info::PcLoop(_) => "pcloop".to_owned(),
        Info::Normal(details) => format!(
            "normal nodes={} depth={} rank={}",
            details.nodes, details.depth, details.original_rank
        ),
    }
}

fn movement_mode_for_planning(mode: MovementModeConfig) -> MovementMode {
    match mode {
        MovementModeConfig::ZeroG => MovementMode::ZeroG,
        MovementModeConfig::ZeroGSafe => MovementMode::ZeroGComplete,
        MovementModeConfig::ZeroGComplete => MovementMode::ZeroGComplete,
        MovementModeConfig::TwentyG => MovementMode::TwentyG,
        MovementModeConfig::HardDropOnly => MovementMode::HardDropOnly,
    }
}

fn build_execution_plan(
    config: &AutomationConfig,
    snapshot: &GameSnapshot,
    planned_move: &Move,
    movement_mode: MovementModeConfig,
) -> std::result::Result<ExecutionPlanBuildResult, BuildExecutionError> {
    let board = board_from_snapshot(snapshot).map_err(BuildExecutionError::Fatal)?;
    let active_piece =
        execution_piece(snapshot, planned_move.hold).map_err(BuildExecutionError::Fatal)?;
    let spawned = active_piece_for_execution(snapshot, planned_move.hold, active_piece)
        .map(Ok)
        .unwrap_or_else(|| spawn_for_execution(&board, active_piece, config.bot.spawn_rule))
        .map_err(BuildExecutionError::Fatal)?;
    let route_selection = if movement_mode == MovementModeConfig::HardDropOnly {
        safe_spawn_tap_route(&board, spawned, planned_move.expected_location)
    } else {
        placement_actions_for_target(
            &board,
            spawned,
            planned_move.expected_location,
            movement_mode_for_routes(movement_mode),
            &config.handling,
        )
    }
    .map_err(BuildExecutionError::NoSafeRoute)?;

    Ok(ExecutionPlanBuildResult {
        execution_plan: ExecutionPlan {
            hold: planned_move.hold,
            movement_actions: route_selection.movement_actions.clone(),
            hard_drop: true,
        },
        route_selection,
    })
}

fn active_piece_for_execution(
    snapshot: &GameSnapshot,
    used_hold: bool,
    active_piece: Piece,
) -> Option<FallingPiece> {
    if used_hold {
        return None;
    }
    let active = snapshot.active?;
    Some(FallingPiece {
        kind: libtetris::PieceState(active_piece, active.rotation.into()),
        x: active.x,
        y: active.y,
        tspin: libtetris::TspinStatus::None,
    })
}

fn board_from_snapshot(snapshot: &GameSnapshot) -> Result<Board> {
    Ok(Board::new_with_state(
        snapshot.field_array()?,
        enumset::EnumSet::all(),
        snapshot.hold_piece(),
        snapshot.b2b,
        snapshot.combo,
    ))
}

fn safe_spawn_tap_route(
    board: &Board,
    spawned: FallingPiece,
    target: FallingPiece,
) -> std::result::Result<RouteSelection, RouteSelectionFailure> {
    let target = target.canonical();
    let (mut movement_actions, rotated_piece) = apply_safe_rotations(board, spawned, target)?;
    let (shift_actions, shifted_piece) = apply_safe_horizontal_taps(board, rotated_piece, target)?;
    movement_actions.extend(shift_actions);

    let mut locked_piece = shifted_piece;
    locked_piece.sonic_drop(board);
    if !locked_piece.same_location(&target) {
        return Err(RouteSelectionFailure {
            candidate_count: 1,
            rejected_count: 1,
            representative_reject_reason: Some(format!(
                "spawn_tap_route_misses_target {:?} -> {:?}",
                locked_piece.canonical(),
                target
            )),
            rejected_route_samples: vec![],
        });
    }

    Ok(RouteSelection {
        route_kind: "SpawnTapCountSafe",
        movement_actions,
        candidate_count: 1,
        rejected_count: 0,
        representative_reject_reason: None,
    })
}

fn apply_safe_rotations(
    board: &Board,
    mut piece: FallingPiece,
    target: FallingPiece,
) -> std::result::Result<(Vec<GameAction>, FallingPiece), RouteSelectionFailure> {
    let actions = safe_rotation_actions(target.kind.1);
    for action in &actions {
        let rotated = match action {
            GameAction::RotateCw => piece.cw(board),
            GameAction::RotateCcw => piece.ccw(board),
            _ => unreachable!("safe rotation plan only emits rotate actions"),
        };
        if !rotated {
            return Err(RouteSelectionFailure {
                candidate_count: 1,
                rejected_count: 1,
                representative_reject_reason: Some(format!(
                    "spawn_rotation_failed target_rotation={:?}",
                    target.kind.1
                )),
                rejected_route_samples: vec![],
            });
        }
    }
    if piece.canonical().kind.1 != target.kind.1 {
        return Err(RouteSelectionFailure {
            candidate_count: 1,
            rejected_count: 1,
            representative_reject_reason: Some(format!(
                "spawn_rotation_ended_at_unexpected_orientation {:?} -> {:?}",
                piece.canonical().kind.1,
                target.kind.1
            )),
            rejected_route_samples: vec![],
        });
    }
    Ok((actions, piece))
}

fn apply_safe_horizontal_taps(
    board: &Board,
    mut piece: FallingPiece,
    target: FallingPiece,
) -> std::result::Result<(Vec<GameAction>, FallingPiece), RouteSelectionFailure> {
    let delta = target.x - piece.canonical().x;
    let action = if delta < 0 {
        GameAction::Left
    } else {
        GameAction::Right
    };
    let mut actions = Vec::new();
    for _ in 0..delta.abs() {
        let shifted = match action {
            GameAction::Left => piece.shift(board, -1, 0),
            GameAction::Right => piece.shift(board, 1, 0),
            _ => unreachable!("safe horizontal plan only emits left/right actions"),
        };
        if !shifted {
            return Err(RouteSelectionFailure {
                candidate_count: 1,
                rejected_count: 1,
                representative_reject_reason: Some(format!(
                    "spawn_horizontal_tap_blocked delta={} target_x={}",
                    delta, target.x
                )),
                rejected_route_samples: vec![],
            });
        }
        actions.push(action);
    }
    Ok((actions, piece))
}

fn safe_rotation_actions(rotation: RotationState) -> Vec<GameAction> {
    match rotation {
        RotationState::North => Vec::new(),
        RotationState::East => vec![GameAction::RotateCw],
        RotationState::South => vec![GameAction::RotateCw, GameAction::RotateCw],
        RotationState::West => vec![GameAction::RotateCcw],
    }
}

fn execution_piece(snapshot: &GameSnapshot, use_hold: bool) -> Result<Piece> {
    let queue = snapshot.queue_pieces();
    if queue.is_empty() {
        anyhow::bail!("snapshot queue must include the active piece");
    }
    if !use_hold {
        return Ok(queue[0]);
    }
    if let Some(held) = snapshot.hold_piece() {
        return Ok(held);
    }
    queue
        .get(1)
        .copied()
        .context("hold-first move requires at least one preview piece")
}

fn spawn_for_execution(
    board: &Board,
    piece: Piece,
    spawn_rule: SpawnRuleConfig,
) -> Result<FallingPiece> {
    let rule = match spawn_rule {
        SpawnRuleConfig::Row19Or20 => SpawnRule::Row19Or20,
        SpawnRuleConfig::Row21AndFall => SpawnRule::Row21AndFall,
    };
    rule.spawn(piece, board)
        .with_context(|| format!("failed to spawn {:?} with {:?}", piece, spawn_rule))
}

fn movement_mode_for_routes(mode: MovementModeConfig) -> MovementMode {
    match mode {
        MovementModeConfig::ZeroG => MovementMode::ZeroG,
        MovementModeConfig::ZeroGSafe => MovementMode::ZeroGComplete,
        MovementModeConfig::ZeroGComplete => MovementMode::ZeroGComplete,
        MovementModeConfig::TwentyG => MovementMode::TwentyG,
        MovementModeConfig::HardDropOnly => MovementMode::HardDropOnly,
    }
}

fn placement_actions_for_target(
    board: &Board,
    spawned: FallingPiece,
    target: FallingPiece,
    movement_mode: MovementMode,
    handling: &HandlingConfig,
) -> std::result::Result<RouteSelection, RouteSelectionFailure> {
    let placements: Vec<Placement> = find_moves(board, spawned, movement_mode)
        .into_iter()
        .filter(|placement| placement.location.same_location(&target))
        .collect();

    if placements.is_empty() {
        return Err(RouteSelectionFailure {
            candidate_count: 0,
            rejected_count: 0,
            representative_reject_reason: Some(format!(
                "no_route_to_target {:?} -> {:?}",
                spawned, target
            )),
            rejected_route_samples: vec![],
        });
    }

    let mut rejected_reasons = Vec::new();
    let mut rejected_route_samples = Vec::new();
    let mut candidates = Vec::new();
    for placement in placements.iter() {
        match candidate_route_from_movements(&placement.inputs.movements, handling) {
            Ok(candidate) => candidates.push(candidate),
            Err(reason) => {
                if rejected_route_samples.len() < 4 {
                    rejected_route_samples.push(format!(
                        "{} route={}",
                        reason,
                        format_piece_movements(&placement.inputs.movements)
                    ));
                }
                rejected_reasons.push(reason);
            }
        }
    }

    if candidates.is_empty() {
        return Err(RouteSelectionFailure {
            candidate_count: placements.len(),
            rejected_count: rejected_reasons.len(),
            representative_reject_reason: summarize_reject_reasons(&rejected_reasons),
            rejected_route_samples,
        });
    }

    candidates.sort_by(|left, right| compare_route_candidates(left, right));
    let chosen = candidates.remove(0);
    Ok(RouteSelection {
        route_kind: chosen.route_kind,
        movement_actions: chosen.movement_actions,
        candidate_count: placements.len(),
        rejected_count: rejected_reasons.len(),
        representative_reject_reason: summarize_reject_reasons(&rejected_reasons),
    })
}

fn compare_route_candidates(left: &CandidateRoute, right: &CandidateRoute) -> Ordering {
    left.score.cmp(&right.score).then_with(|| {
        left.movement_actions
            .len()
            .cmp(&right.movement_actions.len())
    })
}

fn summarize_reject_reasons(reasons: &[String]) -> Option<String> {
    if reasons.is_empty() {
        return None;
    }
    let mut counts = BTreeMap::<&str, usize>::new();
    for reason in reasons {
        *counts.entry(reason.as_str()).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(reason, count)| format!("{reason} x{count}"))
}

fn candidate_route_from_movements(
    movements: &[PieceMovement],
    handling: &HandlingConfig,
) -> std::result::Result<CandidateRoute, String> {
    validate_route(movements, handling)?;
    let movement_actions = movements
        .iter()
        .copied()
        .map(game_action_from_piece_movement)
        .collect::<Vec<_>>();
    let has_soft_drop = movements.contains(&PieceMovement::SonicDrop);
    let has_post_softdrop_actions = movements
        .iter()
        .position(|movement| *movement == PieceMovement::SonicDrop)
        .map(|index| index + 1 < movements.len())
        .unwrap_or(false);
    let post_softdrop_horizontal_count = count_post_softdrop_horizontal(movements);
    let soft_drop_count = movements
        .iter()
        .filter(|movement| **movement == PieceMovement::SonicDrop)
        .count();
    let direction_changes = count_direction_changes(movements);
    let rotation_before_drop = count_rotations_before_soft_drop(movements);
    let score = RouteScore {
        has_soft_drop,
        post_softdrop_horizontal: post_softdrop_horizontal_count > 0,
        post_softdrop_horizontal_count,
        action_count: movements.len(),
        direction_changes: if handling.cancel_das_on_direction_change {
            direction_changes
        } else {
            0
        },
        rotation_before_drop,
        soft_drop_count,
        soft_drop_penalty: if handling.prefer_soft_drop_over_movement {
            0
        } else {
            soft_drop_count
        },
    };

    Ok(CandidateRoute {
        score,
        route_kind: if has_post_softdrop_actions {
            "SoftDropSpinRoute"
        } else if has_soft_drop {
            "SoftDropTail"
        } else {
            "NoSoftDrop"
        },
        movement_actions,
    })
}

fn validate_route(
    movements: &[PieceMovement],
    handling: &HandlingConfig,
) -> std::result::Result<(), String> {
    if let Some(first_soft_drop_index) = movements
        .iter()
        .position(|movement| *movement == PieceMovement::SonicDrop)
    {
        let trailing_actions = &movements[first_soft_drop_index + 1..];
        let has_post_softdrop_actions = !trailing_actions.is_empty();
        let has_post_softdrop_horizontal = trailing_actions
            .iter()
            .any(|movement| matches!(movement, PieceMovement::Left | PieceMovement::Right));
        let trailing_actions_are_spin_safe = trailing_actions
            .iter()
            .all(|movement| is_allowed_post_softdrop_movement(*movement, handling));

        if has_post_softdrop_horizontal && !handling.allow_post_softdrop_horizontal {
            return Err(format!(
                "post_softdrop_horizontal_blocked actions={}",
                format_piece_movements(trailing_actions)
            ));
        }

        if has_post_softdrop_actions && !handling.allow_post_softdrop_actions {
            return Err(format!(
                "post_softdrop_actions_disabled actions={}",
                format_piece_movements(trailing_actions)
            ));
        }

        if handling.soft_drop_mode == SoftDropModeConfig::Infinite
            && !(handling.allow_post_softdrop_actions
                && has_post_softdrop_actions
                && trailing_actions_are_spin_safe)
        {
            return Err("soft_drop_blocked_for_infinite_sdf".to_owned());
        }
        if has_post_softdrop_actions
            && !(handling.allow_post_softdrop_actions && trailing_actions_are_spin_safe)
        {
            return Err(format!(
                "soft_drop_post_actions_blocked actions={}",
                format_piece_movements(trailing_actions)
            ));
        }
    }
    Ok(())
}

fn is_allowed_post_softdrop_movement(movement: PieceMovement, handling: &HandlingConfig) -> bool {
    matches!(
        movement,
        PieceMovement::Cw | PieceMovement::Ccw | PieceMovement::SonicDrop
    ) || (handling.allow_post_softdrop_horizontal
        && matches!(movement, PieceMovement::Left | PieceMovement::Right))
}

fn count_post_softdrop_horizontal(movements: &[PieceMovement]) -> usize {
    let Some(first_soft_drop_index) = movements
        .iter()
        .position(|movement| *movement == PieceMovement::SonicDrop)
    else {
        return 0;
    };

    movements[first_soft_drop_index + 1..]
        .iter()
        .filter(|movement| matches!(movement, PieceMovement::Left | PieceMovement::Right))
        .count()
}

fn format_piece_movements(movements: &[PieceMovement]) -> String {
    movements
        .iter()
        .map(|movement| match movement {
            PieceMovement::Left => "Left",
            PieceMovement::Right => "Right",
            PieceMovement::Cw => "RotateCw",
            PieceMovement::Ccw => "RotateCcw",
            PieceMovement::SonicDrop => "SoftDrop",
        })
        .collect::<Vec<_>>()
        .join(">")
}

fn count_direction_changes(movements: &[PieceMovement]) -> usize {
    let mut last_horizontal = None;
    let mut changes = 0;
    for movement in movements {
        let current = match movement {
            PieceMovement::Left => Some(-1_i32),
            PieceMovement::Right => Some(1_i32),
            _ => None,
        };
        if let Some(current) = current {
            if let Some(last) = last_horizontal {
                if last != current {
                    changes += 1;
                }
            }
            last_horizontal = Some(current);
        }
    }
    changes
}

fn count_rotations_before_soft_drop(movements: &[PieceMovement]) -> usize {
    let Some(first_soft_drop_index) = movements
        .iter()
        .position(|movement| *movement == PieceMovement::SonicDrop)
    else {
        return 0;
    };

    movements[..first_soft_drop_index]
        .iter()
        .filter(|movement| matches!(movement, PieceMovement::Cw | PieceMovement::Ccw))
        .count()
}

fn game_action_from_piece_movement(movement: PieceMovement) -> GameAction {
    match movement {
        PieceMovement::Left => GameAction::Left,
        PieceMovement::Right => GameAction::Right,
        PieceMovement::Cw => GameAction::RotateCw,
        PieceMovement::Ccw => GameAction::RotateCcw,
        PieceMovement::SonicDrop => GameAction::SoftDrop,
    }
}

impl PieceToken {
    fn label(self) -> &'static str {
        match self {
            PieceToken::I => "I",
            PieceToken::O => "O",
            PieceToken::T => "T",
            PieceToken::L => "L",
            PieceToken::J => "J",
            PieceToken::S => "S",
            PieceToken::Z => "Z",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AutomationConfig, InputBackendConfig, MovementModeConfig};
    use crate::driver::InputBackend;
    use crate::scanner::PieceToken;
    use libtetris::{PieceState, RotationState, TspinStatus};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering as AtomicOrdering};
    use std::sync::Arc;
    use std::time::Duration;

    struct SingleSnapshotScanner {
        snapshot: Option<GameSnapshot>,
    }

    impl SnapshotScanner for SingleSnapshotScanner {
        fn next_snapshot(&mut self) -> Result<Option<GameSnapshot>> {
            Ok(self.snapshot.take())
        }
    }

    #[derive(Default)]
    struct StoppingBackend {
        taps: Vec<GameAction>,
        stop: Option<Arc<AtomicBool>>,
    }

    impl InputBackend for StoppingBackend {
        fn tap(&mut self, action: GameAction, _: Duration) -> Result<()> {
            self.taps.push(action);
            if action == GameAction::HardDrop {
                if let Some(stop) = &self.stop {
                    stop.store(true, AtomicOrdering::Relaxed);
                }
            }
            Ok(())
        }

        fn release_all_keys(&mut self) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn plan_move_requires_queue() {
        let snapshot = GameSnapshot {
            source: "test".to_owned(),
            token: "t0".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
            piece_counter: None,
            playing: true,
            countdown: false,
            active: None,
        };
        let result = plan_move(&AutomationConfig::default(), &snapshot);
        assert!(result.is_err());
    }

    #[test]
    fn plan_move_works_for_a_basic_queue() {
        let snapshot = GameSnapshot {
            source: "test".to_owned(),
            token: "t1".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::I, PieceToken::O, PieceToken::T, PieceToken::L],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
            piece_counter: None,
            playing: true,
            countdown: false,
            active: None,
        };
        let (result, _mode) = plan_move(&AutomationConfig::default(), &snapshot).unwrap();
        assert!(!result.inputs.is_empty() || result.hold);
    }

    #[test]
    fn execution_plan_uses_libtetris_route_for_simple_drop() {
        let snapshot = GameSnapshot {
            source: "test".to_owned(),
            token: "t2".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::J, PieceToken::O, PieceToken::T, PieceToken::L],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
            piece_counter: None,
            playing: true,
            countdown: false,
            active: None,
        };
        let config = AutomationConfig::default();
        let planned_move = Move {
            inputs: Default::default(),
            expected_location: FallingPiece {
                kind: PieceState(Piece::J, RotationState::North),
                x: 3,
                y: 0,
                tspin: TspinStatus::None,
            },
            hold: false,
        };

        let plan = build_execution_plan(
            &config,
            &snapshot,
            &planned_move,
            MovementModeConfig::HardDropOnly,
        )
        .unwrap();

        assert_eq!(plan.execution_plan.movement_actions, vec![GameAction::Left]);
        assert!(plan.execution_plan.hard_drop);
        assert_eq!(plan.route_selection.route_kind, "SpawnTapCountSafe");
    }

    #[test]
    fn hard_drop_only_safe_executor_uses_spawn_rotations_then_taps() {
        let snapshot = GameSnapshot {
            source: "test".to_owned(),
            token: "t3".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::T, PieceToken::O, PieceToken::I, PieceToken::L],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
            piece_counter: None,
            playing: true,
            countdown: false,
            active: None,
        };
        let config = AutomationConfig::default();
        let board = board_from_snapshot(&snapshot).unwrap();
        let mut target = spawn_for_execution(&board, Piece::T, SpawnRuleConfig::Row19Or20).unwrap();
        assert!(target.cw(&board));
        assert!(target.cw(&board));
        assert!(target.shift(&board, -1, 0));
        assert!(target.sonic_drop(&board));

        let planned_move = Move {
            inputs: Default::default(),
            expected_location: target,
            hold: false,
        };

        let plan = build_execution_plan(
            &config,
            &snapshot,
            &planned_move,
            MovementModeConfig::HardDropOnly,
        )
        .unwrap();

        assert_eq!(
            plan.execution_plan.movement_actions,
            vec![GameAction::RotateCw, GameAction::RotateCw, GameAction::Left]
        );
        assert_eq!(plan.route_selection.route_kind, "SpawnTapCountSafe");
    }

    #[test]
    fn soft_drop_routes_are_rejected_for_infinite_sdf() {
        let handling = HandlingConfig::default();
        let result = candidate_route_from_movements(
            &[PieceMovement::Left, PieceMovement::SonicDrop],
            &handling,
        );
        assert_eq!(
            result.unwrap_err(),
            "soft_drop_blocked_for_infinite_sdf".to_owned()
        );
    }

    #[test]
    fn spin_routes_can_be_allowed_after_soft_drop() {
        let handling = HandlingConfig {
            allow_post_softdrop_actions: true,
            ..HandlingConfig::default()
        };
        let route = candidate_route_from_movements(
            &[
                PieceMovement::Left,
                PieceMovement::SonicDrop,
                PieceMovement::Cw,
            ],
            &handling,
        )
        .unwrap();

        assert_eq!(
            route.movement_actions,
            vec![GameAction::Left, GameAction::SoftDrop, GameAction::RotateCw]
        );
        assert_eq!(route.route_kind, "SoftDropSpinRoute");
    }

    #[test]
    fn post_softdrop_actions_can_still_be_disabled_explicitly() {
        let handling = HandlingConfig {
            allow_post_softdrop_actions: false,
            soft_drop_mode: SoftDropModeConfig::Step,
            ..HandlingConfig::default()
        };
        let result = candidate_route_from_movements(
            &[PieceMovement::SonicDrop, PieceMovement::Cw],
            &handling,
        );

        assert_eq!(
            result.unwrap_err(),
            "post_softdrop_actions_disabled actions=RotateCw".to_owned()
        );
    }

    #[test]
    fn post_softdrop_horizontal_is_blocked_by_default() {
        let handling = HandlingConfig {
            soft_drop_mode: SoftDropModeConfig::Step,
            ..HandlingConfig::default()
        };
        let result = candidate_route_from_movements(
            &[PieceMovement::SonicDrop, PieceMovement::Right],
            &handling,
        );

        assert_eq!(
            result.unwrap_err(),
            "post_softdrop_horizontal_blocked actions=Right".to_owned()
        );
    }

    #[test]
    fn post_softdrop_horizontal_can_be_enabled_explicitly() {
        let handling = HandlingConfig {
            soft_drop_mode: SoftDropModeConfig::Step,
            allow_post_softdrop_horizontal: true,
            ..HandlingConfig::default()
        };
        let route = candidate_route_from_movements(
            &[PieceMovement::SonicDrop, PieceMovement::Right],
            &handling,
        )
        .unwrap();

        assert_eq!(
            route.movement_actions,
            vec![GameAction::SoftDrop, GameAction::Right]
        );
    }

    #[test]
    fn route_scoring_prefers_no_soft_drop_route() {
        let step_handling = HandlingConfig {
            soft_drop_mode: SoftDropModeConfig::Step,
            ..HandlingConfig::default()
        };
        let no_soft_drop = candidate_route_from_movements(
            &[PieceMovement::Cw, PieceMovement::Left],
            &step_handling,
        )
        .unwrap();
        let soft_drop_tail = candidate_route_from_movements(
            &[PieceMovement::Cw, PieceMovement::SonicDrop],
            &step_handling,
        )
        .unwrap();

        assert_eq!(
            compare_route_candidates(&no_soft_drop, &soft_drop_tail),
            Ordering::Less
        );
    }

    #[test]
    fn route_scoring_penalizes_post_softdrop_horizontal() {
        let handling = HandlingConfig {
            soft_drop_mode: SoftDropModeConfig::Step,
            allow_post_softdrop_horizontal: true,
            ..HandlingConfig::default()
        };
        let rotate_only = candidate_route_from_movements(
            &[PieceMovement::SonicDrop, PieceMovement::Cw],
            &handling,
        )
        .unwrap();
        let with_horizontal = candidate_route_from_movements(
            &[PieceMovement::SonicDrop, PieceMovement::Right],
            &handling,
        )
        .unwrap();

        assert_eq!(
            compare_route_candidates(&rotate_only, &with_horizontal),
            Ordering::Less
        );
    }

    #[test]
    fn skip_snapshot_reason_blocks_duplicate_piece_counter() {
        let snapshot = GameSnapshot {
            source: "browser_cdp".to_owned(),
            token: "browser-12-repeat".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::T, PieceToken::I, PieceToken::O],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
            piece_counter: Some(12),
            playing: true,
            countdown: false,
            active: None,
        };

        assert_eq!(
            skip_snapshot_reason(&snapshot, Some(12)).as_deref(),
            Some("duplicate pieceCounter=12")
        );
    }

    #[test]
    fn skip_snapshot_reason_blocks_non_playing_or_countdown_states() {
        let mut snapshot = GameSnapshot {
            source: "browser_cdp".to_owned(),
            token: "browser-3".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::T, PieceToken::I, PieceToken::O],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
            piece_counter: Some(3),
            playing: false,
            countdown: false,
            active: None,
        };
        assert_eq!(
            skip_snapshot_reason(&snapshot, None).as_deref(),
            Some("playing=false")
        );

        snapshot.playing = true;
        snapshot.countdown = true;
        assert_eq!(
            skip_snapshot_reason(&snapshot, None).as_deref(),
            Some("countdown=true")
        );
    }

    #[test]
    fn target_pps_interval_is_disabled_for_zero_or_invalid_values() {
        assert_eq!(target_pps_interval(0.0), None);
        assert_eq!(target_pps_interval(-1.0), None);
        assert_eq!(target_pps_interval(f32::NAN), None);
    }

    #[test]
    fn pps_wait_duration_only_waits_for_remaining_cycle_time() {
        assert_eq!(
            pps_wait_duration(Some(Duration::from_millis(500)), Duration::from_millis(120)),
            Some(Duration::from_millis(380))
        );
        assert_eq!(
            pps_wait_duration(Some(Duration::from_millis(500)), Duration::from_millis(500)),
            None
        );
        assert_eq!(
            pps_wait_duration(Some(Duration::from_millis(500)), Duration::from_millis(750)),
            None
        );
    }

    #[test]
    fn runner_perf_counters_accumulate_snapshot_and_execution_metrics() {
        let mut perf = RunnerPerfTracker::default();
        record_snapshot_poll_metrics(
            &mut perf,
            &SnapshotPollMetrics {
                read_ms: 3,
                parse_ms: 2,
                skipped_same_token: true,
                skipped_same_mtime: true,
            },
        );
        record_execution_perf(&mut perf, 25, 11, 40);

        assert_eq!(perf.snapshot_read_samples, vec![5]);
        assert_eq!(perf.planner_samples, vec![25]);
        assert_eq!(perf.input_samples, vec![11]);
        assert_eq!(perf.total_samples, vec![40]);
        assert_eq!(perf.processed_snapshots, 1);
        assert_eq!(perf.same_token_skips, 1);
        assert_eq!(perf.duplicate_skips, 1);
    }

    #[test]
    fn run_loop_calls_input_backend_when_dry_run_is_false() {
        let snapshot = GameSnapshot {
            source: "test".to_owned(),
            token: "runner-1".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::I, PieceToken::O, PieceToken::T, PieceToken::L],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
            piece_counter: Some(1),
            playing: true,
            countdown: false,
            active: None,
        };
        let mut scanner = SingleSnapshotScanner {
            snapshot: Some(snapshot),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let mut backend = StoppingBackend {
            taps: Vec::new(),
            stop: Some(stop.clone()),
        };
        let live_target_pps = AtomicU32::new(0.0f32.to_bits());
        let mut config = AutomationConfig::default();
        config.dry_run = false;
        config.perf_log_enabled = false;
        config.input_backend = InputBackendConfig::BrowserCdp;
        config.bot.movement_mode = MovementModeConfig::HardDropOnly;
        config.poll_interval_ms = 1;
        config.piece_interval_ms = 0;
        config.hard_drop_interval_ms = 0;

        run_loop_until(
            &config,
            &mut scanner,
            &mut backend,
            &live_target_pps,
            stop.as_ref(),
            |_| {},
        )
        .unwrap();

        assert!(!backend.taps.is_empty());
        assert!(backend.taps.contains(&GameAction::HardDrop));
    }
}
