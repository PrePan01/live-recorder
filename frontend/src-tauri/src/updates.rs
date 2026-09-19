//! GitHub-hosted installer downloads.
//!
//! Windows 的安装阶段以 NSIS 被动模式就地覆盖并自动重启（见 [`install`]），
//! 其余平台仍交给系统安装流程处理。
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
/// #28 大陆加速镜像（HTTPS，匿名可读）：优先用于检查清单与下载安装包，失败自动回退 GitHub。
/// 清单由 CI 以 no-cache 上传（#43），SHA256 校验安装包完整性。
const MIRROR_ORIGIN: &str = "https://cdn.live-rec.bspartner.top";
const MIRROR_MANIFEST_URL: &str = "https://cdn.live-rec.bspartner.top/latest.json";
/// 弱网鲁棒性（#28）：清单检查与下载失败的网络类错误重试次数（指数退避）。
/// 清单：CDN 优先（1 次、20s），GitHub 兜底探测（1 次、5s，仅当 CDN 判「无更新」时才探测；
/// 大陆被墙时快速失败，避免每次「已是最新」都长时间等待 GitHub）。
const CDN_MANIFEST_ATTEMPTS: usize = 1;
const GITHUB_MANIFEST_ATTEMPTS: usize = 1;
const CDN_MANIFEST_TIMEOUT_SECS: u64 = 20;
const GITHUB_MANIFEST_TIMEOUT_SECS: u64 = 5;
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
    /// 安装包的 minisign 签名（`.sig` 内容）。旧清单与 macOS 产物没有该字段。
    signature: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: Vec<String>,
    platforms: BTreeMap<String, Asset>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Update {
    version: String,
    notes: Vec<String>,
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
        "windows-x86_64" => "-setup.exe",
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
        notes: manifest.notes,
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

/// 从应用配置读取 updater 公钥（`plugins.updater.pubkey`）。
/// 与 tauri build 打包时校验的是同一份配置，避免出现「打包用一把公钥、客户端校验用另一把」的错配。
fn configured_pubkey(app: &AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")?
        .get("pubkey")?
        .as_str()
        .map(str::to_owned)
}

/// 用清单内的 minisign 签名核验安装包来源。
/// 与清单的 SHA256 一样，签名内容是 base64 文本，公钥来自应用配置。
fn signature_valid(pubkey: &str, path: &Path, signature: &str) -> Result<(), String> {
    use base64::Engine;
    let decode = |value: &str, what: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(value)
            .map_err(|e| format!("更新{what}不是有效的 base64：{e}"))
            .and_then(|bytes| String::from_utf8(bytes).map_err(|e| format!("更新{what}不是 UTF-8：{e}")))
    };
    let public_key =
        minisign_verify::PublicKey::decode(&decode(pubkey, "公钥")?).map_err(|e| format!("更新公钥无法解析：{e}"))?;
    let signature = minisign_verify::Signature::decode(&decode(signature, "签名")?).map_err(|e| format!("更新签名无法解析：{e}"))?;
    let bytes = fs::read(path).map_err(|e| format!("无法读取安装包：{e}"))?;
    public_key
        .verify(&bytes, &signature, true)
        .map_err(|e| e.to_string())
}
fn installer(dir: &Path, update: &Update) -> PathBuf {
    dir.join(format!("{}-{}", update.version, update.asset.filename))
}

/// 候选版本是否比基线更新；任一侧版本号非法都返回 false（宁可保持现状，也不误删已下好的包）。
fn is_newer(candidate: &str, baseline: &str) -> bool {
    match (Version::parse(candidate), Version::parse(baseline)) {
        (Ok(candidate), Ok(baseline)) => candidate > baseline,
        _ => false,
    }
}

