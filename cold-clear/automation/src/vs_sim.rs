use std::collections::VecDeque;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use libtetris::{Board, FallingPiece, Move, Piece, PieceState, RotationState, TspinStatus};
use serde::Deserialize;
use serde_json::Value;

use crate::scanner::{GameSnapshot, PieceToken};

const DEFAULT_NEXT_COUNT: usize = 6;
const VS_WS_SIM_ENV: &str = "FUSION_VS_WS_SIM";

pub struct VsSimulationController {
    enabled: bool,
    bridge_path: PathBuf,
    session: Option<VsSimulationSession>,
    blocked_round_id: Option<String>,
}

#[derive(Clone, Debug)]
struct VsSimulationSession {
    round_id: String,
    local_game_id: String,
    seed: String,
    next_count: usize,
    ready_at_ms: u64,
    last_bridge_sequence: u64,
    board: Board,
    hold: Option<Piece>,
    piece_index: usize,
}

#[derive(Debug, Deserialize)]
struct VsBridgeWire {
    version: u64,
    sequence: u64,
    #[serde(alias = "roundId")]
    round_id: String,
    active: bool,
    #[serde(alias = "capturedAt")]
    captured_at: u64,
    #[serde(alias = "readyAt")]
    ready_at: u64,
    local: VsBridgePlayerWire,
    #[allow(dead_code)]
    #[serde(default)]
    opponents: Vec<VsBridgePlayerWire>,
    options: VsBridgeOptionsWire,
    #[serde(default, alias = "incomingGarbage")]
    incoming_garbage: Vec<VsBridgeGarbageWire>,
}

#[derive(Debug, Deserialize)]
struct VsBridgePlayerWire {
    username: Option<String>,
    userid: Option<String>,
    gameid: Value,
}

#[derive(Debug, Deserialize)]
struct VsBridgeOptionsWire {
    seed: Value,
    bagtype: Option<String>,
    nextcount: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct VsBridgeGarbageWire {
    #[allow(dead_code)]
    #[serde(alias = "ownerGameId")]
    owner_game_id: Option<Value>,
}

impl VsSimulationController {
    pub fn new(snapshot_path: &Path) -> Self {
        let bridge_path = snapshot_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("vs-ws-bridge.json");
        Self::with_settings(
            std::env::var(VS_WS_SIM_ENV).ok().as_deref() == Some("1"),
            bridge_path,
        )
    }

    pub fn with_settings(enabled: bool, bridge_path: PathBuf) -> Self {
        Self {
            enabled,
            bridge_path,
            session: None,
            blocked_round_id: None,
        }
    }

    pub fn observe_browser_snapshot<F>(&mut self, snapshot: &GameSnapshot, log: &mut F)
    where
        F: FnMut(String),
    {
        if !self.enabled || snapshot.source == "browser_ws_sim" {
            return;
        }
        if let Some(session) = self.session.take() {
            self.blocked_round_id = Some(session.round_id.clone());
            log(format!(
                "[vs-sim] disabled current round because browser page snapshot became available roundId={}",
                session.round_id
            ));
        }
    }

    pub fn next_snapshot<F>(&mut self, log: &mut F) -> Result<Option<GameSnapshot>>
    where
        F: FnMut(String),
    {
        if !self.enabled {
            return Ok(None);
        }

        let Some(bridge) = read_bridge_wire(&self.bridge_path)? else {
            return Ok(None);
        };
        self.sync_bridge(bridge, log)?;

        let Some(session) = &self.session else {
            return Ok(None);
        };
        if current_time_ms() < session.ready_at_ms {
            return Ok(None);
        }

        Ok(Some(session.snapshot()?))
    }

