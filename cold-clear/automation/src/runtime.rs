use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::browser_source::{emit_log, ProviderProcess, SharedLogger};
use crate::config::AutomationConfig;
use crate::driver::{create_input_backend, InputBackend, TimedGameAction};
use crate::paths::AppPaths;
use crate::runner::{run_loop_until, run_loop_until_with_live_pps};
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
    emit_startup_logs(&logger, &config);
    let mut provider = ProviderProcess::start(&paths, &config, logger.clone())?;
    let mut scanner = JsonFileScanner::new(
        config.snapshot_path.clone(),
        Duration::from_millis(config.min_snapshot_age_ms),
    );
    let mut backend = create_input_backend(&paths, &config)?;
    let result =
        run_loop_with_resources(config, &mut scanner, backend.as_mut(), stop, logger, None);
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
    emit_startup_logs(&logger, &config);
    let result = run_loop_with_resources(
        config,
        &mut scanner,
        &mut backend,
        stop,
        logger.clone(),
        None,
    );
    let release_result = backend.release_all_keys();
    result.and(release_result)
}

pub fn run_automation_with_resources_and_live_pps<S, D, F>(
    config: AutomationConfig,
    mut scanner: S,
    mut backend: D,
    stop: &AtomicBool,
    live_target_pps: Arc<AtomicU32>,
    log: F,
) -> Result<()>
where
    S: SnapshotScanner,
    D: InputBackend,
    F: FnMut(String) + Send + 'static,
{
    let logger: SharedLogger = Arc::new(Mutex::new(Box::new(log)));
    emit_startup_logs(&logger, &config);
    let result = run_loop_with_resources(
        config,
        &mut scanner,
        &mut backend,
        stop,
        logger.clone(),
        Some(live_target_pps.as_ref()),
    );
    let release_result = backend.release_all_keys();
    result.and(release_result)
}

fn run_loop_with_resources<S, D>(
    config: AutomationConfig,
    scanner: &mut S,
    backend: &mut D,
    stop: &AtomicBool,
    logger: SharedLogger,
    live_target_pps: Option<&AtomicU32>,
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
    let result = if let Some(live_target_pps) = live_target_pps {
        run_loop_until_with_live_pps(
            &config,
            scanner,
            &mut observed_backend,
            stop,
            Some(live_target_pps),
            move |line| {
                maybe_emit_perf_from_log(&logger_for_loop, &perf, started_at, &line);
                emit_log(&logger_for_loop, line);
            },
        )
    } else {
        run_loop_until(&config, scanner, &mut observed_backend, stop, move |line| {
            maybe_emit_perf_from_log(&logger_for_loop, &perf, started_at, &line);
            emit_log(&logger_for_loop, line);
        })
    };
    result
}

fn emit_startup_logs(logger: &SharedLogger, config: &AutomationConfig) {
    emit_log(
        logger,
        format!(
            "[automation] watching {} dry_run={} target_pps={}",
            config.snapshot_path.display(),
            config.dry_run,
            format_target_pps(config.target_pps)
        ),
    );
    emit_log(
        logger,
        format!(
            "[bot] style={} target_pps={}",
            config.play_style.log_label(),
            format_target_pps(config.target_pps)
        ),
    );
    emit_log(
        logger,
        format!(
            "[bot] evaluation_profile={} route_profile={}",
            config.evaluation_profile.log_label(),
            config.route_profile.log_label()
        ),
    );
    if config.play_style == crate::config::PlayStyleConfig::Speed {
        emit_log(logger, "[style] speed objective=sprint40l".to_owned());
        emit_log(
            logger,
            "[style] priorities=tetris,clean_well,low_pieces,short_route".to_owned(),
        );
    }
}

fn format_target_pps(target_pps: f32) -> String {
    if target_pps.is_finite() && target_pps > 0.0 {
        format!("{target_pps:.2}")
    } else {
        "unlimited".to_owned()
    }
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
        self.emit_first_input_perf()?;
        self.inner.tap(action, duration)
    }

    fn execute_sequence(&mut self, actions: &[TimedGameAction]) -> Result<()> {
        self.emit_first_input_perf()?;
        self.inner.execute_sequence(actions)
    }

    fn release_all_keys(&mut self) -> Result<()> {
        self.inner.release_all_keys()
    }

    fn supports_batched_sequences(&self) -> bool {
        self.inner.supports_batched_sequences()
    }
}

impl<D: InputBackend + ?Sized> ObservedInputBackend<'_, D> {
    fn emit_first_input_perf(&mut self) -> Result<()> {
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
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::GameAction;
    use crate::scanner::GameSnapshot;
    use std::cell::Cell;
    use std::rc::Rc;

    struct EmptyScanner;

    impl SnapshotScanner for EmptyScanner {
        fn next_snapshot(&mut self) -> Result<Option<GameSnapshot>> {
            Ok(None)
        }
    }

    struct RecordingBackend {
        release_calls: Rc<Cell<u32>>,
    }

    impl InputBackend for RecordingBackend {
        fn tap(&mut self, _: GameAction, _: Duration) -> Result<()> {
            Ok(())
        }

        fn release_all_keys(&mut self) -> Result<()> {
            self.release_calls.set(self.release_calls.get() + 1);
            Ok(())
        }
    }

    #[test]
    fn bot_off_releases_all_keys_once() {
        let stop = AtomicBool::new(true);
        let release_calls = Rc::new(Cell::new(0));

        run_automation_with_resources(
            AutomationConfig::default(),
            EmptyScanner,
            RecordingBackend {
                release_calls: release_calls.clone(),
            },
            &stop,
            |_| {},
        )
        .unwrap();

        assert_eq!(release_calls.get(), 1);
    }
}
