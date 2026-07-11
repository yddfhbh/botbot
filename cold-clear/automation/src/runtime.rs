use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::browser_source::{emit_log, ProviderProcess, SharedLogger};
use crate::config::AutomationConfig;
use crate::driver::{create_input_backend, InputBackend};
use crate::paths::AppPaths;
use crate::runner::run_loop_until;
use crate::scanner::{JsonFileScanner, SnapshotScanner};

pub fn run_automation<F>(
    paths: AppPaths,
    config: AutomationConfig,
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
            config.target_pps
        ),
    );
    let mut provider = ProviderProcess::start(&paths, &config, logger.clone())?;
    let mut scanner = JsonFileScanner::new(
        config.snapshot_path.clone(),
        Duration::from_millis(config.min_snapshot_age_ms),
    );
    let mut backend = create_input_backend(&paths, &config)?;
    let result = run_loop_with_resources(config, &mut scanner, backend.as_mut(), stop, logger);
    let release_result = backend.release_all_keys();
    drop(provider.take());
    result.and(release_result)
}

pub fn run_automation_with_resources<S, D, F>(
    config: AutomationConfig,
    mut scanner: S,
    mut backend: D,
    stop: &AtomicBool,
    log: F,
) -> Result<()>
where
    S: SnapshotScanner,
    D: InputBackend,
    F: FnMut(String) + Send + 'static,
{
    let logger: SharedLogger = Arc::new(Mutex::new(Box::new(log)));
    emit_log(
        &logger,
        format!(
            "[automation] watching {} dry_run={} target_pps={:.2}",
            config.snapshot_path.display(),
            config.dry_run,
            config.target_pps
        ),
    );
    let result = run_loop_with_resources(config, &mut scanner, &mut backend, stop, logger.clone());
    let release_result = backend.release_all_keys();
    result.and(release_result)
}

fn run_loop_with_resources<S, D>(
    config: AutomationConfig,
    scanner: &mut S,
    backend: &mut D,
    stop: &AtomicBool,
    logger: SharedLogger,
) -> Result<()>
where
    S: SnapshotScanner,
    D: InputBackend + ?Sized,
{
    let started_at = Instant::now();
    let perf = PerfState::default();
    let mut observed_backend =
        ObservedInputBackend::new(backend, logger.clone(), started_at, perf.clone());
    let logger_for_loop = logger.clone();
    let result = run_loop_until(&config, scanner, &mut observed_backend, stop, move |line| {
        maybe_emit_perf_from_log(&logger_for_loop, &perf, started_at, &line);
        emit_log(&logger_for_loop, line);
    });
    result
}

#[derive(Clone, Default)]
struct PerfState {
    first_snapshot_logged: Arc<Mutex<bool>>,
    first_plan_logged: Arc<Mutex<bool>>,
    first_input_logged: Arc<Mutex<bool>>,
}

struct ObservedInputBackend<'a, D: InputBackend + ?Sized> {
    inner: &'a mut D,
    logger: SharedLogger,
    started_at: Instant,
    perf: PerfState,
}

impl<'a, D: InputBackend + ?Sized> ObservedInputBackend<'a, D> {
    fn new(inner: &'a mut D, logger: SharedLogger, started_at: Instant, perf: PerfState) -> Self {
        Self {
            inner,
            logger,
            started_at,
            perf,
        }
    }
}

impl<D: InputBackend + ?Sized> InputBackend for ObservedInputBackend<'_, D> {
    fn tap(&mut self, action: crate::driver::GameAction, duration: Duration) -> Result<()> {
        let mut first_input_logged = self
            .perf
            .first_input_logged
            .lock()
            .map_err(|_| anyhow::anyhow!("perf state lock poisoned"))?;
        if !*first_input_logged {
            *first_input_logged = true;
            emit_log(
                &self.logger,
                format!(
                    "[perf] bot_on_to_first_input_ms={}",
                    self.started_at.elapsed().as_millis()
                ),
            );
        }
        drop(first_input_logged);
        self.inner.tap(action, duration)
    }

    fn release_all_keys(&mut self) -> Result<()> {
        self.inner.release_all_keys()
    }
}

fn maybe_emit_perf_from_log(
    logger: &SharedLogger,
    perf: &PerfState,
    started_at: Instant,
    line: &str,
) {
    if line.contains("[automation] source=") && line.contains("token=") {
        if let Ok(mut first_snapshot_logged) = perf.first_snapshot_logged.lock() {
            if !*first_snapshot_logged {
                *first_snapshot_logged = true;
                emit_log(
                    logger,
                    format!(
                        "[perf] bot_on_to_snapshot_ms={}",
                        started_at.elapsed().as_millis()
                    ),
                );
            }
        }
    }

    if line.contains("[automation] source=") && line.contains(" piece=") {
        if let Ok(mut first_plan_logged) = perf.first_plan_logged.lock() {
            if !*first_plan_logged {
                *first_plan_logged = true;
                let elapsed = started_at.elapsed().as_millis();
                emit_log(logger, format!("[perf] bot_on_to_runner_ms={elapsed}"));
                emit_log(logger, format!("[perf] bot_on_to_first_plan_ms={elapsed}"));
            }
        }
    }
}
