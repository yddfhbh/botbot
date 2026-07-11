use std::fs;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use eframe::egui;
use serde::{Deserialize, Serialize};

use crate::browser_source::{ChromiumHostProcess, ProviderProcess, SharedLogger};
use crate::config::{
    AutomationConfig, BotConfig, BrowserCdpConfig, BufferModeConfig, EvaluationProfileConfig,
    HandlingConfig, InputBackendConfig, KeyBindings, MovementModeConfig, PlayStyleConfig,
    RouteProfileConfig, ScannerSourceConfig, SnapshotProviderConfig, SoftDropModeConfig,
    SpawnRuleConfig,
};
use crate::driver::{
    BrowserCdpInputBackend, DebugLogBackend, InputBackend, SharedBrowserCdpInputBackend,
};
use crate::paths::AppPaths;
use crate::runtime::run_automation_with_resources_and_live_pps;
use crate::scanner::{read_snapshot_file, JsonFileScanner};

const BOT_UI_VISIBLE_LABELS: &[&str] = &[
    "Play Style",
    "PPS",
    "Unlimited",
    "Status",
    "Bot ON",
    "Bot OFF",
];
const BOT_UI_HIDDEN_LABELS: &[&str] = &[
    "Dry run",
    "Use hold",
    "Speculate",
    "Allow spin routes",
    "Allow post-softdrop horizontal",
    "Release after each action",
    "Settle",
    "Poll",
    "Move Tap",
    "Rotate Tap",
    "Hold Tap",
    "HardDrop Tap",
    "SoftDrop Tap",
    "Move Delay",
    "Rotate Delay",
    "HardDrop Delay",
    "Piece Delay",
    "Min age",
    "Movement",
    "Spawn",
    "Threads",
    "Min Nodes",
    "Max Nodes",
    "Planner",
];

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
enum ModePreset {
    VsLeft1080p,
    Solo1080p,
    Custom,
}

