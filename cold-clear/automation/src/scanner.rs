use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::convert::TryInto;

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
            .map_err(|rows: Vec<[bool; 10]>| anyhow::anyhow!("expected 40 rows, got {}", rows.len()))
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
}

impl JsonFileScanner {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            last_token: None,
            waiting_for_file_logged: false,
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
                    format!(
                        "failed to read snapshot JSON from {}",
                        self.path.display()
                    )
                });
            }
        };
        let snapshot: GameSnapshot =
            serde_json::from_str(&raw).context("failed to parse snapshot JSON")?;
        if self.last_token.as_deref() == Some(snapshot.token.as_str()) {
            return Ok(None);
        }
        self.last_token = Some(snapshot.token.clone());
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
