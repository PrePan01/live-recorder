use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use super::macos_cookies;
use super::native_browser::{self, Task};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
const WINDOW: &str = "xiaohongshu-native-requests";
const REQUEST_PAGE: &str = "https://www.xiaohongshu.com/explore";
const PAGE_READY_TIMEOUT: Duration = Duration::from_secs(12);

struct PageLoad {
    deadline: Instant,
    verify_session: bool,
}

enum PrepareError {
    Cancelled(String),
    Failed(String),
}

impl PageLoad {
    fn new(verify_session: bool) -> Self {
        Self {
            deadline: Instant::now() + PAGE_READY_TIMEOUT,
            verify_session,
        }
    }

    fn wait_ready(&self, task: &Task, mut ready: impl FnMut() -> bool) -> Result<(), PrepareError> {
        loop {
            task.check().map_err(PrepareError::Cancelled)?;
            let ready = ready();
            task.check().map_err(PrepareError::Cancelled)?;
            if ready {
                return Ok(());
            }
            if Instant::now() >= self.deadline {
                return Err(PrepareError::Failed(
                    "小红书官网校验组件尚未就绪，请完成登录后重试".into(),
                ));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

pub fn start(app: AppHandle) {
    let mut page_load = None;
    native_browser::start(app, "xiaohongshu", move |app, job, task| {
        request(app, job.url, job.session_hash, task, &mut page_load)
    });
}

fn allowed(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
        && matches!(
            (url.host_str(), url.path()),
            (
                Some("edith.xiaohongshu.com"),
                "/api/sns/web/v1/user/otherinfo"
            ) | (
                Some("edith.xiaohongshu.com"),
                "/api/sns/web/v1/user/hover_card"
            ) | (
                Some("edith.xiaohongshu.com"),
                "/api/sns/web/v1/user/selfinfo"
            ) | (
                Some("live-room.xiaohongshu.com"),
                "/api/sns/red/live/h5/v1/interaction/get_simple_interaction"
            ) | (
                Some("live-room.xiaohongshu.com"),
                "/api/sns/red/live/h5/v1/core/current_live_status"
            )
        )
}

fn evaluate(view: &WebviewWindow, script: String) -> Result<serde_json::Value, String> {
    let (sender, receiver) = mpsc::channel();
    view.eval_with_callback(script, move |value| {
        let _ = sender.send(value);
    })
    .map_err(|_| "无法读取小红书官网请求状态".to_string())?;
    let raw = receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "小红书官网请求超时".to_string())?;
    serde_json::from_str(&raw).map_err(|_| "小红书官网返回格式异常".to_string())
}

fn page_ready(view: &WebviewWindow) -> bool {
    evaluate(view, r#"(() => {
          if(!window.__lrXhsClient && window.webpackChunkxhs_pc_web) {
            let runtime;
            window.webpackChunkxhs_pc_web.push([['lr-request-'+Date.now()],{},value=>{runtime=value;}]);
            const id=Object.keys(runtime?.m||{}).find(id=>{
              const source=String(runtime.m[id]);
              return source.includes('[Http Exception] baseURL must be string')&&source.includes('extractData');
            });
            if(id)window.__lrXhsClient=runtime(id);
          }
          const client=window.__lrXhsClient;
          return {ready:!window.__lrXhsReloading&&location.hostname==='www.xiaohongshu.com'&&typeof client?.get==='function'&&client.interceptors?.request?.queue?.length>0&&typeof window._webmsxyw==='function'};
        })()"#.into())
        .ok().and_then(|v| v.get("ready").and_then(|r| r.as_bool())).unwrap_or(false)
}

fn session_hash(value: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn authorized_pairs<'a>(saved: &'a str, expected: &str) -> Result<Vec<(&'a str, &'a str)>, String> {
    let pairs: Vec<(&str, &str)> = saved
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .collect();
    if saved.len() > 32768
        || !pairs
            .iter()
            .any(|(name, value)| *name == "web_session" && session_hash(value) == expected)
    {
        return Err("小红书授权已更新，请重试".into());
    }
    if pairs.iter().any(|(name, value)| {
        name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-.".contains(&byte))
            || value.contains(['\r', '\n', '\0'])
    }) {
        return Err("小红书授权格式无效".into());
    }
    Ok(pairs)
}

fn read_cookies(view: &WebviewWindow) -> Result<Vec<tauri::webview::Cookie<'static>>, String> {
    #[cfg(target_os = "macos")]
    return macos_cookies::read(view, "xiaohongshu.com");
    #[cfg(not(target_os = "macos"))]
    view.cookies().map_err(|_| "无法读取小红书官网会话".into())
}

fn update_cookie(
    view: &WebviewWindow,
    cookie: tauri::webview::Cookie<'static>,
    delete: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos_cookies::update(view, cookie, delete);
    #[cfg(not(target_os = "macos"))]
    {
        let result = if delete {
            view.delete_cookie(cookie)
        } else {
            view.set_cookie(cookie)
        };
        result.map_err(|_| "无法更新小红书官网会话".into())
    }
}

fn synchronize_session(view: &WebviewWindow, expected: &str, task: &Task) -> Result<bool, String> {
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("小红书授权标识无效".into());
    }
    let cookies = read_cookies(view)?;
    if cookies.iter().any(|cookie| {
        cookie.name() == "web_session"
            && cookie
                .domain()
                .is_some_and(|domain| domain.trim_start_matches('.') == "xiaohongshu.com")
            && session_hash(cookie.value()) == expected
    }) {
        return Ok(false);
    }
    task.check()?;
    let saved = crate::backend::read_xiaohongshu_cookie()?;
    task.check()?;
    let pairs = authorized_pairs(&saved, expected)?;
    // Remove stale same-name platform cookies before restoring the authorized
    // session. Only this application's WebView store is touched.
    for cookie in cookies {
        if cookie.domain().is_some_and(|domain| {
            let domain = domain.trim_start_matches('.');
            domain == "xiaohongshu.com" || domain.ends_with(".xiaohongshu.com")
        }) && pairs.iter().any(|(name, _)| *name == cookie.name())
        {
            task.check()?;
            update_cookie(view, cookie, true)?;
        }
    }
    for (name, value) in pairs {
        task.check()?;
        let cookie = tauri::webview::Cookie::build((name.to_owned(), value.to_owned()))
            .domain(".xiaohongshu.com")
            .path("/")
            .secure(true)
            .http_only(name == "web_session")
            .build();
        update_cookie(view, cookie, false)?;
    }
    Ok(true)
}

