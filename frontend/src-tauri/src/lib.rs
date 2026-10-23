mod backend;
mod power;
mod contract;
mod updates;
mod xiaohongshu;

use std::{fs, sync::Mutex};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    window::WindowBuilder,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl,
    WebviewWindowBuilder,
};

use backend::BackendManager;
use contract::{BootEvent, BootState, DiagnosticItem};

struct ShellState {
    backend: BackendManager,
    boot: Mutex<BootState>,
    floating_recorder: Mutex<FloatingRecorderState>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FloatingRecorderState {
    target_room_id: Option<String>,
    button_size: f64,
}

impl ShellState {
    fn set_boot(&self, app: &AppHandle, state: BootState) {
        let _ = self.boot.lock().map(|mut b| *b = state);
        let _ = app.emit(BOOT_EVENT, state);
    }
}

const BOOT_EVENT: &str = "boot:state";
const WINDOW_VISIBILITY_EVENT: &str = "window:visibility";
const DOUYIN_AUTHORIZED_EVENT: &str = "douyin:authorized";
const DOUYIN_AUTH_WINDOW: &str = "douyin-auth";
const DOUYIN_CONTROLS_WEBVIEW: &str = "douyin-auth-controls";
const DOUYIN_LOGIN_WEBVIEW: &str = "douyin-auth-login-page";
const DOUYIN_LOGIN_URL: &str = "https://www.douyin.com/";
const XIAOHONGSHU_AUTHORIZED_EVENT: &str = "xiaohongshu:authorized";
const XIAOHONGSHU_AUTH_WINDOW: &str = "xiaohongshu-auth";
const XIAOHONGSHU_CONTROLS_WEBVIEW: &str = "xiaohongshu-auth-controls";
const XIAOHONGSHU_LOGIN_WEBVIEW: &str = "xiaohongshu-auth-login-page";
const XIAOHONGSHU_LOGIN_URL: &str = "https://www.xiaohongshu.com/explore";
const BILIBILI_AUTHORIZED_EVENT: &str = "bilibili:authorized";
const BILIBILI_AUTH_WINDOW: &str = "bilibili-auth";
const BILIBILI_CONTROLS_WEBVIEW: &str = "bilibili-auth-controls";
const BILIBILI_LOGIN_WEBVIEW: &str = "bilibili-auth-login-page";
// 登录页（passport）与主站同属 bilibili.com 域，登录成功后 Cookie 落在 .bilibili.com。
const BILIBILI_LOGIN_URL: &str = "https://passport.bilibili.com/login";
const YOUTUBE_AUTHORIZED_EVENT: &str = "youtube:authorized";
const YOUTUBE_AUTH_WINDOW: &str = "youtube-auth";
const YOUTUBE_CONTROLS_WEBVIEW: &str = "youtube-auth-controls";
const YOUTUBE_LOGIN_WEBVIEW: &str = "youtube-auth-login-page";
// Google 登录跳 accounts.google.com，完成后回到 youtube.com；从主站进登录页与抖音同构。
const YOUTUBE_LOGIN_URL: &str = "https://www.youtube.com/";
/** 授权窗口底部本地确认栏高度：远程登录页占满其余空间。 */
const AUTH_CONTROLS_HEIGHT: f64 = 76.0;
const FLOATING_RECORDER_WINDOW: &str = "floating-recorder";
const FLOATING_RECORDER_EVENT: &str = "floating-recorder:target";
const FLOATING_RECORDER_MOVED_EVENT: &str = "floating-recorder:moved";
const FLOATING_RECORDER_POSITION_FILE: &str = "floating-recorder-position.json";
// 设置项表达的是半径；默认 36px 对应当前 72px 直径的按钮。
const DEFAULT_FLOATING_RECORDER_SIZE: f64 = 36.0;
const FLOATING_RECORDER_MIN_SIZE: f64 = 20.0;
const FLOATING_RECORDER_MAX_SIZE: f64 = 100.0;

// Store logical pixels so the window keeps a sensible size when the display's
// scale factor changes (for example, moving between Retina and non-Retina
// displays). Position is deliberately not restored: a previously disconnected
// monitor must never leave the main window inaccessible.
const WINDOW_STATE_FILE: &str = "window-state.json";
const MIN_WINDOW_WIDTH: f64 = 720.0;
const MIN_WINDOW_HEIGHT: f64 = 480.0;
const MAX_WINDOW_DIMENSION: f64 = 10_000.0;

#[derive(serde::Deserialize, serde::Serialize)]
struct WindowSize {
    width: f64,
    height: f64,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct WindowPosition {
    x: f64,
    y: f64,
}

impl WindowPosition {
    fn is_valid(&self) -> bool {
        self.x.is_finite() && self.y.is_finite() && (-10_000.0..=10_000.0).contains(&self.x) && (-10_000.0..=10_000.0).contains(&self.y)
    }
}

impl WindowSize {
    fn is_valid(&self) -> bool {
        self.width.is_finite()
            && self.height.is_finite()
            && (MIN_WINDOW_WIDTH..=MAX_WINDOW_DIMENSION).contains(&self.width)
            && (MIN_WINDOW_HEIGHT..=MAX_WINDOW_DIMENSION).contains(&self.height)
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn window_state_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|directory| directory.join(WINDOW_STATE_FILE))
}

fn floating_position_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|directory| directory.join(FLOATING_RECORDER_POSITION_FILE))
}

fn load_floating_position(app: &AppHandle) -> Option<WindowPosition> {
    let path = floating_position_path(app)?;
    let contents = fs::read_to_string(path).ok()?;
    let position = serde_json::from_str::<WindowPosition>(&contents).ok()?;
    position.is_valid().then_some(position)
}

fn default_floating_position(app: &AppHandle, button_size: f64) -> (f64, f64) {
    let Ok(Some(monitor)) = app.primary_monitor() else { return (24.0, 24.0); };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let (width, height) = floating_recorder_window_size(button_size);
    let x = area.position.x as f64 + area.size.width as f64 - (width + 24.0) * scale;
    let y = area.position.y as f64 + area.size.height as f64 - (height + 24.0) * scale;
    (x / scale, y / scale)
}

fn save_floating_position(app: &AppHandle, physical: tauri::PhysicalPosition<i32>) {
    let Some(window) = app.get_webview_window(FLOATING_RECORDER_WINDOW) else { return; };
    let Ok(scale_factor) = window.scale_factor() else { return; };
    let position = physical.to_logical::<f64>(scale_factor);
    let saved = WindowPosition { x: position.x, y: position.y };
    if !saved.is_valid() { return; }
    let Some(path) = floating_position_path(app) else { return; };
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_ok() {
            if let Ok(json) = serde_json::to_vec(&saved) { let _ = fs::write(path, json); }
        }
    }
}

fn floating_state(app: &AppHandle) -> FloatingRecorderState {
    app.state::<ShellState>().floating_recorder.lock().map(|state| state.clone()).unwrap_or(FloatingRecorderState { target_room_id: None, button_size: DEFAULT_FLOATING_RECORDER_SIZE })
}