    pub fn commit_hard_drop<F>(
        &mut self,
        snapshot: &GameSnapshot,
        planned_move: &Move,
        log: &mut F,
    ) -> Result<()>
    where
        F: FnMut(String),
    {
        if !self.enabled || snapshot.source != "browser_ws_sim" {
            return Ok(());
        }

        let Some(session) = self.session.as_mut() else {
            return Ok(());
        };
        if snapshot.token != session.token() {
            self.invalidate_current_round(
                "snapshot token no longer matched current VS session",
                log,
            );
            return Ok(());
        }

        let execution = session
            .execution_state(planned_move.hold)
            .context("failed to derive VS simulation execution piece")?;
        let target_piece = planned_move.expected_location.kind.0;
        if execution.placed_piece != target_piece {
            self.invalidate_current_round(
                &format!(
                    "planned piece {:?} did not match simulated piece {:?}",
                    target_piece, execution.placed_piece
                ),
                log,
            );
            return Ok(());
        }

        let lock = session.board.lock_piece(planned_move.expected_location);
        if lock.locked_out {
            self.invalidate_current_round("simulated hard drop locked out the board", log);
            return Ok(());
        }

        session.hold = execution.next_hold;
        session.piece_index = execution.next_piece_index;
        Ok(())
    }

    pub fn invalidate_current_round<F>(&mut self, reason: &str, log: &mut F)
    where
        F: FnMut(String),
    {
        if let Some(session) = self.session.take() {
            self.blocked_round_id = Some(session.round_id.clone());
            log(format!(
                "[vs-sim] invalidated roundId={} reason={}",
                session.round_id, reason
            ));
        }
    }

    fn sync_bridge<F>(&mut self, bridge: VsBridgeWire, log: &mut F) -> Result<()>
    where
        F: FnMut(String),
    {
        if bridge.version != 1 {
            return Ok(());
        }
        if !bridge.active {
            if self
                .session
                .as_ref()
                .map(|session| session.round_id.as_str())
                == Some(bridge.round_id.as_str())
            {
                self.session = None;
            }
            return Ok(());
        }
        if bridge.options.bagtype.as_deref() != Some("7-bag") {
            return Ok(());
        }

        if self.blocked_round_id.as_deref() != Some(bridge.round_id.as_str()) {
            self.blocked_round_id = None;
        }
        if self.blocked_round_id.as_deref() == Some(bridge.round_id.as_str()) {
            return Ok(());
        }
        if !bridge.incoming_garbage.is_empty() {
            self.session = None;
            self.blocked_round_id = Some(bridge.round_id.clone());
            log(format!(
                "[vs-sim] invalidated roundId={} because incoming garbage was observed",
                bridge.round_id
            ));
            return Ok(());
        }

        match &mut self.session {
            Some(session) if session.round_id == bridge.round_id => {
                session.ready_at_ms = bridge.ready_at;
                session.last_bridge_sequence = bridge.sequence;
            }
            _ => {
                self.session = Some(VsSimulationSession::from_bridge(&bridge)?);
            }
        }

        Ok(())
    }
}

impl VsSimulationSession {
    fn from_bridge(bridge: &VsBridgeWire) -> Result<Self> {
        let seed = value_to_string(&bridge.options.seed).context("bridge seed was not a scalar")?;
        let local_game_id =
            value_to_string(&bridge.local.gameid).context("local gameid was not a scalar")?;
        let next_count = bridge
            .options
            .nextcount
            .as_ref()
            .and_then(value_to_usize)
            .filter(|count| *count > 0)
            .unwrap_or(DEFAULT_NEXT_COUNT);

        Ok(Self {
            round_id: bridge.round_id.clone(),
            local_game_id,
            seed,
            next_count,
            ready_at_ms: bridge.ready_at,
            last_bridge_sequence: bridge.sequence,
            board: Board::new(),
            hold: None,
            piece_index: 0,
        })
    }

    fn token(&self) -> String {
        format!(
            "vs-{}-{}-{}",
            self.local_game_id, self.seed, self.piece_index
        )
    }