fn prepare_view(
    view: &WebviewWindow,
    created: bool,
    expected: &str,
    task: &Task,
    page_load: &mut Option<PageLoad>,
) -> Result<(), PrepareError> {
    // Load the website with the saved session already in place, so even a
    // logged-out page that never loads the client can recover.
    let restored = synchronize_session(view, expected, task).map_err(PrepareError::Failed)?;
    if created || restored {
        task.check().map_err(PrepareError::Failed)?;
        if !created {
            view.eval("window.__lrXhsReloading=true")
                .map_err(|_| PrepareError::Failed("无法刷新小红书官网会话".into()))?;
        }
        view.navigate(REQUEST_PAGE.parse().unwrap())
            .map_err(|_| PrepareError::Failed("无法加载小红书官网请求页面".into()))?;
        *page_load = Some(PageLoad::new(restored));
    }
    let load = page_load.get_or_insert_with(|| PageLoad::new(false));
    load.wait_ready(task, || page_ready(view))?;
    if load.verify_session {
        let cookies = read_cookies(view).map_err(PrepareError::Failed)?;
        if !cookies.iter().any(|cookie| {
            cookie.name() == "web_session" && session_hash(cookie.value()) == expected
        }) {
            return Err(PrepareError::Failed(
                "小红书官网未接受已保存授权，请重新授权".into(),
            ));
        }
    }
    *page_load = None;
    Ok(())
}