impl ModePreset {
    fn label(self) -> &'static str {
        match self {
            ModePreset::VsLeft1080p => "2P Left 1080p",
            ModePreset::Solo1080p => "Solo 1080p",
            ModePreset::Custom => "Custom",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum BrowserStatus {
    Closed,
    Starting,
    Ready,
    Error,
}

impl BrowserStatus {
    fn label(self) -> &'static str {
        match self {
            BrowserStatus::Closed => "Closed",
            BrowserStatus::Starting => "Starting",
            BrowserStatus::Ready => "Ready",
            BrowserStatus::Error => "Error",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum BotStatus {
    Off,
    Starting,
    On,
    Error,
}

impl BotStatus {
    fn label(self) -> &'static str {
        match self {
            BotStatus::Off => "Off",
            BotStatus::Starting => "Starting",
            BotStatus::On => "On",
            BotStatus::Error => "Error",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum SnapshotStatus {
    Closed,
    Starting,
    WaitingForGame,
    Ready,
    Error,
}

impl SnapshotStatus {
    fn label(self) -> &'static str {
        match self {
            SnapshotStatus::Closed => "Closed",
            SnapshotStatus::Starting => "Starting",
            SnapshotStatus::WaitingForGame => "WaitingForGame",
            SnapshotStatus::Ready => "Ready",
            SnapshotStatus::Error => "Error",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum InputStatus {
    Closed,
    Starting,
    Ready,
    Error,
}

impl InputStatus {
    fn label(self) -> &'static str {
        match self {
            InputStatus::Closed => "Closed",
            InputStatus::Starting => "Starting",
            InputStatus::Ready => "Ready",
            InputStatus::Error => "Error",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
struct LauncherState {
    preset: ModePreset,
    snapshot_provider: SnapshotProviderConfig,
    scanner_config_path: String,
    snapshot_path: String,
    python_command: String,
    browser: BrowserCdpConfig,
    always_on_top: bool,
    dry_run: bool,
    play_style: PlayStyleConfig,
    poll_interval_ms: u64,
    pps_unlimited: bool,
    target_pps: f32,
    tap_duration_ms: u64,
    movement_tap_duration_ms: u64,
    rotate_tap_duration_ms: u64,
    hold_tap_duration_ms: u64,
    hard_drop_tap_duration_ms: u64,
    soft_drop_tap_duration_ms: u64,
    movement_interval_ms: u64,
    rotation_interval_ms: u64,
    piece_interval_ms: u64,
    hard_drop_interval_ms: u64,
    min_snapshot_age_ms: u64,
    input_backend: InputBackendConfig,
    bot: BotConfig,
    handling: HandlingConfig,
    keys: KeyBindings,
}

impl Default for LauncherState {
    fn default() -> Self {
        Self {
            preset: ModePreset::VsLeft1080p,
            snapshot_provider: SnapshotProviderConfig::BrowserCdp,
            scanner_config_path: "automation/scan-config.vs-left-1080p.json".to_owned(),
            snapshot_path: "automation/live-snapshot.json".to_owned(),
            python_command: "python".to_owned(),
            browser: BrowserCdpConfig::default(),
            always_on_top: false,
            dry_run: true,
            play_style: PlayStyleConfig::Normal,
            poll_interval_ms: 4,
            pps_unlimited: true,
            target_pps: 3.0,
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
            bot: BotConfig::default(),
            handling: HandlingConfig::default(),
            keys: KeyBindings::default(),
        }
    }
}

#[derive(Clone, Debug)]
struct SnapshotInfo {
    token: String,
    age_ms: u128,
    playing: bool,
}

fn window_level(always_on_top: bool) -> egui::viewport::WindowLevel {
    if always_on_top {
        egui::viewport::WindowLevel::AlwaysOnTop
    } else {
        egui::viewport::WindowLevel::Normal
    }
}

pub fn launcher_viewport(paths: &AppPaths) -> egui::ViewportBuilder {
    let always_on_top = load_launcher_state(paths)
        .map(|state| state.always_on_top)
        .unwrap_or(false);
    egui::ViewportBuilder::default().with_window_level(window_level(always_on_top))
}

impl LauncherState {
    fn apply_tetrio_safe_preset(&mut self) {
        self.pps_unlimited = true;
        self.target_pps = 3.0;
        self.tap_duration_ms = 60;
        self.poll_interval_ms = 4;
        self.movement_tap_duration_ms = 16;
        self.rotate_tap_duration_ms = 18;
        self.hold_tap_duration_ms = 20;
        self.hard_drop_tap_duration_ms = 20;
        self.soft_drop_tap_duration_ms = 16;
        self.movement_interval_ms = 0;
        self.rotation_interval_ms = 0;
        self.piece_interval_ms = 0;
        self.hard_drop_interval_ms = 0;
        self.min_snapshot_age_ms = 0;
        self.snapshot_provider = SnapshotProviderConfig::BrowserCdp;
        self.input_backend = InputBackendConfig::BrowserCdp;
        self.browser = BrowserCdpConfig::default();
        self.bot.threads = BotConfig::default().threads;
        self.bot.min_nodes = BotConfig::default().min_nodes;
        self.bot.max_nodes = BotConfig::default().max_nodes;
        self.bot.speculate = false;
        self.bot.movement_mode = MovementModeConfig::ZeroGSafe;
        self.bot.spawn_rule = SpawnRuleConfig::Row19Or20;
        self.handling.soft_drop_mode = SoftDropModeConfig::Infinite;
        self.handling.allow_post_softdrop_actions = true;
        self.handling.allow_post_softdrop_horizontal = false;
        self.handling.release_after_each_action = false;
        self.handling.action_settle_ms = 0;
        self.handling.prevent_accidental_hard_drops = true;
        self.handling.cancel_das_on_direction_change = true;
        self.handling.prefer_soft_drop_over_movement = false;
        self.handling.irs_mode = BufferModeConfig::Off;
        self.handling.ihs_mode = BufferModeConfig::Off;
        self.normalize_pps_state();
    }

    fn apply_preset(&mut self) {
        self.scanner_config_path = match self.preset {
            ModePreset::VsLeft1080p => "automation/scan-config.vs-left-1080p.json",
            ModePreset::Solo1080p => "automation/scan-config.solo-1080p.json",
            ModePreset::Custom => return,
        }
        .to_owned();
        self.snapshot_path = "automation/live-snapshot.json".to_owned();
        self.apply_tetrio_safe_preset();
    }

    fn migrate_legacy_defaults(&mut self) {
        if self.preset != ModePreset::Custom
            && matches!(
                self.bot.movement_mode,
                MovementModeConfig::TwentyG | MovementModeConfig::ZeroGComplete
            )
            && self.tap_duration_ms <= 8
        {
            self.apply_tetrio_safe_preset();
        }
        if self.preset != ModePreset::Custom
            && self.bot.movement_mode == MovementModeConfig::HardDropOnly
        {
            self.bot.movement_mode = MovementModeConfig::ZeroGSafe;
        }
        if self.preset != ModePreset::Custom && self.matches_known_legacy_safe_preset() {
            self.apply_tetrio_safe_preset();
        }
        self.normalize_pps_state();
    }

    fn matches_known_legacy_safe_preset(&self) -> bool {
        self.effective_target_pps() == 0.0
            && (self.matches_first_safe_preset_family()
                || self.matches_second_safe_preset_family()
                || self.matches_third_safe_preset_family())
    }

    fn matches_first_safe_preset_family(&self) -> bool {
        self.poll_interval_ms == 16
            && self.movement_tap_duration_ms == 55
            && self.rotate_tap_duration_ms == 70
            && self.hold_tap_duration_ms == 70
            && self.hard_drop_tap_duration_ms == 80
            && self.soft_drop_tap_duration_ms == 55
            && self.movement_interval_ms == 60
            && self.rotation_interval_ms == 120
            && self.piece_interval_ms == 100
            && self.hard_drop_interval_ms == 100
            && self.min_snapshot_age_ms == 40
            && self.handling.action_settle_ms == 25
    }

    fn matches_second_safe_preset_family(&self) -> bool {
        self.poll_interval_ms == 16
            && self.movement_tap_duration_ms == 40
            && self.rotate_tap_duration_ms == 45
            && self.hold_tap_duration_ms == 55
            && self.hard_drop_tap_duration_ms == 55
            && self.soft_drop_tap_duration_ms == 40
            && self.movement_interval_ms == 18
            && self.rotation_interval_ms == 45
            && self.piece_interval_ms == 20
            && self.hard_drop_interval_ms == 35
            && self.min_snapshot_age_ms == 8
            && self.handling.action_settle_ms == 8
    }

    fn matches_third_safe_preset_family(&self) -> bool {
        self.poll_interval_ms == 4
            && self.movement_tap_duration_ms == 25
            && self.rotate_tap_duration_ms == 28
            && self.hold_tap_duration_ms == 35
            && self.hard_drop_tap_duration_ms == 30
            && self.soft_drop_tap_duration_ms == 25
            && self.movement_interval_ms == 0
            && self.rotation_interval_ms == 8
            && self.piece_interval_ms == 0
            && self.hard_drop_interval_ms == 0
            && self.min_snapshot_age_ms == 0
            && self.handling.action_settle_ms == 0
            && self.handling.release_after_each_action
    }

    fn to_automation_config(&self, paths: &AppPaths) -> AutomationConfig {
        let mut config = AutomationConfig {
            snapshot_provider: SnapshotProviderConfig::BrowserCdp,
            snapshot_path: paths.resolve_workspace_path(&self.snapshot_path),
            dry_run: self.dry_run,
            poll_interval_ms: self.poll_interval_ms,
            target_pps: self.effective_target_pps(),
            play_style: self.play_style,
            evaluation_profile: EvaluationProfileConfig::Normal,
            route_profile: RouteProfileConfig::Normal,
            tap_duration_ms: self.tap_duration_ms,
            movement_tap_duration_ms: self.movement_tap_duration_ms,
            rotate_tap_duration_ms: self.rotate_tap_duration_ms,
            hold_tap_duration_ms: self.hold_tap_duration_ms,
            hard_drop_tap_duration_ms: self.hard_drop_tap_duration_ms,
            soft_drop_tap_duration_ms: self.soft_drop_tap_duration_ms,
            movement_interval_ms: self.movement_interval_ms,
            rotation_interval_ms: self.rotation_interval_ms,
            piece_interval_ms: self.piece_interval_ms,
            hard_drop_interval_ms: self.hard_drop_interval_ms,
            min_snapshot_age_ms: self.min_snapshot_age_ms,
            input_backend: InputBackendConfig::BrowserCdp,
            scanner: ScannerSourceConfig {
                config_path: self.scanner_config_path.clone(),
                python_command: self.python_command.clone(),
            },
            browser: self.browser.clone(),
            bot: self.bot.clone(),
            handling: self.handling.clone(),
            keys: self.keys.clone(),
        };
        if self.play_style == PlayStyleConfig::Speed {
            config.evaluation_profile = EvaluationProfileConfig::Speed;
            config.route_profile = RouteProfileConfig::Speed;
        }
        config
    }

    fn to_bot_automation_config(&self, paths: &AppPaths) -> AutomationConfig {
        let mut config = self.to_automation_config(paths);
        config.browser.connect_only = true;
        config
    }

    fn normalize_pps_state(&mut self) {
        if !self.target_pps.is_finite() || self.target_pps < 0.25 {
            self.target_pps = 3.0;
        }
        self.target_pps = self.target_pps.clamp(0.25, 20.0);
    }

    fn effective_target_pps(&self) -> f32 {
        if self.pps_unlimited {
            0.0
        } else {
            self.target_pps
        }
    }
}

enum LauncherEvent {
    BrowserLog(String),
    BrowserExited(Result<(), String>),
    BotLog(String),
    BotExited(Result<(), String>),
}

struct BrowserSession {
    host: ChromiumHostProcess,
    snapshot_provider: ProviderProcess,
    input_backend: SharedBrowserCdpInputBackend,
    provider_started_at: Instant,
    last_used_token: Arc<Mutex<Option<String>>>,
}

struct BotSession {
    stop: Arc<AtomicBool>,
    live_target_pps: Arc<AtomicU32>,
    automation_thread: Option<JoinHandle<()>>,
}

impl BotSession {
    fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.automation_thread.take() {
            let _ = thread.join();
        }
    }
}

pub struct LauncherApp {
    paths: AppPaths,
    state: LauncherState,
    logs: Vec<String>,
    event_tx: Sender<LauncherEvent>,
    event_rx: Receiver<LauncherEvent>,
    browser_session: Option<BrowserSession>,
    bot_session: Option<BotSession>,
    browser_status: BrowserStatus,
    snapshot_status: SnapshotStatus,
    input_status: InputStatus,
    bot_status: BotStatus,
    latest_snapshot_token: Option<String>,
    latest_snapshot_age_ms: Option<u128>,
    ignore_next_bot_exit: bool,
}

impl LauncherApp {
    pub fn new(paths: AppPaths) -> Self {
        let mut state = load_launcher_state(&paths).unwrap_or_default();
        if state.scanner_config_path.is_empty() {
            state.apply_preset();
        }
        state.migrate_legacy_defaults();
        let (event_tx, event_rx) = mpsc::channel();
        Self {
            paths,
            state,
            logs: vec!["Launcher ready".to_owned()],
            event_tx,
            event_rx,
            browser_session: None,
            bot_session: None,
            browser_status: BrowserStatus::Closed,
            snapshot_status: SnapshotStatus::Closed,
            input_status: InputStatus::Closed,
            bot_status: BotStatus::Off,
            latest_snapshot_token: None,
            latest_snapshot_age_ms: None,
            ignore_next_bot_exit: false,
        }
    }

    fn browser_logger(&self) -> SharedLogger {
        let tx = self.event_tx.clone();
        Arc::new(Mutex::new(Box::new(move |line| {
            let _ = tx.send(LauncherEvent::BrowserLog(line));
        })))
    }

    fn push_log(&mut self, line: impl Into<String>) {
        let line = line.into();
        self.append_log_file(&line);
        self.logs.push(line);
        if self.logs.len() > 400 {
            let drain = self.logs.len() - 400;
            self.logs.drain(0..drain);
        }
    }

    fn append_log_file(&self, line: &str) {
        let log_path = self
            .paths
            .launcher_state_path
            .parent()
            .map(|parent| parent.join("launcher-latest.log"))
            .unwrap_or_else(|| {
                self.paths
                    .workspace_root
                    .join("automation")
                    .join("launcher-latest.log")
            });
        if let Some(parent) = log_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = writeln!(file, "{line}");
        }
    }

    fn save_state(&mut self) {
        if let Err(err) = save_launcher_state(&self.paths, &self.state) {
            self.push_log(format!("[launcher] failed to save launcher state: {err:#}"));
        } else {
            self.push_log(format!(
                "[launcher] saved settings to {}",
                self.paths
                    .display_workspace_relative(&self.paths.launcher_state_path)
            ));
        }
    }

    fn update_live_target_pps(&mut self) {
        let effective_target_pps = self.state.effective_target_pps();
        if let Some(bot_session) = self.bot_session.as_ref() {
            bot_session
                .live_target_pps
                .store(effective_target_pps.to_bits(), Ordering::Relaxed);
            self.push_log(format!(
                "[bot] target PPS changed {}",
                format_target_pps_label(effective_target_pps)
            ));
        }
    }

    fn open_browser(&mut self) {
        if self.browser_session.is_some() {
            return;
        }

        self.save_state();
        self.browser_status = BrowserStatus::Starting;
        self.snapshot_status = SnapshotStatus::Starting;
        self.input_status = InputStatus::Starting;
        self.push_log("[launcher] opening Chromium");

        let mut host = match ChromiumHostProcess::start(
            &self.paths,
            &self.state.browser,
            self.browser_logger(),
        ) {
            Ok(process) => {
                self.push_log("[browser-host] ready");
                process
            }
            Err(err) => {
                self.browser_status = BrowserStatus::Error;
                self.snapshot_status = SnapshotStatus::Error;
                self.input_status = InputStatus::Error;
                self.push_log(format!("[launcher] failed to open Chromium: {err:#}"));
                return;
            }
        };

        let config = self.state.to_bot_automation_config(&self.paths);
        self.push_log("[snapshot] connecting");
        let mut snapshot_provider =
            match ProviderProcess::start_prewarmed(&self.paths, &config, self.browser_logger()) {
                Ok(process) => {
                    self.push_log("[snapshot] ready");
                    process
                }
                Err(err) => {
                    let _ = host.shutdown();
                    self.browser_status = BrowserStatus::Error;
                    self.snapshot_status = SnapshotStatus::Error;
                    self.input_status = InputStatus::Error;
                    self.push_log(format!("[launcher] snapshot helper failed: {err:#}"));
                    return;
                }
            };

        self.push_log("[input] connecting");
        let input_backend = match BrowserCdpInputBackend::shared(&self.paths, &config) {
            Ok(shared) => {
                self.push_log("[input] ready");
                shared
            }
            Err(err) => {
                snapshot_provider.stop();
                let _ = host.shutdown();
                self.browser_status = BrowserStatus::Error;
                self.snapshot_status = SnapshotStatus::Error;
                self.input_status = InputStatus::Error;
                self.push_log(format!("[launcher] input helper failed: {err:#}"));
                return;
            }
        };

        self.browser_session = Some(BrowserSession {
            host,
            snapshot_provider,
            input_backend,
            provider_started_at: Instant::now(),
            last_used_token: Arc::new(Mutex::new(None)),
        });
        self.browser_status = BrowserStatus::Ready;
        self.input_status = InputStatus::Ready;
        self.refresh_snapshot_status();
        self.push_log("[launcher] browser runtime ready");
    }

    fn start_bot(&mut self) {
        let browser_ready = self.browser_status == BrowserStatus::Ready;
        let input_ready = self.input_status == InputStatus::Ready;
        let snapshot_running = matches!(
            self.snapshot_status,
            SnapshotStatus::WaitingForGame | SnapshotStatus::Ready
        );
        if self.bot_session.is_some() || !browser_ready || !input_ready || !snapshot_running {
            self.bot_status = BotStatus::Error;
            self.push_log("[launcher] bot on blocked: browser runtime is not ready");
            return;
        }

        let Some((shared_input_backend, last_used_token_handle, last_used_token_seed)) =
            self.browser_session.as_ref().map(|session| {
                (
                    session.input_backend.clone(),
                    session.last_used_token.clone(),
                    session
                        .last_used_token
                        .lock()
                        .ok()
                        .and_then(|guard| guard.clone()),
                )
            })
        else {
            self.bot_status = BotStatus::Error;
            self.push_log("[launcher] bot on blocked: browser session missing");
            return;
        };

        self.save_state();
        self.bot_status = BotStatus::Starting;
        self.push_log("[launcher] bot on");
        self.push_log("[bot] starting runner with prewarmed snapshot/input");

        if let Some(snapshot) = self.read_latest_snapshot_info() {
            self.push_log(format!(
                "[bot] latest snapshot token={} age_ms={}",
                snapshot.token, snapshot.age_ms
            ));
        } else {
            self.push_log("[bot] latest snapshot not ready yet; waiting for provider update");
        }

        let config = self.state.to_bot_automation_config(&self.paths);
        self.push_log(format!(
            "[bot] style={} target_pps={}",
            config.play_style.log_label(),
            format_target_pps_label(config.target_pps)
        ));
        self.push_log(format!(
            "[bot] evaluation_profile={} route_profile={}",
            config.evaluation_profile.log_label(),
            config.route_profile.log_label()
        ));
        if config.play_style == PlayStyleConfig::Speed {
            self.push_log("[bot] speed priorities=non_spin,short_input,no_softdrop");
        }
        let scanner = JsonFileScanner::with_last_token(
            config.snapshot_path.clone(),
            Duration::from_millis(config.min_snapshot_age_ms),
            last_used_token_seed,
        );

        let input_backend: Box<dyn InputBackend + Send> = if config.dry_run {
            Box::new(DebugLogBackend::new())
        } else {
            Box::new(BrowserCdpInputBackend::from_shared(shared_input_backend))
        };

        let stop = Arc::new(AtomicBool::new(false));
        let live_target_pps = Arc::new(AtomicU32::new(config.target_pps.to_bits()));
        let worker_stop = stop.clone();
        let worker_target_pps = live_target_pps.clone();
        let tx = self.event_tx.clone();
        let last_used_token = last_used_token_handle;
        let automation_thread = thread::spawn(move || {
            let log_tx = tx.clone();
            let result = run_automation_with_resources_and_live_pps(
                config,
                scanner,
                input_backend,
                &worker_stop,
                worker_target_pps,
                move |line| {
                    if let Some(token) = extract_planned_token(&line) {
                        if let Ok(mut guard) = last_used_token.lock() {
                            *guard = Some(token);
                        }
                    }
                    let _ = log_tx.send(LauncherEvent::BotLog(line));
                },
            )
            .map_err(|err| format!("{err:#}"));
            let _ = tx.send(LauncherEvent::BotExited(result));
        });

        self.bot_session = Some(BotSession {
            stop,
            live_target_pps,
            automation_thread: Some(automation_thread),
        });
        self.bot_status = BotStatus::On;
        self.push_log("[bot] planner started");
    }

    fn stop_bot(&mut self) {
        self.stop_bot_with_browser_hint(self.browser_session.is_some());
    }

    fn stop_bot_with_browser_hint(&mut self, browser_remains_open: bool) {
        if let Some(mut bot) = self.bot_session.take() {
            self.ignore_next_bot_exit = true;
            bot.stop();
            self.push_log("[bot] runner stopped");
            if let Err(err) = self.release_shared_input_now() {
                self.push_log(format!("[input] failed to release all keys: {err:#}"));
            } else {
                self.push_log("[input] released all keys");
            }
            if browser_remains_open {
                self.push_log("[snapshot] provider remains active");
            }
        }
        self.bot_status = BotStatus::Off;
    }

    fn close_browser(&mut self) {
        if self.bot_session.is_some() {
            self.stop_bot_with_browser_hint(false);
        }

        if let Some(mut session) = self.browser_session.take() {
            self.push_log("[launcher] closing Chromium");
            let _ = self.release_input_from_session(&session);
            session.snapshot_provider.stop();
            if let Ok(mut backend) = session.input_backend.lock() {
                let _ = backend.shutdown();
            }
            match session.host.shutdown() {
                Ok(()) => self.push_log("[launcher] browser closed"),
                Err(err) => self.push_log(format!("[launcher] browser shutdown failed: {err:#}")),
            }
        }

        self.browser_status = BrowserStatus::Closed;
        self.snapshot_status = SnapshotStatus::Closed;
        self.input_status = InputStatus::Closed;
        self.latest_snapshot_token = None;
        self.latest_snapshot_age_ms = None;
    }

    fn release_shared_input_now(&self) -> Result<()> {
        let Some(session) = self.browser_session.as_ref() else {
            return Ok(());
        };
        self.release_input_from_session(session)
    }

    fn release_input_from_session(&self, session: &BrowserSession) -> Result<()> {
        let mut backend = session
            .input_backend
            .lock()
            .map_err(|_| anyhow::anyhow!("shared browser input backend lock poisoned"))?;
        backend.release_all_keys()
    }

    fn read_latest_snapshot_info(&self) -> Option<SnapshotInfo> {
        let snapshot_path = self.paths.resolve_workspace_path(&self.state.snapshot_path);
        let metadata = fs::metadata(&snapshot_path).ok()?;
        let modified_at = metadata.modified().ok()?;
        let age_ms = modified_at.elapsed().ok()?.as_millis();
        let snapshot = read_snapshot_file(&snapshot_path).ok()?;
        if snapshot.token.trim().is_empty() {
            return None;
        }
        Some(SnapshotInfo {
            token: snapshot.token,
            age_ms,
            playing: snapshot.playing,
        })
    }

    fn refresh_snapshot_status(&mut self) {
        let Some(session) = self.browser_session.as_ref() else {
            self.snapshot_status = SnapshotStatus::Closed;
            self.latest_snapshot_token = None;
            self.latest_snapshot_age_ms = None;
            return;
        };

        if let Some(snapshot) = self.read_latest_snapshot_info() {
            self.latest_snapshot_token = Some(snapshot.token.clone());
            self.latest_snapshot_age_ms = Some(snapshot.age_ms);
            if snapshot.playing && snapshot.age_ms <= 500 {
                self.snapshot_status = SnapshotStatus::Ready;
            } else {
                self.snapshot_status = SnapshotStatus::WaitingForGame;
            }
        } else if session.provider_started_at.elapsed() >= Duration::from_millis(200) {
            self.snapshot_status = SnapshotStatus::WaitingForGame;
            self.latest_snapshot_token = None;
            self.latest_snapshot_age_ms = None;
        } else {
            self.snapshot_status = SnapshotStatus::Starting;
        }
    }

    fn poll_browser_runtime(&mut self) {
        let Some(session) = self.browser_session.as_mut() else {
            return;
        };

        let host_running = match session.host.is_running() {
            Ok(true) => {}
            Ok(false) => {
                let _ = self.event_tx.send(LauncherEvent::BrowserExited(Ok(())));
                return;
            }
            Err(err) => {
                let _ = self
                    .event_tx
                    .send(LauncherEvent::BrowserExited(Err(format!("{err:#}"))));
                return;
            }
        };
        let _ = host_running;

        let snapshot_result = session.snapshot_provider.is_running();
        let input_result = match session.input_backend.lock() {
            Ok(mut backend) => backend.is_running(),
            Err(_) => Err(anyhow::anyhow!(
                "shared browser input backend lock poisoned"
            )),
        };
        let _ = session;

        match snapshot_result {
            Ok(true) => {}
            Ok(false) => {
                if self.snapshot_status != SnapshotStatus::Error {
                    self.snapshot_status = SnapshotStatus::Error;
                    self.browser_status = BrowserStatus::Error;
                    self.push_log("[snapshot] provider exited unexpectedly");
                }
            }
            Err(err) => {
                if self.snapshot_status != SnapshotStatus::Error {
                    self.snapshot_status = SnapshotStatus::Error;
                    self.browser_status = BrowserStatus::Error;
                    self.push_log(format!("[snapshot] provider status failed: {err:#}"));
                }
            }
        }

        match input_result {
            Ok(true) => {}
            Ok(false) => {
                if self.input_status != InputStatus::Error {
                    self.input_status = InputStatus::Error;
                    self.browser_status = BrowserStatus::Error;
                    self.push_log("[input] helper exited unexpectedly");
                }
            }
            Err(err) => {
                if self.input_status != InputStatus::Error {
                    self.input_status = InputStatus::Error;
                    self.browser_status = BrowserStatus::Error;
                    self.push_log(format!("[input] helper status failed: {err:#}"));
                }
            }
        }

        if self.snapshot_status != SnapshotStatus::Error {
            self.refresh_snapshot_status();
        }
    }

    fn handle_browser_exited(&mut self, result: Result<(), String>) {
        if self.bot_session.is_some() {
            self.push_log("[launcher] browser closed while bot was on");
            self.stop_bot_with_browser_hint(false);
        }
        if let Some(mut session) = self.browser_session.take() {
            session.snapshot_provider.stop();
            if let Ok(mut backend) = session.input_backend.lock() {
                let _ = backend.shutdown();
            }
        }
        match result {
            Ok(()) => self.push_log("[browser-host] Chromium exited"),
            Err(err) => self.push_log(format!("[launcher] browser exited with error: {err}")),
        }
        self.browser_status = BrowserStatus::Closed;
        self.snapshot_status = SnapshotStatus::Closed;
        self.input_status = InputStatus::Closed;
        self.latest_snapshot_token = None;
        self.latest_snapshot_age_ms = None;
        self.push_log("[launcher] browser closed");
    }

    fn poll_events(&mut self) {
        let mut events = Vec::new();
        while let Ok(event) = self.event_rx.try_recv() {
            events.push(event);
        }

        for event in events {
            match event {
                LauncherEvent::BrowserLog(line) => self.push_log(line),
                LauncherEvent::BrowserExited(result) => {
                    self.handle_browser_exited(result);
                }
                LauncherEvent::BotLog(line) => {
                    self.push_log(line);
                }
                LauncherEvent::BotExited(result) => {
                    if self.ignore_next_bot_exit {
                        self.ignore_next_bot_exit = false;
                        continue;
                    }
                    self.bot_session = None;
                    match result {
                        Ok(()) => {
                            self.bot_status = BotStatus::Off;
                            self.push_log("[bot] automation exited cleanly");
                        }
                        Err(err) => {
                            self.bot_status = BotStatus::Error;
                            self.push_log(format!("[bot] automation failed: {err}"));
                        }
                    }
                }
            }
        }
    }
}

impl eframe::App for LauncherApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_browser_runtime();
        self.poll_events();
        ctx.send_viewport_cmd(egui::ViewportCommand::WindowLevel(window_level(
            self.state.always_on_top,
        )));

        let browser_locked = self.browser_session.is_some();
        let bot_locked = self.bot_session.is_some();
        let can_turn_bot_on = self.browser_status == BrowserStatus::Ready
            && self.input_status == InputStatus::Ready
            && matches!(
                self.snapshot_status,
                SnapshotStatus::WaitingForGame | SnapshotStatus::Ready
            )
            && !bot_locked;

        egui::TopBottomPanel::top("top_bar").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading("Cold Clear Launcher");
                ui.separator();
                ui.label(format!("Browser: {}", self.browser_status.label()));
                ui.separator();
                ui.label(format!("Bot: {}", self.bot_status.label()));
            });
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label("Mode");
                let old_preset = self.state.preset;
                ui.add_enabled_ui(!browser_locked && !bot_locked, |ui| {
                    egui::ComboBox::from_id_salt("preset")
                        .selected_text(self.state.preset.label())
                        .show_ui(ui, |ui| {
                            ui.selectable_value(
                                &mut self.state.preset,
                                ModePreset::VsLeft1080p,
                                ModePreset::VsLeft1080p.label(),
                            );
                            ui.selectable_value(
                                &mut self.state.preset,
                                ModePreset::Solo1080p,
                                ModePreset::Solo1080p.label(),
                            );
                            ui.selectable_value(
                                &mut self.state.preset,
                                ModePreset::Custom,
                                ModePreset::Custom.label(),
                            );
                        });
                });
                if self.state.preset != old_preset {
                    self.state.apply_preset();
                }
            });

            ui.label("Open Chromium now prewarms the snapshot and input CDP helpers. Bot ON only starts the planner/runner.");
            if browser_locked {
                ui.small("Browser settings are locked while Chromium is open.");
            }
            ui.add_enabled_ui(!browser_locked, |ui| {
                ui.horizontal(|ui| {
                    ui.label("Chrome Path");
                    ui.text_edit_singleline(&mut self.state.browser.chrome_path);
                });
                ui.horizontal(|ui| {
                    ui.label("CDP Port");
                    ui.add(egui::DragValue::new(&mut self.state.browser.cdp_port).speed(1));
                    ui.label("URL");
                    ui.text_edit_singleline(&mut self.state.browser.url);
                });
                ui.horizontal(|ui| {
                    ui.label("Target");
                    ui.text_edit_singleline(&mut self.state.browser.target_hint);
                });
            });
            ui.horizontal(|ui| {
                ui.checkbox(&mut self.state.always_on_top, "Always on top");
            });

            ui.separator();
            ui.heading("Browser");
            ui.horizontal(|ui| {
                ui.label(format!("Chromium: {}", self.browser_status.label()));
                ui.label(format!("Snapshot: {}", self.snapshot_status.label()));
                ui.label(format!("Input: {}", self.input_status.label()));
            });
            if let Some(token) = &self.latest_snapshot_token {
                ui.label(format!(
                    "Latest Snapshot: token={} age_ms={}",
                    token,
                    self.latest_snapshot_age_ms.unwrap_or_default()
                ));
            }
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(!browser_locked, egui::Button::new("Open Chromium"))
                    .clicked()
                {
                    self.open_browser();
                }
                if ui
                    .add_enabled(browser_locked, egui::Button::new("Close Chromium"))
                    .clicked()
                {
                    self.close_browser();
                }
            });

            ui.separator();
            ui.heading("Bot");
            if bot_locked {
                ui.small("플레이 스타일은 다음 Bot ON부터 적용됩니다.");
            }
            ui.horizontal(|ui| {
                ui.label(BOT_UI_VISIBLE_LABELS[0]);
                ui.add_enabled_ui(!bot_locked, |ui| {
                    egui::ComboBox::from_id_salt("play_style")
                        .selected_text(play_style_label(self.state.play_style))
                        .show_ui(ui, |ui| {
                            ui.selectable_value(
                                &mut self.state.play_style,
                                PlayStyleConfig::Normal,
                                play_style_label(PlayStyleConfig::Normal),
                            );
                            ui.selectable_value(
                                &mut self.state.play_style,
                                PlayStyleConfig::Speed,
                                play_style_label(PlayStyleConfig::Speed),
                            );
                        });
                });
            });
            ui.small(play_style_description(self.state.play_style));

            let previous_target_pps = self.state.target_pps;
            let previous_pps_unlimited = self.state.pps_unlimited;
            ui.horizontal(|ui| {
                ui.label(BOT_UI_VISIBLE_LABELS[1]).on_hover_text(
                    "PPS는 초당 배치할 미노 수의 최대값입니다.\n실제 속도는 계산 및 입력 경로에 따라 더 낮을 수 있습니다.",
                );
                ui.add_enabled_ui(!self.state.pps_unlimited, |ui| {
                    ui.add(
                        egui::DragValue::new(&mut self.state.target_pps)
                            .speed(0.1)
                            .range(0.25..=20.0)
                            .fixed_decimals(2),
                    );
                });
                ui.checkbox(&mut self.state.pps_unlimited, BOT_UI_VISIBLE_LABELS[2]);
            });
            self.state.normalize_pps_state();
            if previous_target_pps != self.state.target_pps
                || previous_pps_unlimited != self.state.pps_unlimited
            {
                self.update_live_target_pps();
            }
            ui.horizontal(|ui| {
                ui.label(format!("{}: {}", BOT_UI_VISIBLE_LABELS[3], self.bot_status.label()));
                if ui
                    .add_enabled(can_turn_bot_on, egui::Button::new(BOT_UI_VISIBLE_LABELS[4]))
                    .clicked()
                {
                    self.start_bot();
                }
                if ui
                    .add_enabled(bot_locked, egui::Button::new(BOT_UI_VISIBLE_LABELS[5]))
                    .clicked()
                {
                    self.stop_bot();
                }
            });

            ui.separator();
            ui.heading("Settings");
            if ui.button("Save Settings").clicked() {
                self.save_state();
            }

            ui.separator();
            ui.heading("Log");
            egui::ScrollArea::vertical()
                .stick_to_bottom(true)
                .max_height(260.0)
                .show(ui, |ui| {
                    for line in &self.logs {
                        ui.monospace(line);
                    }
                });
        });

        ctx.request_repaint_after(Duration::from_millis(100));
    }
}