fn clamp_floating_recorder_size(size: f64) -> f64 {
    if size.is_finite() { size.round().clamp(FLOATING_RECORDER_MIN_SIZE, FLOATING_RECORDER_MAX_SIZE) } else { DEFAULT_FLOATING_RECORDER_SIZE }
}

fn floating_recorder_window_size(button_radius: f64) -> (f64, f64) {
    // 额外空间留给右上角关闭按钮、房间名和居中的时长。
    let button_diameter = button_radius * 2.0;
    (button_diameter + 84.0, button_diameter + 54.0)
}

fn show_floating_recorder_window(app: &AppHandle, room_id: String, button_size: Option<f64>) -> Result<FloatingRecorderState, String> {
    let state = {
        let shell = app.state::<ShellState>();
        let mut state = shell.floating_recorder.lock().map_err(|_| "悬浮录制状态不可用")?;
        state.target_room_id = Some(room_id);
        if let Some(size) = button_size { state.button_size = clamp_floating_recorder_size(size); }
        state.clone()
    };
    if let Some(window) = app.get_webview_window(FLOATING_RECORDER_WINDOW) {
        let _ = app.emit(FLOATING_RECORDER_EVENT, &state);
        let (width, height) = floating_recorder_window_size(state.button_size);
        let _ = window.set_size(LogicalSize::new(width, height));
        let _ = window.unminimize();
        let _ = window.show();
        return Ok(state);
    }
    let (width, height) = floating_recorder_window_size(state.button_size);
    let mut builder = WebviewWindowBuilder::new(app, FLOATING_RECORDER_WINDOW, WebviewUrl::App("src/window-entries/floating-recorder/floating-recorder.html".into()))
        .title("快速录制")
        .inner_size(width, height)
        .min_inner_size(width, height)
        .max_inner_size(width, height)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .shadow(false);
    if let Some(position) = load_floating_position(app).filter(|position| {
        app.monitor_from_point(position.x, position.y).ok().flatten().is_some()
    }) {
        builder = builder.position(position.x, position.y);
    } else {
        let (x, y) = default_floating_position(app, state.button_size);
        builder = builder.position(x, y);
    }
    builder.build().map_err(|error| format!("无法创建快速录制按钮: {error}"))?;
    Ok(state)
}

#[tauri::command]
async fn show_floating_recorder(app: AppHandle, room_id: String, button_size: Option<f64>) -> Result<FloatingRecorderState, String> {
    // WebView2 在同步 command 内创建窗口会死锁；与授权窗口相同，移到后台任务，
    // Tauri 会把窗口操作分派回正确的原生 UI 线程。
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || show_floating_recorder_window(&handle, room_id, button_size))
        .await
        .map_err(|error| format!("创建快速录制窗口任务异常: {error}"))?
}

#[tauri::command]
fn get_floating_recorder_state(app: AppHandle) -> FloatingRecorderState { floating_state(&app) }

#[tauri::command]
fn hide_floating_recorder(app: AppHandle, clear_target: bool) {
    if clear_target {
        if let Ok(mut state) = app.state::<ShellState>().floating_recorder.lock() { state.target_room_id = None; }
    }
    let _ = app.emit(FLOATING_RECORDER_EVENT, floating_state(&app));
    if let Some(window) = app.get_webview_window(FLOATING_RECORDER_WINDOW) { let _ = window.hide(); }
}

#[tauri::command]
fn set_floating_recorder_size(app: AppHandle, button_size: f64) {
    let state = {
        let shell = app.state::<ShellState>();
        let mut state = match shell.floating_recorder.lock() { Ok(state) => state, Err(_) => return };
        state.button_size = clamp_floating_recorder_size(button_size);
        state.clone()
    };
    if let Some(window) = app.get_webview_window(FLOATING_RECORDER_WINDOW) {
        let (width, height) = floating_recorder_window_size(state.button_size);
        let _ = window.set_size(LogicalSize::new(width, height));
        let _ = app.emit(FLOATING_RECORDER_EVENT, state);
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn restore_main_window_size(app: &AppHandle) {
    let Some(path) = window_state_path(app) else {
        return;
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return;
    };
    let Ok(size) = serde_json::from_str::<WindowSize>(&contents) else {
        return;
    };

    if size.is_valid() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_size(LogicalSize::new(size.width, size.height));
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn save_main_window_size(app: &AppHandle, physical_size: tauri::PhysicalSize<u32>) {
    let Some(path) = window_state_path(app) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(scale_factor) = window.scale_factor() else {
        return;
    };
    let logical_size = physical_size.to_logical::<f64>(scale_factor);
    let size = WindowSize {
        width: logical_size.width,
        height: logical_size.height,
    };

    if !size.is_valid() {
        return;
    }
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_ok() {
        if let Ok(json) = serde_json::to_vec(&size) {
            let _ = fs::write(path, json);
        }
    }
}

fn main_window_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|window| window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false))
        .unwrap_or(false)
}

fn emit_window_visibility(app: &AppHandle) {
    let _ = app.emit(WINDOW_VISIBILITY_EVENT, main_window_visible(app));
}

fn show_douyin_auth_windows(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window(DOUYIN_AUTH_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    // The local confirmation page is the primary webview.  The real Douyin
    // page is a child webview above it, leaving a fixed confirmation bar at
    // the bottom of the *same* native window.
    let auth_window = WindowBuilder::new(app, DOUYIN_AUTH_WINDOW)
        .title("抖音授权")
        .inner_size(980.0, 720.0)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("无法打开抖音授权窗口: {e}"))?;
    let login_url = DOUYIN_LOGIN_URL
        .parse()
        .map_err(|e| format!("抖音登录地址无效: {e}"))?;
    auth_window
        .add_child(
            WebviewBuilder::new(DOUYIN_LOGIN_WEBVIEW, WebviewUrl::External(login_url)),
            LogicalPosition::new(0.0, 0.0),
            // Keep this slightly shorter than the window so the local
            // confirmation page remains visible along the bottom.
            LogicalSize::new(980.0, 720.0 - AUTH_CONTROLS_HEIGHT),
        )
        .map_err(|e| format!("无法加载抖音登录页面: {e}"))?;
    auth_window
        .add_child(
            WebviewBuilder::new(DOUYIN_CONTROLS_WEBVIEW, WebviewUrl::App("src/window-entries/platform-auth/douyin-auth.html".into())),
            LogicalPosition::new(0.0, 720.0 - AUTH_CONTROLS_HEIGHT),
            LogicalSize::new(980.0, AUTH_CONTROLS_HEIGHT),
        )
        .map_err(|e| format!("无法加载抖音授权确认栏: {e}"))?;
    Ok(())
}

