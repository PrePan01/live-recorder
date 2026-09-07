use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::contract::{AppInstance, DiagnosticItem, Health};

pub const HOST: &str = "127.0.0.1";
const POLL_INTERVAL: Duration = Duration::from_millis(350);
const POLL_TIMEOUT: Duration = Duration::from_secs(30);
/// 停旧换新：SIGTERM 后等待旧后端退出+端口释放的上限，超时升级 SIGKILL（#9 阻塞根因）。
const STOP_OLD_TIMEOUT_SECS: u64 = 10;

/// 后台控制台程序不应在 Windows 上创建独立窗口；仅重定向 stdio 不足以隐藏它。
fn background_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[derive(Clone)]
struct LaunchConfig {
    cwd: PathBuf,
    node: String,
    args: Vec<String>,
    ready_file: PathBuf,
}

impl LaunchConfig {
    fn discover() -> Result<Self, String> {
        let cwd = backend_cwd().ok_or_else(|| {
            "安装包缺少 backend/dist/index.js，请重新安装完整客户端。".to_string()
        })?;
        Ok(Self {
            cwd,
            node: backend_cmd(),
            args: backend_args(),
            ready_file: ready_file_path().ok_or_else(|| {
                "无法确定状态目录：请检查当前用户的 APPDATA（Windows）或 HOME（macOS）。"
                    .to_string()
            })?,
        })
    }
}

pub struct BackendManager {
    child: Mutex<Option<Child>>,
    instance: Mutex<Option<AppInstance>>,
    // 启动、重试、重启和停止共用同一把锁，不能交错操作同一个后端。
    lifecycle: Mutex<()>,
    diagnostics: Mutex<Vec<DiagnosticItem>>,
    config: Option<LaunchConfig>,
}

