use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::AutomationConfig;
use crate::paths::AppPaths;
use crate::scanner::{ActivePieceState, GameSnapshot, PieceToken, RotationToken};

pub type SharedLogger = Arc<Mutex<Box<dyn FnMut(String) + Send>>>;

pub fn emit_log(logger: &SharedLogger, line: impl Into<String>) {
    if let Ok(mut guard) = logger.lock() {
        (*guard)(line.into());
    }
}

pub struct ProviderProcess {
    child: Child,
    log_threads: Vec<JoinHandle<()>>,
}

impl ProviderProcess {
    pub fn start(
        paths: &AppPaths,
        config: &AutomationConfig,
        logger: SharedLogger,
    ) -> Result<Self> {
        spawn_browser_provider(paths, config, logger)
    }

    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for handle in self.log_threads.drain(..) {
            let _ = handle.join();
        }
    }
}

impl Drop for ProviderProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BrowserSnapshotWire {
    pub ok: bool,
    #[serde(default = "default_browser_source")]
    pub source: String,
    pub field: Vec<[bool; 10]>,
    pub current: PieceToken,
    #[serde(default)]
    pub hold: Option<PieceToken>,
    #[serde(default)]
    pub queue: Vec<PieceToken>,
    #[serde(default)]
    pub b2b: bool,
    #[serde(default)]
    pub combo: u32,
    #[serde(default)]
    pub incoming: u32,
    #[serde(default)]
    #[serde(alias = "pieceCounter")]
    pub piece_counter: Option<u32>,
    pub token: String,
    #[serde(default = "default_true")]
    pub playing: bool,
    #[serde(default)]
    pub countdown: bool,
    #[serde(default)]
    #[serde(alias = "activeX")]
    pub active_x: Option<i32>,
    #[serde(default)]
    #[serde(alias = "activeY")]
    pub active_y: Option<i32>,
    #[serde(default)]
    #[serde(alias = "activeRotation")]
    pub active_rotation: Option<RotationToken>,
}

impl BrowserSnapshotWire {
    pub fn into_game_snapshot(self) -> Result<Option<GameSnapshot>> {
        if !self.ok {
            return Ok(None);
        }
        let mut queue = Vec::with_capacity(self.queue.len() + 1);
        queue.push(self.current);
        queue.extend(self.queue);
        Ok(Some(GameSnapshot {
            source: self.source,
            token: self.token,
            field: self.field,
            queue,
            hold: self.hold,
            combo: self.combo,
            b2b: self.b2b,
            incoming: self.incoming,
            piece_counter: self.piece_counter,
            playing: self.playing,
            countdown: self.countdown,
            active: match (self.active_x, self.active_rotation) {
                (Some(x), Some(rotation)) => Some(ActivePieceState {
                    x,
                    y: self.active_y.unwrap_or_default(),
                    rotation,
                }),
                _ => None,
            },
        }))
    }
}

fn spawn_browser_provider(
    paths: &AppPaths,
    config: &AutomationConfig,
    logger: SharedLogger,
) -> Result<ProviderProcess> {
    let script = &paths.browser_snapshot_script_path;
    let snapshot_path = config.snapshot_path.clone();
    let mut command = Command::new(&config.browser.node_command);
    command.arg(script);
    command.args(build_browser_provider_args(config, &snapshot_path));
    command
        .current_dir(&paths.workspace_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if !config.browser.chrome_path.trim().is_empty() {
        command.env("CHROME_PATH", &config.browser.chrome_path);
    }

    let mut child = command.spawn().with_context(|| {
        format!(
            "failed to launch browser snapshot helper with {} {}",
            config.browser.node_command,
            script.display()
        )
    })?;

    let log_threads =
        take_process_logs(&mut child, "[browser] ", "[browser][err] ", logger.clone());
    wait_for_launch_health(
        &mut child,
        Duration::from_millis(config.browser.bootstrap_timeout_ms),
        &snapshot_path,
    )?;
    emit_log(
        &logger,
        format!(
            "[browser] helper running on port {} target={}",
            config.browser.cdp_port, config.browser.target_hint
        ),
    );
    Ok(ProviderProcess { child, log_threads })
}

fn build_browser_provider_args(config: &AutomationConfig, snapshot_path: &PathBuf) -> Vec<String> {
    vec![
        "--snapshot-path".to_owned(),
        snapshot_path.display().to_string(),
        "--port".to_owned(),
        config.browser.cdp_port.to_string(),
        "--url".to_owned(),
        config.browser.url.clone(),
        "--target".to_owned(),
        config.browser.target_hint.clone(),
        "--poll-ms".to_owned(),
        config.poll_interval_ms.to_string(),
        "--probe-page-state".to_owned(),
        bool_flag(config.browser.probe_page_state).to_owned(),
        "--use-ribbon-websocket".to_owned(),
        bool_flag(config.browser.use_ribbon_websocket).to_owned(),
        "--use-seed-simulation-fallback".to_owned(),
        bool_flag(config.browser.use_seed_simulation_fallback).to_owned(),
        "--connect-only".to_owned(),
        bool_flag(config.browser.connect_only).to_owned(),
        "--player-selector".to_owned(),
        selector_arg_name(config.browser.player_selector).to_owned(),
        "--player-nickname".to_owned(),
        config.browser.player_nickname.clone(),
        "--player-user-id".to_owned(),
        config.browser.player_user_id.clone(),
        "--dump-state-on-fail".to_owned(),
        bool_flag(config.browser.dump_state_on_fail).to_owned(),
        "--dump-state-path".to_owned(),
        config.browser.dump_state_path.clone(),
    ]
}

fn wait_for_launch_health(
    child: &mut Child,
    timeout: Duration,
    snapshot_path: &PathBuf,
) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if snapshot_path.exists() {
            return Ok(());
        }
        if let Some(status) = child.try_wait()? {
            anyhow::bail!("browser snapshot helper exited early with status {status}");
        }
        if Instant::now() >= deadline {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn take_process_logs(
    child: &mut Child,
    stdout_prefix: &'static str,
    stderr_prefix: &'static str,
    logger: SharedLogger,
) -> Vec<JoinHandle<()>> {
    let mut threads = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        threads.push(spawn_log_thread(stdout_prefix, stdout, logger.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        threads.push(spawn_log_thread(stderr_prefix, stderr, logger));
    }
    threads
}

fn spawn_log_thread<R>(prefix: &'static str, reader: R, logger: SharedLogger) -> JoinHandle<()>
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
                    if line.starts_with(prefix.trim_end()) {
                        emit_log(&logger, line);
                    } else {
                        emit_log(&logger, format!("{prefix}{line}"));
                    }
                }
                Err(err) => {
                    emit_log(&logger, format!("{prefix}read error: {err}"));
                    break;
                }
            }
        }
    })
}