    fn snapshot(&self) -> Result<GameSnapshot> {
        let current = generated_piece(&self.seed, self.piece_index)?;
        let queue = generated_queue(&self.seed, self.piece_index, self.next_count)?;
        let mut queue_tokens = Vec::with_capacity(1 + queue.len());
        queue_tokens.push(piece_to_token(current));
        queue_tokens.extend(queue.into_iter().map(piece_to_token));

        Ok(GameSnapshot {
            source: "browser_ws_sim".to_owned(),
            token: self.token(),
            field: self.board.get_field().into_iter().collect(),
            queue: queue_tokens,
            hold: self.hold.map(piece_to_token),
            combo: self.board.combo,
            b2b: self.board.b2b_bonus,
            incoming: 0,
            piece_counter: Some(self.piece_index as u32),
            lines_cleared: None,
            playing: true,
            countdown: false,
            active: None,
        })
    }

    fn execution_state(&self, use_hold: bool) -> Result<ExecutionState> {
        let current = generated_piece(&self.seed, self.piece_index)?;
        if !use_hold {
            return Ok(ExecutionState {
                placed_piece: current,
                next_hold: self.hold,
                next_piece_index: self.piece_index + 1,
            });
        }

        if let Some(held) = self.hold {
            return Ok(ExecutionState {
                placed_piece: held,
                next_hold: Some(current),
                next_piece_index: self.piece_index + 1,
            });
        }

        let preview = generated_piece(&self.seed, self.piece_index + 1)
            .context("hold-first move requires a preview piece")?;
        Ok(ExecutionState {
            placed_piece: preview,
            next_hold: Some(current),
            next_piece_index: self.piece_index + 2,
        })
    }
}

#[derive(Copy, Clone)]
struct ExecutionState {
    placed_piece: Piece,
    next_hold: Option<Piece>,
    next_piece_index: usize,
}

fn read_bridge_wire(path: &Path) -> Result<Option<VsBridgeWire>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if is_retryable_io_error(&err) => return Ok(None),
        Err(err) => {
            return Err(err).with_context(|| {
                format!("failed to read VS WebSocket bridge from {}", path.display())
            })
        }
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    match serde_json::from_str(&raw) {
        Ok(bridge) => Ok(Some(bridge)),
        Err(err) if err.is_eof() => Ok(None),
        Err(err) => Err(err).with_context(|| {
            format!(
                "failed to parse VS WebSocket bridge from {}",
                path.display()
            )
        }),
    }
}

fn is_retryable_io_error(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        ErrorKind::NotFound | ErrorKind::PermissionDenied | ErrorKind::WouldBlock
    )
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(boolean) => Some(boolean.to_string()),
        _ => None,
    }
}

fn value_to_usize(value: &Value) -> Option<usize> {
    match value {
        Value::Number(number) => number.as_u64().map(|value| value as usize),
        Value::String(text) => text.parse::<usize>().ok(),
        _ => None,
    }
}

fn generated_piece(seed: &str, piece_index: usize) -> Result<Piece> {
    generate_piece_sequence(seed, piece_index + 1)?
        .into_iter()
        .nth(piece_index)
        .context("generated piece queue was shorter than requested index")
}

fn generated_queue(seed: &str, piece_index: usize, next_count: usize) -> Result<Vec<Piece>> {
    Ok(generate_piece_sequence(seed, piece_index + next_count + 1)?
        .into_iter()
        .skip(piece_index + 1)
        .take(next_count)
        .collect())
}

fn generate_piece_sequence(seed: &str, count: usize) -> Result<Vec<Piece>> {
    let mut rng = ParkMiller::new(seed)?;
    let pieces = [
        Piece::Z,
        Piece::L,
        Piece::O,
        Piece::S,
        Piece::I,
        Piece::J,
        Piece::T,
    ];
    let mut bag = VecDeque::new();
    let mut out = Vec::with_capacity(count);

    while out.len() < count {
        while bag.len() < 14 {
            let mut next_bag = pieces;
            for index in (1..next_bag.len()).rev() {
                let swap_index = (rng.next_float() * (index + 1) as f64).floor() as usize;
                next_bag.swap(index, swap_index);
            }
            bag.extend(next_bag);
        }
        out.push(
            bag.pop_front()
                .expect("bag should contain at least one generated piece"),
        );
    }

    Ok(out)
}

