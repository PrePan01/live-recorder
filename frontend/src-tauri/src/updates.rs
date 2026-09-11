//! GitHub-hosted installer downloads. No application replacement or process exit.
use reqwest::blocking::Client;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;

const MANIFEST_URL: &str =
    "https://github.com/PrePan01/live-recorder/releases/latest/download/latest.json";
const RELEASE_PREFIX: &str = "https://github.com/PrePan01/live-recorder/releases/download/";
/// #28 大陆加速镜像（用于安装包下载提速）：七牛 CDN 域名（匿名可读；当前仅 HTTP，
/// 二进制走 HTTP 由「HTTPS 清单内的 SHA256」保完整性）。S3 API 端点要求签名，客户端不可匿名直取，
/// 故下载走 CDN 域名，上传才走 S3 API。清单始终走 GitHub HTTPS（可信锚点）。
const MIRROR_ORIGIN: &str = "http://cdn.live-rec.bspartner.top";
/// 弱网鲁棒性（#28）：清单检查与下载失败的网络类错误重试次数（指数退避）。
const CHECK_ATTEMPTS: usize = 3;
const DOWNLOAD_ATTEMPTS: usize = 3;
/// 大文件启用多连接分片下载（#28 提速）；小文件或服务器不支持 Range 时回退单连接。
const PARALLEL_THRESHOLD_BYTES: u64 = 8 * 1024 * 1024;
const PARALLEL_CONNECTIONS: usize = 4;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    filename: String,
    url: String,
    size: u64,
    sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
struct Manifest {
    version: String,
    platforms: BTreeMap<String, Asset>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Update {
    version: String,
    asset: Asset,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    current_version: String,
    phase: String,
    update: Option<Update>,
    downloaded: u64,
    error: Option<String>,
}
#[derive(Default)]
pub struct UpdateManager {
    state: Mutex<Snapshot>,
    operation: Mutex<()>,
    initialized: Mutex<bool>,
}

fn cache(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|p| p.join("updates"))
        .map_err(|e| e.to_string())
}
fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}
fn validate_asset(version: &str, key: &str, asset: &Asset) -> Result<(), String> {
    let extension = match key {
        "macos-aarch64" => ".dmg",
        "windows-x86_64" => ".msi",
        _ => return Err("暂无对应系统和架构的安装包".into()),
    };
    let expected = format!("{RELEASE_PREFIX}v{version}/");
    let mirror_prefix = format!("{MIRROR_ORIGIN}/");
    let url = reqwest::Url::parse(&asset.url).map_err(|_| "更新下载地址无效")?;
    let encoded_name = url.path_segments().and_then(|s| s.last()).unwrap_or("");
    let trusted_source = asset.url.starts_with(&expected) || asset.url.starts_with(&mirror_prefix);
    if asset.filename.contains(['/', '\\', ':'])
        || asset.filename.starts_with('.')
        || !asset.filename.ends_with(extension)
        || !trusted_source
        || url.query().is_some()
        || url.fragment().is_some()
        || encoded_name.is_empty()
        || asset.size == 0
        || asset.sha256.len() != 64
        || !asset.sha256.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("更新安装包信息无效".into());
    }
    Ok(())
}
fn select(manifest: Manifest, current: &str, key: &str) -> Result<Option<Update>, String> {
    let latest = Version::parse(&manifest.version).map_err(|_| "更新版本号无效")?;
    let current = Version::parse(current).map_err(|_| "当前版本号无效")?;
    if !latest.pre.is_empty() || latest <= current {
        return Ok(None);
    }
    let asset = manifest
        .platforms
        .get(key)
        .ok_or("暂无对应系统和架构的安装包")?
        .clone();
    validate_asset(&manifest.version, key, &asset)?;
    Ok(Some(Update {
        version: manifest.version,
        asset,
    }))
}
fn verified(path: &Path, asset: &Asset) -> Result<(), String> {
    let mut f = File::open(path).map_err(|e| format!("无法读取安装包：{e}"))?;
    if f.metadata().map_err(|e| e.to_string())?.len() != asset.size {
        return Err("安装包大小校验失败，请重新下载".into());
    }
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    if format!("{:x}", hash.finalize()) != asset.sha256.to_lowercase() {
        return Err("安装包 SHA-256 校验失败，请重新下载".into());
    }
    Ok(())
}
fn installer(dir: &Path, update: &Update) -> PathBuf {
    dir.join(format!("{}-{}", update.version, update.asset.filename))
}
fn publish(app: &AppHandle, mutate: impl FnOnce(&mut Snapshot)) -> Snapshot {
    let manager = app.state::<UpdateManager>();
    let mut state = manager.state.lock().unwrap();
    mutate(&mut state);
    state.revision += 1;
    let result = state.clone();
    let _ = app.emit("update:state", &result);
    result
}
fn initialize(app: &AppHandle) -> Result<(), String> {
    let manager = app.state::<UpdateManager>();
    let mut initialized = manager.initialized.lock().unwrap();
    if *initialized {
        return Ok(());
    }
    let current = app.package_info().version.to_string();
    publish(app, |s| {
        s.current_version = current.clone();
        s.phase = "idle".into();
    });
    let dir = cache(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建更新缓存：{e}"))?;
    if let Some((update, ready)) = restore(&dir, &current, &platform())? {
        publish(app, |s| {
            s.phase = if ready { "ready" } else { "available" }.into();
            s.downloaded = if ready { update.asset.size } else { 0 };
            s.update = Some(update);
        });
    }
    *initialized = true;
    Ok(())
}
fn restore(dir: &Path, current: &str, key: &str) -> Result<Option<(Update, bool)>, String> {
    // Partial installers are intentionally kept. The part filename includes the
    // release version and asset filename, so download() can resume it safely.
    let Ok(bytes) = fs::read(dir.join("completed.json")) else {
        return Ok(None);
    };
    let Ok(update) = serde_json::from_slice::<Update>(&bytes) else {
        return Ok(None);
    };
    let mut platforms = BTreeMap::new();
    platforms.insert(key.to_string(), update.asset);
    let Ok(Some(update)) = select(
        Manifest {
            version: update.version,
            platforms,
        },
        current,
        key,
    ) else {
        return Ok(None);
    };
    let ready = verified(&installer(dir, &update), &update.asset).is_ok();
    Ok(Some((update, ready)))
}
/// 清单检查客户端：强制 HTTPS（清单是完整性锚点，绝不可走明文 HTTP）。
fn client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .user_agent("Live-Recorder-Update-Checker")
        .build()
        .map_err(|e| e.to_string())
}

