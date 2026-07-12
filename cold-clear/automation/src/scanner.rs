use std::convert::TryInto;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use libtetris::{Piece, RotationState};
use serde::{Deserialize, Serialize};
use serde_json::error::Category as JsonErrorCategory;

use crate::browser_source::BrowserSnapshotWire;

pub const MAX_SNAPSHOT_AGE_MS: u64 = 1_000;

#[derive(Clone, Debug, Deserialize)]
pub struct GameSnapshot {
    #[serde(default = "default_snapshot_source")]
    pub source: String,
    pub token: String,
    #[serde(default)]
    pub round_id: Option<String>,
    pub field: Vec<[bool; 10]>,
    pub queue: Vec<PieceToken>,
    #[serde(default)]
    pub hold: Option<PieceToken>,
    #[serde(default)]
    pub combo: u32,
    #[serde(default)]
    pub b2b: bool,
    #[serde(default)]
    pub incoming: u32,
    #[serde(default)]
    pub piece_counter: Option<u32>,
    #[serde(default)]
    pub lines_cleared: Option<u32>,
    #[serde(default = "default_true")]
    pub playing: bool,
    #[serde(default)]
    pub countdown: bool,
    #[serde(default)]
    pub active: Option<ActivePieceState>,
}

impl GameSnapshot {
    pub fn field_array(&self) -> Result<[[bool; 10]; 40]> {
        self.field
            .clone()
            .try_into()
            .map_err(|rows: Vec<[bool; 10]>| {
                anyhow::anyhow!("expected 40 rows, got {}", rows.len())
            })
    }

    pub fn queue_pieces(&self) -> Vec<Piece> {
        self.queue.iter().copied().map(Into::into).collect()
    }

    pub fn hold_piece(&self) -> Option<Piece> {
        self.hold.map(Into::into)
    }

    pub fn board(&self) -> Result<libtetris::Board> {
        Ok(libtetris::Board::new_with_state(
            self.field_array()?,
            enumset::EnumSet::all(),
            self.hold_piece(),
            self.b2b,
            self.combo,
        ))
    }
}

#[derive(Copy, Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RotationToken {
    North,
    East,
    South,
    West,
}

impl From<RotationToken> for RotationState {
    fn from(value: RotationToken) -> Self {
        match value {
            RotationToken::North => RotationState::North,
            RotationToken::East => RotationState::East,
            RotationToken::South => RotationState::South,
            RotationToken::West => RotationState::West,
        }
    }
}

#[derive(Copy, Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct ActivePieceState {
    pub x: i32,
    #[serde(default)]
    pub y: i32,
    pub rotation: RotationToken,
}

pub trait SnapshotScanner {
    fn next_snapshot(&mut self) -> Result<Option<GameSnapshot>>;

    fn arm_piece_transition(&mut self, _: &GameSnapshot) {}

    fn latest_snapshot_age(&self) -> Option<Duration> {
        None
    }
}

pub struct JsonFileScanner {
    path: PathBuf,
    last_token: Option<String>,
    waiting_for_file_logged: bool,
    min_snapshot_age: Duration,
    piece_transition_guard: Option<PieceTransitionGuard>,
    pending_token: Option<String>,
    pending_seen_count: u32,
    latest_snapshot_age: Option<Duration>,
    stale_snapshot_token_logged: Option<String>,
}

#[derive(Clone, Debug)]
struct PieceTransitionGuard {
    queue: Vec<PieceToken>,
    piece_counter: Option<u32>,
}

impl JsonFileScanner {
    pub fn new(path: PathBuf, min_snapshot_age: Duration) -> Self {
        Self {
            path,
            last_token: None,
            waiting_for_file_logged: false,
            min_snapshot_age,
            piece_transition_guard: None,
            pending_token: None,
            pending_seen_count: 0,
            latest_snapshot_age: None,
            stale_snapshot_token_logged: None,
        }
    }