/// 已下载好安装包（phase=ready）时，是否需要让位给清单里的最新版本。
/// 只有清单版本更新才让位；清单更旧（如 CDN 滞后）或相同都保持现状，避免把下好的文件白白清掉。
fn supersedes_ready(phase: &str, ready: Option<&Update>, latest: Option<&Update>) -> bool {
    if phase != "ready" {
        return false;
    }
    match (ready, latest) {
        (Some(ready), Some(latest)) => is_newer(&latest.version, &ready.version),
        _ => false,
    }
}

/// 丢弃已被新版本取代的安装包：正式包、断点续传文件与 completed.json 元数据。
/// 元数据必须一起删——否则下次启动 restore() 会把它恢复成"待安装"，又回到旧版本。
fn discard_cached(dir: &Path, update: &Update) {
    let destination = installer(dir, update);
    let _ = fs::remove_file(destination.with_extension("part"));
    let _ = fs::remove_file(destination);
    let _ = fs::remove_file(dir.join("completed.json"));
    let _ = fs::remove_file(dir.join("completed.part"));
}

/// 自动下载最新版：放独立线程跑，检查更新的调用方不必等下载完成。
/// 进度与失败都经 update:state 事件回传；失败时状态回到 available，用户仍可手动重试。
fn spawn_auto_download(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(error) = download(app) {
            eprintln!("auto update download failed: {error}");
        }
    });
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
            notes: update.notes.clone(),
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

