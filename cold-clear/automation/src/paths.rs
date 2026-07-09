use std::env;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct AppPaths {
    pub workspace_root: PathBuf,
    pub launcher_state_path: PathBuf,
    pub scanner_script_path: PathBuf,
}

impl AppPaths {
    pub fn discover() -> Self {
        let workspace_root = discover_workspace_root()
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let automation_dir = workspace_root.join("automation");
        Self {
            launcher_state_path: automation_dir.join("launcher-state.json"),
            scanner_script_path: automation_dir.join("scripts").join("screen_scanner.py"),
            workspace_root,
        }
    }

    pub fn resolve_workspace_path(&self, value: &str) -> PathBuf {
        let candidate = PathBuf::from(value);
        if candidate.is_absolute() {
            candidate
        } else {
            self.workspace_root.join(candidate)
        }
    }

    pub fn display_workspace_relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.workspace_root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    }
}

fn discover_workspace_root() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current_dir) = env::current_dir() {
        candidates.push(current_dir);
    }
    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.to_path_buf());
        }
    }

    for candidate in candidates {
        for ancestor in candidate.ancestors() {
            let automation_dir = ancestor.join("automation");
            if automation_dir
                .join("scripts")
                .join("screen_scanner.py")
                .exists()
            {
                return Some(ancestor.to_path_buf());
            }
        }
    }
    None
}