/// 安装包下载客户端（#28）：允许 HTTP——大陆镜像为 HTTP CDN，完整性由 HTTPS 清单中的 SHA256 保证。
fn download_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .user_agent("Live-Recorder-Update-Checker")
        .build()
        .map_err(|e| e.to_string())
}
/// #28：清单检查弱网鲁棒性——清单始终走 GitHub HTTPS（可信锚点），网络类失败按指数退避重试。
fn fetch_manifest() -> Result<Vec<u8>, String> {
    let mut last = String::new();
    for attempt in 0..CHECK_ATTEMPTS {
        let fetched = client(Duration::from_secs(30)).and_then(|http| {
            http.get(MANIFEST_URL)
                .send()
                .and_then(|r| r.error_for_status())
                .map_err(|e| e.to_string())
        });
        match fetched {
            Ok(response) => {
                let mut bytes = Vec::new();
                match response.take(1024 * 1024 + 1).read_to_end(&mut bytes) {
                    Ok(_) => {
                        if bytes.len() > 1024 * 1024 {
                            return Err("更新清单过大".into());
                        }
                        return Ok(bytes);
                    }
                    Err(e) => last = e.to_string(),
                }
            }
            Err(e) => last = e,
        }
        if attempt + 1 < CHECK_ATTEMPTS {
            std::thread::sleep(Duration::from_millis(400 * (attempt as u64 + 1)));
        }
    }
    Err(format!("检查更新失败，请检查网络后重试：{last}"))
}

