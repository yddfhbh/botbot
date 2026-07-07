use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use cold_clear::evaluation::Standard;
use cold_clear::Interface;
use libtetris::{find_moves, Board, FallingPiece, Move, MovementMode, Piece, PieceMovement, SpawnRule};

use crate::config::{AutomationConfig, MovementModeConfig, SpawnRuleConfig};
use crate::driver::{ExecutionPlan, GameAction, InputDriver};
use crate::scanner::{GameSnapshot, SnapshotScanner};

#[allow(dead_code)]
pub fn run_loop<S: SnapshotScanner, D: InputDriver>(
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
    D: InputDriver,
    F: FnMut(String),
{
    let poll_delay = Duration::from_millis(config.poll_interval_ms);
    let tap_duration = Duration::from_millis(config.tap_duration_ms);
    let settle_delay = Duration::from_millis(config.settle_delay_ms);

    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        match scanner.next_snapshot()? {
            Some(snapshot) => {
                let (planned_move, mode_label) = plan_move(config, &snapshot)?;
                let execution_plan = build_execution_plan(config, &snapshot, &planned_move)?;
                log(format!(
                    "[automation] token={} mode={} hold={} actions={:?}",
                    snapshot.token,
                    mode_label,
                    execution_plan.hold,
                    execution_plan.actions
                ));
                driver
                    .execute_plan(&execution_plan, &config.keys, tap_duration, settle_delay)
                    .context("failed to execute bot move")?;
            }
            None => {
                thread::sleep(poll_delay);
            }
        }
    }
}

fn plan_move(config: &AutomationConfig, snapshot: &GameSnapshot) -> Result<(Move, &'static str)> {
    let movement_mode = config.bot.movement_mode;
    let planned_move = plan_move_for_mode(config, snapshot, movement_mode)?;
    Ok((planned_move, movement_mode_label(movement_mode)))
}

fn movement_mode_label(mode: MovementModeConfig) -> &'static str {
    match mode {
        MovementModeConfig::ZeroG => "ZeroG",
        MovementModeConfig::ZeroGComplete => "ZeroGComplete",
        MovementModeConfig::TwentyG => "TwentyG",
        MovementModeConfig::HardDropOnly => "HardDropOnly",
    }
}

fn plan_move_for_mode(
    config: &AutomationConfig,
    snapshot: &GameSnapshot,
    movement_mode: MovementModeConfig,
) -> Result<Move> {
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
            mode: match movement_mode {
                MovementModeConfig::ZeroG => libtetris::MovementMode::ZeroG,
                MovementModeConfig::ZeroGComplete => libtetris::MovementMode::ZeroGComplete,
                MovementModeConfig::TwentyG => libtetris::MovementMode::TwentyG,
                MovementModeConfig::HardDropOnly => libtetris::MovementMode::HardDropOnly,
            },
            spawn_rule: match config.bot.spawn_rule {
                SpawnRuleConfig::Row19Or20 => libtetris::SpawnRule::Row19Or20,
                SpawnRuleConfig::Row21AndFall => libtetris::SpawnRule::Row21AndFall,
            },
            use_hold: config.bot.use_hold,
            speculate: config.bot.speculate,
            pcloop: None,
            min_nodes: config.bot.min_nodes,
            max_nodes: config.bot.max_nodes,
            threads: config.bot.threads,
        },
        Standard::default(),
        Option::<Arc<cold_clear::Book>>::None,
    );
    interface.suggest_next_move(snapshot.incoming);
    let (planned_move, _) = interface
        .block_next_move()
        .context("bot failed to produce a move for the current snapshot")?;
    Ok(planned_move)
}

fn build_execution_plan(
    config: &AutomationConfig,
    snapshot: &GameSnapshot,
    planned_move: &Move,
) -> Result<ExecutionPlan> {
    let board = board_from_snapshot(snapshot)?;
    let active_piece = execution_piece(snapshot, planned_move.hold)?;
    let spawned = spawn_for_execution(&board, active_piece, config.bot.spawn_rule)?;
    let route = placement_actions_for_target(
        &board,
        spawned,
        planned_move.expected_location,
        movement_mode(config.bot.movement_mode),
    )
    .context("failed to build an SRS input route to the expected placement")?;
    Ok(ExecutionPlan {
        hold: planned_move.hold,
        actions: route,
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

fn spawn_for_execution(board: &Board, piece: Piece, spawn_rule: SpawnRuleConfig) -> Result<FallingPiece> {
    let rule = match spawn_rule {
        SpawnRuleConfig::Row19Or20 => SpawnRule::Row19Or20,
        SpawnRuleConfig::Row21AndFall => SpawnRule::Row21AndFall,
    };
    rule.spawn(piece, board)
        .with_context(|| format!("failed to spawn {:?} with {:?}", piece, spawn_rule))
}

fn movement_mode(mode: MovementModeConfig) -> MovementMode {
    match mode {
        MovementModeConfig::ZeroG => MovementMode::ZeroG,
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
) -> Result<Vec<GameAction>> {
    let placement = find_moves(board, spawned, movement_mode)
        .into_iter()
        .find(|placement| placement.location.same_location(&target))
        .with_context(|| {
            format!(
                "no SRS route found from spawn {:?} to target {:?}",
                spawned, target
            )
        })?;

    let mut actions = placement
        .inputs
        .movements
        .iter()
        .copied()
        .map(game_action_from_piece_movement)
        .collect::<Vec<_>>();
    actions.push(GameAction::HardDrop);
    Ok(actions)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AutomationConfig;
    use crate::scanner::{GameSnapshot, PieceToken};
    use libtetris::{PieceState, RotationState, TspinStatus};

    #[test]
    fn plan_move_requires_queue() {
        let snapshot = GameSnapshot {
            token: "t0".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
        };
        let result = plan_move(&AutomationConfig::default(), &snapshot);
        assert!(result.is_err());
    }

    #[test]
    fn plan_move_works_for_a_basic_queue() {
        let snapshot = GameSnapshot {
            token: "t1".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::I, PieceToken::O, PieceToken::T, PieceToken::L],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
        };
        let (result, _mode) = plan_move(&AutomationConfig::default(), &snapshot).unwrap();
        assert!(!result.inputs.is_empty() || result.hold);
    }

    #[test]
    fn execution_plan_uses_libtetris_route_for_simple_drop() {
        let snapshot = GameSnapshot {
            token: "t2".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::J, PieceToken::O, PieceToken::T, PieceToken::L],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
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

        let plan = build_execution_plan(&config, &snapshot, &planned_move).unwrap();

        assert_eq!(plan.actions, vec![GameAction::Left, GameAction::HardDrop]);
    }

    #[test]
    fn execution_route_can_include_rotations() {
        let snapshot = GameSnapshot {
            token: "t3".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::I, PieceToken::O, PieceToken::T, PieceToken::L],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
        };
        let board = board_from_snapshot(&snapshot).unwrap();
        let spawned = spawn_for_execution(&board, Piece::I, SpawnRuleConfig::Row19Or20).unwrap();
        let mut target = spawned;
        target.cw(&board);
        target.sonic_drop(&board);
        let route = placement_actions_for_target(
            &board,
            spawned,
            target,
            movement_mode(MovementModeConfig::ZeroGComplete),
        )
        .unwrap();
        assert!(route.contains(&GameAction::RotateCw) || route.contains(&GameAction::RotateCcw));
        assert_eq!(route.last(), Some(&GameAction::HardDrop));
    }
}
