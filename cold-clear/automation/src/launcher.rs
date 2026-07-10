use std::fs;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result};
use eframe::egui;
use serde::{Deserialize, Serialize};

use crate::config::{
    AutomationConfig, BotConfig, BrowserCdpConfig, BufferModeConfig, HandlingConfig, KeyBindings,
    MovementModeConfig, PlayerSelectorConfig, SnapshotProviderConfig, SoftDropModeConfig,
    SpawnRuleConfig,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
struct LauncherState {
    preset: ModePreset,
    snapshot_path: String,
    snapshot_provider: SnapshotProviderConfig,
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
    bot: BotConfig,
    handling: HandlingConfig,
    keys: KeyBindings,
}

impl Default for LauncherState {
    fn default() -> Self {
        Self {
            preset: ModePreset::VsLeft1080p,
            snapshot_path: "automation/live-snapshot.json".to_owned(),
            snapshot_provider: SnapshotProviderConfig::BrowserCdp,
            browser: BrowserCdpConfig::default(),
            always_on_top: false,
            dry_run: true,
            poll_interval_ms: 2,
            target_pps: 0.0,
            tap_duration_ms: 60,
            movement_tap_duration_ms: 12,
            rotate_tap_duration_ms: 14,
            hold_tap_duration_ms: 16,
            hard_drop_tap_duration_ms: 16,
            soft_drop_tap_duration_ms: 12,
            movement_interval_ms: 0,
            rotation_interval_ms: 0,
            piece_interval_ms: 0,
            hard_drop_interval_ms: 0,
            min_snapshot_age_ms: 0,
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
        self.snapshot_provider = SnapshotProviderConfig::BrowserCdp;
        self.target_pps = 0.0;
        self.tap_duration_ms = 60;
        self.poll_interval_ms = 2;
        self.movement_tap_duration_ms = 12;
        self.rotate_tap_duration_ms = 14;
        self.hold_tap_duration_ms = 16;
        self.hard_drop_tap_duration_ms = 16;
        self.soft_drop_tap_duration_ms = 12;
        self.movement_interval_ms = 0;
        self.rotation_interval_ms = 0;
        self.piece_interval_ms = 0;
        self.hard_drop_interval_ms = 0;
        self.min_snapshot_age_ms = 0;
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
        if self.preset == ModePreset::Custom {
            return;
        }
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
                || self.matches_third_safe_preset_family()
                || self.matches_fourth_safe_preset_family()
                || self.matches_fifth_safe_preset_family())
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

    fn matches_fourth_safe_preset_family(&self) -> bool {
        self.poll_interval_ms == 4
            && self.movement_tap_duration_ms == 16
            && self.rotate_tap_duration_ms == 18
            && self.hold_tap_duration_ms == 20
            && self.hard_drop_tap_duration_ms == 20
            && self.soft_drop_tap_duration_ms == 16
            && self.movement_interval_ms == 0
            && self.rotation_interval_ms == 0
            && self.piece_interval_ms == 0
            && self.hard_drop_interval_ms == 0
            && self.min_snapshot_age_ms == 0
            && self.handling.action_settle_ms == 0
            && !self.handling.release_after_each_action
    }

    fn matches_fifth_safe_preset_family(&self) -> bool {
        self.poll_interval_ms == 2
            && self.movement_tap_duration_ms == 12
            && self.rotate_tap_duration_ms == 14
            && self.hold_tap_duration_ms == 16
            && self.hard_drop_tap_duration_ms == 16
            && self.soft_drop_tap_duration_ms == 12
            && self.movement_interval_ms == 0
            && self.rotation_interval_ms == 0
            && self.piece_interval_ms == 0
            && self.hard_drop_interval_ms == 0
            && self.min_snapshot_age_ms == 0
            && self.handling.action_settle_ms == 0
            && !self.handling.release_after_each_action
    }

    fn to_automation_config(&self, paths: &AppPaths) -> AutomationConfig {
        AutomationConfig {
            snapshot_path: paths.resolve_workspace_path(&self.snapshot_path),
            snapshot_provider: self.snapshot_provider,
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
            input_backend: crate::config::InputBackendConfig::BrowserCdp,
            browser: self.browser.clone(),
            bot: self.bot.clone(),
            handling: self.handling.clone(),
            keys: self.keys.clone(),
        }
    }
}

enum LauncherEvent {
    Log(String),
    AutomationExited(Result<(), String>),
}

struct RunningSession {
    stop: Arc<AtomicBool>,
    live_target_pps: Arc<AtomicU32>,
    automation_thread: Option<JoinHandle<()>>,
}

impl RunningSession {
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
    status: String,
    event_rx: Option<Receiver<LauncherEvent>>,
    running: Option<RunningSession>,
}

impl LauncherApp {
    pub fn new(paths: AppPaths) -> Self {
        let mut state = load_launcher_state(&paths).unwrap_or_default();
        state.migrate_legacy_defaults();
        Self {
            paths,
            state,
            logs: vec!["Launcher ready".to_owned()],
            status: "Idle".to_owned(),
            event_rx: None,
            running: None,
        }
    }

    fn push_log(&mut self, line: impl Into<String>) {
        let line = line.into();
        if line.contains("[automation] idle waiting for next live game") {
            self.status = "Waiting".to_owned();
        } else if line.contains("[automation] live game resumed")
            || line.contains("[automation] source=")
        {
            self.status = "Running".to_owned();
        }
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

    fn start(&mut self) {
        if self.running.is_some() {
            return;
        }

        self.save_state();
        self.clear_snapshot_file();

        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let live_target_pps = Arc::new(AtomicU32::new(self.state.target_pps.to_bits()));

        let config = self.state.to_automation_config(&self.paths);
        let paths = self.paths.clone();
        let worker_stop = stop.clone();
        let worker_target_pps = live_target_pps.clone();
        let worker_tx = tx.clone();
        let worker_log_tx = worker_tx.clone();
        let automation_thread = thread::spawn(move || {
            let result = run_automation(
                paths,
                config,
                worker_target_pps,
                &worker_stop,
                move |line| {
                    let _ = worker_log_tx.send(LauncherEvent::Log(line));
                },
            )
            .map_err(|err| format!("{err:#}"));
            let _ = worker_tx.send(LauncherEvent::AutomationExited(result));
        });

        self.push_log("[launcher] session started");
        self.status = "Running".to_owned();
        self.event_rx = Some(rx);
        self.running = Some(RunningSession {
            stop,
            live_target_pps,
            automation_thread: Some(automation_thread),
        });
    }

    fn sync_live_target_pps(&mut self) {
        let Some(running) = self.running.as_ref() else {
            return;
        };
        running
            .live_target_pps
            .store(self.state.target_pps.to_bits(), Ordering::Relaxed);
        self.push_log(format!(
            "[launcher] live target PPS updated to {:.2}",
            self.state.target_pps
        ));
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

    fn stop(&mut self) {
        if let Some(mut running) = self.running.take() {
            running.stop();
            if let Err(err) = self.release_all_keys_now() {
                self.push_log(format!(
                    "[launcher] failed to release keys on stop: {err:#}"
                ));
            } else {
                self.push_log("[launcher] released keys on stop");
            }
            self.push_log("[launcher] session stopped");
        }
        self.event_rx = None;
        self.status = "Idle".to_owned();
    }

    fn release_all_keys_now(&self) -> Result<()> {
        if self.state.dry_run {
            return Ok(());
        }
        let config = self.state.to_automation_config(&self.paths);
        let mut backend = create_input_backend(&self.paths, &config, None)?;
        backend.release_all_keys()
    }

    fn poll_events(&mut self) {
        let mut should_stop = false;
        let mut events = Vec::new();
        if let Some(rx) = &self.event_rx {
            while let Ok(event) = rx.try_recv() {
                events.push(event);
            }
        }
        for event in events {
            match event {
                LauncherEvent::Log(line) => self.push_log(line),
                LauncherEvent::AutomationExited(result) => {
                    match result {
                        Ok(()) => self.push_log("[launcher] automation exited cleanly"),
                        Err(err) => self.push_log(format!("[launcher] automation failed: {err}")),
                    }
                    should_stop = true;
                }
            }
        }
        if should_stop {
            self.stop();
        }
    }
}

impl eframe::App for LauncherApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_events();
        ctx.send_viewport_cmd(egui::ViewportCommand::WindowLevel(window_level(
            self.state.always_on_top,
        )));
        let mut target_pps_changed = false;

        egui::TopBottomPanel::top("top_bar").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading("Cold Clear Launcher");
                ui.separator();
                ui.label(format!("Status: {}", self.status));
            });
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label("Mode");
                let old_preset = self.state.preset;
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
                if self.state.preset != old_preset {
                    self.state.apply_preset();
                }
            });

            ui.horizontal(|ui| {
                ui.label("Provider");
                egui::ComboBox::from_id_salt("snapshot_provider")
                    .selected_text(snapshot_provider_label(self.state.snapshot_provider))
                    .show_ui(ui, |ui| {
                        for provider in [
                            SnapshotProviderConfig::BrowserCdp,
                            SnapshotProviderConfig::WebsocketSeed,
                            SnapshotProviderConfig::File,
                        ] {
                            ui.selectable_value(
                                &mut self.state.snapshot_provider,
                                provider,
                                snapshot_provider_label(provider),
                            );
                        }
                    });
            });
            ui.horizontal(|ui| {
                ui.label("Snapshot");
                ui.text_edit_singleline(&mut self.state.snapshot_path);
            });
            match self.state.snapshot_provider {
                SnapshotProviderConfig::BrowserCdp => {
                    ui.label("Browser CDP direct mode. The snapshot file is only internal transport between helper and runner.");
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
                        ui.checkbox(&mut self.state.browser.connect_only, "Connect only");
                    });
                    ui.horizontal(|ui| {
                        ui.label("Player");
                        egui::ComboBox::from_id_salt("player_selector")
                            .selected_text(player_selector_label(self.state.browser.player_selector))
                            .show_ui(ui, |ui| {
                                for selector in [
                                    PlayerSelectorConfig::Auto,
                                    PlayerSelectorConfig::Left,
                                    PlayerSelectorConfig::Right,
                                    PlayerSelectorConfig::Nickname,
                                    PlayerSelectorConfig::UserId,
                                ] {
                                    ui.selectable_value(
                                        &mut self.state.browser.player_selector,
                                        selector,
                                        player_selector_label(selector),
                                    );
                                }
                            });
                        ui.label("Nickname");
                        ui.text_edit_singleline(&mut self.state.browser.player_nickname);
                    });
                    ui.horizontal(|ui| {
                        ui.label("User ID");
                        ui.text_edit_singleline(&mut self.state.browser.player_user_id);
                        ui.checkbox(
                            &mut self.state.browser.dump_state_on_fail,
                            "Dump state on fail",
                        );
                    });
                    ui.horizontal(|ui| {
                        ui.label("Dump Path");
                        ui.text_edit_singleline(&mut self.state.browser.dump_state_path);
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
                    });
                }
                SnapshotProviderConfig::WebsocketSeed => {
                    let snapshot_status = load_websocket_seed_status(
                        &self.paths.resolve_workspace_path(&self.state.snapshot_path),
                    );
                    ui.label("WebSocket seed provider for VS room experiments. It captures seed/options and reconstructs only current/queue.");
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
                        ui.checkbox(&mut self.state.browser.connect_only, "Connect only");
                    });
                    ui.horizontal(|ui| {
                        ui.label("Seed captured");
                        ui.monospace(if snapshot_status
                            .as_ref()
                            .map(|status| status.seed_captured)
                            .unwrap_or(false)
                        {
                            "yes"
                        } else {
                            "no"
                        });
                        ui.label("Bagtype");
                        ui.monospace(
                            snapshot_status
                                .as_ref()
                                .map(|status| {
                                    if status.bagtype.is_empty() {
                                        "-".to_owned()
                                    } else {
                                        status.bagtype.clone()
                                    }
                                })
                                .unwrap_or_else(|| "-".to_owned()),
                        );
                        ui.label("PieceIndex");
                        ui.monospace(
                            snapshot_status
                                .as_ref()
                                .and_then(|status| status.piece_index)
                                .map(|value| value.to_string())
                                .unwrap_or_else(|| "-".to_owned()),
                        );
                    });
                }
                SnapshotProviderConfig::File => {
                    ui.label("File provider reads the snapshot path as-is and does not launch a browser helper.");
                }
            }
            ui.horizontal(|ui| {
                ui.checkbox(&mut self.state.always_on_top, "Always on top");
            });

            ui.separator();
            ui.heading("Runtime");
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
                ui.add(egui::DragValue::new(&mut self.state.handling.action_settle_ms).speed(1));
            });
            ui.horizontal(|ui| {
                ui.label("Poll");
                ui.add(egui::DragValue::new(&mut self.state.poll_interval_ms).speed(1));
                ui.label("Target PPS");
                target_pps_changed |= ui
                    .add(
                    egui::DragValue::new(&mut self.state.target_pps)
                        .speed(0.05)
                        .range(0.0..=20.0),
                )
                    .changed();
                ui.small("0 = unlimited");
            });
            ui.horizontal(|ui| {
                ui.label("Move Tap");
                ui.add(egui::DragValue::new(&mut self.state.movement_tap_duration_ms).speed(1));
                ui.label("Rotate Tap");
                ui.add(egui::DragValue::new(&mut self.state.rotate_tap_duration_ms).speed(1));
            });
            ui.horizontal(|ui| {
                ui.label("HardDrop Tap");
                ui.add(egui::DragValue::new(&mut self.state.hard_drop_tap_duration_ms).speed(1));
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
                        for rule in [SpawnRuleConfig::Row19Or20, SpawnRuleConfig::Row21AndFall] {
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

            ui.separator();
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(self.running.is_none(), egui::Button::new("Start"))
                    .clicked()
                {
                    self.start();
                }
                if ui
                    .add_enabled(self.running.is_some(), egui::Button::new("Stop"))
                    .clicked()
                {
                    self.stop();
                }
                if ui.button("Save Settings").clicked() {
                    self.save_state();
                }
            });

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

        if target_pps_changed {
            self.sync_live_target_pps();
        }

        ctx.request_repaint_after(std::time::Duration::from_millis(100));
    }
}

