use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
const WINDOW: &str = "xiaohongshu-native-requests";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    url: String,
    session_hash: Option<String>,
    expires_at: u64,
}

#[derive(Clone)]
struct Task {
    id: String,
    expires_at: u64,
    active: Arc<Mutex<HashSet<String>>>,
}
impl Task {
    fn check(&self) -> Result<(), String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        if now >= self.expires_at as u128
            || !self
                .active
                .lock()
                .map_err(|_| "小红书请求已取消")?
                .contains(&self.id)
        {
            return Err("小红书请求已取消或超时".into());
        }
        Ok(())
    }
}

/// One bounded worker owns the remote WebView. Polling remains independent so
/// cancellation is delivered even while the website is loading or responding.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let Ok(client) = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
        else {
            return;
        };
        let active = Arc::new(Mutex::new(HashSet::new()));
        let (sender, receiver) = mpsc::sync_channel::<(Job, String)>(8);
        let worker_client = client.clone();
        let worker_active = active.clone();
        std::thread::spawn(move || {
            while let Ok((job, endpoint)) = receiver.recv() {
                let task = Task {
                    id: job.id.clone(),
                    expires_at: job.expires_at,
                    active: worker_active.clone(),
                };
                if task.check().is_err() {
                    continue;
                }
                let result = request(app.clone(), job.url, job.session_hash, &task)
                    .unwrap_or_else(|_| serde_json::json!({"status":0,"text":""}));
                if task.check().is_ok() {
                    let _ = worker_client
                        .post(format!("{endpoint}/{}", job.id))
                        .json(&result)
                        .send();
                }
            }
        });
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let Some(instance) = crate::backend::fetch_ready() else {
                if let Ok(mut ids) = active.lock() {
                    ids.clear();
                }
                continue;
            };
            let endpoint = format!(
                "{}/api/v1/platform/xiaohongshu/native-requests",
                instance.base_url
            );
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Jobs {
                requests: Vec<Job>,
                active_request_ids: Vec<String>,
            }
            let jobs = client
                .get(&endpoint)
                .send()
                .ok()
                .filter(|response| response.status().is_success())
                .and_then(|response| response.json::<Jobs>().ok());
            let Some(jobs) = jobs else {
                if let Ok(mut ids) = active.lock() {
                    ids.clear();
                }
                continue;
            };
            if let Ok(mut ids) = active.lock() {
                *ids = jobs.active_request_ids.into_iter().collect();
            }
            for job in jobs.requests.into_iter().take(8) {
                if job.id.len() != 36
                    || !job
                        .id
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
                {
                    continue;
                }
                if let Err(mpsc::TrySendError::Full((job, endpoint))) =
                    sender.try_send((job, endpoint.clone()))
                {
                    let _ = client
                        .post(format!("{endpoint}/{}", job.id))
                        .json(&serde_json::json!({"status":0,"text":""}))
                        .send();
                }
            }
        }
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

fn wait_ready(view: &WebviewWindow, task: &Task) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        task.check()?;
        if evaluate(&view, r#"(() => {
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
            .ok().and_then(|v| v.get("ready").and_then(|r| r.as_bool())).unwrap_or(false) { return Ok(()); }
        if Instant::now() >= deadline {
            return Err("小红书官网校验组件尚未就绪，请完成登录后重试".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
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

fn synchronize_session(view: &WebviewWindow, expected: &str, task: &Task) -> Result<(), String> {
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("小红书授权标识无效".into());
    }
    let cookies = view.cookies().map_err(|_| "无法读取小红书官网会话")?;
    if cookies.iter().any(|cookie| {
        cookie.name() == "web_session"
            && cookie
                .domain()
                .is_some_and(|domain| domain.trim_start_matches('.') == "xiaohongshu.com")
            && session_hash(cookie.value()) == expected
    }) {
        return Ok(());
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
            view.delete_cookie(cookie)
                .map_err(|_| "无法更新小红书官网会话")?;
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
        view.set_cookie(cookie)
            .map_err(|_| "无法同步小红书官网会话")?;
    }
    view.eval("window.__lrXhsReloading=true")
        .map_err(|_| "无法刷新小红书官网会话")?;
    view.navigate("https://www.xiaohongshu.com/explore".parse().unwrap())
        .map_err(|_| "无法刷新小红书官网会话")?;
    wait_ready(view, task)?;
    let cookies = view.cookies().map_err(|_| "无法确认小红书官网会话")?;
    if !cookies
        .iter()
        .any(|cookie| cookie.name() == "web_session" && session_hash(cookie.value()) == expected)
    {
        return Err("小红书官网未接受已保存授权，请重新授权".into());
    }
    Ok(())
}

fn request(
    app: AppHandle,
    raw: String,
    expected_session: Option<String>,
    task: &Task,
) -> Result<serde_json::Value, String> {
    let url: tauri::Url = raw.parse().map_err(|_| "小红书接口地址无效")?;
    if !allowed(&url) {
        return Err("不支持的小红书接口".into());
    }
    task.check()?;
    // Remote content has no Tauri capability. It shares the existing native login cookie store.
    let view = if let Some(view) = app.get_webview_window(WINDOW) {
        view
    } else {
        WebviewWindowBuilder::new(
            &app,
            WINDOW,
            WebviewUrl::External("https://www.xiaohongshu.com/explore".parse().unwrap()),
        )
        .title("小红书官网请求")
        .visible(false)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        // WebView2 does not support background_throttling; an outstanding WebLock
        // keeps its document eligible for background work without timer polling.
        .initialization_script("if(location.hostname==='www.xiaohongshu.com'&&navigator.locks)void navigator.locks.request('live-recorder-xhs-background',()=>new Promise(()=>{})).catch(()=>{});")
        .on_navigation(|url| {
            url.scheme() == "https"
                && matches!(
                    url.host_str(),
                    Some("www.xiaohongshu.com") | Some("xiaohongshu.com")
                )
        })
        .build()
        .map_err(|_| "无法初始化小红书官网请求窗口")?
    };
    wait_ready(&view, task)?;
    synchronize_session(
        &view,
        expected_session.as_deref().ok_or("缺少小红书授权标识")?,
        task,
    )?;
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
    loop {
        if let Err(error) = task.check() {
            let _ = view.eval(format!(
                "window[{key_json}]?.controller?.abort();delete window[{key_json}]"
            ));
            return Err(error);
        }
        let result = evaluate(&view, format!("window[{key_json}]||({{done:false}})"))?;
        if result.get("done").and_then(|v| v.as_bool()) == Some(true) {
            let _ = view.eval(format!("delete window[{key_json}]"));
            return Ok(
                serde_json::json!({"status":result.get("status").and_then(|v|v.as_u64()).unwrap_or(0),
                "text":result.get("text").and_then(|v|v.as_str()).unwrap_or("")}),
            );
        }
        if Instant::now() >= deadline {
            let _ = view.eval(format!(
                "window[{key_json}]?.controller?.abort();delete window[{key_json}]"
            ));
            return Err("小红书官网请求超时".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

#[cfg(test)]
mod tests {
    use super::{allowed, authorized_pairs, session_hash, Task};
    use std::{
        collections::HashSet,
        sync::{Arc, Mutex},
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