/// B站授权窗口：与抖音授权同构（远程登录页 + 底部本地确认栏），
/// 区别仅在于登录页是 passport.bilibili.com，且登录凭证为 SESSDATA。
fn show_bilibili_auth_windows(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window(BILIBILI_AUTH_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    let auth_window = WindowBuilder::new(app, BILIBILI_AUTH_WINDOW)
        .title("B站授权")
        .inner_size(980.0, 720.0)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("无法打开B站授权窗口: {e}"))?;
    let login_url = BILIBILI_LOGIN_URL
        .parse()
        .map_err(|e| format!("B站登录地址无效: {e}"))?;
    auth_window
        .add_child(
            WebviewBuilder::new(BILIBILI_LOGIN_WEBVIEW, WebviewUrl::External(login_url)),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(980.0, 720.0 - AUTH_CONTROLS_HEIGHT),
        )
        .map_err(|e| format!("无法加载B站登录页面: {e}"))?;
    auth_window
        .add_child(
            WebviewBuilder::new(BILIBILI_CONTROLS_WEBVIEW, WebviewUrl::App("src/window-entries/platform-auth/bilibili-auth.html".into())),
            LogicalPosition::new(0.0, 720.0 - AUTH_CONTROLS_HEIGHT),
            LogicalSize::new(980.0, AUTH_CONTROLS_HEIGHT),
        )
        .map_err(|e| format!("无法加载B站授权确认栏: {e}"))?;
    Ok(())
}

fn show_xiaohongshu_auth_windows(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window(XIAOHONGSHU_AUTH_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    let auth_window = WindowBuilder::new(app, XIAOHONGSHU_AUTH_WINDOW)
        .title("小红书授权")
        .inner_size(980.0, 720.0)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("无法打开小红书授权窗口: {e}"))?;
    let login_url = XIAOHONGSHU_LOGIN_URL
        .parse()
        .map_err(|e| format!("小红书登录地址无效: {e}"))?;
    auth_window
        .add_child(
            WebviewBuilder::new(XIAOHONGSHU_LOGIN_WEBVIEW, WebviewUrl::External(login_url)),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(980.0, 720.0 - AUTH_CONTROLS_HEIGHT),
        )
        .map_err(|e| format!("无法加载小红书登录页面: {e}"))?;
    auth_window
        .add_child(
            WebviewBuilder::new(XIAOHONGSHU_CONTROLS_WEBVIEW, WebviewUrl::App("src/window-entries/platform-auth/xiaohongshu-auth.html".into())),
            LogicalPosition::new(0.0, 720.0 - AUTH_CONTROLS_HEIGHT),
            LogicalSize::new(980.0, AUTH_CONTROLS_HEIGHT),
        )
        .map_err(|e| format!("无法加载小红书授权确认栏: {e}"))?;
    Ok(())
}

/// 授权窗口被用户缩放时重新排布：远程登录页占满上部，本地确认栏贴底。
fn layout_auth_window(
    app: &AppHandle,
    size: tauri::PhysicalSize<u32>,
    scale_factor: f64,
    login_label: &str,
    controls_label: &str,
) {
    let logical = size.to_logical::<f64>(scale_factor);
    let bar_top = (logical.height - AUTH_CONTROLS_HEIGHT).max(320.0);
    if let Some(login) = app.get_webview(login_label) {
        let _ = login.set_size(LogicalSize::new(logical.width, bar_top));
    }
    if let Some(controls) = app.get_webview(controls_label) {
        let _ = controls.set_position(LogicalPosition::new(0.0, bar_top));
        let _ = controls.set_size(LogicalSize::new(logical.width, AUTH_CONTROLS_HEIGHT));
    }
}

fn close_douyin_auth_windows(app: &AppHandle) {
    if let Some(window) = app.get_window(DOUYIN_AUTH_WINDOW) {
        let _ = window.close();
    }
}

fn close_bilibili_auth_windows(app: &AppHandle) {
    if let Some(window) = app.get_window(BILIBILI_AUTH_WINDOW) {
        let _ = window.close();
    }
}

fn close_xiaohongshu_auth_windows(app: &AppHandle) {
    if let Some(window) = app.get_window(XIAOHONGSHU_AUTH_WINDOW) {
        let _ = window.close();
    }
}

/// YouTube授权窗口：与抖音授权同构（远程登录页 + 底部本地确认栏）。
fn show_youtube_auth_windows(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window(YOUTUBE_AUTH_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    let auth_window = WindowBuilder::new(app, YOUTUBE_AUTH_WINDOW)
        .title("YouTube授权")
        .inner_size(980.0, 720.0)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("无法打开YouTube授权窗口: {e}"))?;
    let login_url = YOUTUBE_LOGIN_URL
        .parse()
        .map_err(|e| format!("YouTube登录地址无效: {e}"))?;
    auth_window
        .add_child(
            WebviewBuilder::new(YOUTUBE_LOGIN_WEBVIEW, WebviewUrl::External(login_url)),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(980.0, 720.0 - AUTH_CONTROLS_HEIGHT),
        )
        .map_err(|e| format!("无法加载YouTube登录页面: {e}"))?;
    auth_window
        .add_child(
            WebviewBuilder::new(YOUTUBE_CONTROLS_WEBVIEW, WebviewUrl::App("src/window-entries/platform-auth/youtube-auth.html".into())),
            LogicalPosition::new(0.0, 720.0 - AUTH_CONTROLS_HEIGHT),
            LogicalSize::new(980.0, AUTH_CONTROLS_HEIGHT),
        )
        .map_err(|e| format!("无法加载YouTube授权确认栏: {e}"))?;
    Ok(())
}

fn close_youtube_auth_windows(app: &AppHandle) {
    if let Some(window) = app.get_window(YOUTUBE_AUTH_WINDOW) {
        let _ = window.close();
    }
}

#[tauri::command]
async fn start_douyin_authorization(app: AppHandle) -> Result<(), String> {
    // WebView2 can deadlock when a child webview is created synchronously from
    // an invoke handler. Use a worker thread on both desktop runtimes; Tauri
    // dispatches the native window work to the appropriate UI thread.
    tauri::async_runtime::spawn_blocking(move || show_douyin_auth_windows(&app))
        .await
        .map_err(|e| format!("创建抖音授权窗口任务异常: {e}"))?
}

#[tauri::command]
async fn start_bilibili_authorization(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || show_bilibili_auth_windows(&app))
        .await
        .map_err(|e| format!("创建B站授权窗口任务异常: {e}"))?
}

#[tauri::command]
async fn start_xiaohongshu_authorization(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || show_xiaohongshu_auth_windows(&app))
        .await
        .map_err(|e| format!("创建小红书授权窗口任务异常: {e}"))?
}