struct ParkMiller {
    value: i64,
}

impl ParkMiller {
    fn new(seed: &str) -> Result<Self> {
        let mut value = seed.parse::<i64>().context("seed must be an integer")? % 2_147_483_647;
        if value <= 0 {
            value += 2_147_483_646;
        }
        Ok(Self { value })
    }

    fn next(&mut self) -> i64 {
        self.value = (16_807 * self.value) % 2_147_483_647;
        self.value
    }

    fn next_float(&mut self) -> f64 {
        (self.next() - 1) as f64 / 2_147_483_646f64
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs::write;

    fn temp_bridge_path(name: &str) -> PathBuf {
        let unique = current_time_ms();
        env::temp_dir().join(format!("automation-{name}-{unique}.json"))
    }

    fn write_bridge(path: &Path, body: &str) {
        write(path, body).unwrap();
    }

    fn sample_bridge(
        round_id: &str,
        sequence: u64,
        ready_at: u64,
        incoming_garbage: &str,
    ) -> String {
        format!(
            r#"{{
  "version": 1,
  "sequence": {sequence},
  "roundId": "{round_id}",
  "active": true,
  "capturedAt": 1000,
  "readyAt": {ready_at},
  "local": {{
    "username": "hebi_",
    "userid": "63b3ad2b1103e5097025feba",
    "gameid": 4382
  }},
  "opponents": [
    {{
      "username": "guest-e00651",
      "userid": "6a5042ff2dfdb4928a8950fe",
      "gameid": 4383
    }}
  ],
  "options": {{
    "seed": 2034120187,
    "bagtype": "7-bag",
    "nextcount": 6
  }},
  "incomingGarbage": {incoming_garbage}
}}"#
        )
    }

    fn write_ready_bridge(path: &Path, round_id: &str, sequence: u64) {
        write_bridge(path, &sample_bridge(round_id, sequence, 0, "[]"));
    }

    fn simple_lock_move(piece: Piece) -> Move {
        let board: Board = Board::new();
        let mut target = FallingPiece {
            kind: PieceState(piece, RotationState::North),
            x: 4,
            y: 20,
            tspin: TspinStatus::None,
        };
        target.sonic_drop(&board);
        Move {
            inputs: Default::default(),
            expected_location: target,
            hold: false,
        }
    }

    #[test]
    fn disabled_controller_never_emits_simulated_snapshots() {
        let path = temp_bridge_path("vs-sim-disabled");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut controller = VsSimulationController::with_settings(false, path.clone());

        let snapshot = controller.next_snapshot(&mut |_| {}).unwrap();

        assert!(snapshot.is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn blank_field_seed_generates_expected_first_current_and_queue() {
        let path = temp_bridge_path("vs-sim-seed");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut controller = VsSimulationController::with_settings(true, path.clone());

        let snapshot = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("simulated snapshot");

        assert_eq!(snapshot.source, "browser_ws_sim");
        assert_eq!(snapshot.token, "vs-4382-2034120187-0");
        assert_eq!(
            snapshot.queue,
            vec![
                PieceToken::O,
                PieceToken::S,
                PieceToken::I,
                PieceToken::Z,
                PieceToken::T,
                PieceToken::L,
                PieceToken::J
            ]
        );
        assert_eq!(snapshot.hold, None);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn hard_drop_commit_updates_piece_index_only_after_success() {
        let path = temp_bridge_path("vs-sim-commit");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut controller = VsSimulationController::with_settings(true, path.clone());

        let before = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("simulated snapshot");
        assert_eq!(before.piece_counter, Some(0));

        controller
            .commit_hard_drop(&before, &simple_lock_move(Piece::O), &mut |_| {})
            .unwrap();

        let after = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("next simulated snapshot");
        assert_eq!(after.piece_counter, Some(1));
        assert_eq!(after.queue[0], PieceToken::S);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn hold_without_existing_hold_advances_piece_index_by_two() {
        let path = temp_bridge_path("vs-sim-hold-first");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut controller = VsSimulationController::with_settings(true, path.clone());
        let snapshot = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("simulated snapshot");
        let mut move_after_hold = simple_lock_move(Piece::S);
        move_after_hold.hold = true;

        controller
            .commit_hard_drop(&snapshot, &move_after_hold, &mut |_| {})
            .unwrap();

        let next = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("next simulated snapshot");
        assert_eq!(next.piece_counter, Some(2));
        assert_eq!(next.hold, Some(PieceToken::O));
        assert_eq!(next.queue[0], PieceToken::I);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn hold_with_existing_hold_advances_piece_index_by_one() {
        let path = temp_bridge_path("vs-sim-hold-swap");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut controller = VsSimulationController::with_settings(true, path.clone());
        let snapshot = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("simulated snapshot");
        let mut first_hold_move = simple_lock_move(Piece::S);
        first_hold_move.hold = true;
        controller
            .commit_hard_drop(&snapshot, &first_hold_move, &mut |_| {})
            .unwrap();

        let swapped_snapshot = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("swapped snapshot");
        let mut second_hold_move = simple_lock_move(Piece::O);
        second_hold_move.hold = true;
        controller
            .commit_hard_drop(&swapped_snapshot, &second_hold_move, &mut |_| {})
            .unwrap();

        let next = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("next simulated snapshot");
        assert_eq!(next.piece_counter, Some(3));
        assert_eq!(next.hold, Some(PieceToken::I));
        assert_eq!(next.queue[0], PieceToken::Z);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn garbage_invalidates_the_current_round() {
        let path = temp_bridge_path("vs-sim-garbage");
        write_bridge(
            &path,
            &sample_bridge(
                "4382:2034120187",
                1,
                0,
                r#"[{"ownerGameId":4383,"eventType":"interaction","data":{"amt":2}}]"#,
            ),
        );
        let mut logs = Vec::new();
        let mut controller = VsSimulationController::with_settings(true, path.clone());

        let snapshot = controller
            .next_snapshot(&mut |line| logs.push(line))
            .unwrap();

        assert!(snapshot.is_none());
        assert!(logs
            .iter()
            .any(|line| line.contains("incoming garbage was observed")));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn new_round_resets_piece_index_to_zero() {
        let path = temp_bridge_path("vs-sim-new-round");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut controller = VsSimulationController::with_settings(true, path.clone());
        let first = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("first snapshot");
        controller
            .commit_hard_drop(&first, &simple_lock_move(Piece::O), &mut |_| {})
            .unwrap();

        write_bridge(
            &path,
            &sample_bridge("4382:2034120188", 2, 0, "[]").replace("2034120187", "2034120188"),
        );
        let next_round = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("next round snapshot");

        assert_eq!(next_round.piece_counter, Some(0));
        assert_eq!(next_round.token, "vs-4382-2034120188-0");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn browser_snapshot_observation_blocks_same_round_fallback() {
        let path = temp_bridge_path("vs-sim-browser-priority");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut controller = VsSimulationController::with_settings(true, path.clone());
        let snapshot = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("simulated snapshot");
        let browser_snapshot = GameSnapshot {
            source: "browser_cdp".to_owned(),
            token: "browser-10-1".to_owned(),
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::T, PieceToken::I, PieceToken::O],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
            piece_counter: Some(1),
            lines_cleared: None,
            playing: true,
            countdown: false,
            active: None,
        };
        controller.observe_browser_snapshot(&browser_snapshot, &mut |_| {});

        let fallback = controller.next_snapshot(&mut |_| {}).unwrap();

        assert_eq!(snapshot.source, "browser_ws_sim");
        assert!(fallback.is_none());
        let _ = fs::remove_file(path);
    }
}
