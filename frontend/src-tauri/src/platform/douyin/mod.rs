use super::native_browser::{self, Job, Task};
use sha2::{Digest, Sha256};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::{
    webview::Cookie, AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const WINDOW: &str = "douyin-native-requests";
const HOST: &str = "live.douyin.com";
const INITIALIZE: &str = include_str!("douyin_room.js");

pub fn start(app: AppHandle) {
    let mut initialized_session = None;
    native_browser::start(app, "douyin", move |app, job, task| {
        request(app, job, task, &mut initialized_session)
    });
}

fn room_path(url: &Url) -> Option<&str> {
    let room = url.path().strip_prefix('/')?;
    (url.scheme() == "https"
        && url.host_str() == Some(HOST)
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && !room.is_empty()
        && room.bytes().all(|byte| byte.is_ascii_digit()))
    .then_some(url.path())
}

fn restored_cookies(saved: &str, hash: &str) -> Result<Vec<Cookie<'static>>, String> {
    if format!("{:x}", Sha256::digest(saved.as_bytes())) != hash {
        return Err("抖音授权已更新，请重试".into());
    }
    let mut names = std::collections::HashSet::new();
    let mut cookies = Vec::new();
    for item in saved.split(';') {
        let Some((name, value)) = item.trim().split_once('=') else {
            continue;
        };
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-.".contains(&byte))
            || value.contains(['\r', '\n', '\0'])
            || !names.insert(name)
        {
            continue;
        }
        cookies.push(
            Cookie::build((name.to_owned(), value.to_owned()))
                .domain(HOST)
                .path("/")
                .secure(true)
                .http_only(true)
                .build(),
        );
    }
    if !cookies.iter().any(|cookie| {
        matches!(cookie.name(), "sessionid" | "sessionid_ss") && !cookie.value().is_empty()
    }) {
        return Err("未读取到有效的抖音登录会话".into());
    }
    Ok(cookies)
}

fn browser_session(
    app: &AppHandle,
    expected: &str,
    task: &Task,
    initialized: &mut Option<String>,
) -> Result<WebviewWindow, String> {
    if let Some(view) = app.get_webview_window(WINDOW) {
        if initialized.as_deref() == Some(expected) {
            return Ok(view);
        }
        view.destroy().map_err(|_| "无法关闭旧的抖音官网会话")?;
    }
    *initialized = None;
    let saved = crate::backend::read_douyin_cookie()?;
    let cookies = restored_cookies(&saved, expected)?;
    task.check()?;
    let view = WebviewWindowBuilder::new(
        app,
        WINDOW,
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("抖音直播取流")
    .incognito(true)
    .visible(false)
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .initialization_script(INITIALIZE)
    .on_navigation(|url| url.as_str() == "about:blank" || room_path(url).is_some())
    .build()
    .map_err(|_| "无法初始化抖音直播浏览器会话")?;
    let result = cookies.into_iter().try_for_each(|cookie| {
        task.check()?;
        #[cfg(target_os = "macos")]
        return super::macos_cookies::update(&view, cookie, false);
        #[cfg(not(target_os = "macos"))]
        view.set_cookie(cookie)
            .map_err(|_| "无法恢复抖音官网会话".into())
    });
    if let Err(error) = result {
        let _ = view.destroy();
        return Err(error);
    }
    *initialized = Some(expected.to_owned());
    Ok(view)
}

fn request(
    app: &AppHandle,
    job: Job,
    task: &Task,
    initialized: &mut Option<String>,
) -> Result<serde_json::Value, String> {
    let url: Url = job.url.parse().map_err(|_| "抖音直播间地址无效")?;
    let path = room_path(&url).ok_or("不支持的抖音直播间地址")?;
    let expected = job.session_hash.as_deref().ok_or("缺少抖音授权标识")?;
    task.check()?;
    let view = browser_session(app, expected, task, initialized)?;
    let path = serde_json::to_string(path).unwrap();
    // Retire any result from an earlier navigation to the same room.
    view.eval("delete window.__lrDouyinPage")
        .map_err(|_| "无法刷新抖音直播页面")?;
    view.navigate(url).map_err(|_| "无法打开抖音直播页面")?;
    let script = format!(
        r#"(() => {{
        if (location.origin !== 'https://live.douyin.com' || location.pathname !== {path} || !window.__lrDouyinPage) return null;
        if (window.__lrDouyinPage.response) return window.__lrDouyinPage.response;
        if (document.readyState === 'loading') return null;
        const html = Array.from(document.scripts)
            .map(script => script.text)
            .filter(text => text.includes('self.__pace_f.push') && text.includes('roomStore'))
            .map(text => '<script>' + text + '</script>').join('');
        return html && new TextEncoder().encode(html).length <= 1048576 ? html : null;
    }})()"#
    );
    let result = read_room(&view, script, task);
    // The session stays warm, but the page need not keep playing media.
    let _ = view.navigate("about:blank".parse().unwrap());
    result
}

fn read_room(
    view: &WebviewWindow,
    script: String,
    task: &Task,
) -> Result<serde_json::Value, String> {
    let deadline = Instant::now() + Duration::from_secs(9);
    while Instant::now() < deadline {
        task.check()?;
        let (sender, receiver) = mpsc::channel();
        if view
            .eval_with_callback(script.clone(), move |raw| {
                let _ = sender.send(raw);
            })
            .is_ok()
        {
            if let Ok(raw) = receiver.recv_timeout(Duration::from_millis(500)) {
                if let Ok(text) = serde_json::from_str::<String>(&raw) {
                    task.check()?;
                    return Ok(serde_json::json!({"status":200,"text":text}));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("抖音官网没有返回可用的直播间信息".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_only_the_requested_authorization_into_the_live_site() {
        let saved = "sessionid=authorized; sessionid=old; ttwid=visitor";
        assert!(restored_cookies(saved, "different-session").is_err());
        let hash = format!("{:x}", Sha256::digest(saved.as_bytes()));
        let cookies = restored_cookies(saved, &hash).unwrap();
        assert_eq!(cookies.len(), 2);
        assert_eq!(cookies[0].value(), "authorized");
        assert!(cookies.iter().all(|cookie| cookie.domain() == Some(HOST)));
    }

    #[test]
    fn only_loads_numeric_official_live_pages() {
        let allowed: Url = "https://live.douyin.com/123".parse().unwrap();
        assert_eq!(room_path(&allowed), Some("/123"));
        for raw in [
            "http://live.douyin.com/123",
            "https://www.douyin.com/123",
            "https://live.douyin.com/123?foo=bar",
            "https://live.douyin.com/webcast/room/web/enter/",
        ] {
            assert!(room_path(&raw.parse().unwrap()).is_none(), "{raw}");
        }
    }
}