fn douyin_cookie_header(app: &AppHandle) -> Result<String, String> {
    let window = app
        .get_webview(DOUYIN_LOGIN_WEBVIEW)
        .ok_or_else(|| "授权窗口已关闭，请重新打开后完成登录".to_string())?;
    // Read the entire native store rather than only www.douyin.com: the login
    // flow may finish on live.douyin.com, whose host-only login cookie is not
    // returned for the www URL. This API includes HttpOnly cookies.
    let mut pairs: Vec<String> = window
        .cookies()
        .map_err(|e| format!("无法读取抖音登录凭证: {e}"))?
        .into_iter()
        .filter(|cookie| {
            cookie
                .domain()
                .is_none_or(|domain| domain.trim_start_matches('.').ends_with("douyin.com"))
        })
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect();
    pairs.sort();
    pairs.dedup();
    if !pairs.iter().any(|pair| pair.starts_with("sessionid=") || pair.starts_with("sessionid_ss=")) {
        return Err("尚未检测到抖音登录态。请先在上方窗口登录抖音，再点击“完成登录并授权”。".to_string());
    }
    if !pairs.iter().any(|pair| pair.starts_with("ttwid=")) {
        return Err("登录凭证尚未完整写入。请等待几秒后刷新抖音页面，再点击“完成登录并授权”。".to_string());
    }
    Ok(pairs.join("; "))
}

fn verify_douyin_login(cookie: &str) -> Result<(), String> {
    // Presence of sessionid alone is not proof of an active session: Douyin
    // leaves expired credentials in the native cookie store after logout. Its
    // creator endpoint returns status_code=0 only for an authenticated user and
    // 8 for an anonymous/expired session.
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("无法创建抖音登录校验请求: {e}"))?
        .get("https://creator.douyin.com/web/api/media/user/info")
        .header("Cookie", cookie)
        .header("Referer", "https://creator.douyin.com/")
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .send()
        .map_err(|e| format!("无法确认抖音登录状态，请检查网络后重试: {e}"))?;
    if !response.status().is_success() {
        return Err("无法确认抖音登录状态，请稍后重试。授权未保存。".to_string());
    }
    let status_code = response
        .json::<serde_json::Value>()
        .ok()
        .and_then(|body| body.get("status_code").and_then(|value| value.as_i64()));
    match status_code {
        Some(0) => Ok(()),
        Some(8) => Err("抖音当前未登录或登录已失效。请在上方网页登录后再授权。".to_string()),
        _ => Err("暂时无法确认抖音登录状态。请完成网页登录后稍候重试；授权未保存。".to_string()),
    }
}

