use std::thread;
use std::time::Duration;

use anyhow::{bail, Context, Result};

use crate::config::KeyBindings;

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
    pub actions: Vec<GameAction>,
}

pub trait InputDriver {
    fn tap(&mut self, action: GameAction, duration: Duration) -> Result<()>;

    fn execute_plan(
        &mut self,
        plan: &ExecutionPlan,
        key_bindings: &KeyBindings,
        tap_duration: Duration,
        settle_delay: Duration,
    ) -> Result<()> {
        if plan.hold {
            self.tap(GameAction::Hold, tap_duration)
                .context("failed to send hold input")?;
            thread::sleep(settle_delay);
        }

        for action in &plan.actions {
            self.tap(*action, tap_duration)
                .with_context(|| format!("failed to send action {:?}", action))?;
            thread::sleep(settle_delay);
        }

        let _ = key_bindings;
        Ok(())
    }
}

#[cfg(windows)]
pub struct WindowsSendInputDriver {
    vk_left: u16,
    vk_right: u16,
    vk_rotate_cw: u16,
    vk_rotate_ccw: u16,
    vk_hold: u16,
    vk_soft_drop: u16,
    vk_hard_drop: u16,
}

#[cfg(windows)]
impl WindowsSendInputDriver {
    pub fn new(keys: &KeyBindings) -> Result<Self> {
        Ok(Self {
            vk_left: parse_vk(&keys.left)?,
            vk_right: parse_vk(&keys.right)?,
            vk_rotate_cw: parse_vk(&keys.rotate_cw)?,
            vk_rotate_ccw: parse_vk(&keys.rotate_ccw)?,
            vk_hold: parse_vk(&keys.hold)?,
            vk_soft_drop: parse_vk(&keys.soft_drop)?,
            vk_hard_drop: parse_vk(&keys.hard_drop)?,
        })
    }

    fn vk_for(&self, action: GameAction) -> u16 {
        match action {
            GameAction::Left => self.vk_left,
            GameAction::Right => self.vk_right,
            GameAction::RotateCw => self.vk_rotate_cw,
            GameAction::RotateCcw => self.vk_rotate_ccw,
            GameAction::Hold => self.vk_hold,
            GameAction::SoftDrop => self.vk_soft_drop,
            GameAction::HardDrop => self.vk_hard_drop,
        }
    }
}

#[cfg(windows)]
impl InputDriver for WindowsSendInputDriver {
    fn tap(&mut self, action: GameAction, duration: Duration) -> Result<()> {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
            KEYEVENTF_KEYUP, VIRTUAL_KEY,
        };

        let vk = self.vk_for(action);
        let key_down = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(0),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let key_up = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        let sent = unsafe { SendInput(&[key_down], std::mem::size_of::<INPUT>() as i32) };
        if sent != 1 {
            bail!("SendInput failed while pressing virtual key {}", vk);
        }
        thread::sleep(duration);
        let sent = unsafe { SendInput(&[key_up], std::mem::size_of::<INPUT>() as i32) };
        if sent != 1 {
            bail!("SendInput failed while releasing virtual key {}", vk);
        }
        Ok(())
    }
}

#[cfg(not(windows))]
pub struct WindowsSendInputDriver;

#[cfg(not(windows))]
impl WindowsSendInputDriver {
    pub fn new(_: &KeyBindings) -> Result<Self> {
        bail!("WindowsSendInputDriver is only available on Windows")
    }
}

#[cfg(not(windows))]
impl InputDriver for WindowsSendInputDriver {
    fn tap(&mut self, _: GameAction, _: Duration) -> Result<()> {
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
    fn tap(&mut self, action: GameAction, duration: Duration) -> Result<()> {
        println!("[automation] dry-run action={:?} duration_ms={}", action, duration.as_millis());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct RecordingDriver {
        actions: RefCell<Vec<GameAction>>,
    }

    impl RecordingDriver {
        fn new() -> Self {
            Self {
                actions: RefCell::new(Vec::new()),
            }
        }
    }

    impl InputDriver for RecordingDriver {
        fn tap(&mut self, action: GameAction, _duration: Duration) -> Result<()> {
            self.actions.borrow_mut().push(action);
            Ok(())
        }
    }

    #[test]
    fn execute_plan_keeps_explicit_action_order() {
        let mut driver = RecordingDriver::new();
        let plan = ExecutionPlan {
            hold: false,
            actions: vec![GameAction::RotateCw, GameAction::Left, GameAction::SoftDrop, GameAction::HardDrop],
        };

        driver
            .execute_plan(
                &plan,
                &KeyBindings::default(),
                Duration::from_millis(0),
                Duration::from_millis(0),
            )
            .unwrap();

        assert_eq!(
            &*driver.actions.borrow(),
            &[GameAction::RotateCw, GameAction::Left, GameAction::SoftDrop, GameAction::HardDrop]
        );
    }
}

#[cfg(windows)]
fn parse_vk(input: &str) -> Result<u16> {
    let normalized = input.trim().to_ascii_uppercase();
    let vk = match normalized.as_str() {
        "LEFT" => 0x25,
        "UP" => 0x26,
        "RIGHT" => 0x27,
        "DOWN" => 0x28,
        "SPACE" => 0x20,
        "TAB" => 0x09,
        "SHIFT" => 0x10,
        "CTRL" | "CONTROL" => 0x11,
        "ALT" => 0x12,
        "ENTER" => 0x0D,
        _ if normalized.len() == 1 => normalized.as_bytes()[0] as u16,
        _ => bail!("unsupported virtual key name: {}", input),
    };
    Ok(vk)
}
