use std::io::Write;
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{AutomationConfig, BrowserCdpConfig, SnapshotProviderConfig};
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
    exited: bool,
}

pub struct ChromiumHostProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    log_threads: Vec<JoinHandle<()>>,
    exited: bool,
}

impl ProviderProcess {
    pub fn start(
        paths: &AppPaths,
        config: &AutomationConfig,
        logger: SharedLogger,
    ) -> Result<Option<Self>> {
        match config.snapshot_provider {
            SnapshotProviderConfig::File => Ok(None),
            SnapshotProviderConfig::Scanner => {
                let process = spawn_scanner_provider(paths, config, logger)?;
                Ok(Some(process))
            }
            SnapshotProviderConfig::BrowserCdp => {
                match spawn_browser_provider(paths, config, logger.clone(), true) {
                    Ok(process) => Ok(Some(process)),
                    Err(err) => {
                        emit_log(
                        &logger,
                        format!(
                            "[browser] provider launch failed: {err:#}; falling back to screen scanner"
                        ),
                    );
                        let process = spawn_scanner_provider(paths, config, logger)?;
                        Ok(Some(process))
                    }
                }
            }
        }
    }

    pub fn stop(&mut self) {
        if self.exited {
            return;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.exited = true;
        for handle in self.log_threads.drain(..) {
            let _ = handle.join();
        }
    }

    pub fn start_prewarmed(
        paths: &AppPaths,
        config: &AutomationConfig,
        logger: SharedLogger,
    ) -> Result<Self> {
        spawn_browser_provider(paths, config, logger, false)
    }

    pub fn is_running(&mut self) -> Result<bool> {
        if self.exited {
            return Ok(false);
        }
        if self.child.try_wait()?.is_some() {
            self.exited = true;
            for handle in self.log_threads.drain(..) {
                let _ = handle.join();
            }
            return Ok(false);
        }
        Ok(true)
    }
}

impl ChromiumHostProcess {
    pub fn start(
        paths: &AppPaths,
        config: &BrowserCdpConfig,
        logger: SharedLogger,
    ) -> Result<Self> {
        let script = &paths.browser_host_script_path;
        let mut command = Command::new(&config.node_command);
        command
            .arg(script)
            .arg("--port")
            .arg(config.cdp_port.to_string())
            .arg("--url")
            .arg(&config.url)
            .arg("--target")
            .arg(&config.target_hint)
            .current_dir(&paths.workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if !config.chrome_path.trim().is_empty() {
            command.arg("--chrome-path").arg(&config.chrome_path);
            command.env("CHROME_PATH", &config.chrome_path);
        }

        let mut child = command.spawn().with_context(|| {
            format!(
                "failed to launch browser host helper with {} {}",
                config.node_command,
                script.display()
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .context("browser host helper stdin was not available")?;
        let log_threads = take_process_logs(
            &mut child,
            "[browser-host] ",
            "[browser-host][err] ",
            logger,
        );
        wait_for_cdp_health(
            &mut child,
            Duration::from_millis(config.bootstrap_timeout_ms.max(1000)),
            config.cdp_port,
        )?;

        Ok(Self {
            child,
            stdin: Some(stdin),
            log_threads,
            exited: false,
        })
    }

    pub fn is_running(&mut self) -> Result<bool> {
        if self.exited {
            return Ok(false);
        }
        if self.child.try_wait()?.is_some() {
            self.exited = true;
            self.join_logs();
            return Ok(false);
        }
        Ok(true)
    }

    pub fn shutdown(&mut self) -> Result<()> {
        if self.exited {
            return Ok(());
        }

        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(br#"{"type":"shutdown"}"#);
            let _ = stdin.write_all(b"\n");
            let _ = stdin.flush();
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if self.child.try_wait()?.is_some() {
                self.exited = true;
                self.join_logs();
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }

        let _ = self.child.kill();
        let _ = self.child.wait();
        self.exited = true;
        self.join_logs();
        Ok(())
    }

    fn join_logs(&mut self) {
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

impl Drop for ChromiumHostProcess {
    fn drop(&mut self) {
        let _ = self.shutdown();
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
    pub piece_counter: u32,
    #[serde(default)]
    #[serde(alias = "linesCleared")]
    #[serde(alias = "lines")]
    pub lines_cleared: Option<u32>,
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
            piece_counter: Some(self.piece_counter),
            lines_cleared: self.lines_cleared,
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

#[cfg_attr(not(test), allow(dead_code))]
pub fn provider_should_fallback(
    provider: SnapshotProviderConfig,
    browser_launch_failed: bool,
) -> bool {
    provider == SnapshotProviderConfig::BrowserCdp && browser_launch_failed
}

fn spawn_browser_provider(
    paths: &AppPaths,
    config: &AutomationConfig,
    logger: SharedLogger,
    wait_for_snapshot: bool,
) -> Result<ProviderProcess> {
    let script = &paths.browser_snapshot_script_path;
    let snapshot_path = config.snapshot_path.clone();
    let mut command = Command::new(&config.browser.node_command);
    command
        .arg(script)
        .arg("--snapshot-path")
        .arg(&snapshot_path)
        .arg("--port")
        .arg(config.browser.cdp_port.to_string())
        .arg("--url")
        .arg(&config.browser.url)
        .arg("--target")
        .arg(&config.browser.target_hint)
        .arg("--poll-ms")
        .arg(config.poll_interval_ms.to_string())
        .arg("--probe-page-state")
        .arg(bool_flag(config.browser.probe_page_state))
        .arg("--use-ribbon-websocket")
        .arg(bool_flag(config.browser.use_ribbon_websocket))
        .arg("--use-seed-simulation-fallback")
        .arg(bool_flag(config.browser.use_seed_simulation_fallback))
        .arg("--connect-only")
        .arg(bool_flag(config.browser.connect_only))
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
    let stdout = child
        .stdout
        .take()
        .context("browser snapshot helper stdout was not available")?;
    let mut stdout_reader = BufReader::new(stdout);
    wait_for_helper_ready(
        &mut child,
        &mut stdout_reader,
        Duration::from_millis(config.browser.bootstrap_timeout_ms.max(300)),
        "browser snapshot helper",
    )?;
    let mut log_threads = vec![spawn_log_reader_thread(
        "[browser] ",
        stdout_reader,
        logger.clone(),
    )];
    if let Some(stderr) = child.stderr.take() {
        log_threads.push(spawn_log_thread("[browser][err] ", stderr, logger.clone()));
    }
    if wait_for_snapshot {
        wait_for_launch_health(
            &mut child,
            Duration::from_millis(config.browser.bootstrap_timeout_ms),
            &snapshot_path,
        )?;
    }
    emit_log(
        &logger,
        format!(
            "[browser] helper running target={} connect_only={}",
            config.browser.target_hint, config.browser.connect_only
        ),
    );
    Ok(ProviderProcess {
        child,
        log_threads,
        exited: false,
    })
}

fn spawn_scanner_provider(
    paths: &AppPaths,
    config: &AutomationConfig,
    logger: SharedLogger,
) -> Result<ProviderProcess> {
    let script = &paths.scanner_script_path;
    let scanner_config = paths.resolve_workspace_path(&config.scanner.config_path);
    let mut child = Command::new(&config.scanner.python_command)
        .arg(script)
        .arg(&scanner_config)
        .current_dir(&paths.workspace_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!(
                "failed to launch screen scanner with {} {}",
                config.scanner.python_command,
                script.display()
            )
        })?;

    let log_threads =
        take_process_logs(&mut child, "[scanner] ", "[scanner][err] ", logger.clone());
    emit_log(
        &logger,
        format!("[scanner] launched with {}", scanner_config.display()),
    );
    Ok(ProviderProcess {
        child,
        log_threads,
        exited: false,
    })
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

fn wait_for_cdp_health(child: &mut Child, timeout: Duration, port: u16) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if cdp_endpoint_responding(port) {
            return Ok(());
        }
        if let Some(status) = child.try_wait()? {
            anyhow::bail!("browser host helper exited early with status {status}");
        }
        if Instant::now() >= deadline {
            anyhow::bail!("Chrome DevTools endpoint did not open on port {port}");
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn cdp_endpoint_responding(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(
            format!(
                "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .is_err()
    {
        return false;
    }
    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    reader.read_line(&mut status_line).is_ok() && status_line.contains("200")
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

fn wait_for_helper_ready<R>(
    child: &mut Child,
    stdout_reader: &mut BufReader<R>,
    timeout: Duration,
    helper_name: &str,
) -> Result<()>
where
    R: std::io::Read,
{
    let deadline = Instant::now() + timeout;
    let mut line = String::new();
    loop {
        if let Some(status) = child.try_wait()? {
            anyhow::bail!("{helper_name} exited early with status {status}");
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "{helper_name} did not report ready within {}ms",
                timeout.as_millis()
            );
        }

        line.clear();
        match stdout_reader.read_line(&mut line) {
            Ok(0) => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if helper_ready_message(trimmed) {
                    return Ok(());
                }
            }
            Err(err) => {
                anyhow::bail!("failed to read {helper_name} ready response: {err}");
            }
        }
    }
}

fn helper_ready_message(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    value
        .get("type")
        .and_then(|value| value.as_str())
        .map(|value| value == "ready")
        .unwrap_or(false)
        && value
            .get("ok")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
}

fn spawn_log_reader_thread<R>(
    prefix: &'static str,
    reader: BufReader<R>,
    logger: SharedLogger,
) -> JoinHandle<()>
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buffer)
                        .trim_end_matches(['\r', '\n'])
                        .to_string();
                    if line.trim().is_empty() {
                        continue;
                    }
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

fn default_browser_source() -> String {
    "browser_cdp".to_owned()
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

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
            piece_counter: 27,
            lines_cleared: Some(16),
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
        assert_eq!(snapshot.lines_cleared, Some(16));
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
    fn browser_provider_failure_falls_back_to_scanner() {
        assert!(provider_should_fallback(
            SnapshotProviderConfig::BrowserCdp,
            true
        ));
        assert!(!provider_should_fallback(
            SnapshotProviderConfig::Scanner,
            true
        ));
    }
}
