mod backend;
mod contract;

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State,
};

use contract::{BootEvent, BootState, DiagnosticItem};
use backend::BackendManager;

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

#[tauri::command]
fn get_app_instance(_state: State<'_, ShellState>) -> Option<contract::AppInstance> {
    backend::fetch_ready()
}

#[tauri::command]
fn get_health() -> Option<contract::Health> {
    for port in backend_candidates() {
        if let Some(h) = backend::fetch_health(port) {
            return Some(h);
        }
    }
    None
}

#[tauri::command]
fn start_service(app: AppHandle, state: State<'_, ShellState>) -> Result<BootEvent, String> {
    state.set_boot(&app, BootState::Booting);
    match state.backend.start() {
        Ok(instance) => {
            let event = BootEvent {
                state: BootState::Ready,
                instance: Some(instance),
                diagnostics: vec![],
            };
            state.set_boot(&app, BootState::Ready);
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
            state.set_boot(&app, BootState::Degraded);
            Ok(event)
        }
    }
}

#[tauri::command]
fn stop_service(state: State<'_, ShellState>) {
    state.backend.stop();
}

#[tauri::command]
fn restart_service(app: AppHandle, state: State<'_, ShellState>) -> Result<BootEvent, String> {
    state.backend.stop();
    std::thread::sleep(std::time::Duration::from_millis(400));
    start_service(app, state)
}

#[tauri::command]
fn get_diagnostics() -> Vec<DiagnosticItem> {
    let mut items = vec![];
    match backend::fetch_ready() {
        Some(instance) => items.push(DiagnosticItem::Ok {
            key: "service".to_string(),
            message: format!("本地服务运行中（{}）", instance.port),
        }),
        None => items.push(DiagnosticItem::Error {
            key: "service".to_string(),
            message: "本地服务未就绪".to_string(),
            detail: Some("端口不可用或服务启动失败".to_string()),
        }),
    }
    items
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<'_, ShellState>) {
    // Graceful exit: stop the backend service first, then exit the app.
    state.backend.stop();
    app.exit(0);
}

fn backend_candidates() -> Vec<u16> {
    // P0 隔离硬化（#224）：仅本应用默认端口；健康检查不再探测候选范围，避免误连 dev（43140）。
    vec![backend::DEFAULT_PORT]
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重新启动服务", true, None::<&str>)?;
    let diagnostics = MenuItem::with_id(app, "diagnostics", "打开诊断", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出应用", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &restart, &sep, &diagnostics, &sep, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().unwrap())
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
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
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit("boot:existing-instance", ());
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
            // Kick off the boot sequence on launch.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let _ = start_service(handle.clone(), handle.state::<ShellState>());
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Cmd+Q / Dock 退出不会经过托盘 quit_app 命令，后端子进程会成孤儿残留
        // 占用 43120，导致升级新版时后端不更新。这里在进程退出时兜底停掉后端。
        if let tauri::RunEvent::Exit = event {
            let state = app_handle.state::<ShellState>();
            state.backend.stop();
        }
    });
}