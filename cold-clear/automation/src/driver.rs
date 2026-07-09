use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};

use crate::config::{BufferModeConfig, HandlingConfig, InputBackendConfig, KeyBindings};

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
    pub settle_delay: Duration,
    pub pre_hard_drop_delay: Duration,
    pub post_hard_drop_delay: Duration,
}

pub trait InputDriver {
    fn tap(&mut self, action: GameAction, duration: Duration) -> Result<()>;
    fn release_all_keys(&mut self) -> Result<()>;

    fn execute_plan<F>(
        &mut self,
        plan: &ExecutionPlan,
        handling: &HandlingConfig,
        timings: ExecutionTimings,
        mut log: F,
    ) -> Result<()>
    where
        F: FnMut(String),
    {
        log_release(&mut log, "before_plan");
        self.release_all_keys()
            .context("failed to release all keys before executing plan")?;

        if plan.hold {
            if handling.ihs_mode == BufferModeConfig::Off {
                log("[automation] ihs_mode=Off hold will be tapped after snapshot".to_owned());
            }
            tap_with_logging(self, GameAction::Hold, timings.tap_duration, &mut log)
                .context("failed to send hold input")?;
            log_release(&mut log, "after_hold");
            self.release_all_keys()
                .context("failed to release all keys after hold input")?;
            sleep_and_log(&mut log, "settle_after_hold", timings.settle_delay);
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
            tap_with_logging(self, *action, timings.tap_duration, &mut log)
                .with_context(|| format!("failed to send action {:?}", action))?;
            sleep_and_log(&mut log, "settle_after_action", timings.settle_delay);
        }

        if plan.hard_drop {
            log_release(&mut log, "before_hard_drop");
            self.release_all_keys()
                .context("failed to release all keys before hard drop")?;
            if handling.prevent_accidental_hard_drops {
                log("[automation] prevent_accidental_hard_drops=On".to_owned());
            }
            let pre_hard_drop_delay = timings.pre_hard_drop_delay;
            sleep_and_log(&mut log, "pre_hard_drop_delay", pre_hard_drop_delay);
            tap_with_logging(self, GameAction::HardDrop, timings.tap_duration, &mut log)
                .context("failed to send hard drop input")?;
            log_release(&mut log, "after_hard_drop");
            self.release_all_keys()
                .context("failed to release all keys after hard drop")?;
            sleep_and_log(
                &mut log,
                "post_hard_drop_delay",
                timings.post_hard_drop_delay,
            );
        }

        Ok(())
    }
}

