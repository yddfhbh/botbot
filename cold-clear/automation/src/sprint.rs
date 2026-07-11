use cold_clear::evaluation::{Evaluator, Standard, StandardReward, StandardValue};
use cold_clear::MoveCandidate;
use libtetris::{Board, LockResult, PlacementKind};

use crate::scanner::GameSnapshot;

const SPRINT_TARGET_LINES: u32 = 40;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SprintState {
    pub game_epoch: Option<u64>,
    pub lines_cleared_fallback: u32,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum SprintPhase {
    Build,
    Finish,
    Recovery,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SprintBoardFeatures {
    pub best_well_column: usize,
    pub clean_well_depth: u32,
    pub tetris_ready: bool,
    pub almost_tetris_ready: bool,
    pub blocked_well_cells: u32,
    pub cavity_cells: u32,
    pub covered_cells: u32,
    pub max_height: u32,
    pub deep_well_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SprintContext {
    pub lines_cleared: u32,
    pub remaining_lines: u32,
    pub phase: SprintPhase,
    pub board_features: SprintBoardFeatures,
}

#[derive(Clone, Debug)]
pub struct Sprint40lEvaluator {
    context: SprintContext,
    weights: Standard,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct SprintCandidateScore {
    completes_run: bool,
    phase_priority: i32,
    safety_priority: i32,
    clean_well_depth: i32,
    clear_lines: i32,
    clears_without_tetris: i32,
    neg_cavity_cells: i32,
    neg_blocked_well_cells: i32,
    neg_covered_cells: i32,
    neg_max_height: i32,
    neg_deep_well_count: i32,
    base: StandardValue,
    neg_original_rank: i32,
}

impl Sprint40lEvaluator {
    pub fn new(snapshot: &GameSnapshot, sprint_state: &SprintState) -> Self {
        let context = sprint_context(snapshot, sprint_state);
        let weights = sprint_40l_weights(snapshot, sprint_state);
        Self { context, weights }
    }
}

impl Evaluator for Sprint40lEvaluator {
    type Value = StandardValue;
    type Reward = StandardReward;

    fn name(&self) -> String {
        "Sprint40L".to_owned()
    }

    fn evaluate(
        &self,
        lock: &LockResult,
        board: &Board,
        move_time: u32,
        placed: libtetris::Piece,
    ) -> (Self::Value, Self::Reward) {
        self.weights.evaluate(lock, board, move_time, placed)
    }

    fn pick_move(
        &self,
        candidates: Vec<MoveCandidate<Self::Value>>,
        _incoming: u32,
    ) -> MoveCandidate<Self::Value> {
        candidates
            .into_iter()
            .max_by(|left, right| {
                sprint_candidate_score(&self.context, left)
                    .cmp(&sprint_candidate_score(&self.context, right))
            })
            .expect("sprint evaluator requires at least one move candidate")
    }
}

pub fn sprint_context(snapshot: &GameSnapshot, sprint_state: &SprintState) -> SprintContext {
    let lines_cleared = current_lines_cleared(snapshot, sprint_state);
    let remaining_lines = SPRINT_TARGET_LINES.saturating_sub(lines_cleared);
    let board = snapshot.board().unwrap_or_else(|_| Board::new());
    let board_features = analyze_board(&board);
    let phase = sprint_phase(&board_features, remaining_lines);
    SprintContext {
        lines_cleared,
        remaining_lines,
        phase,
        board_features,
    }
}

pub fn current_lines_cleared(snapshot: &GameSnapshot, sprint_state: &SprintState) -> u32 {
    snapshot
        .lines_cleared
        .unwrap_or(sprint_state.lines_cleared_fallback)
}

pub fn update_state_for_snapshot(sprint_state: &mut SprintState, snapshot: &GameSnapshot) -> bool {
    let next_epoch = snapshot_game_epoch(snapshot);
    if next_epoch.is_some() && next_epoch != sprint_state.game_epoch {
        sprint_state.game_epoch = next_epoch;
        sprint_state.lines_cleared_fallback = 0;
        return true;
    }
    if snapshot.lines_cleared.is_some() && next_epoch.is_some() {
        sprint_state.game_epoch = next_epoch;
    }
    false
}

pub fn register_lock_result(sprint_state: &mut SprintState, lock: &LockResult) {
    sprint_state.lines_cleared_fallback = sprint_state
        .lines_cleared_fallback
        .saturating_add(lock.cleared_lines.len() as u32);
}

pub fn snapshot_game_epoch(snapshot: &GameSnapshot) -> Option<u64> {
    let mut parts = snapshot.token.split('-');
    let prefix = parts.next()?;
    let epoch = parts.next()?;
    let _piece = parts.next()?;
    if prefix != "browser" || parts.next().is_some() {
        return None;
    }
    epoch.parse().ok()
}

pub fn sprint_phase(features: &SprintBoardFeatures, remaining_lines: u32) -> SprintPhase {
    if features.max_height >= 14
        || features.cavity_cells > 0
        || features.blocked_well_cells > 0
        || (features.clean_well_depth == 0 && features.max_height >= 10)
    {
        SprintPhase::Recovery
    } else if remaining_lines <= 8 {
        SprintPhase::Finish
    } else {
        SprintPhase::Build
    }
}

pub fn sprint_40l_weights(snapshot: &GameSnapshot, sprint_state: &SprintState) -> Standard {
    let context = sprint_context(snapshot, sprint_state);
    match context.phase {
        SprintPhase::Build => sprint_build_weights(),
        SprintPhase::Finish => sprint_finish_weights(context.remaining_lines),
        SprintPhase::Recovery => sprint_recovery_weights(),
    }
}

pub fn sprint_build_weights() -> Standard {
    let mut weights = Standard::default();
    weights.tslot = [0, 0, 0, 0];
    weights.clear1 = -500;
    weights.clear2 = -350;
    weights.clear3 = -200;
    weights.clear4 = 1300;
    weights.tspin1 = weights.clear1;
    weights.tspin2 = weights.clear2;
    weights.tspin3 = weights.clear3;
    weights.mini_tspin1 = weights.clear1;
    weights.mini_tspin2 = weights.clear2;
    weights.b2b_clear = 50;
    weights.combo_garbage = 0;
    weights.perfect_clear = 150;
    weights.wasted_t = 0;
    weights.move_time = -10;
    weights.cavity_cells = -200;
    weights.covered_cells = -24;
    weights.overhang_cells = -42;
    weights.well_depth = 88;
    weights.max_well_depth = 20;
    weights
}

pub fn sprint_finish_weights(remaining_lines: u32) -> Standard {
    let mut weights = Standard::default();
    weights.tslot = [0, 0, 0, 0];
    weights.combo_garbage = 0;
    weights.wasted_t = 0;
    weights.perfect_clear = 150;
    weights.b2b_clear = 30;
    weights.move_time = -8;
    match remaining_lines {
        0 | 1 => {
            weights.clear1 = 950;
            weights.clear2 = 900;
            weights.clear3 = 900;
            weights.clear4 = 900;
        }
        2 => {
            weights.clear1 = 80;
            weights.clear2 = 900;
            weights.clear3 = 880;
            weights.clear4 = 980;
        }
        3 => {
            weights.clear1 = 50;
            weights.clear2 = 220;
            weights.clear3 = 920;
            weights.clear4 = 1020;
        }
        _ => {
            weights.clear1 = 100;
            weights.clear2 = 350;
            weights.clear3 = 700;
            weights.clear4 = 1100;
        }
    }
    weights.tspin1 = weights.clear1;
    weights.tspin2 = weights.clear2;
    weights.tspin3 = weights.clear3;
    weights.mini_tspin1 = weights.clear1;
    weights.mini_tspin2 = weights.clear2;
    weights
}

pub fn sprint_recovery_weights() -> Standard {
    let mut weights = Standard::default();
    weights.tslot = [0, 0, 0, 0];
    weights.tspin1 = 0;
    weights.tspin2 = 80;
    weights.tspin3 = 180;
    weights.mini_tspin1 = 0;
    weights.mini_tspin2 = 80;
    weights.clear1 = 40;
    weights.clear2 = 140;
    weights.clear3 = 260;
    weights.clear4 = 950;
    weights.combo_garbage = 0;
    weights.b2b_clear = 25;
    weights.perfect_clear = 150;
    weights.wasted_t = 0;
    weights.cavity_cells = -242;
    weights.cavity_cells_sq = -4;
    weights.covered_cells = -28;
    weights.covered_cells_sq = -2;
    weights.overhang_cells = -52;
    weights.overhang_cells_sq = -2;
    weights.height = -46;
    weights.top_half = -180;
    weights.top_quarter = -620;
    weights.move_time = -8;
    weights
}

pub fn analyze_board(board: &Board) -> SprintBoardFeatures {
    let heights = board.column_heights();
    let max_height = heights.iter().copied().max().unwrap_or_default().max(0) as u32;
    let cavity_cells = cavity_cells(board);
    let covered_cells = covered_cells(board);

    let mut best_well_column = 0usize;
    let mut clean_well_depth = 0u32;
    let mut blocked_well_cells = u32::MAX;
    let mut deep_well_count = 0u32;

    for column in 0..10 {
        let depth = clean_well_depth_for_column(board, column);
        if depth >= 3 {
            deep_well_count += 1;
        }
        let blocked = blocked_well_cells_for_column(board, column);
        if depth > clean_well_depth
            || (depth == clean_well_depth && blocked < blocked_well_cells)
            || (depth == clean_well_depth
                && blocked == blocked_well_cells
                && board.column_heights()[column] <= board.column_heights()[best_well_column])
        {
            best_well_column = column;
            clean_well_depth = depth;
            blocked_well_cells = blocked;
        }
    }

    if blocked_well_cells == u32::MAX {
        blocked_well_cells = 0;
    }

    SprintBoardFeatures {
        best_well_column,
        clean_well_depth,
        tetris_ready: clean_well_depth >= 4 && blocked_well_cells == 0,
        almost_tetris_ready: clean_well_depth >= 3 && blocked_well_cells == 0,
        blocked_well_cells,
        cavity_cells,
        covered_cells,
        max_height,
        deep_well_count,
    }
}

fn sprint_candidate_score(
    context: &SprintContext,
    candidate: &MoveCandidate<StandardValue>,
) -> SprintCandidateScore {
    let features = analyze_board(&candidate.board);
    let clear_lines = candidate.lock.cleared_lines.len() as u32;
    let lines_after = context
        .lines_cleared
        .saturating_add(clear_lines)
        .min(SPRINT_TARGET_LINES);
    let completes_run = lines_after >= SPRINT_TARGET_LINES;
    let is_tetris = candidate.lock.placement_kind == PlacementKind::Clear4;
    let clears_without_tetris = if candidate.lock.placement_kind.is_clear() && !is_tetris {
        1
    } else {
        0
    };

    let (phase_priority, safety_priority) = match context.phase {
        SprintPhase::Build => (
            build_phase_priority(candidate.lock.placement_kind, &features),
            build_safety_priority(&features),
        ),
        SprintPhase::Finish => (
            finish_phase_priority(
                candidate.lock.placement_kind,
                context.remaining_lines,
                clear_lines,
                completes_run,
            ),
            finish_safety_priority(&features),
        ),
        SprintPhase::Recovery => (
            recovery_phase_priority(candidate.lock.placement_kind, &features),
            recovery_safety_priority(&features),
        ),
    };

    SprintCandidateScore {
        completes_run,
        phase_priority,
        safety_priority,
        clean_well_depth: features.clean_well_depth as i32,
        clear_lines: clear_lines as i32,
        clears_without_tetris: -clears_without_tetris,
        neg_cavity_cells: -(features.cavity_cells as i32),
        neg_blocked_well_cells: -(features.blocked_well_cells as i32),
        neg_covered_cells: -(features.covered_cells as i32),
        neg_max_height: -(features.max_height as i32),
        neg_deep_well_count: -(features.deep_well_count as i32),
        base: candidate.evaluation,
        neg_original_rank: -(candidate.original_rank as i32),
    }
}

fn build_phase_priority(kind: PlacementKind, features: &SprintBoardFeatures) -> i32 {
    let clear_bonus = match kind {
        PlacementKind::Clear4 => 140,
        PlacementKind::None => 80,
        PlacementKind::Clear3 => -40,
        PlacementKind::Clear2 => -90,
        PlacementKind::Clear1 => -120,
        PlacementKind::Tspin
        | PlacementKind::Tspin1
        | PlacementKind::Tspin2
        | PlacementKind::Tspin3 => -110,
        PlacementKind::MiniTspin | PlacementKind::MiniTspin1 | PlacementKind::MiniTspin2 => -130,
    };
    clear_bonus
        + (features.tetris_ready as i32) * 90
        + (features.almost_tetris_ready as i32) * 35
        + (features.clean_well_depth as i32) * 10
}

fn build_safety_priority(features: &SprintBoardFeatures) -> i32 {
    -((features.cavity_cells as i32) * 30
        + (features.blocked_well_cells as i32) * 25
        + (features.covered_cells as i32) * 12
        + (features.max_height as i32) * 6
        + ((features.deep_well_count.saturating_sub(1)) as i32) * 20)
}

fn finish_phase_priority(
    kind: PlacementKind,
    remaining_lines: u32,
    clear_lines: u32,
    completes_run: bool,
) -> i32 {
    if completes_run {
        return 300
            + match kind {
                PlacementKind::Clear4 => 30,
                PlacementKind::Clear3 => 24,
                PlacementKind::Clear2 => 20,
                PlacementKind::Clear1 => 18,
                _ => 12,
            };
    }
    match remaining_lines {
        0 | 1 => (clear_lines > 0) as i32 * 200,
        2 => match kind {
            PlacementKind::Clear2 => 160,
            PlacementKind::Clear3 => 150,
            PlacementKind::Clear4 => 170,
            PlacementKind::Clear1 => 40,
            _ => 0,
        },
        3 => match kind {
            PlacementKind::Clear3 => 155,
            PlacementKind::Clear4 => 165,
            PlacementKind::Clear2 => 70,
            PlacementKind::Clear1 => 20,
            _ => 0,
        },
        _ => match kind {
            PlacementKind::Clear4 => 170,
            PlacementKind::Clear3 => 110,
            PlacementKind::Clear2 => 70,
            PlacementKind::Clear1 => 20,
            _ => 0,
        },
    }
}

fn finish_safety_priority(features: &SprintBoardFeatures) -> i32 {
    -((features.cavity_cells as i32) * 20
        + (features.blocked_well_cells as i32) * 18
        + (features.covered_cells as i32) * 8
        + (features.max_height as i32) * 4)
}

fn recovery_phase_priority(kind: PlacementKind, features: &SprintBoardFeatures) -> i32 {
    let clear_bonus = match kind {
        PlacementKind::Clear4 => 110,
        PlacementKind::Clear3 => 90,
        PlacementKind::Clear2 => 75,
        PlacementKind::Clear1 => 55,
        _ => 0,
    };
    clear_bonus
        - (features.cavity_cells as i32) * 12
        - (features.blocked_well_cells as i32) * 14
        - (features.covered_cells as i32) * 7
}

fn recovery_safety_priority(features: &SprintBoardFeatures) -> i32 {
    -((features.cavity_cells as i32) * 34
        + (features.blocked_well_cells as i32) * 22
        + (features.covered_cells as i32) * 14
        + (features.max_height as i32) * 8)
}

fn clean_well_depth_for_column(board: &Board, column: usize) -> u32 {
    let mut depth = 0u32;
    for y in 0..20 {
        if board.occupied(column as i32, y) {
            break;
        }
        let supported = (0..10)
            .filter(|other| *other != column)
            .all(|other| board.occupied(other as i32, y));
        if !supported {
            break;
        }
        depth += 1;
    }
    depth
}

fn blocked_well_cells_for_column(board: &Board, column: usize) -> u32 {
    let target_height = board
        .column_heights()
        .iter()
        .enumerate()
        .filter(|(other, _)| *other != column)
        .map(|(_, height)| *height)
        .min()
        .unwrap_or_default()
        .max(0);
    (0..target_height)
        .filter(|y| board.occupied(column as i32, *y))
        .count() as u32
}

fn cavity_cells(board: &Board) -> u32 {
    let mut cavities = 0u32;
    for x in 0..10 {
        for y in 0..board.column_heights()[x].max(0) {
            if !board.occupied(x as i32, y) {
                cavities += 1;
            }
        }
    }
    cavities
}

fn covered_cells(board: &Board) -> u32 {
    let mut covered = 0u32;
    for x in 0..10 {
        let height = board.column_heights()[x].max(0);
        for y in 0..height {
            if !board.occupied(x as i32, y) {
                covered = covered.saturating_add((height - y) as u32);
            }
        }
    }
    covered
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::PieceToken;
    use libtetris::Board;

    fn board_with_field(field: [[bool; 10]; 40]) -> Board {
        Board::new_with_state(field, enumset::EnumSet::all(), None, false, 0)
    }

    fn snapshot_with_field(field: [[bool; 10]; 40]) -> GameSnapshot {
        GameSnapshot {
            source: "test".to_owned(),
            token: "browser-1-0".to_owned(),
            field: field.into_iter().collect(),
            queue: vec![PieceToken::I, PieceToken::T, PieceToken::O, PieceToken::L],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
            piece_counter: Some(0),
            lines_cleared: Some(0),
            playing: true,
            countdown: false,
            active: None,
        }
    }

    #[test]
    fn build_weights_prefer_tetris_over_smaller_clears() {
        let weights = sprint_build_weights();
        assert!(weights.clear4 > weights.clear3);
        assert!(weights.clear4 > weights.clear2);
        assert!(weights.clear4 > weights.clear1);
    }

    #[test]
    fn finish_weights_allow_non_tetris_clear_for_last_three_lines() {
        let weights = sprint_finish_weights(3);
        assert!(weights.clear3 > weights.clear2);
        assert!(weights.clear3 > weights.clear1);
        assert!(weights.clear4 > weights.clear3);
    }

    #[test]
    fn recovery_phase_triggers_on_cavity() {
        let mut field = [[false; 10]; 40];
        for x in 0..10 {
            field[0][x] = true;
            field[1][x] = true;
        }
        field[0][4] = false;
        let features = analyze_board(&board_with_field(field));
        assert_eq!(sprint_phase(&features, 40), SprintPhase::Recovery);
    }

    #[test]
    fn clean_well_detection_finds_ready_tetris_column() {
        let mut field = [[false; 10]; 40];
        for y in 0..4 {
            for x in 0..9 {
                field[y][x] = true;
            }
        }
        let features = analyze_board(&board_with_field(field));
        assert_eq!(features.best_well_column, 9);
        assert_eq!(features.clean_well_depth, 4);
        assert!(features.tetris_ready);
    }

    #[test]
    fn state_uses_snapshot_lines_before_fallback() {
        let mut state = SprintState {
            game_epoch: Some(1),
            lines_cleared_fallback: 12,
        };
        let mut snapshot = snapshot_with_field([[false; 10]; 40]);
        snapshot.lines_cleared = Some(6);
        assert_eq!(current_lines_cleared(&snapshot, &state), 6);
        state.lines_cleared_fallback = 18;
        snapshot.lines_cleared = None;
        assert_eq!(current_lines_cleared(&snapshot, &state), 18);
    }

    #[test]
    fn game_epoch_change_resets_fallback_counter() {
        let mut state = SprintState {
            game_epoch: Some(1),
            lines_cleared_fallback: 20,
        };
        let mut snapshot = snapshot_with_field([[false; 10]; 40]);
        snapshot.token = "browser-2-0".to_owned();
        assert!(update_state_for_snapshot(&mut state, &snapshot));
        assert_eq!(state.game_epoch, Some(2));
        assert_eq!(state.lines_cleared_fallback, 0);
    }

    #[test]
    fn fallback_counter_increments_from_lock_result() {
        let mut lock = LockResult::default();
        lock.cleared_lines.extend([0, 1, 2, 3]);
        let mut state = SprintState::default();
        register_lock_result(&mut state, &lock);
        assert_eq!(state.lines_cleared_fallback, 4);
    }
}