/// 安装包下载客户端（#28）：不强制 HTTPS——兼容镜像/代理可能的 http 候选，
/// 完整性始终由 HTTPS 清单中的 SHA256 保证（篡改会被拒绝）。
fn download_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .user_agent("Live-Recorder-Update-Checker")
        .build()
        .map_err(|e| e.to_string())
}
/// 拉取指定清单 URL（网络类失败按指数退避重试）。
fn fetch_manifest_bytes(
    source: &str,
    attempts: usize,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let mut last = String::new();
    for attempt in 0..attempts {
        let fetched = client(timeout).and_then(|http| {
            http.get(source)
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
        if attempt + 1 < attempts {
            std::thread::sleep(Duration::from_millis(400 * (attempt as u64 + 1)));
        }
    }
    Err(format!("检查更新失败，请检查网络后重试：{last}"))
}

/// #44：多源清单解析与选择（纯函数，便于测试）。
/// 依序解析各源；任一源给出可更新项即返回（CDN 优先）。若所有可达源都判定「无更新」返回 None；
/// 若没有任何源成功解析出有效清单则返回错误（避免「源返回坏数据 + 另一源不可达」被误判为已最新）。
fn resolve_updates(
    current: &str,
    key: &str,
    sources: Vec<Result<Vec<u8>, String>>,
) -> Result<Option<Update>, String> {
    let mut last_error: Option<String> = None;
    let mut parsed_any = false;
    for result in sources {
        let bytes = match result {
            Ok(bytes) => bytes,
            Err(e) => {
                last_error = Some(e);
                continue;
            }
        };
        let manifest = match serde_json::from_slice::<Manifest>(&bytes) {
            Ok(manifest) => manifest,
            Err(_) => {
                last_error = Some("更新清单格式无效".to_string());
                continue;
            }
        };
        parsed_any = true;
        match select(manifest, current, key) {
            Ok(Some(update)) => return Ok(Some(update)),
            // 该源无更新版本：可能确已最新，或 CDN 滞后 → 继续查下一源（freshness 保护）。
            Ok(None) => continue,
            Err(e) => {
                last_error = Some(e);
                continue;
            }
        }
    }
    if parsed_any {
        Ok(None)
    } else {
        Err(last_error.unwrap_or_else(|| "检查更新失败，请检查网络后重试".to_string()))
    }
}

/// 由安装包文件名构造 CDN 镜像平坦路径（`{MIRROR_ORIGIN}/{filename}`）。
/// 镜像仅用于**下载提速**；完整性由 HTTPS 清单中的 SHA256 保证。文件名含版本号，平坦存放不冲突。
fn mirror_asset_url(filename: &str) -> Option<String> {
    if filename.is_empty() || filename.contains(['/', '\\']) {
        return None;
    }
    Some(format!(
        "{MIRROR_ORIGIN}/{}",
        encode_uri_component(filename)
    ))
}

/// 由版本 + 文件名构造 GitHub 兜底地址。
fn github_asset_url(version: &str, filename: &str) -> Option<String> {
    if filename.is_empty() || filename.contains(['/', '\\']) {
        return None;
    }
    Some(format!(
        "{RELEASE_PREFIX}v{version}/{}",
        encode_uri_component(filename)
    ))
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
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn check(app: AppHandle) -> Result<Snapshot, String> {
    initialize(&app)?;
    let manager = app.state::<UpdateManager>();
    let Ok(guard) = manager.operation.try_lock() else {
        return Ok(manager.state.lock().unwrap().clone());
    };
    let current = app.package_info().version.to_string();
    let key = platform();
    // 候选清单：CDN（大陆快）优先，GitHub 兜底。
    let sources: Vec<Result<Vec<u8>, String>> = [
        (
            MIRROR_MANIFEST_URL,
            CDN_MANIFEST_ATTEMPTS,
            Duration::from_secs(CDN_MANIFEST_TIMEOUT_SECS),
        ),
        (
            MANIFEST_URL,
            GITHUB_MANIFEST_ATTEMPTS,
            Duration::from_secs(GITHUB_MANIFEST_TIMEOUT_SECS),
        ),
    ]
    .into_iter()
    .map(|(source, attempts, timeout)| fetch_manifest_bytes(source, attempts, timeout))
    .collect();
    let result = resolve_updates(&current, &key, sources);
    // 已下好的安装包只有被更新的版本取代时才让位；否则保持现状（下好的文件不清、状态不动）。
    let mut superseded: Option<Update> = None;
    let keep_ready = {
        let previous = manager.state.lock().unwrap().clone();
        match &result {
            Ok(update) => {
                if supersedes_ready(&previous.phase, previous.update.as_ref(), update.as_ref()) {
                    superseded = previous.update.clone();
                    false
                } else {
                    previous.phase == "ready"
                }
            }
            Err(_) => false,
        }
    };
    let outcome = match result {
        Ok(update) => {
            if keep_ready {
                Ok(publish(&app, |s| s.error = None))
            } else {
                Ok(publish(&app, |s| {
                    s.update = update;
                    s.phase = if s.update.is_some() {
                        "available"
                    } else {
                        "idle"
                    }
                    .into();
                    s.downloaded = 0;
                    s.error = None;
                }))
            }
        }
        Err(error) => {
            publish(&app, |s| s.error = Some(error.clone()));
            Err(error)
        }
    };
    if let Some(old) = superseded.as_ref() {
        if let Ok(dir) = cache(&app) {
            discard_cached(&dir, old);
        }
    }
    // 必须先释放检查用的操作锁：download() 自己也 try_lock，持有锁时调用会直接返回、什么都不下。
    drop(guard);
    if superseded.is_some() {
        // 用户此前已经选择过下载（才有 ready 的安装包），这里自动接着下最新版，不必再点一次。
        spawn_auto_download(app.clone());
    }
    outcome
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
/// 签名校验只告警不拦截：CI 已保证清单必带签名，这里失败通常意味着本地缓存异常，
/// 不值得因此让用户卡在无法更新的状态（完整性另有清单 SHA256 兜底）。
fn warn_if_untrusted(app: &AppHandle, path: &Path, asset: &Asset) {
    let Some(pubkey) = configured_pubkey(app) else {
        log::warn!("配置缺少 plugins.updater.pubkey，跳过安装包来源校验");
        return;
    };
    match asset.signature.as_deref() {
        Some(signature) => {
            if let Err(error) = signature_valid(&pubkey, path, signature) {
                log::warn!("更新安装包签名校验未通过：{error}");
            }
        }
        None => log::warn!("更新清单未提供安装包签名，跳过来源校验"),
    }
}

/// 安装已下载的安装包。
///
/// Windows：以 NSIS 被动模式就地更新——`/P` 只显示安装进度条（不静默、也不要用户点向导）、
/// `/UPDATE` 覆盖安装而不走「先卸载」分支（避免整包重装、保留快捷方式与注册表）、
/// `/R` 安装完成后自动重启应用。安装程序需要替换正在运行的 exe，因此本进程随后立即退出。
/// 其余平台维持打开安装包（macOS DMG）由系统接手的既有流程。
fn install(app: AppHandle) -> Result<(), String> {
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
    warn_if_untrusted(&app, &path, &update.asset);
    install_platform(&app, &path)
}

/// Windows：被动模式就地更新，然后退出本进程。
///
/// 参数与官方 tauri-plugin-updater 的 passive 模式一致：
/// `/P` 只显示安装进度条（既不静默、也不需要用户点向导），`/UPDATE` 走覆盖安装而不进
/// 「先卸载再安装」分支（保留快捷方式与注册表，不是整包重装），`/R` 装完自动重启应用。
/// `/ARGS` 必须留在末尾——NSIS 用它复位 `$R0`，否则 `/R` 会被当成应用启动参数传下去。
#[cfg(windows)]
fn install_platform(app: &AppHandle, path: &Path) -> Result<(), String> {
    // 打包进安装目录的 node.exe 仍在运行时安装目录被占用，覆盖会失败；
    // 同时安装就意味着录制结束，所以先把服务停干净（与「退出应用」同一套收尾逻辑）。
    let state = app.state::<crate::ShellState>();
    if let Err(error) = state.backend.stop() {
        log::warn!("安装前停止本地服务失败：{error}");
    }
    std::process::Command::new(path)
        .args(["/P", "/UPDATE", "/R", "/ARGS"])
        .spawn()
        .map_err(|e| format!("无法启动安装程序，请重试：{e}"))?;
    // 安装程序需要替换正在运行的 exe，必须让出进程；/R 会在装完后重新拉起应用。
    app.exit(0);
    Ok(())
}

/// 其余平台维持打开安装包（macOS DMG）由系统安装流程接手的既有行为。
#[cfg(not(windows))]
fn install_platform(app: &AppHandle, path: &Path) -> Result<(), String> {
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
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install(app))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    fn asset() -> Asset {
        Asset {
            filename: "Live.Recorder_0.5.112_x64-setup.exe".into(),
            url: format!("{RELEASE_PREFIX}v0.5.112/Live.Recorder_0.5.112_x64-setup.exe"),
            size: 3,
            sha256: format!("{:x}", Sha256::digest(b"abc")),
            signature: None,
        }
    }
    fn manifest(version: &str) -> Manifest {
        Manifest {
            version: version.into(),
            notes: vec!["更新说明".into()],
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
    fn newer_manifest_supersedes_an_already_downloaded_installer() {
        let ready = |version: &str| Update {
            version: version.into(),
            notes: vec![],
            asset: asset(),
        };
        // 已下好旧版 + 清单出现新版 → 让位（下好的旧包不该挡住新版本）。
        assert!(supersedes_ready(
            "ready",
            Some(&ready("0.5.112")),
            Some(&ready("0.5.113"))
        ));
        // 同一版本、或清单更旧（CDN 滞后）→ 保持已下好的那份。
        assert!(!supersedes_ready(
            "ready",
            Some(&ready("0.5.112")),
            Some(&ready("0.5.112"))
        ));
        assert!(!supersedes_ready(
            "ready",
            Some(&ready("0.5.113")),
            Some(&ready("0.5.112"))
        ));
        // 还没下好 → 不涉及让位，走原有逻辑。
        assert!(!supersedes_ready(
            "available",
            Some(&ready("0.5.112")),
            Some(&ready("0.5.113"))
        ));
        // 清单无更新/不可用 → 一律保持现状。
        assert!(!supersedes_ready("ready", Some(&ready("0.5.112")), None));
        // 版本号非法 → 保持现状，绝不误删已下好的包。
        assert!(!supersedes_ready(
            "ready",
            Some(&ready("bad")),
            Some(&ready("0.5.113"))
        ));
    }

    #[test]
    fn discards_only_the_superseded_installer() {
        let dir = std::env::temp_dir().join(format!("lr-update-discard-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let old = Update {
            version: "0.5.112".into(),
            notes: vec![],
            asset: asset(),
        };
        let mut newer_asset = asset();
        newer_asset.filename = "Live.Recorder_0.5.113_x64-setup.exe".into();
        let newer = Update {
            version: "0.5.113".into(),
            notes: vec![],
            asset: newer_asset,
        };
        fs::write(installer(&dir, &old), b"abc").unwrap();
        fs::write(installer(&dir, &old).with_extension("part"), b"ab").unwrap();
        fs::write(dir.join("completed.json"), serde_json::to_vec(&old).unwrap()).unwrap();
        fs::write(installer(&dir, &newer), b"abcd").unwrap();

        discard_cached(&dir, &old);

        assert!(!installer(&dir, &old).exists());
        assert!(!installer(&dir, &old).with_extension("part").exists());
        // 元数据不删的话，下次启动 restore() 会把它恢复成「待安装」，又回到旧版本。
        assert!(!dir.join("completed.json").exists());
        // 别的版本的文件不受影响。
        assert!(installer(&dir, &newer).exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stale_cdn_manifest_yields_no_update_so_github_is_consulted() {
        // #44 freshness 保护的关键性质：CDN 清单若滞后（版本 <= 当前），select 必须返回 None，
        // 这样调用方才会继续核验 GitHub（避免「CDN 旧清单静默漏更新」）。
        assert!(select(manifest("0.5.120"), "0.5.120", "windows-x86_64")
            .unwrap()
            .is_none());
        assert!(select(manifest("0.5.119"), "0.5.120", "windows-x86_64")
            .unwrap()
            .is_none());
        // CDN 有新版本 → 直接可用（无需 GitHub）。
        let mut fresh = manifest("0.5.121");
        if let Some(a) = fresh.platforms.get_mut("windows-x86_64") {
            a.url = format!("{RELEASE_PREFIX}v0.5.121/Live.Recorder_0.5.121_x64-setup.exe");
        }
        assert!(select(fresh, "0.5.120", "windows-x86_64")
            .unwrap()
            .is_some());
    }

    #[test]
    fn resolve_updates_handles_stale_cdn_invalid_and_unreachable() {
        let key = "windows-x86_64";
        let bytes = |v: &str| {
            let mut m = manifest(v);
            if let Some(a) = m.platforms.get_mut(key) {
                a.url = format!("{RELEASE_PREFIX}v{v}/Live.Recorder_{v}_x64-setup.exe");
            }
            serde_json::to_vec(&m).unwrap()
        };
        // CDN 旧版 + GitHub 更高版 → 取 GitHub（不漏更新）。
        let got = resolve_updates(
            "0.5.120",
            key,
            vec![Ok(bytes("0.5.120")), Ok(bytes("0.5.121"))],
        )
        .unwrap()
        .unwrap();
        assert_eq!(got.version, "0.5.121");
        // CDN 有更高版本 → 直接用 CDN（GitHub 不可达也不影响）。
        let got = resolve_updates(
            "0.5.120",
            key,
            vec![Ok(bytes("0.5.121")), Err("down".to_string())],
        )
        .unwrap()
        .unwrap();
        assert_eq!(got.version, "0.5.121");
        // CDN 无效 + GitHub 不可达 → Err（不得假阴性 Ok(None)）。
        assert!(resolve_updates(
            "0.5.120",
            key,
            vec![Ok(b"<html>".to_vec()), Err("down".to_string())]
        )
        .is_err());
        // 两源均有效但都无更新 → Ok(None)。
        assert!(resolve_updates(
            "0.5.120",
            key,
            vec![Ok(bytes("0.5.120")), Ok(bytes("0.5.120"))]
        )
        .unwrap()
        .is_none());
    }
    #[test]
    fn rejects_unsafe_asset() {
        let mut a = asset();
        a.filename = "../evil-setup.exe".into();
        assert!(validate_asset("0.5.112", "windows-x86_64", &a).is_err());
        a = asset();
        a.url = "https://example.com/evil-setup.exe".into();
        assert!(validate_asset("0.5.112", "windows-x86_64", &a).is_err());
    }

    #[test]
    fn accepts_mirror_asset_but_rejects_other_origins() {
        let mut a = asset();
        a.filename = "Live.Recorder_0.5.112_aarch64.dmg".into();
        a.url = format!("{MIRROR_ORIGIN}/Live.Recorder_0.5.112_aarch64.dmg");
        assert!(validate_asset("0.5.112", "macos-aarch64", &a).is_ok());
        // 同前缀但不同域名（前缀欺骗）必须拒绝。
        a.url = "https://cdn.live-rec.bspartner.top.evil.com/x.dmg".into();
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
            Some(format!(
                "{RELEASE_PREFIX}v0.5.112/Live.Recorder_0.5.112_aarch64.dmg"
            )),
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
            notes: vec!["更新说明".into()],
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
            signature: None,
        };
        let result = download_parallel(&client, &asset.url, &path, &asset, Arc::new(|_| {}));
        worker.join().unwrap();
        assert!(result.is_ok(), "parallel download failed: {result:?}");
        assert_eq!(served.load(Ordering::Relaxed), PARALLEL_CONNECTIONS as u64);
        assert_eq!(fs::read(&path).unwrap(), body);
        let _ = fs::remove_file(path);
    }

    /// 配置里的公钥路径必须存在且是合法 minisign 公钥：公钥写错时签名校验只会静默告警，
    /// 而 tauri build 又要求 `plugins.updater` 必须存在，所以这里把两件事一起钉住。
    fn configured_pubkey_from_config() -> String {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json 不是合法 JSON");
        config
            .pointer("/plugins/updater/pubkey")
            .and_then(serde_json::Value::as_str)
            .expect("tauri.conf.json 缺少 plugins.updater.pubkey")
            .to_string()
    }

    #[test]
    fn configured_update_pubkey_is_a_valid_minisign_key() {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(configured_pubkey_from_config())
            .unwrap();
        let text = String::from_utf8(decoded).unwrap();
        assert!(minisign_verify::PublicKey::decode(&text).is_ok());
    }

    #[test]
    fn signature_verification_rejects_malformed_input() {
        let path = std::env::temp_dir().join(format!("lr-update-signature-{}", std::process::id()));
        fs::write(&path, b"abc").unwrap();
        let pubkey = configured_pubkey_from_config();
        // 非 base64 → 签名解码阶段即失败。
        assert!(signature_valid(&pubkey, &path, "not a base64 signature!").is_err());
        // 合法 base64 但内容不是 minisign 签名。
        assert!(signature_valid(&pubkey, &path, "YWJj").is_err());
        // 公钥本身合法 → 走到「签名不匹配」，说明前面确实是校验失败而不是提前返回。
        let bogus = base64::engine::general_purpose::STANDARD.encode(
            "untrusted comment: signature\n\
             RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/UYw3JpNMOxjp3Aj8KGVT/1wOf/gmBA==\n",
        );
        assert!(signature_valid(&pubkey, &path, &bogus).is_err());
        let _ = fs::remove_file(path);
    }
}
