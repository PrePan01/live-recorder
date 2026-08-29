use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::contract::{AppInstance, Health};

pub const DEFAULT_PORT: u16 = 43120;
pub const HOST: &str = "127.0.0.1";
const POLL_INTERVAL: Duration = Duration::from_millis(350);
const POLL_TIMEOUT: Duration = Duration::from_secs(30);

pub struct BackendManager {
    child: Mutex<Option<Child>>,
}

impl BackendManager {
    pub fn new() -> Self {
        Self { child: Mutex::new(None) }
    }

    fn backend_cwd() -> Option<PathBuf> {
        let explicit = std::env::var("LR_BACKEND_CWD").ok().map(PathBuf::from);
        if let Some(path) = explicit {
            return Some(path);
        }
        // Dev layout: <repo>/frontend/../backend
        let from_frontend = std::env::current_dir().ok()?.parent()?.join("backend");
        if from_frontend.join("package.json").exists() {
            return Some(from_frontend);
        }
        // Packaged layout: backend shipped under app bundle Resources.
        //   macOS: <app>.app/Contents/Resources/backend
        //   Windows: resources dir next to the exe (target/release/backend)
        let exe = std::env::current_exe().ok()?;
        let mut candidates = Vec::new();
        // macOS: <exe>/../../Resources/backend  (exe = .../Contents/MacOS/app)
        if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
            candidates.push(contents.join("Resources").join("backend"));
        }
        // Windows/dev fallback: <exe>/../backend (exe = target/release/app.exe)
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("backend"));
        }
        for c in candidates {
            if c.join("package.json").exists() {
                return Some(c);
            }
        }
        None
    }

    pub fn is_running(&self) -> bool {
        self.child
            .lock()
            .ok()
            .and_then(|mut c| c.as_mut().map(|c| c.try_wait().ok().is_none()))
            .unwrap_or(false)
    }

    /// Spawn the backend sidecar as a child and poll until
    /// `GET /api/v1/health` reports ready, returning the AppInstance.
    pub fn start(&self) -> Result<AppInstance, String> {
        if self.is_running() {
            return self.wait_ready();
        }
        let cwd = Self::backend_cwd().ok_or_else(|| "未找到后端运行目录".to_string())?;
        let ready_file = ready_file_path().ok_or_else(|| "无法确定状态目录".to_string())?;
        let state_dir = ready_file
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| ready_file.clone());
        let mut command = Command::new(backend_cmd());
        command
            .args(backend_args())
            .current_dir(&cwd)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env("LR_EXTRA_ORIGINS", tauri_origin_list())
            .env("LIVE_RECORDER_STATE_DIR", &state_dir)
            .env("LIVE_RECORDER_READY_FILE", &ready_file);
        let child = command
            .spawn()
            .map_err(|e| format!("启动后端失败: {e}"))?;
        let pid = child.id();
        *self.child.lock().map_err(|_| "锁不可用".to_string())? = Some(child);
        let mut instance = self.wait_ready()?;
        instance.pid = pid;
        Ok(instance)
    }

    fn wait_ready(&self) -> Result<AppInstance, String> {
        let deadline = Instant::now() + POLL_TIMEOUT;
        loop {
            if let Some(instance) = fetch_ready() {
                return Ok(instance);
            }
            if Instant::now() >= deadline {
                return Err("后端在 30 秒内未就绪".to_string());
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    /// Stop the child gracefully (SIGTERM on Unix). We never SIGKILL a PID we
    /// did not spawn, so unknown/foreign processes are untouched.
    pub fn stop(&self) {
        if let Some(child) = self.child.lock().ok().and_then(|mut c| c.take()) {
            let _ = stop_child(child);
        }
    }
}

/// 定位可用的 node 运行时。优先使用打包进 bundle 的 node（Resources/node），
/// 其次 PATH 中的 node，最后回退到 nvm/usr/local 常见路径（GUI 双击启动时
/// PATH 精简，/usr/bin 通常无 node）。
fn backend_cmd() -> String {
    if let Some(explicit) = std::env::var("LR_BACKEND_CMD").ok() {
        if !explicit.is_empty() {
            return explicit;
        }
    }
    // 1) Packaged node: <bundle Resources>/node
    if let Some(res) = bundled_resources_dir() {
        let bundled = res.join("node");
        if bundled.exists() {
            return bundled.to_string_lossy().to_string();
        }
    }
    // 2) PATH node（dev / 已装系统 node）
    if command_exists("node") {
        return "node".to_string();
    }
    // 3) 常见用户级安装路径（nvm / Homebrew / 独立安装）
    let home = std::env::var("HOME").unwrap_or_default();
    let mut fallbacks = vec![
        format!("{home}/.nvm/versions/node"),
        format!("{home}/.local/bin/node"),
        "/usr/local/bin/node".to_string(),
        "/opt/homebrew/bin/node".to_string(),
        "/opt/local/bin/node".to_string(),
    ];
    // nvm 下取最高版本
    if let Ok(entries) = std::fs::read_dir(format!("{home}/.nvm/versions/node")) {
        let mut versions = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.join("bin/node").exists())
            .collect::<Vec<_>>();
        versions.sort();
        if let Some(latest) = versions.last() {
            fallbacks.insert(0, latest.join("bin/node").to_string_lossy().to_string());
        }
    }
    for p in fallbacks {
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    "node".to_string()
}

/// bundle 内 Resources 目录（macOS: <app>.app/Contents/Resources；Windows: exe 同级）。
fn bundled_resources_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // macOS: exe = .../Contents/MacOS/app → Contents/Resources
    if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
        let res = contents.join("Resources");
        if res.is_dir() {
            return Some(res);
        }
    }
    // Windows / 独立可执行：exe 同级
    exe.parent().map(|p| p.to_path_buf())
}