fn save_douyin_cookie(cookie: String) -> Result<(), String> {
    verify_douyin_login(&cookie)?;
    let instance = backend::fetch_ready().ok_or_else(|| "本地服务尚未就绪，请稍候重试".to_string())?;
    let response = reqwest::blocking::Client::new()
        .post(format!("{}/api/v1/settings/douyin-cookie", instance.base_url))
        .json(&serde_json::json!({ "cookie": cookie }))
        .send()
        .map_err(|e| format!("保存抖音授权失败: {e}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let detail = response
        .json::<serde_json::Value>()
        .ok()
        .and_then(|body| body.pointer("/error/message").and_then(|value| value.as_str()).map(str::to_owned))
        .unwrap_or_else(|| format!("服务返回 {status}"));
    Err(format!("保存抖音授权失败: {detail}"))
}

#[tauri::command]
async fn complete_douyin_authorization(app: AppHandle) -> Result<(), String> {
    // WebView2 can deadlock when cookies are read synchronously on its event
    // thread. Run both native cookie access and the local HTTP write off-thread.
    let handle = app.clone();
    let cookie = tauri::async_runtime::spawn_blocking(move || douyin_cookie_header(&handle))
        .await
        .map_err(|e| format!("读取抖音授权任务异常: {e}"))??;
    tauri::async_runtime::spawn_blocking(move || save_douyin_cookie(cookie))
        .await
        .map_err(|e| format!("保存抖音授权任务异常: {e}"))??;
    close_douyin_auth_windows(&app);
    let _ = app.emit(DOUYIN_AUTHORIZED_EVENT, ());
    Ok(())
}

fn bilibili_cookie_header(app: &AppHandle) -> Result<String, String> {
    let window = app
        .get_webview(BILIBILI_LOGIN_WEBVIEW)
        .ok_or_else(|| "授权窗口已关闭，请重新打开后完成登录".to_string())?;
    // 与抖音同理：passport 与主站分属不同 host，只按其中一个过滤会漏掉登录流程
    // 落在 live.bilibili.com 的 host-only Cookie。这里读取整个原生存储（含 HttpOnly）。
    let mut pairs: Vec<String> = window
        .cookies()
        .map_err(|e| format!("无法读取B站登录凭证: {e}"))?
        .into_iter()
        .filter(|cookie| {
            cookie
                .domain()
                .is_none_or(|domain| domain.trim_start_matches('.').ends_with("bilibili.com"))
        })
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect();
    pairs.sort();
    pairs.dedup();
    if !pairs.iter().any(|pair| pair.starts_with("SESSDATA=")) {
        return Err("尚未检测到B站登录态。请先在上方窗口登录B站，再点击“完成登录并授权”。".to_string());
    }
    if !pairs.iter().any(|pair| pair.starts_with("DedeUserID=")) {
        return Err("登录凭证尚未完整写入。请等待几秒后刷新B站页面，再点击“完成登录并授权”。".to_string());
    }
    Ok(pairs.join("; "))
}

fn xiaohongshu_cookie_header(app: &AppHandle) -> Result<String, String> {
    let window = app
        .get_webview(XIAOHONGSHU_LOGIN_WEBVIEW)
        .ok_or_else(|| "授权窗口已关闭，请重新打开后完成登录".to_string())?;
    // 与抖音同理：passport 与主站分属不同 host，只按其中一个过滤会漏掉登录流程
    // 落在 live.xiaohongshu.com 的 host-only Cookie。这里读取整个原生存储（含 HttpOnly）。
    let mut pairs: Vec<String> = window
        .cookies()
        .map_err(|e| format!("无法读取小红书登录凭证: {e}"))?
        .into_iter()
        .filter(|cookie| {
            cookie
                .domain()
                .is_some_and(|domain| { let host = domain.trim_start_matches('.'); host == "xiaohongshu.com" || host.ends_with(".xiaohongshu.com") })
        })
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect();
    pairs.sort();
    pairs.dedup();
    if !pairs.iter().any(|pair| pair.starts_with("web_session=")) {
        return Err("尚未检测到小红书登录态。请先在上方窗口登录小红书，再点击“完成登录并授权”。".to_string());
    }
    Ok(pairs.join("; "))
}

fn verify_bilibili_login(cookie: &str) -> Result<(), String> {
    // Presence of SESSDATA alone is not proof of an active session: B站 会在退出登录后
    // 把过期凭证留在原生 Cookie 库里。nav 接口仅在已登录时返回 code=0 且 data.isLogin=true，
    // 匿名/过期会话返回 code=-101。
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("无法创建B站登录校验请求: {e}"))?
        .get("https://api.bilibili.com/x/web-interface/nav")
        .header("Cookie", cookie)
        .header("Referer", "https://www.bilibili.com/")
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .send()
        .map_err(|e| format!("无法确认B站登录状态，请检查网络后重试: {e}"))?;
    if !response.status().is_success() {
        return Err("无法确认B站登录状态，请稍后重试。授权未保存。".to_string());
    }
    let parsed = response.json::<serde_json::Value>().ok();
    let code = parsed.as_ref().and_then(|body| body.get("code").and_then(|value| value.as_i64()));
    let is_login = parsed
        .as_ref()
        .and_then(|body| body.pointer("/data/isLogin").and_then(|value| value.as_bool()));
    if code == Some(0) && is_login == Some(true) {
        return Ok(());
    }
    if code == Some(-101) || is_login == Some(false) {
        return Err("B站当前未登录或登录已失效。请在上方网页登录后再授权。".to_string());
    }
    Err("暂时无法确认B站登录状态。请完成网页登录后稍候重试；授权未保存。".to_string())
}

fn save_bilibili_cookie(cookie: String) -> Result<(), String> {
    verify_bilibili_login(&cookie)?;
    let instance = backend::fetch_ready().ok_or_else(|| "本地服务尚未就绪，请稍候重试".to_string())?;
    let response = reqwest::blocking::Client::new()
        .post(format!("{}/api/v1/settings/bilibili-cookie", instance.base_url))
        .json(&serde_json::json!({ "cookie": cookie }))
        .send()
        .map_err(|e| format!("保存B站授权失败: {e}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let detail = response
        .json::<serde_json::Value>()
        .ok()
        .and_then(|body| body.pointer("/error/message").and_then(|value| value.as_str()).map(str::to_owned))
        .unwrap_or_else(|| format!("服务返回 {status}"));
    Err(format!("保存B站授权失败: {detail}"))
}

#[tauri::command]
async fn complete_bilibili_authorization(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let cookie = tauri::async_runtime::spawn_blocking(move || bilibili_cookie_header(&handle))
        .await
        .map_err(|e| format!("读取B站授权任务异常: {e}"))??;
    tauri::async_runtime::spawn_blocking(move || save_bilibili_cookie(cookie))
        .await
        .map_err(|e| format!("保存B站授权任务异常: {e}"))??;
    close_bilibili_auth_windows(&app);
    let _ = app.emit(BILIBILI_AUTHORIZED_EVENT, ());
    Ok(())
}

fn save_xiaohongshu_cookie(cookie: String) -> Result<(), String> {
    // Cookie shape is validated by the backend; signed platform probes run separately.
    let instance = backend::fetch_ready().ok_or_else(|| "本地服务尚未就绪，请稍候重试".to_string())?;
    let response = reqwest::blocking::Client::new()
        .post(format!("{}/api/v1/settings/xiaohongshu-cookie", instance.base_url))
        .json(&serde_json::json!({ "cookie": cookie }))
        .send()
        .map_err(|e| format!("保存小红书授权失败: {e}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let detail = response
        .json::<serde_json::Value>()
        .ok()
        .and_then(|body| body.pointer("/error/message").and_then(|value| value.as_str()).map(str::to_owned))
        .unwrap_or_else(|| format!("服务返回 {status}"));
    Err(format!("保存小红书授权失败: {detail}"))
}

#[tauri::command]
async fn complete_xiaohongshu_authorization(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let cookie = tauri::async_runtime::spawn_blocking(move || xiaohongshu_cookie_header(&handle))
        .await
        .map_err(|e| format!("读取小红书授权任务异常: {e}"))??;
    tauri::async_runtime::spawn_blocking(move || save_xiaohongshu_cookie(cookie))
        .await
        .map_err(|e| format!("保存小红书授权任务异常: {e}"))??;
    close_xiaohongshu_auth_windows(&app);
    let _ = app.emit(XIAOHONGSHU_AUTHORIZED_EVENT, ());
    Ok(())
}

/// 从原生 Cookie 库读到的单条凭证；保留域/路径/安全位，供 Netscape 序列化。
struct CapturedCookie {
    domain: String,
    path: String,
    secure: bool,
    http_only: bool,
    name: String,
    value: String,
}

fn youtube_captured_cookies(app: &AppHandle) -> Result<Vec<CapturedCookie>, String> {
    let window = app
        .get_webview(YOUTUBE_LOGIN_WEBVIEW)
        .ok_or_else(|| "授权窗口已关闭，请重新打开后完成登录".to_string())?;
    // Google 登录态横跨 accounts.google.com 与 youtube.com 两家域：登录完成标记（LOGIN_INFO）
    // 与 API 凭证（SAPISID 家族）分别落在两家，只收一家会误判登录态。
    Ok(window
        .cookies()
        .map_err(|e| format!("无法读取YouTube登录凭证: {e}"))?
        .into_iter()
        .filter(|cookie| {
            cookie.domain().is_some_and(|domain| {
                let host = domain.trim_start_matches('.').to_lowercase();
                host == "youtube.com"
                    || host.ends_with(".youtube.com")
                    || host == "google.com"
                    || host.ends_with(".google.com")
            })
        })
        .map(|cookie| CapturedCookie {
            domain: cookie.domain().unwrap_or("youtube.com").to_string(),
            path: cookie.path().unwrap_or("/").to_string(),
            secure: cookie.secure().unwrap_or(false),
            http_only: cookie.http_only().unwrap_or(false),
            name: cookie.name().to_string(),
            value: cookie.value().to_string(),
        })
        .collect())
}

fn youtube_cookie_header(cookies: &[CapturedCookie]) -> Result<String, String> {
    let on_youtube = |cookie: &CapturedCookie| {
        cookie.domain.trim_start_matches('.').ends_with("youtube.com")
    };
    let has_login = cookies
        .iter()
        .any(|cookie| on_youtube(cookie) && cookie.name == "LOGIN_INFO" && !cookie.value.is_empty());
    let has_api = cookies.iter().any(|cookie| {
        on_youtube(cookie)
            && matches!(
                cookie.name.as_str(),
                "SAPISID" | "__Secure-3PAPISID" | "__Secure-1PAPISID" | "SID"
            )
            && !cookie.value.is_empty()
    });
    if !has_login {
        return Err(
            "尚未检测到YouTube登录态。请先在上方窗口登录YouTube，再点击“完成登录并授权”。"
                .to_string(),
        );
    }
    if !has_api {
        return Err(
            "登录凭证尚未完整写入。请等待几秒后刷新YouTube页面，再点击“完成登录并授权”。"
                .to_string(),
        );
    }
    Ok(youtube_probe_header(cookies))
}

/// 探活请求只拼 youtube.com 域 Cookie——浏览器发往 youtube.com 也只带该域凭证。
/// 同名多份时优先域更宽的一份；历史上 google/youtube 双域同名不同值会同时进头，
/// 服务端取到失效那份就会误判未登录。
fn youtube_probe_header(cookies: &[CapturedCookie]) -> String {
    let mut picked: Vec<(&str, &str, bool)> = Vec::new();
    for cookie in cookies {
        if !cookie.domain.trim_start_matches('.').ends_with("youtube.com") {
            continue;
        }
        let wide = cookie.domain.starts_with('.');
        match picked.iter_mut().find(|(name, _, _)| *name == cookie.name) {
            Some(slot) if wide && !slot.2 => {
                slot.1 = &cookie.value;
                slot.2 = true;
            }
            Some(_) => {}
            None => picked.push((cookie.name.as_str(), cookie.value.as_str(), wide)),
        }
    }
    picked.sort_by(|a, b| a.0.cmp(b.0));
    picked
        .into_iter()
        .map(|(name, value, _)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// 失败诊断只含 Cookie 名与计数，绝不带值。
fn youtube_cookie_diag(cookies: &[CapturedCookie]) -> String {
    let mut names: Vec<&str> = cookies.iter().map(|cookie| cookie.name.as_str()).collect();
    names.sort_unstable();
    let duplicates = names
        .windows(2)
        .filter(|pair| pair[0] == pair[1])
        .count();
    format!(
        "捕获 {} 项（youtube/google 同名重复 {} 处），字段名：{}",
        names.len(),
        duplicates,
        names.join(",")
    )
}

fn youtube_netscape_file(cookies: &[CapturedCookie]) -> String {
    // Netscape 七列：域、子域标记、路径、安全标记、过期、名、值；HttpOnly 行带 #HttpOnly_ 前缀。
    // 过期统一写 0（会话级）：这是授权时点的快照，失效与否由平台探活判定。
    let mut text = String::from("# Netscape HTTP Cookie File\n");
    for cookie in cookies {
        let value = cookie.value.replace(['\t', '\n', '\r'], "");
        text.push_str(&format!(
            "{}{}\t{}\t{}\t{}\t0\t{}\t{}\n",
            if cookie.http_only { "#HttpOnly_" } else { "" },
            cookie.domain,
            if cookie.domain.starts_with('.') { "TRUE" } else { "FALSE" },
            cookie.path,
            if cookie.secure { "TRUE" } else { "FALSE" },
            cookie.name,
            value,
        ));
    }
    text
}

/// 探活落点分类：真未登录 / 安全验证 / 地区确认 / 正常页面。
/// 只按 host+path 判，不拿查询串宽匹配（continue 参数里常挾带 accounts.google.com 字样）。
fn classify_auth_landing(url: &reqwest::Url) -> &'static str {
    let host = url.host_str().unwrap_or("");
    let path = url.path();
    if host == "consent.youtube.com" || host == "consent.google.com" {
        return "consent";
    }
    if host == "accounts.google.com" {
        if path.contains("challenge") || path.contains("recaptcha") {
            return "challenge";
        }
        return "signin";
    }
    "page"
}

/// 探活与 webview 登录必须同网络出口：GUI 进程没有 shell 的代理环境变量，
/// 直连出口与代理出口不同 IP 会触发 Google 重验证，被误判成未登录。
fn system_settings_proxy() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/sbin/scutil")
            .arg("--proxy")
            .output()
            .ok()?;
        return parse_macos_proxy(&String::from_utf8_lossy(&output.stdout));
    }
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer | ConvertTo-Json -Compress",
            ])
            .output()
            .ok()?;
        return parse_windows_proxy(&String::from_utf8_lossy(&output.stdout));
    }
    #[allow(unreachable_code)]
    None
}

fn parse_macos_proxy(text: &str) -> Option<String> {
    for kind in ["HTTPS", "HTTP"] {
        let enabled =
            text.contains(&format!("{kind}Enable : 1")) || text.contains(&format!("{kind}Enable: 1"));
        if !enabled {
            continue;
        }
        let host = text
            .split(&format!("{kind}Proxy"))
            .nth(1)
            .and_then(|rest| rest.split_whitespace().nth(1));
        let port = text
            .split(&format!("{kind}Port"))
            .nth(1)
            .and_then(|rest| rest.split_whitespace().nth(1));
        if let (Some(host), Some(port)) = (host, port) {
            return Some(format!("http://{host}:{port}"));
        }
    }
    None
}

fn parse_windows_proxy(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("ProxyEnable").and_then(|v| v.as_i64()) != Some(1) {
        return None;
    }
    let server = value.get("ProxyServer")?.as_str()?;
    for prefix in ["https=", "http="] {
        if let Some(rest) = server.split(';').find_map(|part| part.strip_prefix(prefix)) {
            return Some(if rest.contains("://") { rest.to_string() } else { format!("http://{rest}") });
        }
    }
    if server.contains('=') {
        return None;
    }
    Some(if server.contains("://") { server.to_string() } else { format!("http://{server}") })
}

fn verify_youtube_login(cookie: &str) -> Result<(), String> {
    // 字段存在不等于登录态有效：退出登录后原生 Cookie 库同样残留过期凭证。
    // 首页对匿名也返回 200，以页内 LOGGED_IN 标记为准；落点只按 host+path 分类。
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15));
    if std::env::var("HTTPS_PROXY").or_else(|_| std::env::var("https_proxy")).is_err() {
        if let Some(proxy) = system_settings_proxy() {
            if let Ok(target) = reqwest::Proxy::all(&proxy) {
                builder = builder.proxy(target);
            }
        }
    }
    let response = builder
        .build()
        .map_err(|e| format!("无法创建YouTube登录校验请求: {e}"))?
        .get("https://www.youtube.com/")
        .header("Cookie", cookie)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .send()
        .map_err(|e| format!("无法确认YouTube登录状态，请检查网络后重试: {e}"))?;
    let landing = classify_auth_landing(response.url());
    let where_ = format!("{}{}", response.url().host_str().unwrap_or(""), response.url().path());
    match landing {
        "signin" => Err(format!(
            "YouTube当前未登录或登录已失效。请在上方网页登录后再授权。（探活落点：{where_}）"
        )),
        "challenge" => Err(format!(
            "Google要求安全验证（确认是本人操作）。请在上方窗口按页面提示完成验证后再点击按钮；授权未保存。（探活落点：{where_}）"
        )),
        "consent" => Err(format!(
            "暂时无法确认YouTube登录状态（地区确认页）。请在页面完成确认后重试；授权未保存。（探活落点：{where_}）"
        )),
        _ if response.status().is_success() => {
            let body = response.text().unwrap_or_default();
            if body.contains("\"LOGGED_IN\":true") {
                return Ok(());
            }
            if body.contains("\"LOGGED_IN\":false") {
                return Err(format!(
                    "YouTube当前未登录或登录已失效。请在上方网页登录后再授权。（探活落点：{where_}）"
                ));
            }
            Err(format!(
                "暂时无法确认YouTube登录状态。请完成网页登录后稍候重试；授权未保存。（探活落点：{where_}）"
            ))
        }
        _ => Err(format!(
            "暂时无法确认YouTube登录状态。请完成网页登录后稍候重试；授权未保存。（探活落点：{where_}）"
        )),
    }
}

