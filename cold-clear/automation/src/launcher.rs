use std::fs;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result};
use eframe::egui;
use serde::{Deserialize, Serialize};

use crate::browser_source::{ChromiumHostProcess, SharedLogger};
use crate::config::{
    AutomationConfig, BotConfig, BrowserCdpConfig, BufferModeConfig, HandlingConfig,
    InputBackendConfig, KeyBindings, MovementModeConfig, ScannerSourceConfig,
    SnapshotProviderConfig, SoftDropModeConfig, SpawnRuleConfig,
};
use crate::driver::create_input_backend;
use crate::paths::AppPaths;
use crate::runtime::run_automation;

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
    poll_interval_ms: u64,
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
            poll_interval_ms: 4,
            target_pps: 0.0,
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
        self.target_pps = 0.0;
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
    }

    fn matches_known_legacy_safe_preset(&self) -> bool {
        self.target_pps == 0.0
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
        AutomationConfig {
            snapshot_provider: SnapshotProviderConfig::BrowserCdp,
            snapshot_path: paths.resolve_workspace_path(&self.snapshot_path),
            dry_run: self.dry_run,
            poll_interval_ms: self.poll_interval_ms,
            target_pps: self.target_pps,
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
        }
    }

    fn to_bot_automation_config(&self, paths: &AppPaths) -> AutomationConfig {
        let mut config = self.to_automation_config(paths);
        config.browser.connect_only = true;
        config
    }
}

enum LauncherEvent {
    BrowserLog(String),
    BrowserExited(Result<(), String>),
    BotLog(String),
    BotExited(Result<(), String>),
}

struct BrowserSession {
    process: ChromiumHostProcess,
}

struct BotSession {
    stop: Arc<AtomicBool>,
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
    bot_status: BotStatus,
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
            bot_status: BotStatus::Off,
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

    fn open_browser(&mut self) {
        if self.browser_session.is_some() {
            return;
        }

        self.save_state();
        self.browser_status = BrowserStatus::Starting;
        self.push_log("[launcher] opening Chromium");

        match ChromiumHostProcess::start(&self.paths, &self.state.browser, self.browser_logger()) {
            Ok(process) => {
                self.browser_session = Some(BrowserSession { process });
                self.browser_status = BrowserStatus::Ready;
                self.push_log("[launcher] browser ready");
            }
            Err(err) => {
                self.browser_status = BrowserStatus::Error;
                self.push_log(format!("[launcher] failed to open Chromium: {err:#}"));
            }
        }
    }

    fn close_browser(&mut self) {
        if self.bot_session.is_some() {
            self.stop_bot();
        }

        if let Some(mut browser) = self.browser_session.take() {
            self.push_log("[launcher] closing Chromium");
            match browser.process.shutdown() {
                Ok(()) => self.push_log("[launcher] browser closed"),
                Err(err) => self.push_log(format!("[launcher] browser shutdown failed: {err:#}")),
            }
        }
        self.browser_status = BrowserStatus::Closed;
    }

    fn clear_snapshot_file(&mut self) {
        let snapshot_path = self.paths.resolve_workspace_path(&self.state.snapshot_path);
        match fs::remove_file(&snapshot_path) {
            Ok(()) => self.push_log(format!(
                "[launcher] cleared stale snapshot {}",
                self.paths.display_workspace_relative(&snapshot_path)
            )),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => self.push_log(format!(
                "[launcher] failed to clear stale snapshot {}: {}",
                self.paths.display_workspace_relative(&snapshot_path),
                err
            )),
        }
    }

