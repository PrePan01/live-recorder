use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl,
    WindowBuilder,
};

use crate::{backend, layout_auth_window, AUTH_CONTROLS_HEIGHT};

struct Authorization {
    platform: &'static str,
    label: &'static str,
    window: &'static str,
    login: &'static str,
    controls: &'static str,
    login_url: &'static str,
    cookie_domain: &'static str,
    confirmation: &'static str,
    required_cookie: &'static str,
}

const PLATFORMS: [Authorization; 2] = [
    Authorization {
        platform: "douyu",
        label: "斗鱼",
        window: "douyu-auth",
        login: "douyu-auth-login-page",
        controls: "douyu-auth-controls",
        login_url: "https://www.douyu.com/",
        cookie_domain: "douyu.com",
        confirmation: "src/window-entries/platform-auth/douyu-auth.html",
        required_cookie: "acf_auth",
    },
    Authorization {
        platform: "huya",
        label: "虎牙",
        window: "huya-auth",
        login: "huya-auth-login-page",
        controls: "huya-auth-controls",
        login_url: "https://www.huya.com/",
        cookie_domain: "huya.com",
        confirmation: "src/window-entries/platform-auth/huya-auth.html",
        required_cookie: "yyuid",
    },
];

fn authorization(platform: &str) -> Result<&'static Authorization, String> {
    PLATFORMS
        .iter()
        .find(|entry| entry.platform == platform)
        .ok_or_else(|| "不支持此平台授权".to_string())
}

fn show(app: &AppHandle, entry: &Authorization) -> Result<(), String> {
    if let Some(window) = app.get_window(entry.window) {
        let _ = window.show();
        let _ = window.unminimize();
        return window
            .set_focus()
            .map_err(|_| "无法激活授权窗口".to_string());
    }
    let url = entry
        .login_url
        .parse()
        .map_err(|_| "登录地址无效".to_string())?;
    let window = WindowBuilder::new(app, entry.window)
        .title(format!("{}授权", entry.label))
        .inner_size(980.0, 720.0)
        .min_inner_size(720.0, 520.0)
        .build()
        .map_err(|_| format!("无法打开{}授权窗口", entry.label))?;
    let bar_top = 720.0 - AUTH_CONTROLS_HEIGHT;
    let result = window
        .add_child(
            WebviewBuilder::new(entry.login, WebviewUrl::External(url)),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(980.0, bar_top),
        )
        .and_then(|_| {
            window.add_child(
                WebviewBuilder::new(entry.controls, WebviewUrl::App(entry.confirmation.into())),
                LogicalPosition::new(0.0, bar_top),
                LogicalSize::new(980.0, AUTH_CONTROLS_HEIGHT),
            )
        });
    if result.is_err() {
        let _ = window.destroy();
    }
    result
        .map(|_| ())
        .map_err(|_| format!("无法加载{}授权页面", entry.label))
}

pub fn on_resize(window: &tauri::Window, size: tauri::PhysicalSize<u32>) {
    if let Some(entry) = PLATFORMS
        .iter()
        .find(|entry| entry.window == window.label())
    {
        if let Ok(scale) = window.scale_factor() {
            layout_auth_window(
                window.app_handle(),
                size,
                scale,
                entry.login,
                entry.controls,
            );
        }
    }
}

fn room_cookie(window: &Webview, entry: &Authorization) -> Result<String, String> {
    let origin = entry
        .login_url
        .parse::<tauri::Url>()
        .map_err(|_| "登录地址无效".to_string())?;
    #[cfg(target_os = "macos")]
    let cookies = window.cookies();
    #[cfg(not(target_os = "macos"))]
    let cookies = window.cookies_for_url(origin.clone());

    let host = origin
        .host_str()
        .ok_or_else(|| "登录地址无效".to_string())?;
    let mut pairs = std::collections::BTreeMap::new();
    let mut cookies = cookies.map_err(|_| format!("无法读取{}登录凭据", entry.label))?;
    cookies
        .sort_by_key(|cookie| std::cmp::Reverse(cookie.domain().map(str::len).unwrap_or_default()));
    for cookie in cookies {
        let Some(domain) = cookie.domain().map(|domain| domain.trim_start_matches('.')) else {
            continue;
        };
        if domain != entry.cookie_domain && domain != host {
            continue;
        }
        if cookie.path().is_some_and(|path| path != "/") || cookie.value().is_empty() {
            continue;
        }
        pairs
            .entry(cookie.name().to_string())
            .or_insert_with(|| cookie.value().to_string());
    }
    if !pairs.contains_key(entry.required_cookie) {
        return Err(format!(
            "尚未检测到{}登录凭据，请先在上方页面登录",
            entry.label
        ));
    }
    Ok(pairs
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; "))
}

fn save(entry: &Authorization, cookie: String) -> Result<(), String> {
    let instance =
        backend::fetch_ready().ok_or_else(|| "本地服务尚未就绪，请稍候重试".to_string())?;
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .and_then(|client| {
            client
                .post(format!(
                    "{}/api/v1/settings/{}-cookie",
                    instance.base_url, entry.platform
                ))
                .json(&serde_json::json!({ "cookie": cookie }))
                .send()
        })
        .map_err(|_| format!("保存{}授权失败", entry.label))?;
    if response.status().is_success() {
        return Ok(());
    }
    let detail = response.json::<serde_json::Value>().ok().and_then(|body| {
        body.pointer("/error/message")
            .and_then(|value| value.as_str())
            .map(str::to_owned)
    });
    Err(detail.unwrap_or_else(|| format!("保存{}授权失败", entry.label)))
}

#[tauri::command]
pub async fn start_chinese_live_authorization(
    app: AppHandle,
    platform: String,
) -> Result<(), String> {
    let entry = authorization(&platform)?;
    tauri::async_runtime::spawn_blocking(move || show(&app, entry))
        .await
        .map_err(|_| "创建授权窗口失败".to_string())?
}

#[tauri::command]
pub async fn complete_chinese_live_authorization(
    app: AppHandle,
    webview: Webview,
    platform: String,
) -> Result<(), String> {
    let entry = authorization(&platform)?;
    if webview.label() != entry.controls {
        return Err("请在该平台的授权窗口完成登录".to_string());
    }
    let login = app
        .get_webview(entry.login)
        .ok_or_else(|| "授权窗口已关闭".to_string())?;
    tauri::async_runtime::spawn_blocking(move || save(entry, room_cookie(&login, entry)?))
        .await
        .map_err(|_| "读取授权凭据失败".to_string())??;
    if let Some(window) = app.get_window(entry.window) {
        let _ = window.destroy();
    }
    let _ = app.emit(&format!("{}:authorized", entry.platform), ());
    Ok(())
}