    pub fn with_last_token(
        path: PathBuf,
        min_snapshot_age: Duration,
        last_token: Option<String>,
    ) -> Self {
        let mut scanner = Self::new(path, min_snapshot_age);
        scanner.last_token = last_token;
        scanner
    }
}

impl SnapshotScanner for JsonFileScanner {
    fn arm_piece_transition(&mut self, previous: &GameSnapshot) {
        self.piece_transition_guard = Some(PieceTransitionGuard {
            queue: previous.queue.clone(),
            piece_counter: previous.piece_counter,
        });
    }

    fn latest_snapshot_age(&self) -> Option<Duration> {
        self.latest_snapshot_age
    }

    fn next_snapshot(&mut self) -> Result<Option<GameSnapshot>> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => {
                self.waiting_for_file_logged = false;
                raw
            }
            Err(err) if is_retryable_snapshot_io_error(&err) => {
                if !self.waiting_for_file_logged {
                    println!(
                        "[automation] waiting for scanner output at {}",
                        self.path.display()
                    );
                    self.waiting_for_file_logged = true;
                }
                return Ok(None);
            }
            Err(err) => {
                return Err(err).with_context(|| {
                    format!("failed to read snapshot JSON from {}", self.path.display())
                });
            }
        };
        if raw.trim().is_empty() {
            return Ok(None);
        }
        let snapshot_age = read_snapshot_age(&self.path)?;
        let snapshot = match parse_snapshot_json(&raw) {
            Ok(snapshot) => snapshot,
            Err(err) if is_retryable_snapshot_parse_error(&raw, &err) => {
                return Ok(None);
            }
            Err(err) => return Err(err).context("failed to parse snapshot JSON"),
        };
        self.latest_snapshot_age = snapshot_age;
        if snapshot_age.map(snapshot_age_is_stale).unwrap_or(false) {
            log_stale_snapshot_once(
                &mut self.stale_snapshot_token_logged,
                &snapshot.token,
                snapshot_age.expect("stale snapshot age should exist"),
            );
            self.pending_token = None;
            self.pending_seen_count = 0;
            return Ok(None);
        }
        if self.last_token.as_deref() == Some(snapshot.token.as_str()) {
            return Ok(None);
        }
        let is_same_pending = self.pending_token.as_deref() == Some(snapshot.token.as_str());
        if is_same_pending {
            self.pending_seen_count += 1;
        } else {
            self.pending_token = Some(snapshot.token.clone());
            self.pending_seen_count = 1;
        }

        let age_ready = snapshot_age
            .map(|age| age >= self.min_snapshot_age)
            .unwrap_or(true);
        let required_stable_reads = if snapshot.source == "browser_cdp" {
            1
        } else {
            2
        };
        let stable_enough = self.pending_seen_count >= required_stable_reads;

        if !age_ready || !stable_enough {
            return Ok(None);
        }

        if let Some(guard) = &self.piece_transition_guard {
            if !queue_transitioned(&guard.queue, guard.piece_counter, &snapshot) {
                return Ok(None);
            }
        }

        self.last_token = Some(snapshot.token.clone());
        self.stale_snapshot_token_logged = None;
        self.piece_transition_guard = None;
        self.pending_token = None;
        self.pending_seen_count = 0;
        Ok(Some(snapshot))
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum SnapshotWire {
    Browser(BrowserSnapshotWire),
    Game(GameSnapshot),
}

fn parse_snapshot_json(raw: &str) -> Result<GameSnapshot> {
    match serde_json::from_str::<SnapshotWire>(raw)? {
        SnapshotWire::Browser(wire) => wire
            .into_game_snapshot()?
            .context("browser snapshot was not ready"),
        SnapshotWire::Game(snapshot) => Ok(snapshot),
    }
}

pub fn read_snapshot_file(path: &Path) -> Result<GameSnapshot> {
    read_snapshot_file_with_age(path).map(|(snapshot, _)| snapshot)
}