fn bool_flag(value: bool) -> &'static str {
    if value {
        "1"
    } else {
        "0"
    }
}

fn selector_arg_name(value: crate::config::PlayerSelectorConfig) -> &'static str {
    match value {
        crate::config::PlayerSelectorConfig::Auto => "auto",
        crate::config::PlayerSelectorConfig::Left => "left",
        crate::config::PlayerSelectorConfig::Right => "right",
        crate::config::PlayerSelectorConfig::Nickname => "nickname",
        crate::config::PlayerSelectorConfig::UserId => "user_id",
    }
}

fn default_browser_source() -> String {
    "browser_cdp".to_owned()
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn browser_wire_converts_to_game_snapshot() {
        let wire = BrowserSnapshotWire {
            ok: true,
            source: "browser_cdp".to_owned(),
            field: vec![[false; 10]; 40],
            current: PieceToken::T,
            hold: Some(PieceToken::I),
            queue: vec![PieceToken::J, PieceToken::L, PieceToken::O],
            b2b: true,
            combo: 3,
            incoming: 2,
            piece_counter: Some(27),
            token: "browser-27".to_owned(),
            playing: true,
            countdown: false,
            active_x: Some(4),
            active_y: Some(19),
            active_rotation: Some(RotationToken::North),
        };

        let snapshot = wire.into_game_snapshot().unwrap().unwrap();
        assert_eq!(snapshot.source, "browser_cdp");
        assert_eq!(snapshot.token, "browser-27");
        assert_eq!(
            snapshot.queue,
            vec![PieceToken::T, PieceToken::J, PieceToken::L, PieceToken::O]
        );
        assert_eq!(snapshot.hold, Some(PieceToken::I));
        assert_eq!(snapshot.piece_counter, Some(27));
        assert_eq!(
            snapshot.active,
            Some(ActivePieceState {
                x: 4,
                y: 19,
                rotation: RotationToken::North
            })
        );
    }

    #[test]
    fn browser_provider_args_include_vs_selector_and_dump_options() {
        let mut config = AutomationConfig::default();
        config.snapshot_path = PathBuf::from("automation/live-snapshot.json");
        config.browser.player_selector = crate::config::PlayerSelectorConfig::Nickname;
        config.browser.player_nickname = "hebi_".to_owned();
        config.browser.player_user_id = "user-123".to_owned();
        config.browser.dump_state_path = "automation/debug/tetrio-state-dump.json".to_owned();

        let args = build_browser_provider_args(&config, &config.snapshot_path);
        let joined = args.join(" ");

        assert!(joined.contains("--player-selector nickname"));
        assert!(joined.contains("--player-nickname hebi_"));
        assert!(joined.contains("--player-user-id user-123"));
        assert!(joined.contains("--dump-state-on-fail 1"));
        assert!(joined.contains("--dump-state-path automation/debug/tetrio-state-dump.json"));
    }

    #[test]
    fn node_tetrio_state_tests_pass() {
        let output = Command::new("node")
            .arg("--test")
            .arg("browser-source/tetrio-state.test.mjs")
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .expect("failed to run node tests");

        assert!(
            output.status.success(),
            "node tests failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
