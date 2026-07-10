use std::convert::TryInto;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use libtetris::Piece;
use serde::{Deserialize, Serialize};

use crate::browser_source::BrowserSnapshotWire;

#[derive(Clone, Debug, Deserialize)]
pub struct GameSnapshot {
    #[serde(default = "default_snapshot_source")]
    pub source: String,
    pub token: String,
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
    #[serde(default = "default_true")]
    pub playing: bool,
    #[serde(default)]
    pub countdown: bool,
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
}

pub trait SnapshotScanner {
    fn next_snapshot(&mut self) -> Result<Option<GameSnapshot>>;

    fn arm_piece_transition(&mut self, _: &GameSnapshot) {}
}

pub struct JsonFileScanner {
    path: PathBuf,
    last_token: Option<String>,
    waiting_for_file_logged: bool,
    min_snapshot_age: Duration,
    piece_transition_guard: Option<PieceTransitionGuard>,
    pending_token: Option<String>,
    pending_seen_count: u32,
}

#[derive(Clone, Debug)]
struct PieceTransitionGuard {
    queue: Vec<PieceToken>,
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
        }
    }
}

impl SnapshotScanner for JsonFileScanner {
    fn arm_piece_transition(&mut self, previous: &GameSnapshot) {
        self.piece_transition_guard = Some(PieceTransitionGuard {
            queue: previous.queue.clone(),
        });
    }

    fn next_snapshot(&mut self) -> Result<Option<GameSnapshot>> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => {
                self.waiting_for_file_logged = false;
                raw
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {
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
        let metadata = fs::metadata(&self.path).with_context(|| {
            format!(
                "failed to read snapshot metadata from {}",
                self.path.display()
            )
        })?;
        let modified_at = metadata
            .modified()
            .context("failed to read snapshot modified timestamp")?;
        let snapshot = parse_snapshot_json(&raw).context("failed to parse snapshot JSON")?;
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

        let age_ready = modified_at
            .elapsed()
            .map(|age| age >= self.min_snapshot_age)
            .unwrap_or(true);
        let stable_enough = self.pending_seen_count >= 2;

        if !age_ready || !stable_enough {
            return Ok(None);
        }

        if let Some(guard) = &self.piece_transition_guard {
            if !queue_transitioned(&guard.queue, &snapshot.queue) {
                return Ok(None);
            }
        }

        self.last_token = Some(snapshot.token.clone());
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

fn queue_transitioned(previous: &[PieceToken], candidate: &[PieceToken]) -> bool {
    previous != candidate
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

    #[test]
    fn queue_transition_requires_queue_change() {
        assert!(!queue_transitioned(
            &[PieceToken::T, PieceToken::I, PieceToken::O],
            &[PieceToken::T, PieceToken::I, PieceToken::O]
        ));
        assert!(queue_transitioned(
            &[PieceToken::T, PieceToken::I, PieceToken::O],
            &[PieceToken::I, PieceToken::O, PieceToken::L]
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
    }
}