pub fn read_snapshot_file_with_age(path: &Path) -> Result<(GameSnapshot, Option<Duration>)> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read snapshot JSON from {}", path.display()))?;
    if raw.trim().is_empty() {
        anyhow::bail!("snapshot JSON file was empty");
    }
    let snapshot_age = read_snapshot_age(path)?;
    let snapshot = parse_snapshot_json(&raw).context("failed to parse snapshot JSON")?;
    Ok((snapshot, snapshot_age))
}

fn is_retryable_snapshot_parse_error(raw: &str, err: &anyhow::Error) -> bool {
    if raw.trim().is_empty() {
        return true;
    }
    err.downcast_ref::<serde_json::Error>()
        .map(|json_err| matches!(json_err.classify(), JsonErrorCategory::Eof))
        .unwrap_or(false)
}

fn is_retryable_snapshot_io_error(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        ErrorKind::NotFound | ErrorKind::PermissionDenied | ErrorKind::WouldBlock
    )
}

fn read_snapshot_age(path: &Path) -> Result<Option<Duration>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if is_retryable_snapshot_io_error(&err) => {
            return Ok(None);
        }
        Err(err) => {
            return Err(err).with_context(|| {
                format!("failed to read snapshot metadata from {}", path.display())
            })
        }
    };
    Ok(metadata
        .modified()
        .ok()
        .and_then(|timestamp| timestamp.elapsed().ok()))
}

fn snapshot_age_is_stale(age: Duration) -> bool {
    age.as_millis() > u128::from(MAX_SNAPSHOT_AGE_MS)
}

fn log_stale_snapshot_once(
    stale_snapshot_token_logged: &mut Option<String>,
    token: &str,
    age: Duration,
) {
    if stale_snapshot_token_logged.as_deref() == Some(token) {
        return;
    }
    println!(
        "[bot] ignoring stale snapshot token={} age_ms={}",
        token,
        age.as_millis()
    );
    println!("[bot] waiting for fresh snapshot");
    *stale_snapshot_token_logged = Some(token.to_owned());
}

fn queue_transitioned(
    previous_queue: &[PieceToken],
    previous_piece_counter: Option<u32>,
    candidate: &GameSnapshot,
) -> bool {
    if previous_queue != candidate.queue {
        return true;
    }
    if let (Some(previous), Some(current)) = (previous_piece_counter, candidate.piece_counter) {
        return current != previous;
    }
    false
}

fn default_snapshot_source() -> String {
    "file".to_owned()
}

fn default_true() -> bool {
    true
}

#[derive(Copy, Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum PieceToken {
    I,
    O,
    T,
    L,
    J,
    S,
    Z,
}

impl From<PieceToken> for Piece {
    fn from(value: PieceToken) -> Self {
        match value {
            PieceToken::I => Piece::I,
            PieceToken::O => Piece::O,
            PieceToken::T => Piece::T,
            PieceToken::L => Piece::L,
            PieceToken::J => Piece::J,
            PieceToken::S => Piece::S,
            PieceToken::Z => Piece::Z,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sample_snapshot(token: &str, piece_counter: u32) -> GameSnapshot {
        GameSnapshot {
            source: "browser_cdp".to_owned(),
            token: token.to_owned(),
            round_id: None,
            field: vec![[false; 10]; 40],
            queue: vec![PieceToken::T, PieceToken::I, PieceToken::O],
            hold: None,
            combo: 0,
            b2b: false,
            incoming: 0,
            piece_counter: Some(piece_counter),
            lines_cleared: None,
            playing: true,
            countdown: false,
            active: None,
        }
    }

    fn temp_snapshot_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("automation-{name}-{unique}.json"))
    }

    fn write_snapshot(path: &Path, snapshot: &GameSnapshot) {
        let raw = serde_json::json!({
            "source": snapshot.source,
            "token": snapshot.token,
            "round_id": snapshot.round_id,
            "field": snapshot.field,
            "queue": snapshot.queue,
            "hold": snapshot.hold,
            "combo": snapshot.combo,
            "b2b": snapshot.b2b,
            "incoming": snapshot.incoming,
            "piece_counter": snapshot.piece_counter,
            "lines_cleared": snapshot.lines_cleared,
            "playing": snapshot.playing,
            "countdown": snapshot.countdown,
            "active": snapshot.active,
        });
        fs::write(path, serde_json::to_vec(&raw).unwrap()).unwrap();
    }