/// 由安装包文件名构造 CDN 镜像平坦路径（`{MIRROR_ORIGIN}/{filename}`）。
/// 镜像仅用于**下载提速**；完整性由 HTTPS 清单中的 SHA256 保证。文件名含版本号，平坦存放不冲突。
fn mirror_asset_url(filename: &str) -> Option<String> {
    if filename.is_empty() || filename.contains(['/', '\\']) {
        return None;
    }
    Some(format!("{MIRROR_ORIGIN}/{}", encode_uri_component(filename)))
}

/// 由版本 + 文件名构造 GitHub 兜底地址。
fn github_asset_url(version: &str, filename: &str) -> Option<String> {
    if filename.is_empty() || filename.contains(['/', '\\']) {
        return None;
    }
    Some(format!("{RELEASE_PREFIX}v{version}/{}", encode_uri_component(filename)))
}

/// 安装包下载候选（#28）：S3 镜像(HTTPS) 优先提速，GitHub(HTTPS) 兜底；最后附上清单原始 URL（防御）。
/// 顺序去重；无论用哪个来源，最终都经 SHA256 校验。
fn asset_candidates(version: &str, asset: &Asset) -> Vec<String> {
    let mut urls = Vec::new();
    if let Some(mirror) = mirror_asset_url(&asset.filename) {
        urls.push(mirror);
    }
    if let Some(github) = github_asset_url(version, &asset.filename) {
        if !urls.contains(&github) {
            urls.push(github);
        }
    }
    if !urls.contains(&asset.url) {
        urls.push(asset.url.clone());
    }
    urls
}

/// 与 URL 生成一致的百分号编码（文件名可能含空格/中文；GitHub release 资产名已归一为无空格）。
fn encode_uri_component(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn check(app: AppHandle) -> Result<Snapshot, String> {
    initialize(&app)?;
    let manager = app.state::<UpdateManager>();
    let Ok(_guard) = manager.operation.try_lock() else {
        return Ok(manager.state.lock().unwrap().clone());
    };
    let result = (|| -> Result<Option<Update>, String> {
        let bytes = fetch_manifest()?;
        let manifest =
            serde_json::from_slice(&bytes).map_err(|_| "更新清单格式无效".to_string())?;
        // 清单来自 HTTPS GitHub，asset.url 为可信 GitHub 地址；镜像候选在下载阶段派生。
        select(
            manifest,
            &app.package_info().version.to_string(),
            &platform(),
        )
    })();
    match result {
        Ok(update) => Ok(publish(&app, |s| {
            // Keep a verified installer available even when a newer release appears.
            if s.phase != "ready" {
                s.update = update;
                s.phase = if s.update.is_some() {
                    "available"
                } else {
                    "idle"
                }
                .into();
                s.downloaded = 0;
            }
            s.error = None;
        })),
        Err(error) => {
            publish(&app, |s| s.error = Some(error.clone()));
            Err(error)
        }
    }
}
#[cfg(test)]
fn transfer(
    reader: impl Read,
    path: &Path,
    asset: &Asset,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    transfer_from(reader, path, asset, 0, false, &mut progress)
}

fn transfer_from(
    mut reader: impl Read,
    path: &Path,
    asset: &Asset,
    initial: u64,
    append: bool,
    progress: &mut impl FnMut(u64),
) -> Result<(), String> {
    let mut file = if append {
        File::options()
            .append(true)
            .open(path)
            .map_err(|e| format!("无法续写安装包文件：{e}"))?
    } else {
        File::create(path).map_err(|e| format!("无法创建安装包文件：{e}"))?
    };
    let mut buf = [0u8; 65536];
    let mut total = initial;
    if initial > 0 {
        progress(total);
    }
    loop {
        let count = reader
            .read(&mut buf)
            .map_err(|e| format!("下载中断，请重试：{e}"))?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > asset.size {
            return Err("安装包大小超出清单声明，请重试".into());
        }
        file.write_all(&buf[..count])
            .map_err(|e| format!("写入安装包失败，请检查磁盘空间：{e}"))?;
        progress(total);
    }
    file.sync_all()
        .map_err(|e| format!("保存安装包失败：{e}"))?;
    drop(file);
    verified(path, asset)
}
/// 单连接下载一次尝试（支持断点续传，不 finalize）；失败保留 .part 供下次续传。
fn download_single(
    app: &AppHandle,
    http: &Client,
    url: &str,
    partial: &Path,
    asset: &Asset,
) -> Result<(), String> {
    let existing = fs::metadata(partial).ok().map(|m| m.len()).unwrap_or(0);
    let resume_at = if existing > 0 && existing < asset.size {
        existing
    } else {
        0
    };
    if resume_at == 0 && existing > 0 {
        let _ = fs::remove_file(partial);
    }
    let mut request = http.get(url);
    if resume_at > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={resume_at}-"));
    }
    let response = request
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("下载安装包失败，请检查网络：{e}"))?;
    // A compliant range response resumes; a normal 200 means the server ignored
    // Range, so overwrite the partial file and download safely from the start.
    let append = resume_at > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let start = if append { resume_at } else { 0 };
    publish(app, |s| s.downloaded = start);
    let mut last = Instant::now();
    transfer_from(response, partial, asset, start, append, &mut |total| {
        if last.elapsed() >= Duration::from_millis(100) {
            publish(app, |s| s.downloaded = total);
            last = Instant::now();
        }
    })
}