impl Drop for LauncherApp {
    fn drop(&mut self) {
        self.stop_bot_with_browser_hint(false);
        self.close_browser();
        let _ = save_launcher_state(&self.paths, &self.state);
    }
}

fn load_launcher_state(paths: &AppPaths) -> Result<LauncherState> {
    let raw = fs::read_to_string(&paths.launcher_state_path).with_context(|| {
        format!(
            "failed to read launcher state from {}",
            paths.launcher_state_path.display()
        )
    })?;
    let raw_json: serde_json::Value =
        serde_json::from_str(&raw).context("failed to parse launcher state JSON")?;
    let mut state: LauncherState =
        serde_json::from_value(raw_json.clone()).context("failed to decode launcher state")?;
    if raw_json.get("pps_unlimited").is_none() {
        state.pps_unlimited = state.target_pps <= 0.0;
    }
    state.normalize_pps_state();
    Ok(state)
}

fn save_launcher_state(paths: &AppPaths, state: &LauncherState) -> Result<()> {
    if let Some(parent) = paths.launcher_state_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(state)?;
    fs::write(&paths.launcher_state_path, raw)?;
    Ok(())
}

fn movement_mode_label(mode: MovementModeConfig) -> &'static str {
    match mode {
        MovementModeConfig::ZeroG => "ZeroG",
        MovementModeConfig::ZeroGSafe => "ZeroG Safe",
        MovementModeConfig::ZeroGComplete => "ZeroG Complete (Experimental)",
        MovementModeConfig::TwentyG => "TwentyG",
        MovementModeConfig::HardDropOnly => "Hard Drop Only",
    }
}

