use std::{
    collections::HashSet,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Job {
    pub(crate) id: String,
    pub(crate) url: String,
    pub(crate) session_hash: Option<String>,
    pub(crate) expires_at: u64,
}

#[derive(Clone)]
pub(crate) struct Task {
    pub(crate) id: String,
    pub(crate) expires_at: u64,
    pub(crate) active: Arc<Mutex<HashSet<String>>>,
}
impl Task {
    pub(crate) fn check(&self) -> Result<(), String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        if now >= self.expires_at as u128
            || !self
                .active
                .lock()
                .map_err(|_| "官网请求已取消")?
                .contains(&self.id)
        {
            return Err("官网请求已取消或超时".into());
        }
        Ok(())
    }
}

/// One bounded worker owns the remote WebView. Polling remains independent so
/// cancellation is delivered even while the website is loading or responding.
pub fn start(
    app: AppHandle,
    platform: &'static str,
    mut request: impl FnMut(&AppHandle, Job, &Task) -> Result<serde_json::Value, String>
        + Send
        + 'static,
) {
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
                let result = request(&app, job, &task).unwrap_or_else(|error| {
                    if task.check().is_ok() {
                        log::warn!("{platform} 官网请求失败：{error}");
                    }
                    serde_json::json!({"status":0,"text":""})
                });
                if task.check().is_ok() {
                    let _ = worker_client
                        .post(format!("{endpoint}/{}", task.id))
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
                "{}/api/v1/platform/{platform}/native-requests",
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