/// #28 提速：多连接分片下载（预分配文件 + Range 并发）。任一分片失败即返回 Err，由调用方回退单连接。
fn download_parallel<F>(
    http: &Client,
    url: &str,
    partial: &Path,
    asset: &Asset,
    progress: Arc<F>,
) -> Result<(), String>
where
    F: Fn(u64) + Send + Sync + 'static,
{
    let size = asset.size;
    if size == 0 {
        return Err("安装包大小无效".into());
    }
    {
        let file = File::create(partial).map_err(|e| format!("无法创建安装包文件：{e}"))?;
        file.set_len(size)
            .map_err(|e| format!("无法预分配安装包文件：{e}"))?;
    }
    let connections = PARALLEL_CONNECTIONS as u64;
    let chunk = size.div_ceil(connections);
    let downloaded = Arc::new(AtomicU64::new(0));
    let last_publish = Arc::new(Mutex::new(Instant::now()));
    let mut handles = Vec::new();
    for index in 0..connections {
        let start = index * chunk;
        if start >= size {
            break;
        }
        let end = (start + chunk - 1).min(size - 1);
        let url = url.to_string();
        let path = partial.to_path_buf();
        let downloaded = downloaded.clone();
        let last_publish = last_publish.clone();
        let progress = progress.clone();
        let http = http.clone();
        handles.push(std::thread::spawn(move || -> Result<(), String> {
            let response = http
                .get(&url)
                .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
                .send()
                .and_then(|r| r.error_for_status())
                .map_err(|e| format!("分片下载失败：{e}"))?;
            if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                return Err("服务器不支持分片下载".into());
            }
            let mut file = File::options()
                .write(true)
                .open(&path)
                .map_err(|e| format!("打开安装包文件失败：{e}"))?;
            file.seek(SeekFrom::Start(start))
                .map_err(|e| e.to_string())?;
            let mut reader = response;
            let mut buf = [0u8; 65536];
            loop {
                let n = reader
                    .read(&mut buf)
                    .map_err(|e| format!("下载中断，请重试：{e}"))?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n])
                    .map_err(|e| format!("写入安装包失败，请检查磁盘空间：{e}"))?;
                let total = downloaded.fetch_add(n as u64, Ordering::Relaxed) + n as u64;
                if let Ok(mut last) = last_publish.lock() {
                    if last.elapsed() >= Duration::from_millis(100) {
                        progress(total);
                        *last = Instant::now();
                    }
                }
            }
            file.sync_all()
                .map_err(|e| format!("保存安装包失败：{e}"))?;
            Ok(())
        }));
    }
    for handle in handles {
        handle
            .join()
            .map_err(|_| "分片下载线程异常".to_string())??;
    }
    verified(partial, asset)
}

