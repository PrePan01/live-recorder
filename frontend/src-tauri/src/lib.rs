mod backend;
mod contract;

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State,
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

/// 唤起主窗口（托盘 open / 单实例恢复 / macOS Dock Reopen 共用）：
/// macOS 上 show() 不会取消最小化（miniaturize），需 unminimize() 后再 set_focus，
/// 否则窗口停在 Dock 最小化栏「唤不出」（QA #7 / tauri#12392）。
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

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
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_instance,
            get_health,
            start_service,
            stop_service,
            restart_service,
            get_diagnostics,
            quit_app,
        ])
        .setup(|app| {
            setup_tray(app)?;
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
