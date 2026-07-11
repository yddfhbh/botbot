mod browser_source;
mod config;
mod driver;
mod launcher;
mod paths;
mod runner;
mod runtime;
mod scanner;
mod sprint;
mod vs_sim;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use anyhow::{Context, Result};
use config::AutomationConfig;
use eframe::egui::{self, FontData, FontDefinitions, FontFamily};
use launcher::{launcher_viewport, LauncherApp};
use paths::AppPaths;
use runtime::run_automation;

fn main() -> Result<()> {
    let paths = AppPaths::discover();
    let mut args = std::env::args().skip(1);
    if let Some(first_arg) = args.next() {
        if first_arg == "--gui" {
            return launch_gui(paths);
        }
        return run_cli(paths, first_arg, args.collect());
    }
    launch_gui(paths)
}

fn run_cli(paths: AppPaths, first_arg: String, rest_args: Vec<String>) -> Result<()> {
    let (config_path, overrides) = if first_arg.starts_with("--") {
        (
            None,
            std::iter::once(first_arg)
                .chain(rest_args)
                .collect::<Vec<_>>(),
        )
    } else {
        (Some(PathBuf::from(first_arg)), rest_args)
    };
    let config_path =
        config_path.unwrap_or_else(|| PathBuf::from("automation/config.example.json"));
    let raw_config = fs::read_to_string(&config_path).with_context(|| {
        format!(
            "failed to read automation config from {}",
            config_path.display()
        )
    })?;
    let mut config: AutomationConfig =
        serde_json::from_str(&raw_config).context("failed to parse automation config JSON")?;
    apply_cli_overrides(&mut config, &overrides)?;
    let stop = AtomicBool::new(false);
    run_automation(paths, config, &stop, |line| {
        println!("{}", line);
    })
}

fn launch_gui(paths: AppPaths) -> Result<()> {
    let native_options = eframe::NativeOptions {
        viewport: launcher_viewport(&paths),
        ..Default::default()
    };
    eframe::run_native(
        "Cold Clear Launcher",
        native_options,
        Box::new(move |cc| {
            configure_launcher_fonts(&cc.egui_ctx);
            Ok(Box::new(LauncherApp::new(paths.clone())))
        }),
    )
    .map_err(|err| anyhow::anyhow!("failed to launch GUI: {err}"))
}

fn configure_launcher_fonts(ctx: &egui::Context) {
    let Some(font_bytes) = load_korean_font_bytes() else {
        return;
    };

    let mut fonts = FontDefinitions::default();
    fonts.font_data.insert(
        "launcher_korean".to_owned(),
        FontData::from_owned(font_bytes).into(),
    );

    for family in [FontFamily::Proportional, FontFamily::Monospace] {
        fonts
            .families
            .entry(family)
            .or_default()
            .insert(0, "launcher_korean".to_owned());
    }

    ctx.set_fonts(fonts);
}

fn load_korean_font_bytes() -> Option<Vec<u8>> {
    let candidates = [
        r"C:\Windows\Fonts\malgun.ttf",
        r"C:\Windows\Fonts\malgunsl.ttf",
        r"C:\Windows\Fonts\gulim.ttc",
        r"C:\Windows\Fonts\batang.ttc",
    ];
    for path in candidates {
        if let Ok(bytes) = fs::read(path) {
            return Some(bytes);
        }
    }
    None
}

fn apply_cli_overrides(config: &mut AutomationConfig, args: &[String]) -> Result<()> {
    let mut index = 0;
    while index < args.len() {
        let key = &args[index];
        let value = args
            .get(index + 1)
            .filter(|next| !next.starts_with("--"))
            .cloned();
        match key.as_str() {
            "--snapshot-provider" => {
                let value = value.context("missing value for --snapshot-provider")?;
                config.snapshot_provider = match value.as_str() {
                    "browser_cdp" => config::SnapshotProviderConfig::BrowserCdp,
                    "scanner" => config::SnapshotProviderConfig::Scanner,
                    "file" => config::SnapshotProviderConfig::File,
                    _ => anyhow::bail!("unsupported snapshot provider: {value}"),
                };
                index += 2;
            }
            "--input-backend" => {
                let value = value.context("missing value for --input-backend")?;
                config.input_backend = match value.as_str() {
                    "browser_cdp" => config::InputBackendConfig::BrowserCdp,
                    "scan_code" => config::InputBackendConfig::ScanCode,
                    "virtual_key" => config::InputBackendConfig::VirtualKey,
                    _ => anyhow::bail!("unsupported input backend: {value}"),
                };
                index += 2;
            }
            "--cdp-port" => {
                let value = value.context("missing value for --cdp-port")?;
                config.browser.cdp_port = value.parse().context("invalid --cdp-port")?;
                index += 2;
            }
            "--url" => {
                config.browser.url = value.context("missing value for --url")?;
                index += 2;
            }
            "--target" => {
                config.browser.target_hint = value.context("missing value for --target")?;
                index += 2;
            }
            "--connect-only" => {
                config.browser.connect_only = true;
                index += 1;
            }
            other => anyhow::bail!("unsupported CLI argument: {other}"),
        }
    }
    Ok(())
}
