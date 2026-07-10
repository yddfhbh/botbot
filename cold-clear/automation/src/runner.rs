use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

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
use crate::driver::{execute_plan, ExecutionPlan, ExecutionTimings, GameAction, InputBackend};
use crate::scanner::{GameSnapshot, PieceToken, SnapshotScanner};

#[allow(dead_code)]
pub fn run_loop<S: SnapshotScanner, D: InputBackend + ?Sized>(
    config: &AutomationConfig,
    scanner: &mut S,
    driver: &mut D,
) -> Result<()> {
    let stop = AtomicBool::new(false);
    run_loop_until(config, scanner, driver, &stop, |line| {
        println!("{}", line);
    })
}

pub fn run_loop_until<S, D, F>(
    config: &AutomationConfig,
    scanner: &mut S,
    driver: &mut D,
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
                match prepare_execution(config, &snapshot, &mut log)? {
                    Some(prepared) => {
                        emit_move_logs(&snapshot, &prepared, &mut log);
                        execute_plan(
                            driver,
                            &prepared.execution_plan,
                            &config.handling,
                            execution_timings,
                            |line| log(line),
                        )
                        .context("failed to execute bot move")?;
                        if snapshot.piece_counter.is_some() {
                            last_piece_counter = snapshot.piece_counter;
                        }
                        if prepared.execution_plan.hard_drop {
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

#[derive(Clone, Debug)]
struct PreparedExecution {
    planned_move: Move,
    planner_info: Info,
    movement_mode_used: MovementModeConfig,
    spawn_rule_used: SpawnRuleConfig,
    fallback_from: Option<MovementModeConfig>,
    execution_plan: ExecutionPlan,
    route_selection: RouteSelection,
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

fn emit_move_logs<F>(snapshot: &GameSnapshot, prepared: &PreparedExecution, log: &mut F)
where
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
        "[automation] planner={}",
        format_planner_info(&prepared.planner_info)
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
    let spawned = spawn_for_execution(&board, active_piece, config.bot.spawn_rule)
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
    let soft_drop_count = movements
        .iter()
        .filter(|movement| **movement == PieceMovement::SonicDrop)
        .count();
    let direction_changes = count_direction_changes(movements);
    let rotation_before_drop = count_rotations_before_soft_drop(movements);
    let score = RouteScore {
        has_soft_drop,
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
        let trailing_actions_are_spin_safe = trailing_actions
            .iter()
            .all(|movement| is_allowed_post_softdrop_movement(*movement));

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

fn is_allowed_post_softdrop_movement(movement: PieceMovement) -> bool {
    matches!(
        movement,
        PieceMovement::Left
            | PieceMovement::Right
            | PieceMovement::Cw
            | PieceMovement::Ccw
            | PieceMovement::SonicDrop
    )
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
    use crate::config::{AutomationConfig, MovementModeConfig};
    use crate::scanner::PieceToken;
    use libtetris::{PieceState, RotationState, TspinStatus};

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
                PieceMovement::Right,
            ],
            &handling,
        )
        .unwrap();

        assert_eq!(
            route.movement_actions,
            vec![
                GameAction::Left,
                GameAction::SoftDrop,
                GameAction::RotateCw,
                GameAction::Right,
            ]
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
            "soft_drop_post_actions_blocked actions=RotateCw".to_owned()
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
}
