use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result};
use eframe::egui;
use serde::{Deserialize, Serialize};

use crate::config::{
    AutomationConfig, BotConfig, BufferModeConfig, HandlingConfig, KeyBindings,
    MovementModeConfig, SoftDropModeConfig, SpawnRuleConfig,
};
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
    scanner_config_path: String,
    snapshot_path: String,
    python_command: String,
    launch_scanner: bool,
    always_on_top: bool,
    dry_run: bool,
    poll_interval_ms: u64,
    tap_duration_ms: u64,
    settle_delay_ms: u64,
    bot: BotConfig,
    handling: HandlingConfig,
    keys: KeyBindings,
}

impl Default for LauncherState {
    fn default() -> Self {
        Self {
            preset: ModePreset::VsLeft1080p,
            scanner_config_path: "automation/scan-config.vs-left-1080p.json".to_owned(),
            snapshot_path: "automation/live-snapshot.json".to_owned(),
            python_command: "python".to_owned(),
            launch_scanner: true,
            always_on_top: false,
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
    fn apply_preset(&mut self) {
        self.scanner_config_path = match self.preset {
            ModePreset::VsLeft1080p => "automation/scan-config.vs-left-1080p.json",
            ModePreset::Solo1080p => "automation/scan-config.solo-1080p.json",
            ModePreset::Custom => return,
        }
        .to_owned();
        self.snapshot_path = "automation/live-snapshot.json".to_owned();
        self.bot.movement_mode = MovementModeConfig::ZeroGComplete;
    }

    fn migrate_legacy_defaults(&mut self) {
        if self.preset != ModePreset::Custom
            && self.bot.movement_mode == MovementModeConfig::TwentyG
        {
            self.bot.movement_mode = MovementModeConfig::ZeroGComplete;
        }
        if self.tap_duration_ms == 24 {
            self.tap_duration_ms = 8;
        }
        if self.settle_delay_ms == 10 {
            self.settle_delay_ms = 2;
        }
    }

    fn to_automation_config(&self, paths: &AppPaths) -> AutomationConfig {
        AutomationConfig {
            snapshot_path: paths.resolve_workspace_path(&self.snapshot_path),
            dry_run: self.dry_run,
            poll_interval_ms: self.poll_interval_ms,
            tap_duration_ms: self.tap_duration_ms,
            settle_delay_ms: self.settle_delay_ms,
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
    automation_thread: Option<JoinHandle<()>>,
    scanner_child: Option<Child>,
    scanner_log_threads: Vec<JoinHandle<()>>,
}

impl RunningSession {
    fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(child) = self.scanner_child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(thread) = self.automation_thread.take() {
            let _ = thread.join();
        }
        for handle in self.scanner_log_threads.drain(..) {
            let _ = handle.join();
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
        if state.scanner_config_path.is_empty() {
            state.apply_preset();
        }
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
        self.logs.push(line.into());
        if self.logs.len() > 400 {
            let drain = self.logs.len() - 400;
            self.logs.drain(0..drain);
        }
    }

    fn save_state(&mut self) {
        if let Err(err) = save_launcher_state(&self.paths, &self.state) {
            self.push_log(format!("[launcher] failed to save launcher state: {err:#}"));
        } else {
            self.push_log(format!(
                "[launcher] saved settings to {}",
                self.paths.display_workspace_relative(&self.paths.launcher_state_path)
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
        let mut scanner_child = None;
        let mut scanner_log_threads = Vec::new();

        if self.state.launch_scanner {
            match spawn_scanner_process(&self.paths, &self.state, &tx) {
                Ok((child, threads)) => {
                    scanner_child = Some(child);
                    scanner_log_threads = threads;
                }
                Err(err) => {
                    self.push_log(format!("[launcher] scanner launch failed: {err:#}"));
                    self.status = "Scanner launch failed".to_owned();
                    return;
                }
            }
        }

        let config = self.state.to_automation_config(&self.paths);
        let worker_stop = stop.clone();
        let worker_tx = tx.clone();
        let automation_thread = thread::spawn(move || {
            let result = run_automation(config, &worker_stop, |line| {
                let _ = worker_tx.send(LauncherEvent::Log(line));
            })
            .map_err(|err| format!("{err:#}"));
            let _ = worker_tx.send(LauncherEvent::AutomationExited(result));
        });

        self.push_log("[launcher] session started");
        self.status = "Running".to_owned();
        self.event_rx = Some(rx);
        self.running = Some(RunningSession {
            stop,
            automation_thread: Some(automation_thread),
            scanner_child,
            scanner_log_threads,
        });
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
            self.push_log("[launcher] session stopped");
        }
        self.event_rx = None;
        self.status = "Idle".to_owned();
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
                ui.label("Scanner Config");
                ui.text_edit_singleline(&mut self.state.scanner_config_path);
            });
            ui.horizontal(|ui| {
                ui.label("Snapshot Path");
                ui.text_edit_singleline(&mut self.state.snapshot_path);
            });
            ui.horizontal(|ui| {
                ui.checkbox(&mut self.state.launch_scanner, "Launch scanner process");
                ui.label("Python");
                ui.text_edit_singleline(&mut self.state.python_command);
            });
            ui.horizontal(|ui| {
                ui.checkbox(&mut self.state.always_on_top, "Always on top");
            });

            ui.separator();
            ui.heading("Runtime");
            ui.horizontal(|ui| {
                ui.checkbox(&mut self.state.dry_run, "Dry run");
                ui.checkbox(&mut self.state.bot.use_hold, "Use hold");
                ui.checkbox(&mut self.state.bot.speculate, "Speculate");
            });
            ui.horizontal(|ui| {
                ui.label("Poll");
                ui.add(egui::DragValue::new(&mut self.state.poll_interval_ms).speed(1));
                ui.label("Tap");
                ui.add(egui::DragValue::new(&mut self.state.tap_duration_ms).speed(1));
                ui.label("Settle");
                ui.add(egui::DragValue::new(&mut self.state.settle_delay_ms).speed(1));
            });
            ui.horizontal(|ui| {
                ui.label("Threads");
                ui.add(egui::DragValue::new(&mut self.state.bot.threads).range(1..=64));
                ui.label("Min nodes");
                ui.add(egui::DragValue::new(&mut self.state.bot.min_nodes).speed(1000));
                ui.label("Max nodes");
                ui.add(egui::DragValue::new(&mut self.state.bot.max_nodes).speed(10000));
            });
            ui.horizontal(|ui| {
                ui.label("Movement");
                egui::ComboBox::from_id_salt("movement_mode")
                    .selected_text(movement_mode_label(self.state.bot.movement_mode))
                    .show_ui(ui, |ui| {
                        for mode in [
                            MovementModeConfig::TwentyG,
                            MovementModeConfig::ZeroG,
                            MovementModeConfig::ZeroGComplete,
                            MovementModeConfig::HardDropOnly,
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
            });

            ui.separator();
            ui.heading("Handling");
            ui.horizontal(|ui| {
                ui.label("ARR");
                ui.add(egui::DragValue::new(&mut self.state.handling.arr_ms).speed(1));
                ui.label("DAS");
                ui.add(egui::DragValue::new(&mut self.state.handling.das_ms).speed(1));
                ui.label("DCD");
                ui.add(egui::DragValue::new(&mut self.state.handling.dcd_ms).speed(1));
            });
            ui.horizontal(|ui| {
                ui.label("SDF");
                egui::ComboBox::from_id_salt("soft_drop_mode")
                    .selected_text(soft_drop_mode_label(self.state.handling.soft_drop_mode))
                    .show_ui(ui, |ui| {
                        for mode in [SoftDropModeConfig::Infinite, SoftDropModeConfig::Step] {
                            ui.selectable_value(
                                &mut self.state.handling.soft_drop_mode,
                                mode,
                                soft_drop_mode_label(mode),
                            );
                        }
                    });
                ui.label("Factor");
                ui.add(
                    egui::DragValue::new(&mut self.state.handling.soft_drop_factor).range(1..=999),
                );
            });
            ui.horizontal(|ui| {
                ui.checkbox(
                    &mut self.state.handling.prevent_accidental_hard_drops,
                    "Prevent accidental hard drops",
                );
                ui.checkbox(
                    &mut self.state.handling.cancel_das_on_direction_change,
                    "Cancel DAS on direction change",
                );
                ui.checkbox(
                    &mut self.state.handling.prefer_soft_drop_over_movement,
                    "Prefer soft drop over movement",
                );
            });
            ui.horizontal(|ui| {
                ui.label("IRS");
                egui::ComboBox::from_id_salt("irs_mode")
                    .selected_text(buffer_mode_label(self.state.handling.irs_mode))
                    .show_ui(ui, |ui| {
                        for mode in [BufferModeConfig::Off, BufferModeConfig::Hold, BufferModeConfig::Tap] {
                            ui.selectable_value(
                                &mut self.state.handling.irs_mode,
                                mode,
                                buffer_mode_label(mode),
                            );
                        }
                    });
                ui.label("IHS");
                egui::ComboBox::from_id_salt("ihs_mode")
                    .selected_text(buffer_mode_label(self.state.handling.ihs_mode))
                    .show_ui(ui, |ui| {
                        for mode in [BufferModeConfig::Off, BufferModeConfig::Hold, BufferModeConfig::Tap] {
                            ui.selectable_value(
                                &mut self.state.handling.ihs_mode,
                                mode,
                                buffer_mode_label(mode),
                            );
                        }
                    });
            });

            ui.separator();
            ui.heading("Keys");
            ui.horizontal(|ui| {
                ui.label("Left");
                ui.text_edit_singleline(&mut self.state.keys.left);
                ui.label("Right");
                ui.text_edit_singleline(&mut self.state.keys.right);
                ui.label("Soft");
                ui.text_edit_singleline(&mut self.state.keys.soft_drop);
            });
            ui.horizontal(|ui| {
                ui.label("CW");
                ui.text_edit_singleline(&mut self.state.keys.rotate_cw);
                ui.label("CCW");
                ui.text_edit_singleline(&mut self.state.keys.rotate_ccw);
                ui.label("Hold");
                ui.text_edit_singleline(&mut self.state.keys.hold);
                ui.label("Hard");
                ui.text_edit_singleline(&mut self.state.keys.hard_drop);
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

        ctx.request_repaint_after(std::time::Duration::from_millis(100));
    }
}

impl Drop for LauncherApp {
    fn drop(&mut self) {
        self.stop();
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
        MovementModeConfig::ZeroGComplete => "ZeroG Complete",
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

fn soft_drop_mode_label(mode: SoftDropModeConfig) -> &'static str {
    match mode {
        SoftDropModeConfig::Infinite => "Infinite",
        SoftDropModeConfig::Step => "Step",
    }
}

fn buffer_mode_label(mode: BufferModeConfig) -> &'static str {
    match mode {
        BufferModeConfig::Off => "Off",
        BufferModeConfig::Hold => "Hold",
        BufferModeConfig::Tap => "Tap",
    }
}

fn spawn_scanner_process(
    paths: &AppPaths,
    state: &LauncherState,
    tx: &Sender<LauncherEvent>,
) -> Result<(Child, Vec<JoinHandle<()>>)> {
    let script = &paths.scanner_script_path;
    let scanner_config = paths.resolve_workspace_path(&state.scanner_config_path);
    let mut child = Command::new(&state.python_command)
        .arg(script)
        .arg(&scanner_config)
        .current_dir(&paths.workspace_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!(
                "failed to launch scanner with {} {}",
                state.python_command,
                script.display()
            )
        })?;

    let mut log_threads = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        log_threads.push(spawn_log_thread("[scanner] ", stdout, tx.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        log_threads.push(spawn_log_thread("[scanner][err] ", stderr, tx.clone()));
    }
    tx.send(LauncherEvent::Log(format!(
        "[launcher] scanner launched with {}",
        scanner_config.display()
    )))
    .ok();
    Ok((child, log_threads))
}

fn spawn_log_thread<R>(prefix: &'static str, reader: R, tx: Sender<LauncherEvent>) -> JoinHandle<()>
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buffer)
                        .trim_end_matches(['\r', '\n'])
                        .to_string();
                    let _ = tx.send(LauncherEvent::Log(format!("{prefix}{line}")));
                }
                Err(err) => {
                    let _ = tx.send(LauncherEvent::Log(format!("{prefix}read error: {err}")));
                    break;
                }
            }
        }
    })
}
