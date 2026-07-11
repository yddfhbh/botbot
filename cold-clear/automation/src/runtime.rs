use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;

use crate::browser_source::{emit_log, ProviderProcess, SharedLogger};
use crate::config::{
    AutomationConfig, DebuggerProbeMode, InputBackendConfig, MovementModeConfig, RibbonDecodeMode,
    SnapshotProviderConfig, SpawnRuleConfig,
};
use crate::driver::{create_input_backend, InputHelperLogger};
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
    emit_log(
        &logger,
        format!(
            "[config] snapshot_provider={} input_backend={} dry_run={}",
            snapshot_provider_label(config.snapshot_provider),
            input_backend_label(config.input_backend),
            config.dry_run
        ),
    );
    emit_log(
        &logger,
        format!(
            "[config] poll={}ms browser_state_poll={}ms probe={} ribbon={} seedFallback={}",
            config.poll_interval_ms,
            config.browser.state_poll_ms,
            debugger_probe_mode_label(config.browser.debugger_probe_mode),
            ribbon_decode_mode_label(config.browser.ribbon_decode_mode),
            config.browser.use_seed_simulation_fallback
        ),
    );
    emit_log(
        &logger,
        format!(
            "[config] movement={} spawn={} threads={} max_nodes={}",
            movement_mode_label(config.bot.movement_mode),
            spawn_rule_label(config.bot.spawn_rule),
            config.bot.threads,
            config.bot.max_nodes
        ),
    );
    let provider = ProviderProcess::start(&paths, &config, logger.clone())?;
    let mut scanner = JsonFileScanner::new(
        config.snapshot_path.clone(),
        Duration::from_millis(config.min_snapshot_age_ms),
    );
    let input_logger: InputHelperLogger = {
        let logger = logger.clone();
        Arc::new(move |line| emit_log(&logger, line))
    };
    let mut backend = create_input_backend(&paths, &config, Some(input_logger))?;
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

fn snapshot_provider_label(provider: SnapshotProviderConfig) -> &'static str {
    match provider {
        SnapshotProviderConfig::BrowserCdp => "browser_cdp",
        SnapshotProviderConfig::WebsocketSeed => "websocket_seed",
        SnapshotProviderConfig::File => "file",
    }
}

fn input_backend_label(backend: InputBackendConfig) -> &'static str {
    match backend {
        InputBackendConfig::BrowserCdp => "browser_cdp",
        InputBackendConfig::ScanCode => "scan_code",
        InputBackendConfig::VirtualKey => "virtual_key",
    }
}

fn debugger_probe_mode_label(mode: DebuggerProbeMode) -> &'static str {
    match mode {
        DebuggerProbeMode::StartupOnly => "startup_only",
        DebuggerProbeMode::Manual => "manual",
        DebuggerProbeMode::Disabled => "disabled",
    }
}

fn ribbon_decode_mode_label(mode: RibbonDecodeMode) -> &'static str {
    match mode {
        RibbonDecodeMode::UntilSeed => "until_seed",
        RibbonDecodeMode::AlwaysDebug => "always_debug",
        RibbonDecodeMode::Off => "off",
    }
}

fn movement_mode_label(mode: MovementModeConfig) -> &'static str {
    match mode {
        MovementModeConfig::ZeroG => "zero_g",
        MovementModeConfig::ZeroGSafe => "zero_g_safe",
        MovementModeConfig::ZeroGComplete => "zero_g_complete",
        MovementModeConfig::TwentyG => "twenty_g",
        MovementModeConfig::HardDropOnly => "hard_drop_only",
    }
}

fn spawn_rule_label(rule: SpawnRuleConfig) -> &'static str {
    match rule {
        SpawnRuleConfig::Row19Or20 => "row19_or20",
        SpawnRuleConfig::Row21AndFall => "row21_and_fall",
    }
}
