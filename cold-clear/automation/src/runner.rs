use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use cold_clear::evaluation::{Evaluator, Standard, StandardReward, StandardValue};
use cold_clear::{Info, Interface};
use libtetris::{
    find_moves, Board, FallingPiece, LockResult, Move, MovementMode, Piece, PieceMovement,
    Placement, PlacementKind, RotationState, SpawnRule,
};

use crate::config::{
    AutomationConfig, EvaluationProfileConfig, HandlingConfig, MovementModeConfig,
    RouteProfileConfig, SoftDropModeConfig, SpawnRuleConfig,
};
use crate::driver::{
    execute_hard_drop_action, execute_plan_until_hard_drop, execute_single_action, ExecutionPlan,
    ExecutionTimings, GameAction, InputBackend,
};
use crate::scanner::{
    read_snapshot_file, GameSnapshot, PieceToken, RotationToken, SnapshotScanner,
};
use crate::sprint::{
    register_lock_result, sprint_40l_weights, sprint_context, update_state_for_snapshot,
    Sprint40lEvaluator, SprintContext, SprintPhase, SprintState,
};

#[derive(Clone, Debug)]
enum PlannerEvaluator {
    Normal(Standard),
    Sprint(Sprint40lEvaluator),
}

impl Evaluator for PlannerEvaluator {
    type Value = StandardValue;
    type Reward = StandardReward;

    fn name(&self) -> String {
        match self {
            Self::Normal(weights) => weights.name(),
            Self::Sprint(evaluator) => evaluator.name(),
        }
    }

    fn evaluate(
        &self,
        lock: &LockResult,
        board: &Board,
        move_time: u32,
        placed: Piece,
    ) -> (Self::Value, Self::Reward) {
        match self {
            Self::Normal(weights) => weights.evaluate(lock, board, move_time, placed),
            Self::Sprint(evaluator) => evaluator.evaluate(lock, board, move_time, placed),
        }
    }

    fn pick_move(
        &self,
        candidates: Vec<cold_clear::MoveCandidate<Self::Value>>,
        incoming: u32,
    ) -> cold_clear::MoveCandidate<Self::Value> {
        match self {
            Self::Normal(weights) => weights.pick_move(candidates, incoming),
            Self::Sprint(evaluator) => evaluator.pick_move(candidates, incoming),
        }
    }
}

#[allow(dead_code)]
pub fn run_loop<S: SnapshotScanner, D: InputBackend + ?Sized>(
    config: &AutomationConfig,
    scanner: &mut S,
    driver: &mut D,
) -> Result<()> {
    let stop = AtomicBool::new(false);
    run_loop_until_with_live_pps(config, scanner, driver, &stop, None, |line| {
        println!("{}", line);
    })
}

pub fn run_loop_until<S, D, F>(
    config: &AutomationConfig,
    scanner: &mut S,
    driver: &mut D,
    stop: &AtomicBool,
    log: F,
) -> Result<()>
where
    S: SnapshotScanner,
    D: InputBackend + ?Sized,
    F: FnMut(String),
{
    run_loop_until_with_live_pps(config, scanner, driver, stop, None, log)
}