fn save_youtube_cookie(cookie_header: String, netscape: String) -> Result<(), String> {
    verify_youtube_login(&cookie_header)?;
    let instance = backend::fetch_ready().ok_or_else(|| "本地服务尚未就绪，请稍候重试".to_string())?;
    // 存储契约沿用既有 Netscape 全文格式，yt-dlp 消费链与旧导入数据不受影响。
    let response = reqwest::blocking::Client::new()
        .post(format!("{}/api/v1/settings/youtube-cookie", instance.base_url))
        .json(&serde_json::json!({ "cookie": netscape }))
        .send()
        .map_err(|e| format!("保存YouTube授权失败: {e}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let detail = response
        .json::<serde_json::Value>()
        .ok()
        .and_then(|body| body.pointer("/error/message").and_then(|value| value.as_str()).map(str::to_owned))
        .unwrap_or_else(|| format!("服务返回 {status}"));
    Err(format!("保存YouTube授权失败: {detail}"))
}

#[tauri::command]
async fn complete_youtube_authorization(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let cookies = tauri::async_runtime::spawn_blocking(move || youtube_captured_cookies(&handle))
        .await
        .map_err(|e| format!("读取YouTube授权任务异常: {e}"))??;
    let cookie_header = youtube_cookie_header(&cookies)?;
    let netscape = youtube_netscape_file(&cookies);
    let diag = youtube_cookie_diag(&cookies);
    tauri::async_runtime::spawn_blocking(move || save_youtube_cookie(cookie_header, netscape))
        .await
        .map_err(|e| format!("保存YouTube授权任务异常: {e}"))?
        .map_err(|e| format!("{e}（{diag}）"))?;
    close_youtube_auth_windows(&app);
    let _ = app.emit(YOUTUBE_AUTHORIZED_EVENT, ());
    Ok(())
}

#[tauri::command]
async fn start_youtube_authorization(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || show_youtube_auth_windows(&app))
        .await
        .map_err(|e| format!("创建YouTube授权窗口任务异常: {e}"))?
}

/// 唤起主窗口（托盘 open / 单实例恢复 / macOS Dock Reopen 共用）：
/// macOS 上 show() 不会取消最小化（miniaturize），需 unminimize() 后再 set_focus，
/// 否则窗口停在 Dock 最小化栏「唤不出」（QA #7 / tauri#12392）。
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    emit_window_visibility(app);
}

