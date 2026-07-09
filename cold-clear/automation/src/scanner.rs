use std::convert::TryInto;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use libtetris::Piece;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
pub struct GameSnapshot {
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
}

pub struct JsonFileScanner {
    path: PathBuf,
    last_token: Option<String>,
    waiting_for_file_logged: bool,
    min_snapshot_age: Duration,
    pending_token: Option<String>,
    pending_snapshot: Option<GameSnapshot>,
    pending_seen_count: u32,
}

impl JsonFileScanner {
    pub fn new(path: PathBuf, min_snapshot_age: Duration) -> Self {
        Self {
            path,
            last_token: None,
            waiting_for_file_logged: false,
            min_snapshot_age,
            pending_token: None,
            pending_snapshot: None,
            pending_seen_count: 0,
        }
    }
}

impl SnapshotScanner for JsonFileScanner {
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
        let snapshot: GameSnapshot =
            serde_json::from_str(&raw).context("failed to parse snapshot JSON")?;
        if self.last_token.as_deref() == Some(snapshot.token.as_str()) {
            return Ok(None);
        }
        let is_same_pending = self.pending_token.as_deref() == Some(snapshot.token.as_str());
        if is_same_pending {
            self.pending_seen_count += 1;
            self.pending_snapshot = Some(snapshot.clone());
        } else {
            self.pending_token = Some(snapshot.token.clone());
            self.pending_snapshot = Some(snapshot.clone());
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

        self.last_token = Some(snapshot.token.clone());
        self.pending_token = None;
        self.pending_snapshot = None;
        self.pending_seen_count = 0;
        Ok(Some(snapshot))
    }
}

#[derive(Copy, Clone, Debug, Deserialize)]
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
