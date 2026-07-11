use std::path::PathBuf;
use std::thread;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AutomationConfig {
    pub snapshot_provider: SnapshotProviderConfig,
    pub snapshot_path: PathBuf,
    pub dry_run: bool,
    pub poll_interval_ms: u64,
    pub target_pps: f32,
    pub play_style: PlayStyleConfig,
    pub evaluation_profile: EvaluationProfileConfig,
    pub route_profile: RouteProfileConfig,
    pub tap_duration_ms: u64,
    pub movement_tap_duration_ms: u64,
    pub rotate_tap_duration_ms: u64,
    pub hold_tap_duration_ms: u64,
    pub hard_drop_tap_duration_ms: u64,
    pub soft_drop_tap_duration_ms: u64,
    pub movement_interval_ms: u64,
    pub rotation_interval_ms: u64,
    pub piece_interval_ms: u64,
    pub hard_drop_interval_ms: u64,
    pub min_snapshot_age_ms: u64,
    pub input_backend: InputBackendConfig,
    pub scanner: ScannerSourceConfig,
    pub browser: BrowserCdpConfig,
    pub bot: BotConfig,
    pub handling: HandlingConfig,
    pub keys: KeyBindings,
}

impl Default for AutomationConfig {
    fn default() -> Self {
        Self {
            snapshot_provider: SnapshotProviderConfig::BrowserCdp,
            snapshot_path: PathBuf::from("automation/live-snapshot.json"),
            dry_run: true,
            poll_interval_ms: 4,
            target_pps: 0.0,
            play_style: PlayStyleConfig::Normal,
            evaluation_profile: EvaluationProfileConfig::Normal,
            route_profile: RouteProfileConfig::Normal,
            tap_duration_ms: 60,
            movement_tap_duration_ms: 16,
            rotate_tap_duration_ms: 18,
            hold_tap_duration_ms: 20,
            hard_drop_tap_duration_ms: 20,
            soft_drop_tap_duration_ms: 16,
            movement_interval_ms: 0,
            rotation_interval_ms: 0,
            piece_interval_ms: 0,
            hard_drop_interval_ms: 0,
            min_snapshot_age_ms: 0,
            input_backend: InputBackendConfig::BrowserCdp,
            scanner: ScannerSourceConfig::default(),
            browser: BrowserCdpConfig::default(),
            bot: BotConfig::default(),
            handling: HandlingConfig::default(),
            keys: KeyBindings::default(),
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotProviderConfig {
    Scanner,
    BrowserCdp,
    File,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ScannerSourceConfig {
    pub config_path: String,
    pub python_command: String,
}

impl Default for ScannerSourceConfig {
    fn default() -> Self {
        Self {
            config_path: "automation/scan-config.vs-left-1080p.json".to_owned(),
            python_command: "python".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct BrowserCdpConfig {
    pub node_command: String,
    pub chrome_path: String,
    pub cdp_port: u16,
    pub url: String,
    pub target_hint: String,
    pub connect_only: bool,
    pub probe_page_state: bool,
    pub use_ribbon_websocket: bool,
    pub use_seed_simulation_fallback: bool,
    pub bootstrap_timeout_ms: u64,
}

impl Default for BrowserCdpConfig {
    fn default() -> Self {
        Self {
            node_command: "node".to_owned(),
            chrome_path: String::new(),
            cdp_port: 9222,
            url: "https://tetr.io/".to_owned(),
            target_hint: "TETR.IO".to_owned(),
            connect_only: false,
            probe_page_state: true,
            use_ribbon_websocket: true,
            use_seed_simulation_fallback: true,
            bootstrap_timeout_ms: 500,
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlayStyleConfig {
    Normal,
    Speed,
}

impl Default for PlayStyleConfig {
    fn default() -> Self {
        Self::Normal
    }
}

impl PlayStyleConfig {
    pub fn log_label(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Speed => "speed",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationProfileConfig {
    Normal,
    Speed,
}

impl Default for EvaluationProfileConfig {
    fn default() -> Self {
        Self::Normal
    }
}

impl EvaluationProfileConfig {
    pub fn log_label(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Speed => "speed",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteProfileConfig {
    Normal,
    Speed,
}

impl Default for RouteProfileConfig {
    fn default() -> Self {
        Self::Normal
    }
}

impl RouteProfileConfig {
    pub fn log_label(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Speed => "speed",
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
            min_nodes: 500,
            max_nodes: 5_000,
            use_hold: true,
            speculate: false,
            movement_mode: MovementModeConfig::ZeroGSafe,
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
    pub allow_post_softdrop_actions: bool,
    pub allow_post_softdrop_horizontal: bool,
    pub release_after_each_action: bool,
    pub action_settle_ms: u64,
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
            allow_post_softdrop_actions: true,
            allow_post_softdrop_horizontal: false,
            release_after_each_action: false,
            action_settle_ms: 0,
            soft_drop_factor: 1,
            prevent_accidental_hard_drops: true,
            cancel_das_on_direction_change: true,
            prefer_soft_drop_over_movement: false,
            irs_mode: BufferModeConfig::Off,
            ihs_mode: BufferModeConfig::Off,
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputBackendConfig {
    VirtualKey,
    ScanCode,
    BrowserCdp,
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
    ZeroGSafe,
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

fn default_bot_threads() -> u32 {
    let detected = thread::available_parallelism()
        .map(|parallelism| parallelism.get())
        .unwrap_or(1);
    detected.min(4) as u32
}