#[tauri::command]
fn get_window_visible(app: AppHandle) -> bool { main_window_visible(&app) }

#[tauri::command]
async fn get_app_instance() -> Option<contract::AppInstance> {
    // #233：fetch_ready 含 reqwest::blocking，移出主线程避免阻塞 UI。
    tauri::async_runtime::spawn_blocking(backend::fetch_ready)
        .await
        .ok()
        .flatten()
}

#[tauri::command]
async fn get_health() -> Option<contract::Health> {
    tauri::async_runtime::spawn_blocking(|| {
        backend::fetch_ready().and_then(|instance| backend::fetch_health(instance.port))
    })
    .await
    .ok()
    .flatten()
}

/// 同步执行服务启动（backend.start() 含 spawn + 最长 ~30s health 轮询，均为阻塞调用）。
/// 必须在非主线程调用（#233：主线程跑会阻塞 UI → 整客户端卡死）。
fn start_service_sync(app: &AppHandle, restart: bool) -> Result<BootEvent, String> {
    let state = app.state::<ShellState>();
    state.set_boot(app, BootState::Booting);
    match if restart {
        state.backend.restart()
    } else {
        state.backend.start()
    } {
        Ok(instance) => {
            let event = BootEvent {
                state: BootState::Ready,
                instance: Some(instance),
                diagnostics: vec![],
            };
            state.set_boot(app, BootState::Ready);
            Ok(event)
        }
        Err(message) => {
            let event = BootEvent {
                state: BootState::Degraded,
                instance: None,
                diagnostics: vec![DiagnosticItem::Error {
                    key: "service".to_string(),
                    message: "本地服务未就绪".to_string(),
                    detail: Some(message),
                }],
            };
            state.set_boot(app, BootState::Degraded);
            Ok(event)
        }
    }
}

#[tauri::command]
async fn start_service(app: AppHandle) -> Result<BootEvent, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || start_service_sync(&handle, false))
        .await
        .map_err(|e| format!("启动服务任务异常: {e}"))?
}

#[tauri::command]
async fn stop_service(app: AppHandle) {
    let handle = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<ShellState>();
        let _ = state.backend.stop();
    })
    .await;
}

#[tauri::command]
async fn restart_service(app: AppHandle) -> Result<BootEvent, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || start_service_sync(&handle, true))
        .await
        .map_err(|e| format!("重启服务任务异常: {e}"))?
}

#[tauri::command]
async fn get_diagnostics(app: AppHandle) -> Vec<DiagnosticItem> {
    // 返回实际启动阶段/原始错误，不再用一次探测覆盖错误上下文。
    app.state::<ShellState>().backend.diagnostics()
}

