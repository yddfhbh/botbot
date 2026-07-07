use std::sync::atomic::AtomicBool;

use anyhow::Result;

use crate::config::AutomationConfig;
use crate::driver::{LoggingDriver, WindowsSendInputDriver};
use crate::runner::run_loop_until;
use crate::scanner::JsonFileScanner;

pub fn run_automation<F>(config: AutomationConfig, stop: &AtomicBool, mut log: F) -> Result<()>
where
    F: FnMut(String),
{
    log(format!(
        "[automation] watching {} dry_run={}",
        config.snapshot_path.display(),
        config.dry_run
    ));
    let mut scanner = JsonFileScanner::new(config.snapshot_path.clone());
    if config.dry_run {
        let mut driver = LoggingDriver::new();
        run_loop_until(&config, &mut scanner, &mut driver, stop, log)
    } else {
        let mut driver = WindowsSendInputDriver::new(&config.keys)?;
        run_loop_until(&config, &mut scanner, &mut driver, stop, log)
    }
}