    fn start_bot(&mut self) {
        if self.bot_session.is_some() {
            return;
        }
        if self.browser_status != BrowserStatus::Ready || self.browser_session.is_none() {
            self.bot_status = BotStatus::Error;
            self.push_log("[launcher] bot on blocked: browser is not ready");
            return;
        }

        self.save_state();
        self.clear_snapshot_file();
        self.bot_status = BotStatus::Starting;
        self.push_log("[launcher] bot on");

        let config = self.state.to_bot_automation_config(&self.paths);
        self.push_log(format!(
            "[bot] connecting to existing Chromium port={}",
            config.browser.cdp_port
        ));

        let paths = self.paths.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let tx = self.event_tx.clone();
        let automation_thread = thread::spawn(move || {
            let log_tx = tx.clone();
            let result = run_automation(paths, config, &worker_stop, move |line| {
                let _ = log_tx.send(LauncherEvent::BotLog(line));
            })
            .map_err(|err| format!("{err:#}"));
            let _ = tx.send(LauncherEvent::BotExited(result));
        });

        self.bot_session = Some(BotSession {
            stop,
            automation_thread: Some(automation_thread),
        });
        self.bot_status = BotStatus::On;
    }

    fn stop_bot(&mut self) {
        self.stop_bot_with_browser_hint(self.browser_session.is_some());
    }

    fn stop_bot_with_browser_hint(&mut self, browser_remains_open: bool) {
        if let Some(mut bot) = self.bot_session.take() {
            self.ignore_next_bot_exit = true;
            self.push_log("[bot] stopping");
            bot.stop();
            match self.release_all_keys_now() {
                Ok(()) => self.push_log("[bot] released all keys"),
                Err(err) => self.push_log(format!("[bot] failed to release keys: {err:#}")),
            }
            self.push_log("[bot] stopped");
            if browser_remains_open {
                self.push_log("[browser-host] Chromium remains open");
            }
        }
        self.bot_status = BotStatus::Off;
    }

    fn release_all_keys_now(&self) -> Result<()> {
        if self.state.dry_run {
            return Ok(());
        }
        let config = self.state.to_bot_automation_config(&self.paths);
        let mut backend = create_input_backend(&self.paths, &config)?;
        backend.release_all_keys()
    }

    fn poll_browser_session(&mut self) {
        let Some(session) = self.browser_session.as_mut() else {
            return;
        };
        match session.process.is_running() {
            Ok(true) => {}
            Ok(false) => {
                let _ = self.event_tx.send(LauncherEvent::BrowserExited(Ok(())));
            }
            Err(err) => {
                let _ = self
                    .event_tx
                    .send(LauncherEvent::BrowserExited(Err(format!("{err:#}"))));
            }
        }
    }

    fn handle_browser_exited(&mut self, result: Result<(), String>) {
        self.browser_session = None;
        self.browser_status = BrowserStatus::Closed;
        match result {
            Ok(()) => self.push_log("[browser-host] Chromium exited"),
            Err(err) => self.push_log(format!("[launcher] browser exited with error: {err}")),
        }
        if self.bot_session.is_some() {
            self.push_log("[launcher] browser closed while bot was on");
            self.stop_bot_with_browser_hint(false);
        }
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
                    if self.browser_session.is_some() {
                        self.handle_browser_exited(result);
                    }
                }
                LauncherEvent::BotLog(line) => {
                    if line.contains("[automation] live game resumed")
                        || line.contains("[automation] idle waiting for next live game")
                        || line.contains("[automation] source=")
                    {
                        self.bot_status = BotStatus::On;
                    }
                    self.push_log(line);
                }
                LauncherEvent::BotExited(result) => {
                    if self.ignore_next_bot_exit {
                        self.ignore_next_bot_exit = false;
                        continue;
                    }
                    self.bot_session = None;
                    self.bot_status = match result {
                        Ok(()) => {
                            self.push_log("[bot] automation exited cleanly");
                            BotStatus::Off
                        }
                        Err(err) => {
                            self.push_log(format!("[bot] automation failed: {err}"));
                            BotStatus::Error
                        }
                    };
                }
            }
        }
    }
}