#[tauri::command]
async fn quit_app(app: AppHandle) {
    // Graceful exit: stop the backend service first, then exit the app.
    // #233：停止服务含 SIGTERM + 等待子进程退出，属阻塞调用；在主线程执行会把整个
    // 客户端卡住（直播墙等有活跃预览连接时尤其明显），必须移出主线程。
    let handle = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<ShellState>();
        let _ = state.backend.stop();
    })
    .await;
    app.exit(0);
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重新启动服务", true, None::<&str>)?;
    let diagnostics = MenuItem::with_id(app, "diagnostics", "打开诊断", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出应用", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &restart, &sep, &diagnostics, &sep, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        // 所有平台托盘使用透明底 PNG，独立于 macOS 白底应用 ICNS。
        .icon(tauri::include_image!("icons/32x32.png"))
        .icon_as_template(false)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                show_main_window(app);
            }
            "restart" => {
                let _ = app.emit("tray:restart", ());
            }
            "diagnostics" => {
                let _ = app.emit("tray:diagnostics", ());
            }
            "quit" => {
                // Only our own frontend can confirm; emit so the UI can ask the
                // user before calling quit_app.
                let _ = app.emit("tray:quit", ());
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window instead of starting a second UI/service.
            show_main_window(app);
            // 此回调运行在已有主实例中；只唤醒窗口，不能把正常工作台切成“已有实例”。
        }))
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(updates::UpdateManager::default())
        .manage(ShellState {
            backend: BackendManager::new(),
            boot: Mutex::new(BootState::Booting),
            floating_recorder: Mutex::new(FloatingRecorderState { target_room_id: None, button_size: DEFAULT_FLOATING_RECORDER_SIZE }),
        })
        .on_window_event(|window, event| {
            // Close to tray by default: the main window hides rather than
            // destroys, so the recording service keeps running. Real exit is
            // driven by the tray "quit" flow with frontend confirmation.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    emit_window_visibility(&window.app_handle());
                }
                if window.label() == FLOATING_RECORDER_WINDOW {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if let tauri::WindowEvent::Moved(position) = event {
                if window.label() == FLOATING_RECORDER_WINDOW {
                    save_floating_position(&window.app_handle(), *position);
                    let _ = window.app_handle().emit_to(FLOATING_RECORDER_WINDOW, FLOATING_RECORDER_MOVED_EVENT, ());
                }
            }
            if let tauri::WindowEvent::Resized(size) = event {
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                if window.label() == "main" {
                    save_main_window_size(&window.app_handle(), *size);
                }
                if window.label() == DOUYIN_AUTH_WINDOW || window.label() == BILIBILI_AUTH_WINDOW || window.label() == XIAOHONGSHU_AUTH_WINDOW || window.label() == YOUTUBE_AUTH_WINDOW {
                    // The remote child webview occupies all but the bottom
                    // confirmation bar, including after user resizes.
                    if let Ok(scale_factor) = window.scale_factor() {
                        let (login_label, controls_label) = if window.label() == DOUYIN_AUTH_WINDOW {
                            (DOUYIN_LOGIN_WEBVIEW, DOUYIN_CONTROLS_WEBVIEW)
                        } else if window.label() == XIAOHONGSHU_AUTH_WINDOW {
                            (XIAOHONGSHU_LOGIN_WEBVIEW, XIAOHONGSHU_CONTROLS_WEBVIEW)
                        } else if window.label() == YOUTUBE_AUTH_WINDOW {
                            (YOUTUBE_LOGIN_WEBVIEW, YOUTUBE_CONTROLS_WEBVIEW)
                        } else {
                            (BILIBILI_LOGIN_WEBVIEW, BILIBILI_CONTROLS_WEBVIEW)
                        };
                        layout_auth_window(&window.app_handle(), *size, scale_factor, login_label, controls_label);
                    }
                }
                emit_window_visibility(&window.app_handle());
            }
            if matches!(event, tauri::WindowEvent::Focused(_)) {
                emit_window_visibility(&window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            updates::get_update_state,
            updates::check_update,
            updates::download_update,
            updates::install_update,
            get_app_instance,
            get_health,
            start_service,
            stop_service,
            restart_service,
            get_diagnostics,
            get_window_visible,
            show_floating_recorder,
            get_floating_recorder_state,
            hide_floating_recorder,
            set_floating_recorder_size,
            start_douyin_authorization,
            complete_douyin_authorization,
            start_bilibili_authorization,
            complete_bilibili_authorization,
            start_xiaohongshu_authorization,
            complete_xiaohongshu_authorization,
            start_youtube_authorization,
            complete_youtube_authorization,
            quit_app,
        ])
        .setup(|app| {
            power::start(app.handle().clone());
            xiaohongshu::start(app.handle().clone());
            // This runs before the event loop begins, so the saved dimensions
            // are applied as the native window is being brought up.
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            restore_main_window_size(&app.handle());
            setup_tray(app)?;
            // Observe the child independently of UI health polling. It never
            // kills a slow process: BackendManager only returns a recovery
            // result after try_wait confirms the child actually exited.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                let state = handle.state::<ShellState>();
                if let Some(result) = state.backend.recover_if_exited() {
                    match result {
                        Ok(instance) => {
                            state.set_boot(&handle, BootState::Ready);
                            let _ = handle.emit("boot:recovered", instance);
                        }
                        Err(_) => state.set_boot(&handle, BootState::Degraded),
                    }
                }
            });
            // 由前端 start_service 统一启动并接收结果，避免两条启动链交错发出状态事件。
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Cmd+Q / Dock 退出不会经过托盘 quit_app 命令，后端子进程会成孤儿残留
        // 占用 43120，导致升级新版时后端不更新。这里在进程退出时兜底停掉后端。
        if let tauri::RunEvent::Exit = event {
            let state = app_handle.state::<ShellState>();
            let _ = state.backend.stop();
        }
        // macOS Dock 图标点击 / 应用重新激活（applicationShouldHandleReopen）：
        // 窗口被 hide（close-to-tray）或最小化后，点击 Dock 图标必须重新唤出主窗口。
        // 缺失该处理时隐藏窗口无法通过 Dock 唤回（QA #7）。
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show_main_window(&app_handle);
        }
    });
}

#[cfg(test)]
mod youtube_auth_tests {
    use super::*;

    fn cookie(domain: &str, name: &str, value: &str) -> CapturedCookie {
        CapturedCookie {
            domain: domain.to_string(),
            path: "/".to_string(),
            secure: true,
            http_only: false,
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn probe_header_prefers_youtube_scope_and_drops_google_duplicates() {
        let cookies = vec![
            cookie(".google.com", "SID", "stale-google"),
            cookie(".youtube.com", "SID", "fresh-youtube"),
            cookie(".youtube.com", "LOGIN_INFO", "login"),
            cookie(".google.com", "GPS", "google-only"),
        ];
        let header = youtube_probe_header(&cookies);
        assert_eq!(header, "LOGIN_INFO=login; SID=fresh-youtube");
    }

    #[test]
    fn probe_header_prefers_the_wider_scope_for_same_domain_duplicates() {
        let cookies = vec![
            cookie("www.youtube.com", "PREF", "host-only"),
            cookie(".youtube.com", "PREF", "domain-wide"),
        ];
        assert_eq!(youtube_probe_header(&cookies), "PREF=domain-wide");
    }

    #[test]
    fn landing_classification_ignores_query_strings_and_splits_buckets() {
        let parse = |text: &str| reqwest::Url::parse(text).unwrap();
        assert_eq!(
            classify_auth_landing(&parse("https://consent.youtube.com/?continue=https://accounts.google.com/x")),
            "consent"
        );
        assert_eq!(
            classify_auth_landing(&parse("https://accounts.google.com/ServiceLogin?continue=https://www.youtube.com/")),
            "signin"
        );
        assert_eq!(
            classify_auth_landing(&parse("https://accounts.google.com/v3/signin/challenge/pwd")),
            "challenge"
        );
        assert_eq!(
            classify_auth_landing(&parse("https://www.youtube.com/?continue=accounts.google.com")),
            "page"
        );
    }

    #[test]
    fn system_proxy_parsing_matches_platform_settings_shapes() {
        let macos = "\nHTTPEnable : 1\nHTTPPort : 7890\nHTTPProxy : 127.0.0.1\nHTTPSEnable : 1\nHTTPSPort : 7891\nHTTPSProxy : 127.0.0.2\n";
        assert_eq!(parse_macos_proxy(macos).as_deref(), Some("http://127.0.0.2:7891"));
        let windows = "{\"ProxyEnable\":1,\"ProxyServer\":\"http=127.0.0.1:7890;https=127.0.0.2:7891\"}";
        assert_eq!(parse_windows_proxy(windows).as_deref(), Some("http://127.0.0.2:7891"));
        assert_eq!(parse_windows_proxy("{\"ProxyEnable\":0,\"ProxyServer\":\"x\"}"), None);
    }
}