    #[test]
    fn queue_transition_requires_queue_change() {
        let same_snapshot = sample_snapshot("browser-4", 4);
        assert!(!queue_transitioned(
            &[PieceToken::T, PieceToken::I, PieceToken::O],
            Some(4),
            &same_snapshot
        ));
        let changed_queue = GameSnapshot {
            token: "browser-5".to_owned(),
            queue: vec![PieceToken::I, PieceToken::O, PieceToken::L],
            piece_counter: Some(5),
            ..same_snapshot.clone()
        };
        assert!(queue_transitioned(
            &[PieceToken::T, PieceToken::I, PieceToken::O],
            Some(4),
            &changed_queue
        ));
    }

    #[test]
    fn queue_transition_allows_new_game_even_if_queue_repeats() {
        let candidate = sample_snapshot("browser-0", 0);
        assert!(queue_transitioned(
            &[PieceToken::T, PieceToken::I, PieceToken::O],
            Some(12),
            &candidate
        ));
    }

    #[test]
    fn parses_browser_snapshot_wire() {
        let raw = r#"{
          "ok": true,
          "source": "browser_cdp",
          "field": [[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false],[false,false,false,false,false,false,false,false,false,false]],
          "current": "T",
          "hold": "I",
          "queue": ["J","L","O","S","Z"],
          "b2b": false,
          "combo": 0,
          "piece_counter": 123,
          "token": "browser-123"
        }"#;
        let snapshot = parse_snapshot_json(raw).unwrap();
        assert_eq!(snapshot.source, "browser_cdp");
        assert_eq!(snapshot.queue[0], PieceToken::T);
        assert_eq!(snapshot.piece_counter, Some(123));
        assert_eq!(snapshot.lines_cleared, None);
    }

    #[test]
    fn retryable_snapshot_io_errors_include_permission_denied() {
        assert!(is_retryable_snapshot_io_error(&std::io::Error::from(
            ErrorKind::NotFound
        )));
        assert!(is_retryable_snapshot_io_error(&std::io::Error::from(
            ErrorKind::PermissionDenied
        )));
        assert!(is_retryable_snapshot_io_error(&std::io::Error::from(
            ErrorKind::WouldBlock
        )));
        assert!(!is_retryable_snapshot_io_error(&std::io::Error::from(
            ErrorKind::InvalidData
        )));
    }

    #[test]
    fn snapshot_age_threshold_allows_500ms_but_blocks_1001ms() {
        assert!(!snapshot_age_is_stale(Duration::from_millis(500)));
        assert!(!snapshot_age_is_stale(Duration::from_millis(1000)));
        assert!(snapshot_age_is_stale(Duration::from_millis(1001)));
    }

    #[test]
    fn stale_snapshot_is_blocked_until_a_fresh_token_arrives() {
        let path = temp_snapshot_path("stale-snapshot");
        let mut scanner = JsonFileScanner::new(path.clone(), Duration::ZERO);

        write_snapshot(&path, &sample_snapshot("browser-1-1008", 1008));
        std::thread::sleep(Duration::from_millis(MAX_SNAPSHOT_AGE_MS + 50));
        assert!(scanner.next_snapshot().unwrap().is_none());
        assert!(scanner
            .latest_snapshot_age()
            .map(snapshot_age_is_stale)
            .unwrap_or(false));

        write_snapshot(&path, &sample_snapshot("browser-2-0", 0));
        let snapshot = scanner.next_snapshot().unwrap().expect("fresh snapshot");
        assert_eq!(snapshot.token, "browser-2-0");
        assert!(scanner
            .latest_snapshot_age()
            .map(|age| age.as_millis() <= u128::from(MAX_SNAPSHOT_AGE_MS))
            .unwrap_or(false));

        let _ = fs::remove_file(path);
    }
}
