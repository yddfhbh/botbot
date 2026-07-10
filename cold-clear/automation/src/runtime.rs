use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;

use crate::browser_source::{emit_log, ProviderProcess, SharedLogger};
use crate::config::AutomationConfig;
use crate::driver::create_input_backend;
use crate::paths::AppPaths;
use crate::runner::run_loop_until;
use crate::scanner::JsonFileScanner;

pub fn run_automation<F>(
    paths: AppPaths,
    config: AutomationConfig,
    live_target_pps: Arc<AtomicU32>,
    stop: &AtomicBool,
    log: F,
) -> Result<()>
where
    F: FnMut(String) + Send + 'static,
{
    let logger: SharedLogger = Arc::new(Mutex::new(Box::new(log)));
    emit_log(
        &logger,
        format!(
            "[automation] watching {} dry_run={} target_pps={:.2}",
            config.snapshot_path.display(),
            config.dry_run,
            f32::from_bits(live_target_pps.load(Ordering::Relaxed))
        ),
    );
    let provider = ProviderProcess::start(&paths, &config, logger.clone())?;
    let mut scanner = JsonFileScanner::new(
        config.snapshot_path.clone(),
        Duration::from_millis(config.min_snapshot_age_ms),
    );
    let mut backend = create_input_backend(&paths, &config)?;
    let logger_for_loop = logger.clone();
    let result = run_loop_until(
        &config,
        &mut scanner,
        backend.as_mut(),
        live_target_pps.as_ref(),
        stop,
        move |line| {
            emit_log(&logger_for_loop, line);
        },
    );
    let release_result = backend.release_all_keys();
    drop(provider);
    result.and(release_result)
}
