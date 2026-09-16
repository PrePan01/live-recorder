mod backend;
mod contract;
mod updates;

use std::{fs, sync::Mutex};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    window::WindowBuilder,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewBuilder, WebviewUrl,
};

use backend::BackendManager;
use contract::{BootEvent, BootState, DiagnosticItem};

struct ShellState {
    backend: BackendManager,
    boot: Mutex<BootState>,
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
            LogicalSize::new(980.0, 644.0),
        )
        .map_err(|e| format!("无法加载抖音登录页面: {e}"))?;
    auth_window
        .add_child(
            WebviewBuilder::new(DOUYIN_CONTROLS_WEBVIEW, WebviewUrl::App("douyin-auth.html".into())),
            LogicalPosition::new(0.0, 644.0),
            LogicalSize::new(980.0, 76.0),
        )
        .map_err(|e| format!("无法加载抖音授权确认栏: {e}"))?;
    Ok(())
}

fn close_douyin_auth_windows(app: &AppHandle) {
    if let Some(window) = app.get_window(DOUYIN_AUTH_WINDOW) {
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
fn quit_app(app: AppHandle, state: State<'_, ShellState>) {
    // Graceful exit: stop the backend service first, then exit the app.
    let _ = state.backend.stop();
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
            }
            if let tauri::WindowEvent::Resized(size) = event {
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                if window.label() == "main" {
                    save_main_window_size(&window.app_handle(), *size);
                }
                if window.label() == DOUYIN_AUTH_WINDOW {
                    // The remote child webview occupies all but the bottom
                    // confirmation bar, including after user resizes.
                    if let Ok(scale_factor) = window.scale_factor() {
                        let logical = size.to_logical::<f64>(scale_factor);
                        if let Some(login) = window.app_handle().get_webview(DOUYIN_LOGIN_WEBVIEW) {
                            let _ = login.set_size(LogicalSize::new(logical.width, (logical.height - 76.0).max(320.0)));
                        }
                        if let Some(controls) = window.app_handle().get_webview(DOUYIN_CONTROLS_WEBVIEW) {
                            let bar_top = (logical.height - 76.0).max(320.0);
                            let _ = controls.set_position(LogicalPosition::new(0.0, bar_top));
                            let _ = controls.set_size(LogicalSize::new(logical.width, 76.0));
                        }
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
            updates::open_update,
            get_app_instance,
            get_health,
            start_service,
            stop_service,
            restart_service,
            get_diagnostics,
            get_window_visible,
            start_douyin_authorization,
            complete_douyin_authorization,
            quit_app,
        ])
        .setup(|app| {
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