fn tap_with_logging<F, D>(
    driver: &mut D,
    action: GameAction,
    duration: Duration,
    log: &mut F,
) -> Result<()>
where
    F: FnMut(String),
    D: InputDriver + ?Sized,
{
    let down_at = unix_time_ms();
    log(format!(
        "[automation] tap {:?} down ts={} duration_ms={}",
        action,
        down_at,
        duration.as_millis()
    ));
    driver.tap(action, duration)?;
    let up_at = unix_time_ms();
    log(format!(
        "[automation] tap {:?} up ts={} held_ms={}",
        action,
        up_at,
        duration.as_millis()
    ));
    Ok(())
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

fn sleep_and_log<F>(log: &mut F, label: &str, duration: Duration)
where
    F: FnMut(String),
{
    if duration.is_zero() {
        return;
    }
    log(format!("[automation] {} {}ms", label, duration.as_millis()));
    thread::sleep(duration);
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
pub struct WindowsSendInputDriver {
    input_backend: InputBackendConfig,
    left: InputKey,
    right: InputKey,
    rotate_cw: InputKey,
    rotate_ccw: InputKey,
    hold: InputKey,
    soft_drop: InputKey,
    hard_drop: InputKey,
}

#[cfg(windows)]
impl WindowsSendInputDriver {
    pub fn new(keys: &KeyBindings, input_backend: InputBackendConfig) -> Result<Self> {
        Ok(Self {
            input_backend,
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

        let (virtual_key, scan_code, flags) = match self.input_backend {
            InputBackendConfig::VirtualKey => (VIRTUAL_KEY(key.virtual_key), 0, flags),
            InputBackendConfig::ScanCode => {
                (VIRTUAL_KEY(0), key.scan_code, flags | KEYEVENTF_SCANCODE)
            }
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
impl InputDriver for WindowsSendInputDriver {
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
pub struct WindowsSendInputDriver;

#[cfg(not(windows))]
impl WindowsSendInputDriver {
    pub fn new(_: &KeyBindings, _: InputBackendConfig) -> Result<Self> {
        bail!("WindowsSendInputDriver is only available on Windows")
    }
}

#[cfg(not(windows))]
impl InputDriver for WindowsSendInputDriver {
    fn tap(&mut self, _: GameAction, _: Duration) -> Result<()> {
        bail!("WindowsSendInputDriver is only available on Windows")
    }

    fn release_all_keys(&mut self) -> Result<()> {
        bail!("WindowsSendInputDriver is only available on Windows")
    }
}

pub struct LoggingDriver;

impl LoggingDriver {
    pub fn new() -> Self {
        Self
    }
}

impl InputDriver for LoggingDriver {
    fn tap(&mut self, _: GameAction, _: Duration) -> Result<()> {
        Ok(())
    }

    fn release_all_keys(&mut self) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum RecordedEvent {
        Tap(GameAction),
        ReleaseAll,
    }

    struct RecordingDriver {
        events: RefCell<Vec<RecordedEvent>>,
    }

    impl RecordingDriver {
        fn new() -> Self {
            Self {
                events: RefCell::new(Vec::new()),
            }
        }
    }

    impl InputDriver for RecordingDriver {
        fn tap(&mut self, action: GameAction, _duration: Duration) -> Result<()> {
            self.events.borrow_mut().push(RecordedEvent::Tap(action));
            Ok(())
        }

        fn release_all_keys(&mut self) -> Result<()> {
            self.events.borrow_mut().push(RecordedEvent::ReleaseAll);
            Ok(())
        }
    }

    fn timings() -> ExecutionTimings {
        ExecutionTimings {
            tap_duration: Duration::from_millis(0),
            settle_delay: Duration::from_millis(0),
            pre_hard_drop_delay: Duration::from_millis(0),
            post_hard_drop_delay: Duration::from_millis(0),
        }
    }

    #[test]
    fn execute_plan_releases_keys_around_hold_and_hard_drop() {
        let mut driver = RecordingDriver::new();
        let plan = ExecutionPlan {
            hold: true,
            movement_actions: vec![GameAction::RotateCw, GameAction::Left],
            hard_drop: true,
        };

        driver
            .execute_plan(&plan, &HandlingConfig::default(), timings(), |_| {})
            .unwrap();

        assert_eq!(
            &*driver.events.borrow(),
            &[
                RecordedEvent::ReleaseAll,
                RecordedEvent::Tap(GameAction::Hold),
                RecordedEvent::ReleaseAll,
                RecordedEvent::Tap(GameAction::RotateCw),
                RecordedEvent::Tap(GameAction::Left),
                RecordedEvent::ReleaseAll,
                RecordedEvent::Tap(GameAction::HardDrop),
                RecordedEvent::ReleaseAll,
            ]
        );
    }

    #[test]
    fn execute_plan_keeps_hard_drop_last_and_separate() {
        let mut driver = RecordingDriver::new();
        let plan = ExecutionPlan {
            hold: false,
            movement_actions: vec![GameAction::RotateCw, GameAction::Left, GameAction::SoftDrop],
            hard_drop: true,
        };

        driver
            .execute_plan(&plan, &HandlingConfig::default(), timings(), |_| {})
            .unwrap();

        assert_eq!(
            driver.events.borrow().last(),
            Some(&RecordedEvent::ReleaseAll)
        );
        assert_eq!(
            driver.events.borrow()[driver.events.borrow().len() - 2],
            RecordedEvent::Tap(GameAction::HardDrop)
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
