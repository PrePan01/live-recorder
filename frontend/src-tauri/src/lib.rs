mod backend;
mod contract;

use std::{fs, sync::Mutex};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, LogicalSize, Manager, State,
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
                emit_window_visibility(&window.app_handle());
            }
            if matches!(event, tauri::WindowEvent::Focused(_)) {
                emit_window_visibility(&window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_instance,
            get_health,
            start_service,
            stop_service,
            restart_service,
            get_diagnostics,
            get_window_visible,
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
