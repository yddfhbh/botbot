use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AutomationConfig {
    pub snapshot_path: PathBuf,
    pub dry_run: bool,
    pub poll_interval_ms: u64,
    pub tap_duration_ms: u64,
    pub settle_delay_ms: u64,
    pub bot: BotConfig,
    pub handling: HandlingConfig,
    pub keys: KeyBindings,
}

impl Default for AutomationConfig {
    fn default() -> Self {
        Self {
            snapshot_path: PathBuf::from("snapshot.json"),
            dry_run: true,
            poll_interval_ms: 16,
            tap_duration_ms: 8,
            settle_delay_ms: 2,
            bot: BotConfig::default(),
            handling: HandlingConfig::default(),
            keys: KeyBindings::default(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct BotConfig {
    pub threads: u32,
    pub min_nodes: u32,
    pub max_nodes: u32,
    pub use_hold: bool,
    pub speculate: bool,
    pub movement_mode: MovementModeConfig,
    pub spawn_rule: SpawnRuleConfig,
}

impl Default for BotConfig {
    fn default() -> Self {
        Self {
            threads: 1,
            min_nodes: 0,
            max_nodes: 400_000,
            use_hold: true,
            speculate: false,
            movement_mode: MovementModeConfig::ZeroGComplete,
            spawn_rule: SpawnRuleConfig::Row19Or20,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct HandlingConfig {
    pub arr_ms: u64,
    pub das_ms: u64,
    pub dcd_ms: u64,
    pub soft_drop_mode: SoftDropModeConfig,
    pub soft_drop_factor: u32,
    pub prevent_accidental_hard_drops: bool,
    pub cancel_das_on_direction_change: bool,
    pub prefer_soft_drop_over_movement: bool,
    pub irs_mode: BufferModeConfig,
    pub ihs_mode: BufferModeConfig,
}

impl Default for HandlingConfig {
    fn default() -> Self {
        Self {
            arr_ms: 0,
            das_ms: 97,
            dcd_ms: 0,
            soft_drop_mode: SoftDropModeConfig::Infinite,
            soft_drop_factor: 1,
            prevent_accidental_hard_drops: true,
            cancel_das_on_direction_change: true,
            prefer_soft_drop_over_movement: true,
            irs_mode: BufferModeConfig::Tap,
            ihs_mode: BufferModeConfig::Tap,
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SoftDropModeConfig {
    Infinite,
    Step,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BufferModeConfig {
    Off,
    Hold,
    Tap,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MovementModeConfig {
    ZeroG,
    ZeroGComplete,
    TwentyG,
    HardDropOnly,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpawnRuleConfig {
    Row19Or20,
    Row21AndFall,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct KeyBindings {
    pub left: String,
    pub right: String,
    pub rotate_cw: String,
    pub rotate_ccw: String,
    pub hold: String,
    pub soft_drop: String,
    pub hard_drop: String,
}

impl Default for KeyBindings {
    fn default() -> Self {
        Self {
            left: "LEFT".to_owned(),
            right: "RIGHT".to_owned(),
            rotate_cw: "X".to_owned(),
            rotate_ccw: "Z".to_owned(),
            hold: "C".to_owned(),
            soft_drop: "DOWN".to_owned(),
            hard_drop: "SPACE".to_owned(),
        }
    }
}