fn command_exists(cmd: &str) -> bool {
    use std::process::Command;
    Command::new(cmd)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn backend_args() -> Vec<String> {
    let explicit = std::env::var("LR_BACKEND_ARGS").ok();
    if let Some(args) = explicit {
        return shell_words(&args);
    }
    // 契约定稿：#99 后端入口为 dist/index.js（调用 startSidecar+installShutdownSignals）。
    vec!["dist/index.js".to_string()]
}

fn shell_words(s: &str) -> Vec<String> {
    s.split_whitespace().map(|w| w.to_string()).collect()
}

fn tauri_origin_list() -> String {
    // The WebView origin must be allowed by the backend's Origin guard.
    // tauri://localhost (Windows) and http://tauri.localhost (macOS).
    "http://localhost:5173,tauri://localhost,http://tauri.localhost".to_string()
}

#[cfg(unix)]
fn stop_child(mut child: Child) -> Result<(), String> {
    let pid = child.id() as i32;
    let ret = unsafe { libc::kill(pid, libc::SIGTERM) };
    if ret != 0 {
        return Err("发送 SIGTERM 失败".to_string());
    }
    let _ = child.wait();
    Ok(())
}

#[cfg(windows)]
fn stop_child(mut child: Child) -> Result<(), String> {
    // Windows 无 SIGTERM；用 taskkill（不带 /F）向进程发送终止消息，
    // 让后端自己的优雅收束逻辑（删 ready/锁、收束录制）有机会执行。
    use std::process::Command as OsCommand;
    let _ = OsCommand::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    // 等待进程退出（上限 5 秒），确保 ready/锁清理完成后再放行。
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

/// 读取受控 ready 文件获取真实 AppInstance（含 OS 分配端口、pid、startedAt）。
/// ready 文件位置：<dataDir>/state/ready.json，其中 dataDir 与后端 defaultDataDir 一致。
pub fn read_ready_file() -> Option<AppInstance> {
    let path = ready_file_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let instance: AppInstance = serde_json::from_str(&raw).ok()?;
    // 校验该实例仍在运行（health 可达且 ready=true）才视为有效。
    match fetch_health(instance.port) {
        Some(health) if health.ready => Some(instance),
        _ => None,
    }
}

/// 探测就绪实例：优先读 ready 文件（权威端口，覆盖 OS 分配），
/// 失败再退回默认/备用候选端口轮询（兼容无 ready 文件的旧后端）。
pub fn fetch_ready() -> Option<AppInstance> {
    if let Some(instance) = read_ready_file() {
        return Some(instance);
    }
    for port in candidate_ports() {
        if let Some(health) = fetch_health(port) {
            if health.ready {
                return Some(AppInstance {
                    instance_id: health.instance_id,
                    pid: 0,
                    host: HOST.to_string(),
                    port: health.port,
                    base_url: format!("http://{HOST}:{}", health.port),
                    api_version: health.api_version,
                    started_at: String::new(),
                });
            }
        }
    }
    None
}

pub fn fetch_health(port: u16) -> Option<Health> {
    let url = format!("http://{HOST}:{port}/api/v1/health");
    let resp = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
        .ok()?
        .get(&url)
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    #[derive(Deserialize)]
    struct Envelope {
        #[serde(rename = "serviceStatus")]
        service_status: Health,
    }
    resp.json::<Envelope>().ok().map(|e| e.service_status)
}

pub fn candidate_ports() -> Vec<u16> {
    let base = std::env::var("LR_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let mut ports = vec![base];
    for delta in 1..=10 {
        ports.push(base.saturating_add(delta));
    }
    ports
}

fn ready_file_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("LIVE_RECORDER_READY_FILE") {
        return Some(PathBuf::from(path));
    }
    if let Ok(dir) = std::env::var("LIVE_RECORDER_STATE_DIR") {
        return Some(PathBuf::from(dir).join("ready.json"));
    }
    if let Ok(dir) = std::env::var("LR_STATE_DIR") {
        return Some(PathBuf::from(dir).join("ready.json"));
    }
    let home = std::env::var("HOME").ok()?;
    let base = if cfg!(target_os = "macos") {
        PathBuf::from(&home)
            .join("Library")
            .join("Application Support")
            .join("live-recorder")
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").ok()?;
        PathBuf::from(appdata).join("live-recorder")
    } else {
        let xdg = std::env::var("XDG_DATA_HOME")
            .ok()
            .unwrap_or_else(|| format!("{home}/.local/share"));
        PathBuf::from(xdg).join("live-recorder")
    };
    Some(base.join("state").join("ready.json"))
}