impl eframe::App for LauncherApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_browser_session();
        self.poll_events();
        ctx.send_viewport_cmd(egui::ViewportCommand::WindowLevel(window_level(
            self.state.always_on_top,
        )));

        let browser_locked = self.browser_session.is_some();
        let bot_locked = self.bot_session.is_some();

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

            ui.label(
                "Browser host keeps Chromium alive on its own. Bot ON later reconnects with Browser CDP only.",
            );
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
                ui.checkbox(&mut self.state.browser.probe_page_state, "Probe page state");
                ui.checkbox(
                    &mut self.state.browser.use_ribbon_websocket,
                    "Use ribbon websocket",
                );
                ui.checkbox(
                    &mut self.state.browser.use_seed_simulation_fallback,
                    "Use seed simulation fallback",
                );
                ui.checkbox(&mut self.state.always_on_top, "Always on top");
            });

            ui.separator();
            ui.heading("Browser");
            ui.horizontal(|ui| {
                ui.label(format!("Status: {}", self.browser_status.label()));
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
                ui.small("Runtime settings are locked while the bot is on.");
            }
            ui.add_enabled_ui(!bot_locked, |ui| {
                ui.horizontal(|ui| {
                    ui.checkbox(&mut self.state.dry_run, "Dry run");
                    ui.checkbox(&mut self.state.bot.use_hold, "Use hold");
                    ui.checkbox(&mut self.state.bot.speculate, "Speculate");
                    ui.checkbox(
                        &mut self.state.handling.allow_post_softdrop_actions,
                        "Allow spin routes",
                    );
                    ui.checkbox(
                        &mut self.state.handling.allow_post_softdrop_horizontal,
                        "Allow post-softdrop horizontal",
                    );
                    ui.label("Input");
                    ui.monospace("Browser CDP");
                });
                ui.horizontal(|ui| {
                    ui.checkbox(
                        &mut self.state.handling.release_after_each_action,
                        "Release after each action",
                    );
                    ui.label("Settle");
                    ui.add(
                        egui::DragValue::new(&mut self.state.handling.action_settle_ms).speed(1),
                    );
                });
                ui.horizontal(|ui| {
                    ui.label("Poll");
                    ui.add(egui::DragValue::new(&mut self.state.poll_interval_ms).speed(1));
                    ui.label("Target PPS");
                    ui.add(
                        egui::DragValue::new(&mut self.state.target_pps)
                            .speed(0.05)
                            .range(0.0..=20.0),
                    );
                    ui.small("0 = unlimited");
                });
                ui.horizontal(|ui| {
                    ui.label("Move Tap");
                    ui.add(
                        egui::DragValue::new(&mut self.state.movement_tap_duration_ms).speed(1),
                    );
                    ui.label("Rotate Tap");
                    ui.add(
                        egui::DragValue::new(&mut self.state.rotate_tap_duration_ms).speed(1),
                    );
                });
                ui.horizontal(|ui| {
                    ui.label("HardDrop Tap");
                    ui.add(
                        egui::DragValue::new(&mut self.state.hard_drop_tap_duration_ms).speed(1),
                    );
                });
                ui.horizontal(|ui| {
                    ui.label("Move Delay");
                    ui.add(egui::DragValue::new(&mut self.state.movement_interval_ms).speed(1));
                    ui.label("Rotate Delay");
                    ui.add(egui::DragValue::new(&mut self.state.rotation_interval_ms).speed(1));
                    ui.label("HardDrop Delay");
                    ui.add(egui::DragValue::new(&mut self.state.hard_drop_interval_ms).speed(1));
                });
                ui.horizontal(|ui| {
                    ui.label("Piece Delay");
                    ui.add(egui::DragValue::new(&mut self.state.piece_interval_ms).speed(1));
                    ui.label("Min age");
                    ui.add(egui::DragValue::new(&mut self.state.min_snapshot_age_ms).speed(1));
                });
                ui.horizontal(|ui| {
                    ui.label("Movement");
                    egui::ComboBox::from_id_salt("movement_mode")
                        .selected_text(movement_mode_label(self.state.bot.movement_mode))
                        .show_ui(ui, |ui| {
                            for mode in [
                                MovementModeConfig::HardDropOnly,
                                MovementModeConfig::ZeroGSafe,
                                MovementModeConfig::ZeroG,
                                MovementModeConfig::ZeroGComplete,
                                MovementModeConfig::TwentyG,
                            ] {
                                ui.selectable_value(
                                    &mut self.state.bot.movement_mode,
                                    mode,
                                    movement_mode_label(mode),
                                );
                            }
                        });
                    ui.label("Spawn");
                    egui::ComboBox::from_id_salt("spawn_rule")
                        .selected_text(spawn_rule_label(self.state.bot.spawn_rule))
                        .show_ui(ui, |ui| {
                            for rule in [SpawnRuleConfig::Row19Or20, SpawnRuleConfig::Row21AndFall]
                            {
                                ui.selectable_value(
                                    &mut self.state.bot.spawn_rule,
                                    rule,
                                    spawn_rule_label(rule),
                                );
                            }
                        });
                    ui.label("Planner");
                    ui.monospace("Safe spawn tap route");
                });
                ui.horizontal(|ui| {
                    ui.label("Threads");
                    ui.add(egui::DragValue::new(&mut self.state.bot.threads).range(1..=8).speed(1));
                    ui.label("Min Nodes");
                    ui.add(
                        egui::DragValue::new(&mut self.state.bot.min_nodes)
                            .range(50..=50_000)
                            .speed(50),
                    );
                    ui.label("Max Nodes");
                    ui.add(
                        egui::DragValue::new(&mut self.state.bot.max_nodes)
                            .range(100..=500_000)
                            .speed(100),
                    );
                });
            });
            ui.horizontal(|ui| {
                ui.label(format!("Status: {}", self.bot_status.label()));
                if ui
                    .add_enabled(
                        self.browser_status == BrowserStatus::Ready && !bot_locked,
                        egui::Button::new("Bot ON"),
                    )
                    .clicked()
                {
                    self.start_bot();
                }
                if ui
                    .add_enabled(bot_locked, egui::Button::new("Bot OFF"))
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

        ctx.request_repaint_after(std::time::Duration::from_millis(100));
    }
}

impl Drop for LauncherApp {
    fn drop(&mut self) {
        self.stop_bot();
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
    let state: LauncherState =
        serde_json::from_str(&raw).context("failed to parse launcher state JSON")?;
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

fn spawn_rule_label(rule: SpawnRuleConfig) -> &'static str {
    match rule {
        SpawnRuleConfig::Row19Or20 => "Row 19 or 20",
        SpawnRuleConfig::Row21AndFall => "Row 21 and fall",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_preset_uses_safe_defaults() {
        let mut state = LauncherState::default();
        state.preset = ModePreset::Solo1080p;
        state.apply_preset();

        assert_eq!(state.bot.movement_mode, MovementModeConfig::ZeroGSafe);
        assert_eq!(state.bot.spawn_rule, SpawnRuleConfig::Row19Or20);
        assert_eq!(state.target_pps, 0.0);
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
        assert!(readme.contains("TETR.IO Safe preset"));
        assert!(readme.contains("ZeroG Safe"));
        assert!(readme.contains("Hard Drop Only"));
        assert!(readme.contains("ZeroG Complete"));
        assert!(readme.contains("Open Chromium"));
        assert!(readme.contains("Bot ON"));
    }

    #[test]
    fn migrate_legacy_defaults_upgrades_previous_safe_profile() {
        let mut state = LauncherState {
            preset: ModePreset::Solo1080p,
            dry_run: false,
            poll_interval_ms: 4,
            target_pps: 0.0,
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
    fn bot_requires_ready_browser() {
        assert!(BrowserStatus::Ready == BrowserStatus::Ready);
        assert!(BrowserStatus::Closed != BrowserStatus::Ready);
    }
}
