use std::io::Write;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};

use crate::config::{
    AutomationConfig, BufferModeConfig, HandlingConfig, InputBackendConfig, KeyBindings,
};
use crate::paths::AppPaths;

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum GameAction {
    Left,
    Right,
    RotateCw,
    RotateCcw,
    Hold,
    SoftDrop,
    HardDrop,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionPlan {
    pub hold: bool,
    pub movement_actions: Vec<GameAction>,
    pub hard_drop: bool,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct ExecutionTimings {
    pub tap_duration: Duration,
    pub movement_tap_duration: Duration,
    pub rotate_tap_duration: Duration,
    pub hold_tap_duration: Duration,
    pub hard_drop_tap_duration: Duration,
    pub soft_drop_tap_duration: Duration,
    pub movement_interval: Duration,
    pub rotation_interval: Duration,
    pub piece_interval: Duration,
    pub hard_drop_interval: Duration,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
struct ActionTapProfile {
    requested_duration: Duration,
    actual_duration: Duration,
    source: &'static str,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
struct ActionDelayProfile {
    duration: Duration,
    label: &'static str,
    source: &'static str,
}

pub trait InputBackend {
    fn tap(&mut self, action: GameAction, duration: Duration) -> Result<()>;
    fn release_all_keys(&mut self) -> Result<()>;
}

pub fn create_input_backend(
    paths: &AppPaths,
    config: &AutomationConfig,
) -> Result<Box<dyn InputBackend>> {
    if config.dry_run {
        return Ok(Box::new(DebugLogBackend::new()));
    }

    match config.input_backend {
        InputBackendConfig::ScanCode => Ok(Box::new(SendInputScanCodeBackend::new(&config.keys)?)),
        InputBackendConfig::VirtualKey => {
            Ok(Box::new(SendInputVirtualKeyBackend::new(&config.keys)?))
        }
        InputBackendConfig::BrowserCdp => Ok(Box::new(BrowserCdpInputBackend::new(paths, config)?)),
    }
}

pub fn execute_plan<B, F>(
    backend: &mut B,
    plan: &ExecutionPlan,
    handling: &HandlingConfig,
    timings: ExecutionTimings,
    mut log: F,
) -> Result<()>
where
    B: InputBackend + ?Sized,
    F: FnMut(String),
{
    log_release(&mut log, "before_plan");
    backend
        .release_all_keys()
        .context("failed to release all keys before executing plan")?;

    if plan.hold {
        if handling.ihs_mode == BufferModeConfig::Off {
            log("[automation] ihs_mode=Off hold will be tapped after snapshot".to_owned());
        }
        tap_action_with_logging(backend, GameAction::Hold, handling, timings, &mut log)
            .context("failed to send hold input")?;
        log_release(&mut log, "after_hold");
        backend
            .release_all_keys()
            .context("failed to release all keys after hold input")?;
        sleep_action_delay(&mut log, GameAction::Hold, timings);
    }

    if handling.irs_mode == BufferModeConfig::Off
        && plan
            .movement_actions
            .iter()
            .any(|action| matches!(action, GameAction::RotateCw | GameAction::RotateCcw))
    {
        log("[automation] irs_mode=Off rotations will be tapped after snapshot".to_owned());
    }

    for action in &plan.movement_actions {
        tap_action_with_logging(backend, *action, handling, timings, &mut log)
            .with_context(|| format!("failed to send action {:?}", action))?;
        sleep_action_delay(&mut log, *action, timings);
    }

    if plan.hard_drop {
        log_release(&mut log, "before_hard_drop");
        backend
            .release_all_keys()
            .context("failed to release all keys before hard drop")?;
        if handling.prevent_accidental_hard_drops {
            log("[automation] prevent_accidental_hard_drops=On".to_owned());
        }
        tap_action_with_logging(backend, GameAction::HardDrop, handling, timings, &mut log)
            .context("failed to send hard drop input")?;
        log_release(&mut log, "after_hard_drop");
        backend
            .release_all_keys()
            .context("failed to release all keys after hard drop")?;
        sleep_action_delay(&mut log, GameAction::HardDrop, timings);
    }

    Ok(())
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn duration_for_action(
    action: GameAction,
    handling: &HandlingConfig,
    timings: ExecutionTimings,
) -> Duration {
    action_tap_profile(action, handling, timings).actual_duration
}

fn tap_action_with_logging<B, F>(
    backend: &mut B,
    action: GameAction,
    handling: &HandlingConfig,
    timings: ExecutionTimings,
    log: &mut F,
) -> Result<()>
where
    B: InputBackend + ?Sized,
    F: FnMut(String),
{
    let profile = action_tap_profile(action, handling, timings);
    log_movement_clamp(action, profile, handling, log);
    let down_at = unix_time_ms();
    log(format!(
        "[automation] tap {:?} down ts={} duration_ms={} source={}",
        action,
        down_at,
        profile.actual_duration.as_millis(),
        profile.source
    ));
    backend.tap(action, profile.actual_duration)?;
    let up_at = unix_time_ms();
    log(format!(
        "[automation] tap {:?} up ts={} held_ms={} source={}",
        action,
        up_at,
        profile.actual_duration.as_millis(),
        profile.source
    ));
    Ok(())
}

fn sleep_action_delay<F>(log: &mut F, action: GameAction, timings: ExecutionTimings)
where
    F: FnMut(String),
{
    let profile = action_delay_profile(action, timings);
    if profile.duration.is_zero() {
        return;
    }
    log(format!(
        "[automation] {} {}ms source={}",
        profile.label,
        profile.duration.as_millis(),
        profile.source
    ));
    thread::sleep(profile.duration);
}

fn action_tap_profile(
    action: GameAction,
    handling: &HandlingConfig,
    timings: ExecutionTimings,
) -> ActionTapProfile {
    let (requested_duration, source) = requested_duration_for_action(action, timings);
    let actual_duration = match action {
        GameAction::Left | GameAction::Right => {
            clamp_movement_tap_duration(requested_duration, Duration::from_millis(handling.das_ms))
        }
        _ => requested_duration,
    };
    ActionTapProfile {
        requested_duration,
        actual_duration,
        source,
    }
}

fn requested_duration_for_action(
    action: GameAction,
    timings: ExecutionTimings,
) -> (Duration, &'static str) {
    match action {
        GameAction::Left | GameAction::Right => fallback_aware_duration(
            timings.movement_tap_duration,
            timings.tap_duration,
            "movement_tap",
        ),
        GameAction::RotateCw | GameAction::RotateCcw => fallback_aware_duration(
            timings.rotate_tap_duration,
            timings.tap_duration,
            "rotate_tap",
        ),
        GameAction::Hold => {
            fallback_aware_duration(timings.hold_tap_duration, timings.tap_duration, "hold_tap")
        }
        GameAction::SoftDrop => fallback_aware_duration(
            timings.soft_drop_tap_duration,
            timings.tap_duration,
            "soft_drop_tap",
        ),
        GameAction::HardDrop => fallback_aware_duration(
            timings.hard_drop_tap_duration,
            timings.tap_duration,
            "hard_drop_tap",
        ),
    }
}

fn action_delay_profile(action: GameAction, timings: ExecutionTimings) -> ActionDelayProfile {
    match action {
        GameAction::Left | GameAction::Right | GameAction::SoftDrop => {
            let (duration, source) = fallback_aware_duration(
                timings.movement_interval,
                Duration::ZERO,
                "movement_interval",
            );
            ActionDelayProfile {
                duration,
                label: "after_move_delay",
                source,
            }
        }
        GameAction::RotateCw | GameAction::RotateCcw => {
            let (duration, source) = fallback_aware_duration(
                timings.rotation_interval,
                timings.movement_interval,
                "rotation_interval",
            );
            ActionDelayProfile {
                duration,
                label: "after_rotate_delay",
                source,
            }
        }
        GameAction::Hold => {
            let (duration, source) = fallback_aware_duration(
                timings.piece_interval,
                timings.rotation_interval,
                "piece_interval",
            );
            ActionDelayProfile {
                duration,
                label: "after_hold_delay",
                source,
            }
        }
        GameAction::HardDrop => {
            let (duration, source) = fallback_aware_duration(
                timings.hard_drop_interval,
                timings.piece_interval,
                "hard_drop_interval",
            );
            ActionDelayProfile {
                duration,
                label: "after_hard_drop_delay",
                source,
            }
        }
    }
}

fn fallback_aware_duration(
    specific: Duration,
    fallback: Duration,
    specific_source: &'static str,
) -> (Duration, &'static str) {
    if specific.is_zero() {
        (fallback, "legacy_tap_fallback")
    } else {
        (specific, specific_source)
    }
}

fn clamp_movement_tap_duration(requested_duration: Duration, das_duration: Duration) -> Duration {
    let min_duration = Duration::from_millis(25);
    let das_guard = Duration::from_millis(20);
    let das_capped = das_duration.saturating_sub(das_guard).max(min_duration);
    requested_duration.min(das_capped).max(min_duration)
}

fn log_movement_clamp<F>(
    action: GameAction,
    profile: ActionTapProfile,
    handling: &HandlingConfig,
    log: &mut F,
) where
    F: FnMut(String),
{
    if matches!(action, GameAction::Left | GameAction::Right)
        && profile.actual_duration < profile.requested_duration
    {
        log(format!(
            "[automation] movement tap clamped {}ms -> {}ms because das_ms={}",
            profile.requested_duration.as_millis(),
            profile.actual_duration.as_millis(),
            handling.das_ms
        ));
    }
}

fn log_release<F>(log: &mut F, context: &str)
where
    F: FnMut(String),
{
    log(format!(
        "[automation] release_all {} ts={}",
        context,
        unix_time_ms()
    ));
}

fn unix_time_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(windows)]
#[derive(Copy, Clone, Debug)]
struct InputKey {
    virtual_key: u16,
    scan_code: u16,
    extended: bool,
}

#[cfg(windows)]
struct WindowsSendInputBackend {
    use_scan_code: bool,
    left: InputKey,
    right: InputKey,
    rotate_cw: InputKey,
    rotate_ccw: InputKey,
    hold: InputKey,
    soft_drop: InputKey,
    hard_drop: InputKey,
}

#[cfg(windows)]
impl WindowsSendInputBackend {
    fn new(keys: &KeyBindings, use_scan_code: bool) -> Result<Self> {
        Ok(Self {
            use_scan_code,
            left: parse_key(&keys.left)?,
            right: parse_key(&keys.right)?,
            rotate_cw: parse_key(&keys.rotate_cw)?,
            rotate_ccw: parse_key(&keys.rotate_ccw)?,
            hold: parse_key(&keys.hold)?,
            soft_drop: parse_key(&keys.soft_drop)?,
            hard_drop: parse_key(&keys.hard_drop)?,
        })
    }

    fn key_for(&self, action: GameAction) -> InputKey {
        match action {
            GameAction::Left => self.left,
            GameAction::Right => self.right,
            GameAction::RotateCw => self.rotate_cw,
            GameAction::RotateCcw => self.rotate_ccw,
            GameAction::Hold => self.hold,
            GameAction::SoftDrop => self.soft_drop,
            GameAction::HardDrop => self.hard_drop,
        }
    }

    fn send(&self, key: InputKey, key_up: bool) -> Result<()> {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
            KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, VIRTUAL_KEY,
        };

        let mut flags = KEYBD_EVENT_FLAGS(0);
        if key_up {
            flags |= KEYEVENTF_KEYUP;
        }
        if key.extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }

        let (virtual_key, scan_code, flags) = if self.use_scan_code {
            (VIRTUAL_KEY(0), key.scan_code, flags | KEYEVENTF_SCANCODE)
        } else {
            (VIRTUAL_KEY(key.virtual_key), 0, flags)
        };

        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: virtual_key,
                    wScan: scan_code,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
        if sent != 1 {
            bail!(
                "SendInput failed while sending {} event for key {:?}",
                if key_up { "key-up" } else { "key-down" },
                key
            );
        }
        Ok(())
    }
}

#[cfg(windows)]
impl InputBackend for WindowsSendInputBackend {
    fn tap(&mut self, action: GameAction, duration: Duration) -> Result<()> {
        let key = self.key_for(action);
        self.send(key, false)?;
        thread::sleep(duration);
        self.send(key, true)
    }

    fn release_all_keys(&mut self) -> Result<()> {
        for action in [
            GameAction::Left,
            GameAction::Right,
            GameAction::RotateCw,
            GameAction::RotateCcw,
            GameAction::Hold,
            GameAction::SoftDrop,
            GameAction::HardDrop,
        ] {
            self.send(self.key_for(action), true)?;
        }
        Ok(())
    }
}

#[cfg(not(windows))]
struct WindowsSendInputBackend;

#[cfg(not(windows))]
impl WindowsSendInputBackend {
    fn new(_: &KeyBindings, _: bool) -> Result<Self> {
        bail!("SendInput backends are only available on Windows")
    }
}

#[cfg(not(windows))]
impl InputBackend for WindowsSendInputBackend {
    fn tap(&mut self, _: GameAction, _: Duration) -> Result<()> {
        bail!("SendInput backends are only available on Windows")
    }

    fn release_all_keys(&mut self) -> Result<()> {
        bail!("SendInput backends are only available on Windows")
    }
}

pub struct SendInputScanCodeBackend {
    inner: WindowsSendInputBackend,
}

impl SendInputScanCodeBackend {
    pub fn new(keys: &KeyBindings) -> Result<Self> {
        Ok(Self {
            inner: WindowsSendInputBackend::new(keys, true)?,
        })
    }
}

impl InputBackend for SendInputScanCodeBackend {
    fn tap(&mut self, action: GameAction, duration: Duration) -> Result<()> {
        self.inner.tap(action, duration)
    }

    fn release_all_keys(&mut self) -> Result<()> {
        self.inner.release_all_keys()
    }
}

pub struct SendInputVirtualKeyBackend {
    inner: WindowsSendInputBackend,
}

impl SendInputVirtualKeyBackend {
    pub fn new(keys: &KeyBindings) -> Result<Self> {
        Ok(Self {
            inner: WindowsSendInputBackend::new(keys, false)?,
        })
    }
}

impl InputBackend for SendInputVirtualKeyBackend {
    fn tap(&mut self, action: GameAction, duration: Duration) -> Result<()> {
        self.inner.tap(action, duration)
    }

    fn release_all_keys(&mut self) -> Result<()> {
        self.inner.release_all_keys()
    }
}

pub struct DebugLogBackend;

impl DebugLogBackend {
    pub fn new() -> Self {
        Self
    }
}

impl InputBackend for DebugLogBackend {
    fn tap(&mut self, _: GameAction, _: Duration) -> Result<()> {
        Ok(())
    }

    fn release_all_keys(&mut self) -> Result<()> {
        Ok(())
    }
}

pub struct BrowserCdpInputBackend {
    child: Child,
    stdin: ChildStdin,
}

impl BrowserCdpInputBackend {
    pub fn new(paths: &AppPaths, config: &AutomationConfig) -> Result<Self> {
        let script = &paths.browser_input_script_path;
        let mut command = Command::new(&config.browser.node_command);
        command
            .arg(script)
            .arg("--port")
            .arg(config.browser.cdp_port.to_string())
            .arg("--url")
            .arg(&config.browser.url)
            .arg("--target")
            .arg(&config.browser.target_hint)
            .arg("--connect-only")
            .arg("1")
            .current_dir(&paths.workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        if !config.browser.chrome_path.trim().is_empty() {
            command.env("CHROME_PATH", &config.browser.chrome_path);
        }

        let mut child = command.spawn().with_context(|| {
            format!(
                "failed to launch browser input helper with {} {}",
                config.browser.node_command,
                script.display()
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .context("browser input helper stdin was not available")?;
        Ok(Self { child, stdin })
    }

    fn command_name_for(action: GameAction) -> &'static str {
        match action {
            GameAction::Left => "moveLeft",
            GameAction::Right => "moveRight",
            GameAction::RotateCw => "rotateCW",
            GameAction::RotateCcw => "rotateCCW",
            GameAction::Hold => "hold",
            GameAction::SoftDrop => "softDrop",
            GameAction::HardDrop => "hardDrop",
        }
    }

    fn send_line(&mut self, line: &str) -> Result<()> {
        self.stdin
            .write_all(line.as_bytes())
            .context("failed to write to browser input helper")?;
        self.stdin
            .write_all(b"\n")
            .context("failed to write newline to browser input helper")?;
        self.stdin
            .flush()
            .context("failed to flush browser input helper")
    }
}

impl Drop for BrowserCdpInputBackend {
    fn drop(&mut self) {
        let _ = self.send_line(r#"{"type":"quit"}"#);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl InputBackend for BrowserCdpInputBackend {
    fn tap(&mut self, action: GameAction, duration: Duration) -> Result<()> {
        let key = Self::command_name_for(action);
        self.send_line(&format!(
            r#"{{"type":"tap","key":"{key}","durationMs":{}}}"#,
            duration.as_millis()
        ))
    }

    fn release_all_keys(&mut self) -> Result<()> {
        self.send_line(r#"{"type":"releaseAll"}"#)
    }
}

#[allow(dead_code)]
pub struct BrowserDomEventBackend;

#[allow(dead_code)]
impl BrowserDomEventBackend {
    pub fn new_disabled() -> Result<Self> {
        bail!("BrowserDomEventBackend is disabled for TETR.IO desktop")
    }
}

impl InputBackend for BrowserDomEventBackend {
    fn tap(&mut self, _: GameAction, _: Duration) -> Result<()> {
        bail!("BrowserDomEventBackend is disabled for TETR.IO desktop")
    }

    fn release_all_keys(&mut self) -> Result<()> {
        bail!("BrowserDomEventBackend is disabled for TETR.IO desktop")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum RecordedEvent {
        Tap(GameAction, Duration),
        ReleaseAll,
    }

    struct RecordingBackend {
        events: RefCell<Vec<RecordedEvent>>,
    }

    impl RecordingBackend {
        fn new() -> Self {
            Self {
                events: RefCell::new(Vec::new()),
            }
        }
    }

    impl InputBackend for RecordingBackend {
        fn tap(&mut self, action: GameAction, duration: Duration) -> Result<()> {
            self.events
                .borrow_mut()
                .push(RecordedEvent::Tap(action, duration));
            Ok(())
        }

        fn release_all_keys(&mut self) -> Result<()> {
            self.events.borrow_mut().push(RecordedEvent::ReleaseAll);
            Ok(())
        }
    }

    fn timings() -> ExecutionTimings {
        ExecutionTimings {
            tap_duration: Duration::from_millis(60),
            movement_tap_duration: Duration::from_millis(55),
            rotate_tap_duration: Duration::from_millis(70),
            hold_tap_duration: Duration::from_millis(70),
            hard_drop_tap_duration: Duration::from_millis(80),
            soft_drop_tap_duration: Duration::from_millis(55),
            movement_interval: Duration::from_millis(60),
            rotation_interval: Duration::from_millis(120),
            piece_interval: Duration::from_millis(100),
            hard_drop_interval: Duration::from_millis(100),
        }
    }

    #[test]
    fn execute_plan_uses_action_specific_durations_and_releases_keys() {
        let mut backend = RecordingBackend::new();
        let plan = ExecutionPlan {
            hold: true,
            movement_actions: vec![GameAction::RotateCw, GameAction::Left, GameAction::SoftDrop],
            hard_drop: true,
        };
        let mut logs = Vec::new();

        execute_plan(
            &mut backend,
            &plan,
            &HandlingConfig::default(),
            timings(),
            |line| logs.push(line),
        )
        .unwrap();

        assert_eq!(
            &*backend.events.borrow(),
            &[
                RecordedEvent::ReleaseAll,
                RecordedEvent::Tap(GameAction::Hold, Duration::from_millis(70)),
                RecordedEvent::ReleaseAll,
                RecordedEvent::Tap(GameAction::RotateCw, Duration::from_millis(70)),
                RecordedEvent::Tap(GameAction::Left, Duration::from_millis(55)),
                RecordedEvent::Tap(GameAction::SoftDrop, Duration::from_millis(55)),
                RecordedEvent::ReleaseAll,
                RecordedEvent::Tap(GameAction::HardDrop, Duration::from_millis(80)),
                RecordedEvent::ReleaseAll,
            ]
        );
        assert!(logs
            .iter()
            .any(|line| line.contains("release_all before_plan")));
        assert!(logs
            .iter()
            .any(|line| line.contains("after_rotate_delay 120ms")));
        assert!(logs
            .iter()
            .any(|line| line.contains("after_hard_drop_delay 100ms")));
    }

    #[test]
    fn execute_plan_keeps_hard_drop_last_and_separate() {
        let mut backend = RecordingBackend::new();
        let plan = ExecutionPlan {
            hold: false,
            movement_actions: vec![GameAction::RotateCw, GameAction::Left, GameAction::SoftDrop],
            hard_drop: true,
        };

        execute_plan(
            &mut backend,
            &plan,
            &HandlingConfig::default(),
            timings(),
            |_| {},
        )
        .unwrap();

        assert_eq!(
            backend.events.borrow().last(),
            Some(&RecordedEvent::ReleaseAll)
        );
        assert_eq!(
            backend.events.borrow()[backend.events.borrow().len() - 2],
            RecordedEvent::Tap(GameAction::HardDrop, Duration::from_millis(80))
        );
    }

    #[test]
    fn duration_for_action_clamps_movement_to_das_guard_band() {
        let handling = HandlingConfig {
            das_ms: 97,
            ..HandlingConfig::default()
        };
        let timings = ExecutionTimings {
            movement_tap_duration: Duration::from_millis(90),
            ..timings()
        };

        assert_eq!(
            duration_for_action(GameAction::Left, &handling, timings),
            Duration::from_millis(77)
        );
        assert_eq!(
            duration_for_action(GameAction::Right, &handling, timings),
            Duration::from_millis(77)
        );
    }

    #[test]
    fn duration_for_action_keeps_short_movement_above_minimum() {
        let handling = HandlingConfig {
            das_ms: 30,
            ..HandlingConfig::default()
        };
        let timings = ExecutionTimings {
            movement_tap_duration: Duration::from_millis(10),
            ..timings()
        };

        assert_eq!(
            duration_for_action(GameAction::Left, &handling, timings),
            Duration::from_millis(25)
        );
    }

    #[test]
    fn duration_for_action_uses_action_specific_tap_values() {
        let handling = HandlingConfig::default();
        let timings = timings();

        assert_eq!(
            duration_for_action(GameAction::RotateCw, &handling, timings),
            Duration::from_millis(70)
        );
        assert_eq!(
            duration_for_action(GameAction::RotateCcw, &handling, timings),
            Duration::from_millis(70)
        );
        assert_eq!(
            duration_for_action(GameAction::Hold, &handling, timings),
            Duration::from_millis(70)
        );
        assert_eq!(
            duration_for_action(GameAction::SoftDrop, &handling, timings),
            Duration::from_millis(55)
        );
        assert_eq!(
            duration_for_action(GameAction::HardDrop, &handling, timings),
            Duration::from_millis(80)
        );
    }
}

#[cfg(windows)]
fn parse_key(input: &str) -> Result<InputKey> {
    let normalized = input.trim().to_ascii_uppercase();
    let key = match normalized.as_str() {
        "LEFT" => InputKey {
            virtual_key: 0x25,
            scan_code: 0x4B,
            extended: true,
        },
        "UP" => InputKey {
            virtual_key: 0x26,
            scan_code: 0x48,
            extended: true,
        },
        "RIGHT" => InputKey {
            virtual_key: 0x27,
            scan_code: 0x4D,
            extended: true,
        },
        "DOWN" => InputKey {
            virtual_key: 0x28,
            scan_code: 0x50,
            extended: true,
        },
        "SPACE" => InputKey {
            virtual_key: 0x20,
            scan_code: 0x39,
            extended: false,
        },
        "TAB" => InputKey {
            virtual_key: 0x09,
            scan_code: 0x0F,
            extended: false,
        },
        "SHIFT" => InputKey {
            virtual_key: 0x10,
            scan_code: 0x2A,
            extended: false,
        },
        "CTRL" | "CONTROL" => InputKey {
            virtual_key: 0x11,
            scan_code: 0x1D,
            extended: false,
        },
        "ALT" => InputKey {
            virtual_key: 0x12,
            scan_code: 0x38,
            extended: false,
        },
        "ENTER" => InputKey {
            virtual_key: 0x0D,
            scan_code: 0x1C,
            extended: false,
        },
        _ if normalized.len() == 1 => InputKey {
            virtual_key: normalized.as_bytes()[0] as u16,
            scan_code: parse_letter_scan_code(normalized.as_bytes()[0] as char)?,
            extended: false,
        },
        _ => bail!("unsupported key name: {}", input),
    };
    Ok(key)
}

#[cfg(windows)]
fn parse_letter_scan_code(letter: char) -> Result<u16> {
    let scan_code = match letter {
        'A' => 0x1E,
        'B' => 0x30,
        'C' => 0x2E,
        'D' => 0x20,
        'E' => 0x12,
        'F' => 0x21,
        'G' => 0x22,
        'H' => 0x23,
        'I' => 0x17,
        'J' => 0x24,
        'K' => 0x25,
        'L' => 0x26,
        'M' => 0x32,
        'N' => 0x31,
        'O' => 0x18,
        'P' => 0x19,
        'Q' => 0x10,
        'R' => 0x13,
        'S' => 0x1F,
        'T' => 0x14,
        'U' => 0x16,
        'V' => 0x2F,
        'W' => 0x11,
        'X' => 0x2D,
        'Y' => 0x15,
        'Z' => 0x2C,
        _ => bail!(
            "unsupported single-letter key for scan-code backend: {}",
            letter
        ),
    };
    Ok(scan_code)
}
