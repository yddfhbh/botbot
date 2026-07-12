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
const DEFAULT_VALIDATION_MAX_PIECES: usize = 10;
const POST_COUNTDOWN_FOCUS_GRACE_MS: u64 = 500;
const POST_DROP_SETTLE_MS: u64 = 80;
const VS_WS_SIM_ENV: &str = "FUSION_VS_WS_SIM";
const VS_WS_SIM_MAX_PIECES_ENV: &str = "FUSION_VS_WS_SIM_MAX_PIECES";

pub struct VsSimulationController {
    enabled: bool,
    bridge_path: PathBuf,
    session: Option<VsSimulationSession>,
    blocked_round_id: Option<String>,
    max_pieces: usize,
}

#[derive(Clone, Debug)]
struct VsSimulationSession {
    round_id: String,
    local_game_id: String,
    seed: String,
    next_count: usize,
    countdown_ready_at_ms: u64,
    input_allowed_at_ms: u64,
    last_bridge_sequence: u64,
    board: Board,
    hold: Option<Piece>,
    piece_index: usize,
    processed_pieces: usize,
    next_snapshot_ready_at_ms: u64,
    paused_pending_verification: bool,
    logged_focus_grace_wait: bool,
    logged_input_grace_complete: bool,
}

#[derive(Copy, Clone)]
enum ValidationStage {
    RoutePreflight,
    PreHardDrop,
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
        Self::with_validation_limit(enabled, bridge_path, resolve_max_piece_limit())
    }

    pub fn with_validation_limit(enabled: bool, bridge_path: PathBuf, max_pieces: usize) -> Self {
        Self {
            enabled,
            bridge_path,
            session: None,
            blocked_round_id: None,
            max_pieces,
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
        let now = current_time_ms();
        let paused_pending_verification = session.paused_pending_verification;
        let piece_index = session.piece_index;
        let input_allowed_at_ms = session.input_allowed_at_ms;
        let countdown_ready_at_ms = session.countdown_ready_at_ms;
        let next_snapshot_ready_at_ms = session.next_snapshot_ready_at_ms;
        let logged_input_grace_complete = session.logged_input_grace_complete;
        if paused_pending_verification {
            return Ok(None);
        }
        if initial_input_grace_active(piece_index, now, input_allowed_at_ms) {
            if let Some(session) = self.session.as_mut() {
                if !session.logged_focus_grace_wait {
                    log(format!(
                        "[vs-sim] waiting post-countdown focus grace {}ms",
                        POST_COUNTDOWN_FOCUS_GRACE_MS
                    ));
                    session.logged_focus_grace_wait = true;
                }
            }
            return Ok(None);
        }
        if piece_index == 0 && !logged_input_grace_complete {
            if let Some(session) = self.session.as_mut() {
                if !session.logged_input_grace_complete {
                    let elapsed_ms = now.saturating_sub(countdown_ready_at_ms);
                    log(format!(
                        "[vs-sim] input grace complete elapsed_ms={elapsed_ms}"
                    ));
                    session.logged_input_grace_complete = true;
                }
            }
        }
        if now < next_snapshot_ready_at_ms {
            return Ok(None);
        }

        Ok(Some(
            self.session
                .as_ref()
                .expect("session should still exist")
                .snapshot()?,
        ))
    }

    pub fn validate_route_preflight<F>(
        &mut self,
        snapshot: &GameSnapshot,
        log: &mut F,
    ) -> Result<bool>
    where
        F: FnMut(String),
    {
        self.validate_snapshot_stage(snapshot, ValidationStage::RoutePreflight, log)
    }

    pub fn validate_pre_hard_drop<F>(
        &mut self,
        snapshot: &GameSnapshot,
        log: &mut F,
    ) -> Result<bool>
    where
        F: FnMut(String),
    {
        self.validate_snapshot_stage(snapshot, ValidationStage::PreHardDrop, log)
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
        session.processed_pieces = session.processed_pieces.saturating_add(1);
        session.next_snapshot_ready_at_ms = current_time_ms().saturating_add(POST_DROP_SETTLE_MS);
        if self.max_pieces > 0 && session.processed_pieces >= self.max_pieces {
            session.paused_pending_verification = true;
            log(format!(
                "[vs-sim] validation piece limit reached count={}",
                session.processed_pieces
            ));
            log("[vs-sim] paused pending verification".to_owned());
        }
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

    fn validate_snapshot_stage<F>(
        &mut self,
        snapshot: &GameSnapshot,
        stage: ValidationStage,
        log: &mut F,
    ) -> Result<bool>
    where
        F: FnMut(String),
    {
        if !self.enabled || snapshot.source != "browser_ws_sim" {
            return Ok(true);
        }

        let Some(bridge) = read_bridge_wire(&self.bridge_path)? else {
            log_validation_failure(stage, "bridge_unavailable", log);
            return Ok(false);
        };

        let bridge_round_id = bridge.round_id.clone();
        let bridge_active = bridge.active;
        let bridge_has_garbage = !bridge.incoming_garbage.is_empty();
        let bridge_local_game_id = match value_to_string(&bridge.local.gameid) {
            Some(value) => value,
            None => {
                log_validation_failure(stage, "bridge_local_gameid_invalid", log);
                return Ok(false);
            }
        };
        let bridge_seed = match value_to_string(&bridge.options.seed) {
            Some(value) => value,
            None => {
                log_validation_failure(stage, "bridge_seed_invalid", log);
                return Ok(false);
            }
        };

        self.sync_bridge(bridge, log)?;

        if !bridge_active {
            log_validation_failure(stage, "bridge_inactive", log);
            return Ok(false);
        }
        if bridge_has_garbage {
            log_validation_failure(stage, "incoming_garbage", log);
            return Ok(false);
        }

        let Some(session) = &self.session else {
            log_validation_failure(stage, "session_missing", log);
            return Ok(false);
        };
        if session.paused_pending_verification {
            log_validation_failure(stage, "validation_paused", log);
            return Ok(false);
        }
        if !session.matches_identity(&bridge_round_id, &bridge_local_game_id, &bridge_seed) {
            log_validation_failure(stage, "bridge_identity_mismatch", log);
            return Ok(false);
        }
        if snapshot.round_id.as_deref() != Some(session.round_id.as_str()) {
            log_validation_failure(
                stage,
                &format!(
                    "round_mismatch expected={} actual={}",
                    snapshot.round_id.as_deref().unwrap_or("-"),
                    session.round_id
                ),
                log,
            );
            return Ok(false);
        }
        if snapshot.token != session.token() {
            log_validation_failure(
                stage,
                &format!(
                    "token_mismatch expected={} actual={}",
                    snapshot.token,
                    session.token()
                ),
                log,
            );
            return Ok(false);
        }
        if matches!(stage, ValidationStage::RoutePreflight)
            && snapshot.piece_counter != Some(session.piece_index as u32)
        {
            log_validation_failure(
                stage,
                &format!(
                    "piece_index_mismatch expected={} actual={}",
                    snapshot.piece_counter.unwrap_or_default(),
                    session.piece_index
                ),
                log,
            );
            return Ok(false);
        }

        Ok(true)
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

        let bridge_local_game_id = match value_to_string(&bridge.local.gameid) {
            Some(value) => value,
            None => return Ok(()),
        };
        let bridge_seed = match value_to_string(&bridge.options.seed) {
            Some(value) => value,
            None => return Ok(()),
        };

        match &mut self.session {
            Some(session)
                if session.matches_identity(
                    &bridge.round_id,
                    &bridge_local_game_id,
                    &bridge_seed,
                ) =>
            {
                session.countdown_ready_at_ms = bridge.ready_at;
                session.input_allowed_at_ms = bridge
                    .ready_at
                    .saturating_add(POST_COUNTDOWN_FOCUS_GRACE_MS);
                session.last_bridge_sequence = bridge.sequence;
            }
            _ => {
                let session = VsSimulationSession::from_bridge(&bridge)?;
                let first14 = generated_sequence_labels(&session.seed, 14)?;
                log(format!("[vs-sim] generated queue first14={first14}"));
                self.session = Some(session);
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
            countdown_ready_at_ms: bridge.ready_at,
            input_allowed_at_ms: bridge
                .ready_at
                .saturating_add(POST_COUNTDOWN_FOCUS_GRACE_MS),
            last_bridge_sequence: bridge.sequence,
            board: Board::new(),
            hold: None,
            piece_index: 0,
            processed_pieces: 0,
            next_snapshot_ready_at_ms: 0,
            paused_pending_verification: false,
            logged_focus_grace_wait: false,
            logged_input_grace_complete: false,
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
            round_id: Some(self.round_id.clone()),
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

    fn matches_identity(&self, round_id: &str, local_game_id: &str, seed: &str) -> bool {
        self.round_id == round_id && self.local_game_id == local_game_id && self.seed == seed
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

fn initial_input_grace_active(piece_index: usize, now: u64, input_allowed_at_ms: u64) -> bool {
    piece_index == 0 && now < input_allowed_at_ms
}

fn log_validation_failure<F>(stage: ValidationStage, reason: &str, log: &mut F)
where
    F: FnMut(String),
{
    match stage {
        ValidationStage::RoutePreflight => {
            log(format!("[vs-sim] route preflight failed reason={reason}"))
        }
        ValidationStage::PreHardDrop => log(format!(
            "[vs-sim] pre-drop validation failed reason={reason}"
        )),
    }
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

fn generated_sequence_labels(seed: &str, count: usize) -> Result<String> {
    Ok(generate_piece_sequence(seed, count)?
        .into_iter()
        .map(|piece| match piece {
            Piece::I => "I",
            Piece::O => "O",
            Piece::T => "T",
            Piece::L => "L",
            Piece::J => "J",
            Piece::S => "S",
            Piece::Z => "Z",
        })
        .collect::<Vec<_>>()
        .join(","))
}

fn resolve_max_piece_limit() -> usize {
    std::env::var(VS_WS_SIM_MAX_PIECES_ENV)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_VALIDATION_MAX_PIECES)
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

    fn sample_bridge_with_state(
        round_id: &str,
        sequence: u64,
        ready_at: u64,
        incoming_garbage: &str,
        active: bool,
        local_game_id: &str,
        seed: &str,
        captured_at: u64,
    ) -> String {
        format!(
            r#"{{
  "version": 1,
  "sequence": {sequence},
  "roundId": "{round_id}",
  "active": {active},
  "capturedAt": {captured_at},
  "readyAt": {ready_at},
  "local": {{
    "username": "hebi_",
    "userid": "63b3ad2b1103e5097025feba",
    "gameid": {local_game_id}
  }},
  "opponents": [
    {{
      "username": "guest-e00651",
      "userid": "6a5042ff2dfdb4928a8950fe",
      "gameid": 4383
    }}
  ],
  "options": {{
    "seed": {seed},
    "bagtype": "7-bag",
    "nextcount": 6
  }},
  "incomingGarbage": {incoming_garbage}
}}"#
        )
    }

    fn sample_bridge(
        round_id: &str,
        sequence: u64,
        ready_at: u64,
        incoming_garbage: &str,
    ) -> String {
        sample_bridge_with_state(
            round_id,
            sequence,
            ready_at,
            incoming_garbage,
            true,
            "4382",
            "2034120187",
            current_time_ms(),
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
        if let Some(session) = controller.session.as_mut() {
            session.next_snapshot_ready_at_ms = 0;
        }

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
        if let Some(session) = controller.session.as_mut() {
            session.next_snapshot_ready_at_ms = 0;
        }

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
        if let Some(session) = controller.session.as_mut() {
            session.next_snapshot_ready_at_ms = 0;
        }

        let swapped_snapshot = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("swapped snapshot");
        let mut second_hold_move = simple_lock_move(Piece::O);
        second_hold_move.hold = true;
        controller
            .commit_hard_drop(&swapped_snapshot, &second_hold_move, &mut |_| {})
            .unwrap();
        if let Some(session) = controller.session.as_mut() {
            session.next_snapshot_ready_at_ms = 0;
        }

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
            round_id: None,
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

    #[test]
    fn generated_queue_matches_js_reference_for_seed_220638408() {
        let sequence = generate_piece_sequence("220638408", 28).unwrap();
        let labels = sequence
            .into_iter()
            .map(|piece| match piece {
                Piece::I => "I",
                Piece::O => "O",
                Piece::T => "T",
                Piece::L => "L",
                Piece::J => "J",
                Piece::S => "S",
                Piece::Z => "Z",
            })
            .collect::<Vec<_>>();

        assert_eq!(
            labels,
            vec![
                "I", "O", "Z", "S", "T", "L", "J", "T", "Z", "S", "I", "J", "O", "L", "I", "J",
                "S", "L", "T", "O", "Z", "Z", "L", "O", "I", "S", "T", "J"
            ]
        );
    }

    #[test]
    fn pre_drop_validation_rejects_token_mismatch() {
        let path = temp_bridge_path("vs-sim-pre-drop-token");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut controller = VsSimulationController::with_settings(true, path.clone());
        let mut logs = Vec::new();
        let snapshot = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("simulated snapshot");
        let mut mismatched = snapshot.clone();
        mismatched.token = "browser-1-1008".to_owned();

        let valid = controller
            .validate_pre_hard_drop(&mismatched, &mut |line| logs.push(line))
            .unwrap();

        assert!(!valid);
        assert!(logs
            .iter()
            .any(|line| line.contains("reason=token_mismatch")));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn stale_captured_at_does_not_invalidate_an_active_session() {
        let path = temp_bridge_path("vs-sim-old-captured-at");
        write_bridge(
            &path,
            &sample_bridge_with_state(
                "4382:2034120187",
                1,
                0,
                "[]",
                true,
                "4382",
                "2034120187",
                current_time_ms().saturating_sub(60_000),
            ),
        );
        let mut controller = VsSimulationController::with_settings(true, path.clone());

        let snapshot = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("simulated snapshot");
        let valid = controller
            .validate_route_preflight(&snapshot, &mut |_| {})
            .unwrap();

        assert!(valid);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn unchanged_bridge_sequence_does_not_invalidate_an_active_session() {
        let path = temp_bridge_path("vs-sim-static-sequence");
        write_ready_bridge(&path, "4382:2034120187", 7);
        let mut controller = VsSimulationController::with_settings(true, path.clone());
        let snapshot = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("simulated snapshot");
        write_bridge(
            &path,
            &sample_bridge_with_state(
                "4382:2034120187",
                7,
                0,
                "[]",
                true,
                "4382",
                "2034120187",
                current_time_ms().saturating_sub(60_000),
            ),
        );

        let valid = controller
            .validate_route_preflight(&snapshot, &mut |_| {})
            .unwrap();

        assert!(valid);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn route_preflight_rejects_inactive_bridge() {
        let path = temp_bridge_path("vs-sim-inactive-bridge");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut controller = VsSimulationController::with_settings(true, path.clone());
        let snapshot = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("simulated snapshot");
        let mut logs = Vec::new();
        write_bridge(
            &path,
            &sample_bridge_with_state(
                "4382:2034120187",
                2,
                0,
                "[]",
                false,
                "4382",
                "2034120187",
                current_time_ms(),
            ),
        );

        let valid = controller
            .validate_route_preflight(&snapshot, &mut |line| logs.push(line))
            .unwrap();

        assert!(!valid);
        assert!(logs
            .iter()
            .any(|line| line.contains("reason=bridge_inactive")));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn route_preflight_rejects_round_change() {
        let path = temp_bridge_path("vs-sim-round-change");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut controller = VsSimulationController::with_settings(true, path.clone());
        let snapshot = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("simulated snapshot");
        let mut logs = Vec::new();
        write_bridge(
            &path,
            &sample_bridge_with_state(
                "4382:2034120188",
                2,
                0,
                "[]",
                true,
                "4382",
                "2034120187",
                current_time_ms(),
            ),
        );

        let valid = controller
            .validate_route_preflight(&snapshot, &mut |line| logs.push(line))
            .unwrap();

        assert!(!valid);
        assert!(logs
            .iter()
            .any(|line| line.contains("reason=round_mismatch")));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn route_preflight_rejects_incoming_garbage() {
        let path = temp_bridge_path("vs-sim-route-garbage");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut controller = VsSimulationController::with_settings(true, path.clone());
        let snapshot = controller
            .next_snapshot(&mut |_| {})
            .unwrap()
            .expect("simulated snapshot");
        let mut logs = Vec::new();
        write_bridge(
            &path,
            &sample_bridge(
                "4382:2034120187",
                2,
                0,
                r#"[{"ownerGameId":4383,"eventType":"interaction","data":{"amt":2}}]"#,
            ),
        );

        let valid = controller
            .validate_route_preflight(&snapshot, &mut |line| logs.push(line))
            .unwrap();

        assert!(!valid);
        assert!(logs
            .iter()
            .any(|line| line.contains("reason=incoming_garbage")));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn input_grace_is_active_at_ready_at_plus_499ms() {
        assert!(initial_input_grace_active(0, 1_499, 1_500));
        assert!(!initial_input_grace_active(1, 1_499, 1_500));
    }

    #[test]
    fn input_grace_is_inactive_at_ready_at_plus_500ms() {
        assert!(!initial_input_grace_active(0, 1_500, 1_500));
    }

    #[test]
    fn first_snapshot_wait_logs_while_grace_is_active() {
        let path = temp_bridge_path("vs-sim-focus-grace-wait");
        let ready_at = current_time_ms().saturating_add(250);
        write_bridge(&path, &sample_bridge("4382:2034120187", 1, ready_at, "[]"));
        let mut logs = Vec::new();
        let mut controller = VsSimulationController::with_settings(true, path.clone());

        let snapshot = controller
            .next_snapshot(&mut |line| logs.push(line))
            .unwrap();

        assert!(snapshot.is_none());
        assert!(logs
            .iter()
            .any(|line| line.contains("waiting post-countdown focus grace 500ms")));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn first_snapshot_is_allowed_at_ready_at_plus_500ms() {
        let path = temp_bridge_path("vs-sim-focus-grace-allowed");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut logs = Vec::new();
        let mut controller = VsSimulationController::with_settings(true, path.clone());
        controller.next_snapshot(&mut |_| {}).unwrap();
        if let Some(session) = controller.session.as_mut() {
            session.countdown_ready_at_ms = current_time_ms().saturating_sub(500);
            session.input_allowed_at_ms = current_time_ms();
            session.logged_input_grace_complete = false;
        }

        let snapshot = controller
            .next_snapshot(&mut |line| logs.push(line))
            .unwrap();

        assert!(snapshot.is_some());
        assert!(logs.iter().any(|line| {
            line.strip_prefix("[vs-sim] input grace complete elapsed_ms=")
                .and_then(|value| value.parse::<u64>().ok())
                .map(|elapsed| elapsed >= 500)
                .unwrap_or(false)
        }));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn validation_piece_limit_pauses_after_ten_commits() {
        let path = temp_bridge_path("vs-sim-piece-limit");
        write_ready_bridge(&path, "4382:2034120187", 1);
        let mut logs = Vec::new();
        let mut controller = VsSimulationController::with_validation_limit(true, path.clone(), 10);

        for _ in 0..10 {
            let snapshot = controller
                .next_snapshot(&mut |_| {})
                .unwrap()
                .expect("simulated snapshot");
            controller
                .commit_hard_drop(
                    &snapshot,
                    &simple_lock_move(snapshot.queue_pieces()[0]),
                    &mut |line| logs.push(line),
                )
                .unwrap();
            if let Some(session) = controller.session.as_mut() {
                session.next_snapshot_ready_at_ms = 0;
            }
        }

        assert!(controller.next_snapshot(&mut |_| {}).unwrap().is_none());
        assert!(logs
            .iter()
            .any(|line| line.contains("validation piece limit reached count=10")));
        assert!(logs
            .iter()
            .any(|line| line.contains("paused pending verification")));
        let _ = fs::remove_file(path);
    }
}
