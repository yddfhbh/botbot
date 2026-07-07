mod config;
mod driver;
mod launcher;
mod paths;
mod runner;
mod runtime;
mod scanner;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use anyhow::{Context, Result};
use config::AutomationConfig;
use launcher::{launcher_viewport, LauncherApp};
use paths::AppPaths;
use runtime::run_automation;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    if let Some(first_arg) = args.next() {
        if first_arg == "--gui" {
            return launch_gui();
        }
        return run_cli(PathBuf::from(first_arg));
    }
    launch_gui()
}

fn run_cli(config_path: PathBuf) -> Result<()> {
    let raw_config = fs::read_to_string(&config_path).with_context(|| {
        format!(
            "failed to read automation config from {}",
            config_path.display()
        )
    })?;
    let config: AutomationConfig =
        serde_json::from_str(&raw_config).context("failed to parse automation config JSON")?;
    let stop = AtomicBool::new(false);
    run_automation(config, &stop, |line| {
        println!("{}", line);
    })
}

fn launch_gui() -> Result<()> {
    let paths = AppPaths::discover();
    let native_options = eframe::NativeOptions {
        viewport: launcher_viewport(&paths),
        ..Default::default()
    };
    eframe::run_native(
        "Cold Clear Launcher",
        native_options,
        Box::new(move |_cc| Ok(Box::new(LauncherApp::new(paths.clone())))),
    )
    .map_err(|err| anyhow::anyhow!("failed to launch GUI: {err}"))
}