pub fn run_loop_until_with_live_pps<S, D, F>(
    config: &AutomationConfig,
    scanner: &mut S,
    driver: &mut D,
    stop: &AtomicBool,
    live_target_pps: Option<&AtomicU32>,
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
    let mut sprint_state = SprintState::default();

    loop {
        if stop.load(AtomicOrdering::Relaxed) {
            return Ok(());
        }
        let snapshot_option = if let Some(snapshot) = buffered_snapshot.take() {
            Some(snapshot)
        } else {
            scanner.next_snapshot()?
        };
        match snapshot_option {
            Some(snapshot) => {
                if config.play_style == crate::config::PlayStyleConfig::Speed {
                    update_state_for_snapshot(&mut sprint_state, &snapshot);
                }
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
                    thread::sleep(poll_delay);
                    continue;
                }
                match prepare_execution(config, &snapshot, &sprint_state, &mut log)? {
                    Some(prepared) => {
                        emit_move_logs(config, &snapshot, &prepared, &mut log);
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
                                    if !wait_for_target_pps(
                                        last_hard_drop_started_at,
                                        current_target_pps(config, live_target_pps),
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
                                    if config.play_style == crate::config::PlayStyleConfig::Speed {
                                        register_lock_result(
                                            &mut sprint_state,
                                            &prepared.planned_lock,
                                        );
                                    }
                                }
                                HardDropDecision::Retry(retry_snapshot) => {
                                    buffered_snapshot = Some(retry_snapshot);
                                    thread::sleep(poll_delay);
                                    continue;
                                }
                            }

                            buffered_snapshot = wait_for_next_piece_snapshot(
                                scanner,
                                &snapshot,
                                stop,
                                poll_delay,
                                piece_interval,
                                &mut log,
                            )?;
                            if buffered_snapshot.is_none() && stop.load(AtomicOrdering::Relaxed) {
                                return Ok(());
                            }
                        }
                    }
                    None => {
                        thread::sleep(poll_delay);
                    }
                }
            }
            None => {
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

fn current_target_pps(config: &AutomationConfig, live_target_pps: Option<&AtomicU32>) -> f32 {
    live_target_pps
        .map(|value| f32::from_bits(value.load(AtomicOrdering::Relaxed)))
        .unwrap_or(config.target_pps)
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
    last_hard_drop_started_at: Option<Instant>,
    target_pps: f32,
    stop: &AtomicBool,
    log: &mut F,
) -> bool
where
    F: FnMut(String),
{
    let Some(target_piece_time) = target_pps_interval(target_pps) else {
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

#[derive(Clone, Debug)]
struct PreparedExecution {
    planned_move: Move,
    planned_piece: Piece,
    planned_lock: LockResult,
    planner_info: Info,
    planner_elapsed_ms: u128,
    movement_mode_used: MovementModeConfig,
    spawn_rule_used: SpawnRuleConfig,
    fallback_from: Option<MovementModeConfig>,
    sprint_context: Option<SprintContext>,
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
    estimated_input_cost: usize,
    rotation_count: usize,
    direction_changes: usize,
    action_count: usize,
    soft_drop_count: usize,
    is_spin_route: bool,
    used_spin_fallback: bool,
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

#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct SpeedRouteScore {
    soft_drop_penalty: usize,
    post_softdrop_penalty: usize,
    estimated_input_cost: usize,
    rotation_count: usize,
    direction_changes: usize,
    action_count: usize,
}

#[derive(Clone, Debug)]
struct CandidateRoute {
    score: RouteScore,
    speed_score: SpeedRouteScore,
    route_kind: &'static str,
    movement_actions: Vec<GameAction>,
    rotation_count: usize,
    direction_changes: usize,
    action_count: usize,
    soft_drop_count: usize,
    estimated_input_cost: usize,
    is_spin_route: bool,
}

fn prepare_execution<F>(
    config: &AutomationConfig,
    snapshot: &GameSnapshot,
    sprint_state: &SprintState,
    log: &mut F,
) -> Result<Option<PreparedExecution>>
where
    F: FnMut(String),
{
    let planner_started_at = Instant::now();
    let Some((planned_move, planner_info)) =
        plan_move_for_mode(config, snapshot, config.bot.movement_mode, sprint_state)?
    else {
        log(format!(
            "[automation] source={} token={} planner produced no move for mode={}; waiting for fresher snapshot",
            snapshot.source,
            snapshot.token,
            movement_mode_label(config.bot.movement_mode),
        ));
        return Ok(None);
    };
    let planned_outcome = simulate_planned_lock(snapshot, &planned_move)?;
    let sprint_context = sprint_context_for_config(config, snapshot, sprint_state);
    match build_execution_plan(config, snapshot, &planned_move, config.bot.movement_mode) {
        Ok(result) => Ok(Some(PreparedExecution {
            planned_move,
            planned_piece: planned_outcome.placed_piece,
            planned_lock: planned_outcome.lock,
            planner_info,
            planner_elapsed_ms: planner_started_at.elapsed().as_millis(),
            movement_mode_used: config.bot.movement_mode,
            spawn_rule_used: config.bot.spawn_rule,
            fallback_from: None,
            sprint_context,
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
                plan_move_for_mode(config, snapshot, fallback_mode, sprint_state)?
            else {
                log(format!(
                    "[automation] source={} token={} planner produced no move for fallback mode={}; waiting for fresher snapshot",
                    snapshot.source,
                    snapshot.token,
                    movement_mode_label(fallback_mode),
                ));
                return Ok(None);
            };
            let fallback_outcome = simulate_planned_lock(snapshot, &fallback_move)?;
            match build_execution_plan(config, snapshot, &fallback_move, fallback_mode) {
                Ok(result) => Ok(Some(PreparedExecution {
                    planned_move: fallback_move,
                    planned_piece: fallback_outcome.placed_piece,
                    planned_lock: fallback_outcome.lock,
                    planner_info: fallback_info,
                    planner_elapsed_ms: fallback_started_at.elapsed().as_millis(),
                    movement_mode_used: fallback_mode,
                    spawn_rule_used: config.bot.spawn_rule,
                    fallback_from: Some(config.bot.movement_mode),
                    sprint_context,
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
    if let Some(context) = &prepared.sprint_context {
        log(format!(
            "[style] speed objective=sprint40l phase={} lines={} remaining={}",
            sprint_phase_label(context.phase),
            context.lines_cleared,
            context.remaining_lines
        ));
        log(format!(
            "[style] board well_col={} clean_depth={} tetris_ready={} max_height={} cavities={}",
            context.board_features.best_well_column,
            context.board_features.clean_well_depth,
            context.board_features.tetris_ready,
            context.board_features.max_height,
            context.board_features.cavity_cells
        ));
        log(format!(
            "[style] planned_clear={} route_cost={}",
            prepared.planned_lock.cleared_lines.len(),
            prepared.route_selection.estimated_input_cost
        ));
        if context.phase == SprintPhase::Recovery {
            log(format!(
                "[style] sprint phase=recovery reason={} max_height={}",
                sprint_recovery_reason(&context.board_features),
                context.board_features.max_height
            ));
        }
        if context.phase == SprintPhase::Finish
            && prepared.planned_lock.placement_kind != PlacementKind::Clear4
            && prepared.planned_lock.placement_kind.is_clear()
        {
            log(format!(
                "[style] sprint phase=finish remaining={} allowing_non_tetris_clear=true",
                context.remaining_lines
            ));
        }
        if prepared.planned_lock.placement_kind == PlacementKind::Clear4 {
            let remaining = context
                .remaining_lines
                .saturating_sub(prepared.planned_lock.cleared_lines.len() as u32);
            log(format!(
                "[style] sprint tetris remaining={} well_col={}",
                remaining, context.board_features.best_well_column
            ));
        }
        if snapshot.queue.first() == Some(&PieceToken::I) && prepared.planned_move.hold {
            log("[style] sprint I decision=hold reason=well_not_ready".to_owned());
        } else if prepared.planned_piece == Piece::I
            && prepared.planned_lock.placement_kind == PlacementKind::Clear4
        {
            log(format!(
                "[style] sprint I decision=tetris well_column={}",
                context.board_features.best_well_column
            ));
        }
    }
    if config.route_profile == RouteProfileConfig::Speed {
        if prepared.route_selection.used_spin_fallback {
            log(format!(
                "[style] speed spin fallback reason=no_non_spin_route input_cost={}",
                prepared.route_selection.estimated_input_cost
            ));
        } else {
            log(format!(
                "[style] speed route={} inputs={} rotations={} softdrops={} spin={} estimated_cost={} direction_changes={} actions={}",
                if prepared.route_selection.is_spin_route {
                    "spin"
                } else {
                    "non_spin"
                },
                prepared.route_selection.action_count,
                prepared.route_selection.rotation_count,
                prepared.route_selection.soft_drop_count,
                prepared.route_selection.is_spin_route,
                prepared.route_selection.estimated_input_cost,
                prepared.route_selection.direction_changes,
                prepared.route_selection.action_count
            ));
        }
    }
}

fn route_actions_with_hard_drop(plan: &ExecutionPlan) -> Vec<GameAction> {
    let mut actions = plan.movement_actions.clone();
    if plan.hard_drop {
        actions.push(GameAction::HardDrop);
    }
    actions
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
    let sprint_state = SprintState::default();
    let movement_mode = config.bot.movement_mode;
    let (planned_move, _) = plan_move_for_mode(config, snapshot, movement_mode, &sprint_state)?
        .context("bot failed to produce a move for the current snapshot")?;
    Ok((planned_move, movement_mode_label(movement_mode)))
}

fn plan_move_for_mode(
    config: &AutomationConfig,
    snapshot: &GameSnapshot,
    movement_mode: MovementModeConfig,
    sprint_state: &SprintState,
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

    let evaluator = planner_evaluator(config, snapshot, sprint_state);
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
        evaluator,
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

fn evaluation_weights_for_profile(
    profile: EvaluationProfileConfig,
    snapshot: &GameSnapshot,
    sprint_state: &SprintState,
) -> Standard {
    match profile {
        EvaluationProfileConfig::Normal => Standard::default(),
        EvaluationProfileConfig::Speed => sprint_40l_weights(snapshot, sprint_state),
    }
}

fn planner_evaluator(
    config: &AutomationConfig,
    snapshot: &GameSnapshot,
    sprint_state: &SprintState,
) -> PlannerEvaluator {
    match config.evaluation_profile {
        EvaluationProfileConfig::Normal => PlannerEvaluator::Normal(
            evaluation_weights_for_profile(config.evaluation_profile, snapshot, sprint_state),
        ),
        EvaluationProfileConfig::Speed => {
            PlannerEvaluator::Sprint(Sprint40lEvaluator::new(snapshot, sprint_state))
        }
    }
}

#[derive(Clone, Debug)]
struct PlannedLockOutcome {
    placed_piece: Piece,
    lock: LockResult,
}

fn simulate_planned_lock(
    snapshot: &GameSnapshot,
    planned_move: &Move,
) -> Result<PlannedLockOutcome> {
    let mut board = board_from_snapshot(snapshot)?;
    for piece in snapshot.queue_pieces() {
        board.add_next_piece(piece);
    }
    let queued_piece = board
        .advance_queue()
        .context("snapshot queue must include the active piece for lock simulation")?;
    let placed_piece = if planned_move.hold {
        board.hold(queued_piece).unwrap_or_else(|| {
            board
                .advance_queue()
                .expect("hold-first move requires at least one preview piece for lock simulation")
        })
    } else {
        queued_piece
    };
    let lock = board.lock_piece(planned_move.expected_location);
    Ok(PlannedLockOutcome { placed_piece, lock })
}

fn sprint_context_for_config(
    config: &AutomationConfig,
    snapshot: &GameSnapshot,
    sprint_state: &SprintState,
) -> Option<SprintContext> {
    if config.play_style == crate::config::PlayStyleConfig::Speed {
        Some(sprint_context(snapshot, sprint_state))
    } else {
        None
    }
}

fn sprint_phase_label(phase: SprintPhase) -> &'static str {
    match phase {
        SprintPhase::Build => "build",
        SprintPhase::Finish => "finish",
        SprintPhase::Recovery => "recovery",
    }
}

fn sprint_recovery_reason(features: &crate::sprint::SprintBoardFeatures) -> &'static str {
    if features.cavity_cells > 0 {
        "cavity"
    } else if features.blocked_well_cells > 0 {
        "blocked_well"
    } else if features.max_height >= 14 {
        "height"
    } else {
        "unstable_stack"
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
            config.route_profile,
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
        estimated_input_cost: estimate_game_action_cost(&movement_actions),
        rotation_count: count_game_action_rotations(&movement_actions),
        direction_changes: count_game_action_direction_changes(&movement_actions),
        action_count: movement_actions.len(),
        soft_drop_count: 0,
        is_spin_route: false,
        used_spin_fallback: false,
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
    route_profile: RouteProfileConfig,
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

    let chosen = select_route_candidate(route_profile, candidates);
    let CandidateRoute {
        route_kind,
        movement_actions,
        rotation_count,
        direction_changes,
        action_count,
        soft_drop_count,
        estimated_input_cost,
        is_spin_route,
        ..
    } = chosen;
    Ok(RouteSelection {
        route_kind,
        movement_actions,
        candidate_count: placements.len(),
        rejected_count: rejected_reasons.len(),
        representative_reject_reason: summarize_reject_reasons(&rejected_reasons),
        estimated_input_cost,
        rotation_count,
        direction_changes,
        action_count,
        soft_drop_count,
        is_spin_route,
        used_spin_fallback: route_profile == RouteProfileConfig::Speed && is_spin_route,
    })
}

fn compare_route_candidates(left: &CandidateRoute, right: &CandidateRoute) -> Ordering {
    left.score.cmp(&right.score).then_with(|| {
        left.movement_actions
            .len()
            .cmp(&right.movement_actions.len())
    })
}

fn compare_speed_route_candidates(left: &CandidateRoute, right: &CandidateRoute) -> Ordering {
    left.speed_score.cmp(&right.speed_score).then_with(|| {
        left.movement_actions
            .len()
            .cmp(&right.movement_actions.len())
    })
}

fn select_route_candidate(
    profile: RouteProfileConfig,
    mut candidates: Vec<CandidateRoute>,
) -> CandidateRoute {
    match profile {
        RouteProfileConfig::Normal => {
            candidates.sort_by(compare_route_candidates);
            candidates.remove(0)
        }
        RouteProfileConfig::Speed => {
            let mut non_spin = candidates
                .iter()
                .filter(|candidate| !candidate.is_spin_route)
                .cloned()
                .collect::<Vec<_>>();
            if !non_spin.is_empty() {
                non_spin.sort_by(compare_speed_route_candidates);
                return non_spin.remove(0);
            }
            candidates.sort_by(compare_speed_route_candidates);
            candidates.remove(0)
        }
    }
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
    let rotation_count = count_rotations(movements);
    let rotation_before_drop = count_rotations_before_soft_drop(movements);
    let action_count = movements.len();
    let is_spin_route = has_post_softdrop_actions;
    let estimated_input_cost = estimate_input_cost(
        movements,
        has_post_softdrop_actions,
        post_softdrop_horizontal_count,
    );
    let score = RouteScore {
        has_soft_drop,
        post_softdrop_horizontal: post_softdrop_horizontal_count > 0,
        post_softdrop_horizontal_count,
        action_count,
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
    let speed_score = SpeedRouteScore {
        soft_drop_penalty: soft_drop_count,
        post_softdrop_penalty: post_softdrop_horizontal_count,
        estimated_input_cost,
        rotation_count,
        direction_changes,
        action_count,
    };

    Ok(CandidateRoute {
        score,
        speed_score,
        route_kind: if has_post_softdrop_actions {
            "SoftDropSpinRoute"
        } else if has_soft_drop {
            "SoftDropTail"
        } else {
            "NoSoftDrop"
        },
        movement_actions,
        rotation_count,
        direction_changes,
        action_count,
        soft_drop_count,
        estimated_input_cost,
        is_spin_route,
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

fn count_rotations(movements: &[PieceMovement]) -> usize {
    movements
        .iter()
        .filter(|movement| matches!(movement, PieceMovement::Cw | PieceMovement::Ccw))
        .count()
}

fn estimate_input_cost(
    movements: &[PieceMovement],
    is_spin_route: bool,
    post_softdrop_horizontal_count: usize,
) -> usize {
    let mut cost = 0;
    for movement in movements {
        cost += match movement {
            PieceMovement::Left | PieceMovement::Right => 1,
            PieceMovement::Cw | PieceMovement::Ccw => 2,
            PieceMovement::SonicDrop => 4,
        };
    }
    if is_spin_route {
        cost += 100;
    }
    cost + (post_softdrop_horizontal_count * 8)
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

fn count_game_action_direction_changes(actions: &[GameAction]) -> usize {
    let mut last_horizontal = None;
    let mut changes = 0;
    for action in actions {
        let current = match action {
            GameAction::Left => Some(-1_i32),
            GameAction::Right => Some(1_i32),
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

fn count_game_action_rotations(actions: &[GameAction]) -> usize {
    actions
        .iter()
        .filter(|action| matches!(action, GameAction::RotateCw | GameAction::RotateCcw))
        .count()
}

fn estimate_game_action_cost(actions: &[GameAction]) -> usize {
    actions
        .iter()
        .map(|action| match action {
            GameAction::Left | GameAction::Right => 1,
            GameAction::RotateCw | GameAction::RotateCcw => 2,
            GameAction::SoftDrop => 4,
            GameAction::Hold => 2,
            GameAction::HardDrop => 0,
        })
        .sum()
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
    use crate::config::{
        AutomationConfig, EvaluationProfileConfig, MovementModeConfig, PlayStyleConfig,
        RouteProfileConfig,
    };
    use crate::scanner::PieceToken;
    use libtetris::{PieceState, RotationState, Statistics, TspinStatus};
    use std::sync::atomic::AtomicU32;

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
            lines_cleared: None,
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
            lines_cleared: None,
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
            lines_cleared: None,
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
            lines_cleared: None,
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
    fn speed_profile_uses_requested_weight_overrides() {
        let snapshot = GameSnapshot {
            source: "test".to_owned(),
            token: "browser-1-0".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::I, PieceToken::O, PieceToken::T],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
            piece_counter: Some(0),
            lines_cleared: Some(0),
            playing: true,
            countdown: false,
            active: None,
        };
        let weights = evaluation_weights_for_profile(
            EvaluationProfileConfig::Speed,
            &snapshot,
            &SprintState::default(),
        );

        assert_eq!(weights.tslot, [0, 0, 0, 0]);
        assert_eq!(weights.clear1, -500);
        assert_eq!(weights.clear2, -350);
        assert_eq!(weights.clear3, -200);
        assert_eq!(weights.clear4, 1300);
        assert_eq!(weights.wasted_t, 0);
        assert_eq!(weights.move_time, -10);
        assert_eq!(weights.b2b_clear, 50);
        assert_eq!(weights.combo_garbage, 0);
    }

    #[test]
    fn speed_route_prefers_non_spin_routes() {
        let handling = HandlingConfig {
            soft_drop_mode: SoftDropModeConfig::Step,
            allow_post_softdrop_actions: true,
            ..HandlingConfig::default()
        };
        let non_spin = candidate_route_from_movements(&[PieceMovement::Left], &handling).unwrap();
        let spin = candidate_route_from_movements(
            &[
                PieceMovement::Left,
                PieceMovement::SonicDrop,
                PieceMovement::Cw,
            ],
            &handling,
        )
        .unwrap();

        let chosen =
            select_route_candidate(RouteProfileConfig::Speed, vec![spin, non_spin.clone()]);

        assert_eq!(chosen.route_kind, non_spin.route_kind);
        assert!(!chosen.is_spin_route);
    }

    #[test]
    fn speed_route_prefers_shorter_input_costs() {
        let handling = HandlingConfig {
            soft_drop_mode: SoftDropModeConfig::Step,
            ..HandlingConfig::default()
        };
        let shorter =
            candidate_route_from_movements(&[PieceMovement::Left, PieceMovement::Cw], &handling)
                .unwrap();
        let longer = candidate_route_from_movements(
            &[PieceMovement::Left, PieceMovement::Right, PieceMovement::Cw],
            &handling,
        )
        .unwrap();

        let chosen =
            select_route_candidate(RouteProfileConfig::Speed, vec![longer, shorter.clone()]);

        assert_eq!(chosen.estimated_input_cost, shorter.estimated_input_cost);
    }

    #[test]
    fn speed_route_prefers_fewer_rotations_after_cost_tie() {
        let handling = HandlingConfig {
            soft_drop_mode: SoftDropModeConfig::Step,
            ..HandlingConfig::default()
        };
        let fewer_rotations =
            candidate_route_from_movements(&[PieceMovement::Left, PieceMovement::Right], &handling)
                .unwrap();
        let more_rotations =
            candidate_route_from_movements(&[PieceMovement::Cw], &handling).unwrap();

        let chosen = select_route_candidate(
            RouteProfileConfig::Speed,
            vec![more_rotations, fewer_rotations.clone()],
        );

        assert_eq!(chosen.rotation_count, fewer_rotations.rotation_count);
        assert_eq!(chosen.route_kind, fewer_rotations.route_kind);
    }

    #[test]
    fn speed_route_falls_back_to_spin_when_needed() {
        let handling = HandlingConfig {
            soft_drop_mode: SoftDropModeConfig::Step,
            allow_post_softdrop_actions: true,
            ..HandlingConfig::default()
        };
        let spin = candidate_route_from_movements(
            &[
                PieceMovement::Left,
                PieceMovement::SonicDrop,
                PieceMovement::Cw,
            ],
            &handling,
        )
        .unwrap();

        let chosen = select_route_candidate(RouteProfileConfig::Speed, vec![spin.clone()]);

        assert!(chosen.is_spin_route);
        assert_eq!(chosen.route_kind, spin.route_kind);
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
            lines_cleared: None,
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
            lines_cleared: None,
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
    fn target_pps_interval_matches_expected_piece_times() {
        assert_eq!(target_pps_interval(2.0), Some(Duration::from_millis(500)));
        assert_eq!(target_pps_interval(5.0), Some(Duration::from_millis(200)));
    }

    #[test]
    fn live_target_pps_overrides_static_config_value() {
        let config = AutomationConfig {
            target_pps: 2.0,
            ..AutomationConfig::default()
        };
        let live_target_pps = AtomicU32::new(5.0f32.to_bits());

        assert_eq!(current_target_pps(&config, Some(&live_target_pps)), 5.0);
        assert_eq!(
            target_pps_interval(current_target_pps(&config, Some(&live_target_pps))),
            Some(Duration::from_millis(200))
        );
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

    #[derive(Default)]
    struct BenchmarkAggregate {
        completed: usize,
        topouts: usize,
        total_pieces: u64,
        tetrises: u64,
        non_tetris_clears: u64,
        clear_events: u64,
        estimated_input_cost: u64,
        rotation_count: u64,
    }

    impl BenchmarkAggregate {
        fn update(&mut self, result: &SimulationResult) {
            self.completed += usize::from(result.completed);
            self.topouts += usize::from(result.topout);
            self.total_pieces += result.statistics.pieces;
            self.tetrises += result.statistics.tetrises;
            self.non_tetris_clears +=
                result.statistics.singles + result.statistics.doubles + result.statistics.triples;
            self.clear_events += result.statistics.singles
                + result.statistics.doubles
                + result.statistics.triples
                + result.statistics.tetrises;
            self.estimated_input_cost += result.estimated_input_cost;
            self.rotation_count += result.rotation_count;
        }
    }

    struct SimulationResult {
        completed: bool,
        topout: bool,
        statistics: Statistics,
        estimated_input_cost: u64,
        rotation_count: u64,
    }

    fn speed_config() -> AutomationConfig {
        let mut config = AutomationConfig::default();
        config.play_style = PlayStyleConfig::Speed;
        config.evaluation_profile = EvaluationProfileConfig::Speed;
        config.route_profile = RouteProfileConfig::Speed;
        config
    }

    fn piece_to_token(piece: Piece) -> PieceToken {
        match piece {
            Piece::I => PieceToken::I,
            Piece::O => PieceToken::O,
            Piece::T => PieceToken::T,
            Piece::L => PieceToken::L,
            Piece::J => PieceToken::J,
            Piece::S => PieceToken::S,
            Piece::Z => PieceToken::Z,
        }
    }

    fn next_seed_value(seed: &mut u64) -> u32 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        (*seed >> 32) as u32
    }

    fn next_bag(seed: &mut u64) -> [Piece; 7] {
        let mut bag = [
            Piece::I,
            Piece::O,
            Piece::T,
            Piece::L,
            Piece::J,
            Piece::S,
            Piece::Z,
        ];
        for index in (1..bag.len()).rev() {
            let swap_index = (next_seed_value(seed) as usize) % (index + 1);
            bag.swap(index, swap_index);
        }
        bag
    }

    fn fill_queue(board: &mut Board, seed: &mut u64, min_len: usize) {
        while board.next_queue().count() < min_len {
            for piece in next_bag(seed) {
                board.add_next_piece(piece);
            }
        }
    }

    fn snapshot_from_board(
        board: &Board,
        piece_counter: u32,
        lines_cleared: u32,
        epoch: u64,
    ) -> GameSnapshot {
        GameSnapshot {
            source: "benchmark".to_owned(),
            token: format!("browser-{epoch}-{piece_counter}"),
            field: board.get_field().into_iter().collect(),
            queue: board.next_queue().take(6).map(piece_to_token).collect(),
            hold: board.hold_piece.map(piece_to_token),
            combo: board.combo,
            b2b: board.b2b_bonus,
            incoming: 0,
            piece_counter: Some(piece_counter),
            lines_cleared: Some(lines_cleared),
            playing: true,
            countdown: false,
            active: None,
        }
    }

    fn apply_planned_move(board: &mut Board, planned_move: &Move) -> LockResult {
        let next = board
            .advance_queue()
            .expect("benchmark queue should not be empty");
        if planned_move.hold {
            board
                .hold(next)
                .unwrap_or_else(|| board.advance_queue().expect("hold move needs preview"));
        }
        board.lock_piece(planned_move.expected_location)
    }

    fn simulate_seed(config: &AutomationConfig, seed: u64) -> SimulationResult {
        let mut board = Board::new();
        let mut rng = seed.max(1);
        let mut sprint_state = SprintState::default();
        let mut piece_counter = 0u32;
        let mut lines_cleared = 0u32;
        let mut statistics = Statistics::default();
        let mut estimated_input_cost = 0u64;
        let mut rotation_count = 0u64;

        fill_queue(&mut board, &mut rng, 8);

        while lines_cleared < 40 && piece_counter < 200 {
            fill_queue(&mut board, &mut rng, 8);
            let snapshot = snapshot_from_board(&board, piece_counter, lines_cleared, 1);
            if config.play_style == PlayStyleConfig::Speed {
                update_state_for_snapshot(&mut sprint_state, &snapshot);
            }
            let prepared = match prepare_execution(config, &snapshot, &sprint_state, &mut |_| {}) {
                Ok(Some(prepared)) => prepared,
                Ok(None) | Err(_) => {
                    return SimulationResult {
                        completed: false,
                        topout: true,
                        statistics,
                        estimated_input_cost,
                        rotation_count,
                    };
                }
            };
            estimated_input_cost += prepared.route_selection.estimated_input_cost as u64;
            rotation_count += prepared.route_selection.rotation_count as u64;

            let lock = apply_planned_move(&mut board, &prepared.planned_move);
            statistics.update(&lock);
            lines_cleared = lines_cleared.saturating_add(lock.cleared_lines.len() as u32);
            piece_counter += 1;
            if config.play_style == PlayStyleConfig::Speed {
                register_lock_result(&mut sprint_state, &lock);
            }
            if lock.locked_out {
                return SimulationResult {
                    completed: false,
                    topout: true,
                    statistics,
                    estimated_input_cost,
                    rotation_count,
                };
            }
        }

        SimulationResult {
            completed: lines_cleared >= 40,
            topout: false,
            statistics,
            estimated_input_cost,
            rotation_count,
        }
    }

    #[test]
    #[ignore]
    fn sprint_40l_benchmark() {
        let normal = AutomationConfig::default();
        let speed = speed_config();
        let seeds = std::env::var("AUTOMATION_SPRINT_BENCH_SEEDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(20);
        let mut normal_stats = BenchmarkAggregate::default();
        let mut speed_stats = BenchmarkAggregate::default();

        for seed in 1..=seeds {
            normal_stats.update(&simulate_seed(&normal, seed));
            speed_stats.update(&simulate_seed(&speed, seed));
        }

        println!("Sprint benchmark, {seeds} seeds");
        println!(
            "normal completion rate: {}/{}",
            normal_stats.completed, seeds
        );
        println!(
            "normal average tetrises: {:.2}",
            normal_stats.tetrises as f64 / seeds as f64
        );
        println!(
            "normal average clear events: {:.2}",
            normal_stats.clear_events as f64 / seeds as f64
        );
        println!("speed completion rate: {}/{}", speed_stats.completed, seeds);
        println!(
            "speed average pieces: {:.2}",
            speed_stats.total_pieces as f64 / seeds as f64
        );
        println!(
            "speed average tetrises: {:.2}",
            speed_stats.tetrises as f64 / seeds as f64
        );
        println!(
            "speed average non-tetris clears: {:.2}",
            speed_stats.non_tetris_clears as f64 / seeds as f64
        );
        println!(
            "speed average clear events: {:.2}",
            speed_stats.clear_events as f64 / seeds as f64
        );
        println!(
            "speed average estimated input cost: {:.2}",
            speed_stats.estimated_input_cost as f64 / seeds as f64
        );
        println!(
            "speed average rotations: {:.2}",
            speed_stats.rotation_count as f64 / seeds as f64
        );
        println!("speed topouts: {}", speed_stats.topouts);
    }
}