impl BackendManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            instance: Mutex::new(None),
            lifecycle: Mutex::new(()),
            diagnostics: Mutex::new(vec![]),
            config: None,
        }
    }

    fn report(&self, key: &str, message: &str) {
        *self.diagnostics.lock().unwrap_or_else(|e| e.into_inner()) = vec![DiagnosticItem::Warn {
            key: key.to_string(),
            message: message.to_string(),
            detail: None,
        }];
    }

    pub fn diagnostics(&self) -> Vec<DiagnosticItem> {
        self.diagnostics
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn is_running(&self) -> bool {
        self.child
            .lock()
            .ok()
            .and_then(|mut child| {
                child
                    .as_mut()
                    .map(|child| matches!(child.try_wait(), Ok(None)))
            })
            .unwrap_or(false)
    }

    pub fn start(&self) -> Result<AppInstance, String> {
        self.run(false)
    }
    pub fn restart(&self) -> Result<AppInstance, String> {
        self.run(true)
    }

    fn run(&self, restart: bool) -> Result<AppInstance, String> {
        let _guard = self
            .lifecycle
            .lock()
            .map_err(|_| "服务管理锁不可用".to_string())?;
        self.report("prepare", "正在检查运行环境与本地数据目录");
        let result = (|| {
            let config = self
                .config
                .clone()
                .map(Ok)
                .unwrap_or_else(LaunchConfig::discover)?;
            if restart {
                self.report("stopping", "正在结束旧服务，保留本地数据");
                self.stop_inner()?;
            }
            self.start_inner(&config)
        })();
        match &result {
            Ok(instance) => {
                *self.instance.lock().unwrap_or_else(|e| e.into_inner()) = Some(instance.clone());
                *self.diagnostics.lock().unwrap_or_else(|e| e.into_inner()) =
                    vec![DiagnosticItem::Ok {
                        key: "service".into(),
                        message: format!("本地服务运行中（{}）", instance.port),
                    }];
            }
            Err(detail) => {
                *self.diagnostics.lock().unwrap_or_else(|e| e.into_inner()) =
                    vec![DiagnosticItem::Error {
                        key: "service".into(),
                        message: "本地服务暂未就绪".into(),
                        detail: Some(detail.clone()),
                    }];
            }
        }
        result
    }

    fn start_inner(&self, config: &LaunchConfig) -> Result<AppInstance, String> {
        let state_dir = config.ready_file.parent().ok_or("状态文件路径无效")?;
        fs::create_dir_all(state_dir)
            .map_err(|e| format!("无法创建状态目录 {}：{e}", state_dir.display()))?;
        let log_path = state_dir.join("backend.log");
        if self.is_running() {
            self.report("health", "服务进程仍在启动，正在等待健康检查");
            // 上次观察超时不是进程退出，继续观察同一进程，不重复拉起。
            return self.wait_ready(config, &log_path);
        }
        {
            let mut child = self.child.lock().map_err(|_| "进程管理锁不可用")?;
            if let Some(process) = child.as_mut() {
                process
                    .try_wait()
                    .map_err(|e| format!("读取旧后端状态失败：{e}"))?;
            }
            *child = None;
        }
        if let Some(existing) = read_ready_at(&config.ready_file) {
            let expected = fs::read_to_string(config.cwd.join("package.json"))
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|json| {
                    json.get("version")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned)
                });
            let actual = fetch_health(existing.port).and_then(|health| health.version);
            if expected.is_some() && expected == actual {
                return Ok(existing);
            }
            self.report("stopping", "正在更新旧版本本地服务");
            stop_existing_pid(existing.pid)?;
        }
        // 只有同一个随包 Node 的进程才能作为本应用残留后端处理。
        // 单凭状态文件里的 PID 不足以证明进程归属（PID 可能已被系统复用）。
        if let Some(pid) = read_lock_pid_at(&config.ready_file) {
            if pid_alive(pid) {
                if same_executable(pid, Path::new(&config.node)) {
                    self.report("stopping", "正在恢复上次未正常退出的本地服务");
                    stop_existing_pid(pid)?;
                } else {
                    return Err(format!("状态目录被进程 {pid} 占用，无法确认其属于本客户端。请关闭使用该目录的其他实例后重试；本地数据未更改。"));
                }
            }
        }
        for attempt in 1..=2 {
            self.report(
                "starting",
                if attempt == 1 {
                    "正在启动本地服务"
                } else {
                    "服务意外退出，正在自动恢复（第 2 次）"
                },
            );
            let mut log = open_backend_log(&log_path)?;
            let _ = writeln!(
                log,
                "\n--- backend start attempt {attempt}; node={}; cwd={} ---",
                config.node,
                config.cwd.display()
            );
            let stderr = log
                .try_clone()
                .map_err(|e| format!("无法写入启动日志：{e}"))?;
            let mut command = background_command(&config.node);
            command
                .args(&config.args)
                .current_dir(&config.cwd)
                .stdout(Stdio::from(log))
                .stderr(Stdio::from(stderr))
                .env("LR_EXTRA_ORIGINS", tauri_origin_list())
                .env("LIVE_RECORDER_STATE_DIR", state_dir)
                .env("LIVE_RECORDER_READY_FILE", &config.ready_file)
                .env(
                    "RECORDING_ADAPTER",
                    std::env::var("RECORDING_ADAPTER").unwrap_or_else(|_| "real".into()),
                );
            let child = command.spawn().map_err(|e| {
                format!(
                    "无法运行 Node（{}）：{e}。请检查安装文件是否完整。",
                    config.node
                )
            })?;
            *self.child.lock().map_err(|_| "进程管理锁不可用")? = Some(child);
            self.report("health", "进程已启动，正在检查本地接口");
            match self.wait_ready(config, &log_path) {
                Ok(instance) => return Ok(instance),
                Err(error) => {
                    // 仅确认进程退出后才自动重试一次；慢启动不触发杀进程/重复启动。
                    if attempt == 2 || self.is_running() {
                        return Err(error);
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
        }
        unreachable!()
    }

    fn wait_ready(&self, config: &LaunchConfig, log_path: &Path) -> Result<AppInstance, String> {
        let deadline = Instant::now() + POLL_TIMEOUT;
        loop {
            let pid = {
                let mut guard = self.child.lock().map_err(|_| "进程管理锁不可用")?;
                let child = guard.as_mut().ok_or("启动进程已被停止")?;
                if let Some(status) = child
                    .try_wait()
                    .map_err(|e| format!("读取后端进程状态失败：{e}"))?
                {
                    return Err(format!(
                        "后端进程已退出（{status}）。\n日志：{}\n{}",
                        log_path.display(),
                        log_tail(log_path)
                    ));
                }
                child.id()
            };
            if let Some(instance) = read_ready_at(&config.ready_file) {
                if instance.pid == pid {
                    return Ok(instance);
                }
            }
            if Instant::now() >= deadline {
                return Err(format!("后端进程 {pid} 仍在运行，但本地接口在 30 秒内未就绪。可继续等待后点击重试连接；只有选择重启才会停止此进程。\n日志：{}\n{}", log_path.display(), log_tail(log_path)));
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    pub fn stop(&self) -> Result<(), String> {
        let _guard = self.lifecycle.lock().map_err(|_| "服务管理锁不可用")?;
        self.stop_inner()
    }

    fn stop_inner(&self) -> Result<(), String> {
        if let Some(child) = self.child.lock().map_err(|_| "进程管理锁不可用")?.take() {
            stop_child(child)?;
        } else if let Some(instance) = self.instance.lock().map_err(|_| "实例锁不可用")?.as_ref()
        {
            if fetch_health(instance.port).is_some_and(|health| health_matches(instance, &health)) {
                stop_existing_pid(instance.pid)?;
            }
        }
        *self.instance.lock().map_err(|_| "实例锁不可用")? = None;
        Ok(())
    }
}

fn backend_cwd() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("LR_BACKEND_CWD") {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    // 安装包永远优先使用自己的资源，不受终端当前目录影响。
    if let Some(resources) = bundled_resources_dir() {
        let packaged = resources.join("backend");
        if packaged.join("dist/index.js").is_file() {
            return Some(packaged);
        }
    }
    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend");
        if development.join("dist/index.js").is_file() {
            return Some(development);
        }
    }
    None
}

fn open_backend_log(path: &Path) -> Result<fs::File, String> {
    if fs::metadata(path).is_ok_and(|meta| meta.len() > 1_048_576) {
        let _ = fs::rename(path, path.with_extension("previous.log"));
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| {
            format!(
                "无法写入启动日志 {}：{e}。请检查当前用户的目录权限。",
                path.display()
            )
        })
}

fn log_tail(path: &Path) -> String {
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let offset = file
        .metadata()
        .map(|meta| meta.len().saturating_sub(6000))
        .unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(offset));
    let mut bytes = Vec::new();
    let _ = file.take(6000).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn stop_existing_pid(pid: u32) -> Result<(), String> {
    if pid <= 1 || pid == std::process::id() {
        return Err("拒绝停止无效后端 PID".into());
    }
    if !pid_alive(pid) {
        return Ok(());
    }
    #[cfg(unix)]
    unsafe {
        if libc::kill(pid as i32, libc::SIGTERM) != 0 {
            return Err(format!(
                "无法停止后端 {pid}：{}",
                std::io::Error::last_os_error()
            ));
        }
    }
    #[cfg(windows)]
    {
        let _ = background_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let deadline = Instant::now() + Duration::from_secs(STOP_OLD_TIMEOUT_SECS);
    while pid_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    if pid_alive(pid) {
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            let _ = background_command("taskkill")
                .args(["/PID", &pid.to_string(), "/F", "/T"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while pid_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    if pid_alive(pid) {
        Err(format!("后端 {pid} 尚未退出，请检查进程权限后重试。"))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    pid > 1
        && (unsafe { libc::kill(pid as i32, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

#[cfg(windows)]
mod win_process {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        pub fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
        pub fn QueryFullProcessImageNameW(
            handle: *mut c_void,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
        pub fn CloseHandle(handle: *mut c_void) -> i32;
    }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    if pid <= 1 {
        return false;
    }
    unsafe {
        let handle = win_process::OpenProcess(0x1000, 0, pid);
        if handle.is_null() {
            return std::io::Error::last_os_error().raw_os_error() == Some(5);
        }
        let mut code = 0;
        let ok = win_process::GetExitCodeProcess(handle, &mut code) != 0;
        win_process::CloseHandle(handle);
        ok && code == 259
    }
}

fn same_executable(pid: u32, expected: &Path) -> bool {
    process_executable(pid)
        .and_then(|path| path.canonicalize().ok())
        .zip(expected.canonicalize().ok())
        .is_some_and(|(actual, expected)| actual == expected)
}

#[cfg(target_os = "macos")]
fn process_executable(pid: u32) -> Option<PathBuf> {
    #[link(name = "proc")]
    extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, size: u32) -> i32;
    }
    let mut buffer = vec![0u8; 4096];
    let len = unsafe { proc_pidpath(pid as i32, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if len <= 0 {
        return None;
    }
    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(len as usize);
    use std::os::unix::ffi::OsStringExt;
    Some(PathBuf::from(std::ffi::OsString::from_vec(
        buffer[..end].to_vec(),
    )))
}

#[cfg(windows)]
fn process_executable(pid: u32) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    unsafe {
        let handle = win_process::OpenProcess(0x1000, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let ok =
            win_process::QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length)
                != 0;
        win_process::CloseHandle(handle);
        ok.then(|| PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length as usize])))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn process_executable(pid: u32) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{pid}/exe")).ok()
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
    // 1) Packaged node: <bundle Resources>/node（Windows 为 node.exe）
    if let Some(res) = bundled_resources_dir() {
        let bundled = if cfg!(windows) {
            res.join("node.exe")
        } else {
            res.join("node")
        };
        if bundled.is_file() {
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
        if std::path::Path::new(&p).is_file() {
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
    background_command(cmd)
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
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    let pid = child.id() as i32;
    let ret = unsafe { libc::kill(pid, libc::SIGTERM) };
    if ret != 0 {
        return Err("发送 SIGTERM 失败".to_string());
    }
    let deadline = Instant::now() + Duration::from_secs(STOP_OLD_TIMEOUT_SECS);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Err(e) => return Err(format!("等待后端退出失败: {e}")),
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            // 仅处理本应用持有的子进程，避免断网时优雅退出挂起拖死重启。
            child.kill().map_err(|e| format!("停止后端失败: {e}"))?;
            child.wait().map_err(|e| format!("回收后端失败: {e}"))?;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

#[cfg(windows)]
fn stop_child(mut child: Child) -> Result<(), String> {
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    // Windows 无 SIGTERM；用 taskkill（不带 /F）向进程发送终止消息，
    // 让后端自己的优雅收束逻辑（删 ready/锁、收束录制）有机会执行。
    let _ = background_command("taskkill")
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
            child.kill().map_err(|e| format!("停止后端失败: {e}"))?;
            child.wait().map_err(|e| format!("回收后端失败: {e}"))?;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

/// 读取受控 ready 文件获取真实 AppInstance（含 OS 分配端口、pid、startedAt）。
/// ready 文件位置：<dataDir>/state/ready.json，其中 dataDir 与后端 defaultDataDir 一致。
pub fn read_ready_file() -> Option<AppInstance> {
    read_ready_at(&ready_file_path()?)
}

fn health_matches(instance: &AppInstance, health: &Health) -> bool {
    health.ready
        && health.instance_id == instance.instance_id
        && health.port == instance.port
        && health.api_version == instance.api_version
        && health.started_at == instance.started_at
}

fn read_ready_at(path: &Path) -> Option<AppInstance> {
    let instance: AppInstance = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    if instance.pid <= 1
        || instance.port == 0
        || instance.host != HOST
        || instance.api_version != "v1"
        || instance.instance_id.is_empty()
        || instance.base_url != format!("http://{HOST}:{}", instance.port)
    {
        return None;
    }
    let health = fetch_health(instance.port)?;
    health_matches(&instance, &health).then_some(instance)
}

/// 仅使用当前数据目录声明且身份匹配的就绪实例，不扫描/接管其他端口。
pub fn fetch_ready() -> Option<AppInstance> {
    read_ready_file()
}

pub fn fetch_health(port: u16) -> Option<Health> {
    static CLIENT: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();
    let client = CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_millis(800))
                .build()
                .ok()
        })
        .as_ref()?;
    let resp = client
        .get(format!("http://{HOST}:{port}/api/v1/health"))
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
    resp.json::<Envelope>().ok().map(|body| body.service_status)
}

fn ready_file_path() -> Option<PathBuf> {
    ready_file_path_for(std::env::consts::OS, |key| std::env::var(key).ok())
}

// 显式传入平台和环境，便于在任意宿主上验证 Windows 不依赖 HOME。
fn ready_file_path_for(platform: &str, env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(path) = env("LIVE_RECORDER_READY_FILE").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path));
    }
    if let Some(dir) = env("LIVE_RECORDER_STATE_DIR").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(dir).join("ready.json"));
    }
    if let Some(dir) = env("LR_STATE_DIR").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(dir).join("ready.json"));
    }
    // 与后端 defaultDataDir 的开发数据目录覆盖保持一致。
    if let Some(dir) = env("LIVE_RECORDER_DATA_DIR").filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir).join("state").join("ready.json"));
    }
    // 各平台只读取自身所需变量。Windows 安装环境通常没有 HOME。
    let base = match platform {
        "windows" => PathBuf::from(
            env("APPDATA")
                .filter(|value| !value.is_empty())
                .or_else(|| env("USERPROFILE"))?,
        )
        .join("live-recorder"),
        "macos" => PathBuf::from(env("HOME")?)
            .join("Library")
            .join("Application Support")
            .join("live-recorder"),
        _ => {
            let data_home = match env("XDG_DATA_HOME") {
                Some(dir) => PathBuf::from(dir),
                None => PathBuf::from(env("HOME")?).join(".local").join("share"),
            };
            data_home.join("live-recorder")
        }
    };
    Some(base.join("state").join("ready.json"))
}

fn read_lock_pid_at(ready: &Path) -> Option<u32> {
    let raw = fs::read_to_string(ready.parent()?.join("instance.lock")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let pid = u32::try_from(parsed.get("pid")?.as_u64()?).ok()?;
    (pid > 1 && pid != std::process::id()).then_some(pid)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    #[test]
    fn running_child_is_recognized_and_reaped() {
        let manager = BackendManager::new();
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        *manager.child.lock().unwrap() = Some(child);
        assert!(manager.is_running());
        manager.stop().unwrap();
        assert!(!manager.is_running());
    }

    #[test]
    fn stop_bounds_wait_for_child_ignoring_sigterm() {
        let mut child = Command::new("sh")
            .args(["-c", "trap '' TERM; echo ready; exec sleep 60"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), "ready");
        let started = Instant::now();
        stop_child(child).unwrap();
        assert!(started.elapsed() < Duration::from_secs(20));
    }
}

#[cfg(test)]
mod state_directory_tests {
    use super::*;

    fn resolve(platform: &str, vars: &[(&str, &str)]) -> Option<PathBuf> {
        ready_file_path_for(platform, |key| {
            vars.iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_string())
        })
    }

    #[test]
    fn windows_uses_appdata_without_home() {
        let appdata = r"C:\Users\用户\AppData\Roaming";
        let expected = PathBuf::from(appdata)
            .join("live-recorder")
            .join("state")
            .join("ready.json");
        assert_eq!(resolve("windows", &[("APPDATA", appdata)]), Some(expected));
    }

    #[test]
    fn windows_does_not_use_unix_home() {
        assert_eq!(resolve("windows", &[("HOME", "/home/user")]), None);
    }

    #[test]
    fn explicit_paths_take_precedence_without_platform_environment() {
        let vars = [
            ("LIVE_RECORDER_READY_FILE", "custom/ready.json"),
            ("LIVE_RECORDER_STATE_DIR", "state-override"),
            ("LR_STATE_DIR", "legacy-state"),
            ("LIVE_RECORDER_DATA_DIR", "dev-data"),
        ];
        assert_eq!(
            resolve("windows", &vars),
            Some(PathBuf::from("custom/ready.json"))
        );
        assert_eq!(
            resolve("windows", &vars[1..]),
            Some(PathBuf::from("state-override").join("ready.json"))
        );
        assert_eq!(
            resolve("windows", &vars[2..]),
            Some(PathBuf::from("legacy-state").join("ready.json"))
        );
        assert_eq!(
            resolve("windows", &vars[3..]),
            Some(PathBuf::from("dev-data").join("state").join("ready.json"))
        );
    }

    #[test]
    fn unix_defaults_remain_compatible_with_backend() {
        assert_eq!(
            resolve("macos", &[("HOME", "/Users/test")]),
            Some(PathBuf::from(
                "/Users/test/Library/Application Support/live-recorder/state/ready.json"
            ))
        );
        assert_eq!(
            resolve("linux", &[("HOME", "/home/test")]),
            Some(PathBuf::from(
                "/home/test/.local/share/live-recorder/state/ready.json"
            ))
        );
        assert_eq!(
            resolve("linux", &[("XDG_DATA_HOME", "/data")]),
            Some(PathBuf::from("/data/live-recorder/state/ready.json"))
        );
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn fixture(crash: bool) -> BackendManager {
        let dir = std::env::temp_dir().join(format!(
            "lr-lifecycle-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("package.json"), r#"{"version":"test"}"#).unwrap();
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/backend.cjs");
        let mut manager = BackendManager::new();
        let mut args = vec![script.to_string_lossy().into_owned()];
        if crash {
            args.push("--crash".into());
        }
        manager.config = Some(LaunchConfig {
            cwd: dir.clone(),
            node: std::env::var("LR_TEST_NODE").unwrap_or_else(|_| "node".into()),
            args,
            ready_file: dir.join("ready.json"),
        });
        manager
    }

    #[test]
    fn concurrent_starts_share_one_process_and_restart_replaces_it() {
        let manager = Arc::new(fixture(false));
        let other = Arc::clone(&manager);
        let pending = std::thread::spawn(move || other.start().unwrap());
        let first = manager.start().unwrap();
        let second = pending.join().unwrap();
        assert_eq!(first.pid, second.pid);
        assert_eq!(first.instance_id, second.instance_id);
        let restarted = manager.restart().unwrap();
        assert_ne!(restarted.pid, first.pid);
        assert!(!pid_alive(first.pid));
        manager.stop().unwrap();
        assert!(!pid_alive(restarted.pid));
    }

    #[test]
    fn immediate_exit_reports_original_error_without_waiting_thirty_seconds() {
        let manager = fixture(true);
        let started = Instant::now();
        let error = manager.start().unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(error.contains("fixture: native dependency unavailable"));
        assert!(error.contains("17"));
        assert!(!manager.is_running());
        let diagnostics = serde_json::to_string(&manager.diagnostics()).unwrap();
        assert!(diagnostics.contains("fixture: native dependency unavailable"));
        manager.stop().unwrap();
    }

    #[test]
    fn a_stale_ready_file_cannot_identify_a_different_live_server() {
        let manager = fixture(false);
        let instance = manager.start().unwrap();
        let path = &manager.config.as_ref().unwrap().ready_file;
        let mut forged = instance.clone();
        forged.instance_id = "stale-instance".into();
        fs::write(path, serde_json::to_vec(&forged).unwrap()).unwrap();
        assert!(read_ready_at(path).is_none());
        manager.stop().unwrap();
    }

    #[test]
    fn process_identity_is_checked_using_the_executable() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0));
        assert!(same_executable(
            std::process::id(),
            &std::env::current_exe().unwrap()
        ));
        assert!(!same_executable(
            std::process::id(),
            Path::new("not-the-backend")
        ));
    }
}