/// 下载成功后落盘：partial → 正式安装包 + 写入 completed.json 元数据。
fn finalize_download(
    dir: &Path,
    partial: &Path,
    destination: &Path,
    update: &Update,
) -> Result<(), String> {
    if destination.exists() {
        fs::remove_file(destination).map_err(|e| e.to_string())?;
    }
    fs::rename(partial, destination).map_err(|e| e.to_string())?;
    let metadata_part = dir.join("completed.part");
    fs::write(
        &metadata_part,
        serde_json::to_vec(update).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let metadata = dir.join("completed.json");
    if metadata.exists() {
        fs::remove_file(&metadata).map_err(|e| e.to_string())?;
    }
    fs::rename(metadata_part, metadata).map_err(|e| e.to_string())?;
    Ok(())
}

fn download(app: AppHandle) -> Result<Snapshot, String> {
    initialize(&app)?;
    let manager = app.state::<UpdateManager>();
    let Ok(_guard) = manager.operation.try_lock() else {
        return Ok(manager.state.lock().unwrap().clone());
    };
    let before = manager.state.lock().unwrap().clone();
    if before.phase == "ready" {
        return Ok(before);
    }
    let update = before.update.ok_or("请先检查更新")?;
    let dir = cache(&app)?;
    let destination = installer(&dir, &update);
    let partial = destination.with_extension("part");
    publish(&app, |s| {
        s.phase = "downloading".into();
        s.downloaded = 0;
        s.error = None;
    });
    let outcome = (|| -> Result<(), String> {
        let http = download_client(Duration::from_secs(30 * 60))?;
        // #28：安装包候选 = [HTTP CDN 镜像, GitHub]；单源内退避重试+断点续传，源间清理避免跨源续传污染。
        let candidates = asset_candidates(&update.version, &update.asset);
        let mut last = String::new();
        for (index, url) in candidates.iter().enumerate() {
            let source = if index == 0 { "CDN" } else { "GitHub" };
            // 全新的大文件优先多连接分片下载提速；失败则清理并回退单连接断点续传。
            let existing = fs::metadata(&partial).ok().map(|m| m.len()).unwrap_or(0);
            if existing == 0 && update.asset.size >= PARALLEL_THRESHOLD_BYTES {
                let sink = app.clone();
                let progress = Arc::new(move |total: u64| {
                    let _ = publish(&sink, |s| s.downloaded = total);
                });
                if download_parallel(&http, url, &partial, &update.asset, progress).is_ok() {
                    return finalize_download(&dir, &partial, &destination, &update);
                }
                let _ = fs::remove_file(&partial);
            }
            for attempt in 0..DOWNLOAD_ATTEMPTS {
                match download_single(&app, &http, url, &partial, &update.asset) {
                    Ok(()) => return finalize_download(&dir, &partial, &destination, &update),
                    Err(e) => {
                        last = format!("{e}（来源 {source}）");
                        if attempt + 1 < DOWNLOAD_ATTEMPTS {
                            std::thread::sleep(Duration::from_millis(600 * (attempt as u64 + 1)));
                        }
                    }
                }
            }
            // 该来源失败：清理部分文件再试下一候选，避免不同来源字节拼接污染。
            let _ = fs::remove_file(&partial);
        }
        Err(last)
    })();
    match outcome {
        Ok(()) => Ok(publish(&app, |s| {
            s.phase = "ready".into();
            s.downloaded = update.asset.size;
        })),
        Err(error) => {
            // 保留 .part 供下次续传（弱网下不必从 0 重下）。
            publish(&app, |s| {
                s.phase = "available".into();
                s.error = Some(error.clone());
            });
            Err(error)
        }
    }
}
fn open(app: AppHandle) -> Result<(), String> {
    initialize(&app)?;
    let manager = app.state::<UpdateManager>();
    let _guard = manager.operation.lock().unwrap();
    let snapshot = manager.state.lock().unwrap().clone();
    if snapshot.phase != "ready" {
        return Err("安装包尚未下载完成".into());
    }
    let update = snapshot.update.ok_or("安装包信息缺失")?;
    let path = installer(&cache(&app)?, &update);
    if let Err(error) = verified(&path, &update.asset) {
        publish(&app, |s| {
            s.phase = "available".into();
            s.downloaded = 0;
            s.error = Some(error.clone());
        });
        return Err(error);
    }
    #[allow(deprecated)]
    app.shell()
        .open(path.to_string_lossy().to_string(), None)
        .map_err(|e| format!("无法打开安装包，请重试：{e}"))
}
#[tauri::command]
pub async fn get_update_state(app: AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        initialize(&app)?;
        Ok(app.state::<UpdateManager>().state.lock().unwrap().clone())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || check(app))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn download_update(app: AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || download(app))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn open_update(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open(app))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn asset() -> Asset {
        Asset {
            filename: "Live Recorder.msi".into(),
            url: format!("{RELEASE_PREFIX}v0.5.112/Live%20Recorder.msi"),
            size: 3,
            sha256: format!("{:x}", Sha256::digest(b"abc")),
        }
    }
    fn manifest(version: &str) -> Manifest {
        Manifest {
            version: version.into(),
            platforms: BTreeMap::from([("windows-x86_64".into(), asset())]),
        }
    }
    #[test]
    fn version_and_platform_selection() {
        assert!(select(manifest("0.5.112"), "0.5.99", "windows-x86_64")
            .unwrap()
            .is_some());
        assert!(select(manifest("0.5.112"), "0.5.112", "windows-x86_64")
            .unwrap()
            .is_none());
        assert!(
            select(manifest("0.5.112-beta.1"), "0.5.111", "windows-x86_64")
                .unwrap()
                .is_none()
        );
        assert!(select(manifest("0.5.112"), "0.5.111", "macos-x86_64").is_err());
        assert!(select(manifest("broken"), "0.5.111", "windows-x86_64").is_err());
    }
    #[test]
    fn rejects_unsafe_asset() {
        let mut a = asset();
        a.filename = "../evil.msi".into();
        assert!(validate_asset("0.5.112", "windows-x86_64", &a).is_err());
        a = asset();
        a.url = "https://example.com/evil.msi".into();
        assert!(validate_asset("0.5.112", "windows-x86_64", &a).is_err());
    }

    #[test]
    fn accepts_mirror_asset_but_rejects_other_origins() {
        let mut a = asset();
        a.filename = "Live.Recorder_0.5.112_aarch64.dmg".into();
        a.url = format!("{MIRROR_ORIGIN}/Live.Recorder_0.5.112_aarch64.dmg");
        assert!(validate_asset("0.5.112", "macos-aarch64", &a).is_ok());
        // 同前缀但不同域名（前缀欺骗）必须拒绝。
        a.url = "http://cdn.live-rec.bspartner.top.evil.com/x.dmg".into();
        assert!(validate_asset("0.5.112", "macos-aarch64", &a).is_err());
        a.url = "https://evil.example.com/x.dmg".into();
        assert!(validate_asset("0.5.112", "macos-aarch64", &a).is_err());
    }

    #[test]
    fn builds_mirror_and_github_asset_urls() {
        assert_eq!(
            mirror_asset_url("Live.Recorder_0.5.112_aarch64.dmg"),
            Some(format!("{MIRROR_ORIGIN}/Live.Recorder_0.5.112_aarch64.dmg")),
        );
        assert_eq!(
            github_asset_url("0.5.112", "Live.Recorder_0.5.112_aarch64.dmg"),
            Some(format!("{RELEASE_PREFIX}v0.5.112/Live.Recorder_0.5.112_aarch64.dmg")),
        );
        // 文件名含路径分隔符 → 拒绝（防目录穿越）。
        assert!(mirror_asset_url("../evil.dmg").is_none());
        assert!(github_asset_url("0.5.112", "a/b.dmg").is_none());
    }

    #[test]
    fn asset_candidates_prefer_mirror_then_github() {
        let a = asset();
        let candidates = asset_candidates("0.5.112", &a);
        assert_eq!(candidates.len(), 2);
        assert!(candidates[0].starts_with(MIRROR_ORIGIN));
        assert_eq!(candidates[1], a.url);
    }
    #[test]
    fn verifies_download_and_detects_truncation_and_corruption() {
        let path = std::env::temp_dir().join(format!("lr-update-test-{}", std::process::id()));
        let mut progress = Vec::new();
        transfer(&b"abc"[..], &path, &asset(), |n| progress.push(n)).unwrap();
        assert_eq!(progress, vec![3]);
        assert!(transfer(&b"ab"[..], &path, &asset(), |_| {}).is_err());
        assert!(transfer(&b"abd"[..], &path, &asset(), |_| {}).is_err());
        assert!(transfer(&b"abcd"[..], &path, &asset(), |_| {}).is_err());
        let _ = fs::remove_file(path);
    }
    #[test]
    fn restores_verified_cache_and_cleans_incomplete_files() {
        let dir = std::env::temp_dir().join(format!("lr-update-cache-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let update = Update {
            version: "0.5.112".into(),
            asset: asset(),
        };
        fs::write(
            dir.join("completed.json"),
            serde_json::to_vec(&update).unwrap(),
        )
        .unwrap();
        fs::write(installer(&dir, &update), b"abc").unwrap();
        fs::write(dir.join("interrupted.part"), b"a").unwrap();
        assert!(
            restore(&dir, "0.5.111", "windows-x86_64")
                .unwrap()
                .unwrap()
                .1
        );
        assert!(dir.join("interrupted.part").exists());
        fs::write(installer(&dir, &update), b"bad").unwrap();
        assert!(
            !restore(&dir, "0.5.111", "windows-x86_64")
                .unwrap()
                .unwrap()
                .1
        );
        assert!(restore(&dir, "0.5.112", "windows-x86_64")
            .unwrap()
            .is_none());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn streams_slow_http_and_rejects_interrupted_response() {
        use std::net::TcpListener;
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            for complete in [true, false] {
                let (mut socket, _) = server.accept().unwrap();
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request);
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\n")
                    .unwrap();
                for byte in if complete { &b"abc"[..] } else { &b"ab"[..] } {
                    socket.write_all(&[*byte]).unwrap();
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        });
        let client = Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let path = std::env::temp_dir().join(format!("lr-update-http-{}", std::process::id()));
        let response = client.get(format!("http://{address}")).send().unwrap();
        let mut progress = Vec::new();
        transfer(response, &path, &asset(), |n| progress.push(n)).unwrap();
        assert_eq!(progress.last(), Some(&3));
        assert!(progress.len() > 1);
        let response = client.get(format!("http://{address}")).send().unwrap();
        assert!(transfer(response, &path, &asset(), |_| {}).is_err());
        worker.join().unwrap();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn downloads_in_parallel_range_chunks() {
        use std::io::BufRead;
        use std::net::TcpListener;
        let body: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let sha = format!("{:x}", Sha256::digest(&body));
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let served = Arc::new(AtomicU64::new(0));
        let served_worker = served.clone();
        let expected = body.clone();
        let worker = std::thread::spawn(move || {
            for _ in 0..PARALLEL_CONNECTIONS {
                let (mut socket, _) = server.accept().unwrap();
                let mut reader = std::io::BufReader::new(socket.try_clone().unwrap());
                let mut range: Option<(usize, usize)> = None;
                let mut line = String::new();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap() == 0 {
                        break;
                    }
                    if line.trim().is_empty() {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(rest) = lower.strip_prefix("range: bytes=") {
                        let spec = rest.trim();
                        if let Some((s, e)) = spec.split_once('-') {
                            let start: usize = s.parse().unwrap_or(0);
                            let end: usize = e.parse().unwrap_or(expected.len() - 1);
                            range = Some((start, end));
                        }
                    }
                }
                let (start, end) = range.expect("range header expected");
                let slice = &expected[start..=end];
                served_worker.fetch_add(1, Ordering::Relaxed);
                let header = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                    slice.len(),
                    start,
                    end,
                    expected.len()
                );
                socket.write_all(header.as_bytes()).unwrap();
                socket.write_all(slice).unwrap();
            }
        });
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let path = std::env::temp_dir().join(format!("lr-update-parallel-{}", std::process::id()));
        let asset = Asset {
            filename: "x.dmg".into(),
            url: format!("http://{address}/x.dmg"),
            size: body.len() as u64,
            sha256: sha,
        };
        let result = download_parallel(&client, &asset.url, &path, &asset, Arc::new(|_| {}));
        worker.join().unwrap();
        assert!(result.is_ok(), "parallel download failed: {result:?}");
        assert_eq!(served.load(Ordering::Relaxed), PARALLEL_CONNECTIONS as u64);
        assert_eq!(fs::read(&path).unwrap(), body);
        let _ = fs::remove_file(path);
    }
}