fn request(
    app: &AppHandle,
    raw: String,
    expected_session: Option<String>,
    task: &Task,
    page_load: &mut Option<PageLoad>,
) -> Result<serde_json::Value, String> {
    let url: tauri::Url = raw.parse().map_err(|_| "小红书接口地址无效")?;
    if !allowed(&url) {
        return Err("不支持的小红书接口".into());
    }
    task.check()?;
    let expected = expected_session.as_deref().ok_or("缺少小红书授权标识")?;
    // Remote content has no Tauri capability. It shares the existing native login cookie store.
    let (view, created) = if let Some(view) = app.get_webview_window(WINDOW) {
        (view, false)
    } else {
        let view = WebviewWindowBuilder::new(
            app,
            WINDOW,
            WebviewUrl::External("about:blank".parse().unwrap()),
        )
        .title("小红书官网请求")
        .visible(false)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        // WebView2 does not support background_throttling; an outstanding WebLock
        // keeps its document eligible for background work without timer polling.
        .initialization_script("if(location.hostname==='www.xiaohongshu.com'&&navigator.locks)void navigator.locks.request('live-recorder-xhs-background',()=>new Promise(()=>{})).catch(()=>{});")
        .on_navigation(|url| {
            url.as_str() == "about:blank"
                || (url.scheme() == "https"
                    && matches!(
                        url.host_str(),
                        Some("www.xiaohongshu.com") | Some("xiaohongshu.com")
                    ))
        })
        .build()
        .map_err(|_| "无法初始化小红书官网请求窗口")?;
        (view, true)
    };
    match prepare_view(&view, created, expected, task, page_load) {
        Ok(()) => {}
        // A shorter-lived broker request can end while this page is still loading.
        Err(PrepareError::Cancelled(error)) => return Err(error),
        Err(PrepareError::Failed(error)) => {
            *page_load = None;
            let _ = view.destroy();
            return Err(error);
        }
    }
    task.check()?;
    let key = format!(
        "__live_recorder_xhs_{}",
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let key_json = serde_json::to_string(&key).unwrap();
    let url_json = serde_json::to_string(url.as_str()).unwrap();
    let script = format!(
        r#"(() => {{
      const key={key_json}, url=new URL({url_json});
      const controller=new AbortController();
      window[key]={{done:false,controller}};
      (async()=>{{
        const headers={{}};
        const room=url.searchParams.get('room_id');
        if(room) headers['x-ratelimit-meta']='roomId='+room;
        let status=200, body;
        try {{
          body=await window.__lrXhsClient.get(url.origin+url.pathname,{{params:Object.fromEntries(url.searchParams),headers,withCredentials:true,extractData:false,transform:false,timeout:10000,signal:controller.signal}});
        }} catch(error) {{
          status=Number(error?.status)||0;
          body=error?.data||{{success:false}};
        }}
        const text=JSON.stringify(body);
        if(new TextEncoder().encode(text).byteLength>1048576)throw new Error('response-too-large');
        if(window[key])window[key]={{done:true,status,text}};
      }})().catch(()=>{{if(window[key])window[key]={{done:true,status:0,text:''}};}});
      return true;
    }})()"#
    );
    view.eval(script).map_err(|_| "无法发起小红书官网请求")?;
    let deadline = Instant::now() + Duration::from_secs(12);
    let result = loop {
        if let Err(error) = task.check() {
            break Err(error);
        }
        match evaluate(&view, format!("window[{key_json}]||({{done:false}})")) {
            Ok(result) if result["done"].as_bool() == Some(true) => {
                if result["status"].as_u64().unwrap_or(0) == 0 {
                    break Err("小红书官网客户端未返回 HTTP 响应".into());
                }
                break Ok(serde_json::json!({"status": result["status"], "text": result["text"]}));
            }
            Ok(_) => {}
            Err(error) => break Err(error),
        }
        if Instant::now() >= deadline {
            break Err("小红书官网请求超时".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    };
    let _ = view.eval(format!(
        "window[{key_json}]?.controller?.abort();delete window[{key_json}]"
    ));
    result
}

#[cfg(test)]
mod tests {
    use super::{allowed, authorized_pairs, session_hash, PageLoad, PrepareError, Task};
    use std::{
        collections::HashSet,
        sync::{Arc, Mutex},
        time::Instant,
    };
    #[test]
    fn skips_expired_and_cancelled_native_work() {
        let active = Arc::new(Mutex::new(HashSet::from(["pending".to_string()])));
        let mut task = Task {
            id: "pending".into(),
            expires_at: u64::MAX,
            active: active.clone(),
        };
        assert!(task.check().is_ok());
        active.lock().unwrap().clear();
        assert!(task.check().is_err());
        active.lock().unwrap().insert("pending".into());
        task.expires_at = 0;
        assert!(task.check().is_err());
    }

    #[test]
    fn a_cancelled_request_leaves_the_same_page_load_available_to_its_retry() {
        let active = Arc::new(Mutex::new(HashSet::from(["first".into(), "retry".into()])));
        let first = Task {
            id: "first".into(),
            expires_at: u64::MAX,
            active: active.clone(),
        };
        let retry = Task {
            id: "retry".into(),
            ..first.clone()
        };
        let load = PageLoad::new(true);
        let first_result = load.wait_ready(&first, || {
            active.lock().unwrap().remove("first");
            false
        });
        assert!(matches!(first_result, Err(PrepareError::Cancelled(_))));
        assert!(load.wait_ready(&retry, || true).is_ok());
        assert!(load.verify_session);
    }

    #[test]
    fn a_retry_checks_the_existing_page_before_enforcing_its_original_deadline() {
        let task = Task {
            id: "retry".into(),
            expires_at: u64::MAX,
            active: Arc::new(Mutex::new(HashSet::from(["retry".into()]))),
        };
        let load = PageLoad {
            deadline: Instant::now(),
            verify_session: false,
        };
        assert!(load.wait_ready(&task, || true).is_ok());
        assert!(matches!(
            load.wait_ready(&task, || false),
            Err(PrepareError::Failed(_))
        ));
    }
    #[test]
    fn restores_only_the_session_bound_to_the_pending_request() {
        let expected = session_hash("local-session");
        assert_eq!(
            authorized_pairs("a1=device; web_session=local-session", &expected)
                .unwrap()
                .len(),
            2
        );
        assert!(authorized_pairs("web_session=another-session", &expected).is_err());
        assert!(authorized_pairs("web_session=local-session; bad name=value", &expected).is_err());
        assert!(
            authorized_pairs("web_session=local-session; a1=value\r\ninjected", &expected).is_err()
        );
    }
    #[test]
    fn limits_native_requests_to_read_only_platform_apis() {
        for value in ["https://edith.xiaohongshu.com/api/sns/web/v1/user/otherinfo?target_user_id=abc", "https://edith.xiaohongshu.com/api/sns/web/v1/user/hover_card?target_user_id=abc", "https://live-room.xiaohongshu.com/api/sns/red/live/h5/v1/interaction/get_simple_interaction?room_id=123"] {
            assert!(allowed(&value.parse().unwrap()));
        }
        for value in [
            "http://127.0.0.1/api/sns/web/v1/user/otherinfo",
            "https://edith.xiaohongshu.com.evil.test/api/sns/web/v1/user/otherinfo",
            "https://edith.xiaohongshu.com/api/sns/web/v1/comment/post",
            "https://secret@edith.xiaohongshu.com/api/sns/web/v1/user/selfinfo",
        ] {
            assert!(!allowed(&value.parse().unwrap()));
        }
    }
}