impl Drop for LauncherApp {
    fn drop(&mut self) {
        self.stop();
        let _ = save_launcher_state(&self.paths, &self.state);
    }
}

#[derive(Clone, Debug, Deserialize)]
struct WebsocketSeedSnapshotStatus {
    #[serde(default)]
    source: String,
    #[serde(default, rename = "seedCaptured")]
    seed_captured: bool,
    #[serde(default)]
    bagtype: String,
    #[serde(default, rename = "pieceIndex")]
    piece_index: Option<u32>,
}

fn load_websocket_seed_status(
    snapshot_path: &std::path::Path,
) -> Option<WebsocketSeedSnapshotStatus> {
    let raw = fs::read_to_string(snapshot_path).ok()?;
    let parsed: WebsocketSeedSnapshotStatus = serde_json::from_str(&raw).ok()?;
    if parsed.source != "websocket_seed" {
        return None;
    }
    Some(parsed)
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

fn snapshot_provider_label(provider: SnapshotProviderConfig) -> &'static str {
    match provider {
        SnapshotProviderConfig::BrowserCdp => "Browser CDP Direct",
        SnapshotProviderConfig::WebsocketSeed => "WebSocket Seed",
        SnapshotProviderConfig::File => "File",
    }
}

fn player_selector_label(selector: PlayerSelectorConfig) -> &'static str {
    match selector {
        PlayerSelectorConfig::Auto => "Auto",
        PlayerSelectorConfig::Left => "Left",
        PlayerSelectorConfig::Right => "Right",
        PlayerSelectorConfig::Nickname => "Nickname",
        PlayerSelectorConfig::UserId => "User ID",
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

        assert_eq!(state.snapshot_provider, SnapshotProviderConfig::BrowserCdp);
        assert_eq!(state.bot.movement_mode, MovementModeConfig::ZeroGSafe);
        assert_eq!(state.bot.spawn_rule, SpawnRuleConfig::Row19Or20);
        assert_eq!(state.target_pps, 0.0);
        assert_eq!(state.tap_duration_ms, 60);
        assert_eq!(state.poll_interval_ms, 2);
        assert_eq!(state.movement_tap_duration_ms, 12);
        assert_eq!(state.rotate_tap_duration_ms, 14);
        assert_eq!(state.hold_tap_duration_ms, 16);
        assert_eq!(state.hard_drop_tap_duration_ms, 16);
        assert_eq!(state.soft_drop_tap_duration_ms, 12);
        assert_eq!(state.movement_interval_ms, 0);
        assert_eq!(state.rotation_interval_ms, 0);
        assert_eq!(state.piece_interval_ms, 0);
        assert_eq!(state.hard_drop_interval_ms, 0);
        assert_eq!(state.min_snapshot_age_ms, 0);
        assert_eq!(state.bot.threads, 4);
        assert_eq!(state.bot.min_nodes, 4_000);
        assert_eq!(state.bot.max_nodes, 400_000);
        assert_eq!(state.browser.player_selector, PlayerSelectorConfig::Auto);
        assert!(state.browser.player_nickname.is_empty());
        assert!(state.browser.player_user_id.is_empty());
        assert!(state.browser.dump_state_on_fail);
        assert_eq!(
            state.browser.dump_state_path,
            "automation/debug/tetrio-state-dump.json"
        );
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
        assert!(readme.contains("Advanced/Experimental"));
        assert!(readme.contains("VS room"));
        assert!(readme.contains("\"player_selector\": \"auto\""));
        assert!(readme.contains("WebSocket Seed"));
    }

    #[test]
    fn migrate_legacy_defaults_upgrades_previous_safe_profile() {
        let mut state = LauncherState {
            preset: ModePreset::Solo1080p,
            dry_run: false,
            poll_interval_ms: 4,
            target_pps: 0.0,
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
            handling: HandlingConfig {
                release_after_each_action: false,
                action_settle_ms: 0,
                ..HandlingConfig::default()
            },
            ..LauncherState::default()
        };

        state.migrate_legacy_defaults();

        assert_eq!(state.poll_interval_ms, 2);
        assert_eq!(state.movement_tap_duration_ms, 12);
        assert_eq!(state.rotate_tap_duration_ms, 14);
        assert_eq!(state.hold_tap_duration_ms, 16);
        assert_eq!(state.hard_drop_tap_duration_ms, 16);
        assert_eq!(state.movement_interval_ms, 0);
        assert_eq!(state.rotation_interval_ms, 0);
        assert_eq!(state.piece_interval_ms, 0);
        assert_eq!(state.hard_drop_interval_ms, 0);
        assert_eq!(state.min_snapshot_age_ms, 0);
        assert_eq!(state.bot.threads, 4);
        assert_eq!(state.bot.min_nodes, 4_000);
        assert_eq!(state.bot.max_nodes, 400_000);
        assert_eq!(state.handling.action_settle_ms, 0);
        assert!(!state.handling.release_after_each_action);
    }
}