fn play_style_label(style: PlayStyleConfig) -> &'static str {
    match style {
        PlayStyleConfig::Normal => "노말",
        PlayStyleConfig::Speed => "속도 지향",
    }
}

fn play_style_description(style: PlayStyleConfig) -> &'static str {
    match style {
        PlayStyleConfig::Normal => "현재 기본 설정으로 플레이합니다.",
        PlayStyleConfig::Speed => "테트리스 중심의 Sprint 40L 빌드를 우선합니다.",
    }
}

fn format_target_pps_label(target_pps: f32) -> String {
    if target_pps.is_finite() && target_pps > 0.0 {
        format!("{target_pps:.2}")
    } else {
        "unlimited".to_owned()
    }
}

fn spawn_rule_label(rule: SpawnRuleConfig) -> &'static str {
    match rule {
        SpawnRuleConfig::Row19Or20 => "Row 19 or 20",
        SpawnRuleConfig::Row21AndFall => "Row 21 and fall",
    }
}

fn extract_planned_token(line: &str) -> Option<String> {
    if !line.contains("[automation] source=") || !line.contains(" piece=") {
        return None;
    }
    line.split_whitespace()
        .find_map(|part| part.strip_prefix("token=").map(|value| value.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn built_in_preset_uses_safe_defaults() {
        let mut state = LauncherState::default();
        state.preset = ModePreset::Solo1080p;
        state.apply_preset();

        assert_eq!(state.bot.movement_mode, MovementModeConfig::ZeroGSafe);
        assert_eq!(state.bot.spawn_rule, SpawnRuleConfig::Row19Or20);
        assert!(state.pps_unlimited);
        assert_eq!(state.effective_target_pps(), 0.0);
        assert_eq!(state.target_pps, 3.0);
        assert_eq!(state.tap_duration_ms, 60);
        assert_eq!(state.poll_interval_ms, 4);
        assert_eq!(state.movement_tap_duration_ms, 16);
        assert_eq!(state.rotate_tap_duration_ms, 18);
        assert_eq!(state.hold_tap_duration_ms, 20);
        assert_eq!(state.hard_drop_tap_duration_ms, 20);
        assert_eq!(state.soft_drop_tap_duration_ms, 16);
        assert_eq!(state.movement_interval_ms, 0);
        assert_eq!(state.rotation_interval_ms, 0);
        assert_eq!(state.piece_interval_ms, 0);
        assert_eq!(state.hard_drop_interval_ms, 0);
        assert_eq!(state.min_snapshot_age_ms, 0);
        assert_eq!(state.snapshot_provider, SnapshotProviderConfig::BrowserCdp);
        assert_eq!(state.input_backend, InputBackendConfig::BrowserCdp);
        assert!(state.handling.allow_post_softdrop_actions);
        assert!(!state.handling.allow_post_softdrop_horizontal);
        assert!(!state.handling.release_after_each_action);
        assert_eq!(state.handling.action_settle_ms, 0);
        assert_eq!(state.handling.irs_mode, BufferModeConfig::Off);
        assert_eq!(state.handling.ihs_mode, BufferModeConfig::Off);
    }

    #[test]
    fn readme_matches_safe_preset_defaults() {
        let readme = include_str!("../README.md");
        assert!(readme.contains("Open Chromium"));
        assert!(readme.contains("Bot ON"));
        assert!(readme.contains("snapshot and input CDP helpers"));
        assert!(readme.contains("Play Style"));
        assert!(readme.contains("Unlimited"));
    }

    #[test]
    fn migrate_legacy_defaults_upgrades_previous_safe_profile() {
        let mut state = LauncherState {
            preset: ModePreset::Solo1080p,
            dry_run: false,
            poll_interval_ms: 4,
            pps_unlimited: true,
            target_pps: 3.0,
            movement_tap_duration_ms: 25,
            rotate_tap_duration_ms: 28,
            hold_tap_duration_ms: 35,
            hard_drop_tap_duration_ms: 30,
            soft_drop_tap_duration_ms: 25,
            movement_interval_ms: 0,
            rotation_interval_ms: 8,
            piece_interval_ms: 0,
            hard_drop_interval_ms: 0,
            min_snapshot_age_ms: 0,
            handling: HandlingConfig {
                release_after_each_action: true,
                action_settle_ms: 0,
                ..HandlingConfig::default()
            },
            ..LauncherState::default()
        };

        state.migrate_legacy_defaults();

        assert_eq!(state.poll_interval_ms, 4);
        assert_eq!(state.movement_tap_duration_ms, 16);
        assert_eq!(state.rotate_tap_duration_ms, 18);
        assert_eq!(state.hold_tap_duration_ms, 20);
        assert_eq!(state.hard_drop_tap_duration_ms, 20);
        assert_eq!(state.movement_interval_ms, 0);
        assert_eq!(state.rotation_interval_ms, 0);
        assert_eq!(state.piece_interval_ms, 0);
        assert_eq!(state.hard_drop_interval_ms, 0);
        assert_eq!(state.min_snapshot_age_ms, 0);
        assert_eq!(state.handling.action_settle_ms, 0);
        assert!(!state.handling.release_after_each_action);
    }

    #[test]
    fn bot_config_forces_connect_only() {
        let paths = AppPaths::discover();
        let state = LauncherState::default();
        let config = state.to_bot_automation_config(&paths);
        assert!(config.browser.connect_only);
    }

    #[test]
    fn launcher_state_missing_play_style_defaults_to_normal() {
        let state: LauncherState = serde_json::from_value(json!({
            "preset": "Solo1080p"
        }))
        .unwrap();
        assert_eq!(state.play_style, PlayStyleConfig::Normal);
    }

    #[test]
    fn normal_style_preserves_base_profiles() {
        let paths = AppPaths::discover();
        let mut state = LauncherState::default();
        state.play_style = PlayStyleConfig::Normal;
        let config = state.to_automation_config(&paths);
        assert_eq!(config.play_style, PlayStyleConfig::Normal);
        assert_eq!(config.evaluation_profile, EvaluationProfileConfig::Normal);
        assert_eq!(config.route_profile, RouteProfileConfig::Normal);
        assert_eq!(config.bot.movement_mode, state.bot.movement_mode);
        assert_eq!(config.bot.min_nodes, state.bot.min_nodes);
    }

    #[test]
    fn speed_style_only_applies_transient_profiles() {
        let paths = AppPaths::discover();
        let mut state = LauncherState::default();
        state.bot.movement_mode = MovementModeConfig::TwentyG;
        state.bot.min_nodes = 1234;
        state.play_style = PlayStyleConfig::Speed;

        let config = state.to_automation_config(&paths);

        assert_eq!(config.play_style, PlayStyleConfig::Speed);
        assert_eq!(config.evaluation_profile, EvaluationProfileConfig::Speed);
        assert_eq!(config.route_profile, RouteProfileConfig::Speed);
        assert_eq!(config.bot.movement_mode, MovementModeConfig::TwentyG);
        assert_eq!(config.bot.min_nodes, 1234);
        assert_eq!(state.bot.movement_mode, MovementModeConfig::TwentyG);
        assert_eq!(state.bot.min_nodes, 1234);
    }

    #[test]
    fn pps_unlimited_migration_is_inferred_from_zero_target_pps() {
        let raw = json!({
            "preset": "Solo1080p",
            "target_pps": 0.0
        });
        let mut state: LauncherState = serde_json::from_value(raw).unwrap();
        state.pps_unlimited = state.target_pps <= 0.0;
        state.normalize_pps_state();
        assert!(state.pps_unlimited);
        assert_eq!(state.target_pps, 3.0);
        assert_eq!(state.effective_target_pps(), 0.0);
    }

    #[test]
    fn bot_ui_hides_legacy_controls() {
        assert!(BOT_UI_VISIBLE_LABELS.contains(&"Play Style"));
        assert!(BOT_UI_VISIBLE_LABELS.contains(&"PPS"));
        assert!(BOT_UI_VISIBLE_LABELS.contains(&"Bot ON"));
        assert!(BOT_UI_VISIBLE_LABELS.contains(&"Bot OFF"));
        assert!(!BOT_UI_VISIBLE_LABELS.contains(&"Dry run"));
        assert!(BOT_UI_HIDDEN_LABELS.contains(&"Dry run"));
        assert!(BOT_UI_HIDDEN_LABELS.contains(&"Movement"));
        assert!(BOT_UI_HIDDEN_LABELS.contains(&"Threads"));
    }

    #[test]
    fn extract_planned_token_reads_runner_move_log() {
        assert_eq!(
            extract_planned_token(
                "[automation] source=browser_cdp token=browser-10 piece=T hold=- mode=ZeroG Safe"
            )
            .as_deref(),
            Some("browser-10")
        );
        assert_eq!(extract_planned_token("[automation] waiting"), None);
    }
}
