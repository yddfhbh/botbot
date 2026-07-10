use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AutomationConfig {
    pub snapshot_path: PathBuf,
    pub snapshot_provider: SnapshotProviderConfig,
    pub dry_run: bool,
    pub poll_interval_ms: u64,
    pub perf_log_enabled: bool,
    pub target_pps: f32,
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
    pub browser: BrowserCdpConfig,
    pub bot: BotConfig,
    pub handling: HandlingConfig,
    pub keys: KeyBindings,
}

impl Default for AutomationConfig {
    fn default() -> Self {
        Self {
            snapshot_path: PathBuf::from("automation/live-snapshot.json"),
            snapshot_provider: SnapshotProviderConfig::BrowserCdp,
            dry_run: true,
            poll_interval_ms: 20,
            perf_log_enabled: true,
            target_pps: 1.2,
            tap_duration_ms: 60,
            movement_tap_duration_ms: 20,
            rotate_tap_duration_ms: 30,
            hold_tap_duration_ms: 30,
            hard_drop_tap_duration_ms: 40,
            soft_drop_tap_duration_ms: 20,
            movement_interval_ms: 20,
            rotation_interval_ms: 30,
            piece_interval_ms: 60,
            hard_drop_interval_ms: 40,
            min_snapshot_age_ms: 30,
            input_backend: InputBackendConfig::ScanCode,
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
    BrowserCdp,
    WebsocketSeed,
    File,
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
    pub debugger_probe_mode: DebuggerProbeMode,
    pub state_poll_ms: u64,
    pub min_state_poll_ms: u64,
    pub use_ribbon_websocket: bool,
    pub ribbon_decode_mode: RibbonDecodeMode,
    pub use_seed_simulation_fallback: bool,
    pub input_focus_mode: InputFocusMode,
    pub player_selector: PlayerSelectorConfig,
    pub player_nickname: String,
    pub player_user_id: String,
    pub dump_state_on_fail: bool,
    pub dump_state_path: String,
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
            debugger_probe_mode: DebuggerProbeMode::StartupOnly,
            state_poll_ms: 40,
            min_state_poll_ms: 16,
            use_ribbon_websocket: false,
            ribbon_decode_mode: RibbonDecodeMode::UntilSeed,
            use_seed_simulation_fallback: false,
            input_focus_mode: InputFocusMode::PerPlan,
            player_selector: PlayerSelectorConfig::Auto,
            player_nickname: String::new(),
            player_user_id: String::new(),
            dump_state_on_fail: true,
            dump_state_path: "automation/debug/tetrio-state-dump.json".to_owned(),
            bootstrap_timeout_ms: 2500,
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlayerSelectorConfig {
    Auto,
    Left,
    Right,
    Nickname,
    UserId,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DebuggerProbeMode {
    StartupOnly,
    Manual,
    Disabled,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RibbonDecodeMode {
    UntilSeed,
    AlwaysDebug,
    Off,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputFocusMode {
    PerPlan,
    PerHarddrop,
    PerAction,
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
            max_nodes: 100_000,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automation_config_defaults_to_browser_cdp_snapshot_provider() {
        let config = AutomationConfig::default();

        assert_eq!(config.snapshot_provider, SnapshotProviderConfig::BrowserCdp);
        assert_eq!(config.input_backend, InputBackendConfig::ScanCode);
    }

    #[test]
    fn automation_config_deserializes_websocket_seed_snapshot_provider() {
        let parsed: AutomationConfig = serde_json::from_str(
            r#"{
                "snapshot_provider": "websocket_seed"
            }"#,
        )
        .unwrap();

        assert_eq!(
            parsed.snapshot_provider,
            SnapshotProviderConfig::WebsocketSeed
        );
    }

    #[test]
    fn browser_cdp_config_defaults_include_vs_selector_and_dump_settings() {
        let config = BrowserCdpConfig::default();

        assert_eq!(config.debugger_probe_mode, DebuggerProbeMode::StartupOnly);
        assert_eq!(config.state_poll_ms, 40);
        assert_eq!(config.min_state_poll_ms, 16);
        assert_eq!(config.ribbon_decode_mode, RibbonDecodeMode::UntilSeed);
        assert_eq!(config.input_focus_mode, InputFocusMode::PerPlan);
        assert_eq!(config.player_selector, PlayerSelectorConfig::Auto);
        assert!(config.player_nickname.is_empty());
        assert!(config.player_user_id.is_empty());
        assert!(config.dump_state_on_fail);
        assert_eq!(
            config.dump_state_path,
            "automation/debug/tetrio-state-dump.json"
        );
    }

    #[test]
    fn browser_cdp_config_deserializes_player_selector_variants() {
        let parsed: BrowserCdpConfig = serde_json::from_str(
            r#"{
                "player_selector": "user_id",
                "player_nickname": "hebi_",
                "player_user_id": "user-123",
                "debugger_probe_mode": "manual",
                "state_poll_ms": 24,
                "min_state_poll_ms": 16,
                "ribbon_decode_mode": "off",
                "input_focus_mode": "per_harddrop",
                "dump_state_on_fail": false,
                "dump_state_path": "automation/debug/custom-dump.json"
            }"#,
        )
        .unwrap();

        assert_eq!(parsed.player_selector, PlayerSelectorConfig::UserId);
        assert_eq!(parsed.player_nickname, "hebi_");
        assert_eq!(parsed.player_user_id, "user-123");
        assert_eq!(parsed.debugger_probe_mode, DebuggerProbeMode::Manual);
        assert_eq!(parsed.state_poll_ms, 24);
        assert_eq!(parsed.min_state_poll_ms, 16);
        assert_eq!(parsed.ribbon_decode_mode, RibbonDecodeMode::Off);
        assert_eq!(parsed.input_focus_mode, InputFocusMode::PerHarddrop);
        assert!(!parsed.dump_state_on_fail);
        assert_eq!(parsed.dump_state_path, "automation/debug/custom-dump.json");
    }
}
