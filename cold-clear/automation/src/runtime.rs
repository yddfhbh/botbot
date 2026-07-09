use std::sync::atomic::AtomicBool;
use std::time::Duration;

use anyhow::Result;

use crate::config::AutomationConfig;
use crate::driver::{InputDriver, LoggingDriver, WindowsSendInputDriver};
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
    let mut scanner = JsonFileScanner::new(
        config.snapshot_path.clone(),
        Duration::from_millis(config.min_snapshot_age_ms),
    );
    if config.dry_run {
        let mut driver = LoggingDriver::new();
        let result = run_loop_until(&config, &mut scanner, &mut driver, stop, &mut log);
        let release_result = driver.release_all_keys();
        result.and(release_result)
    } else {
        let mut driver = WindowsSendInputDriver::new(&config.keys, config.input_backend)?;
        let result = run_loop_until(&config, &mut scanner, &mut driver, stop, &mut log);
        let release_result = driver.release_all_keys();
        result.and(release_result)
    }
}
