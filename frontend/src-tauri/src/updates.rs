//! GitHub-hosted installer downloads. No application replacement or process exit.
use reqwest::blocking::Client;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;

const MANIFEST_URL: &str =
    "https://github.com/PrePan01/live-recorder/releases/latest/download/latest.json";
const RELEASE_PREFIX: &str = "https://github.com/PrePan01/live-recorder/releases/download/";

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
    let url = reqwest::Url::parse(&asset.url).map_err(|_| "更新下载地址无效")?;
    let encoded_name = url.path_segments().and_then(|s| s.last()).unwrap_or("");
    if asset.filename.contains(['/', '\\', ':'])
        || asset.filename.starts_with('.')
        || !asset.filename.ends_with(extension)
        || !asset.url.starts_with(&expected)
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
fn client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .user_agent("Live-Recorder-Update-Checker")
        .build()
        .map_err(|e| e.to_string())
}
fn check(app: AppHandle) -> Result<Snapshot, String> {
    initialize(&app)?;
    let manager = app.state::<UpdateManager>();
    let Ok(_guard) = manager.operation.try_lock() else {
        return Ok(manager.state.lock().unwrap().clone());
    };
    let result = (|| {
        let response = client(Duration::from_secs(30))?
            .get(MANIFEST_URL)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("检查更新失败，请检查网络后重试：{e}"))?;
        let mut bytes = Vec::new();
        response
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 1024 * 1024 {
            return Err("更新清单过大".into());
        }
        let manifest =
            serde_json::from_slice(&bytes).map_err(|_| "更新清单格式无效".to_string())?;
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
    let result = (|| {
        let existing = fs::metadata(&partial).ok().map(|m| m.len()).unwrap_or(0);
        let resume_at = if existing > 0 && existing < update.asset.size {
            existing
        } else {
            0
        };
        if resume_at == 0 && existing > 0 {
            let _ = fs::remove_file(&partial);
        }
        let http = client(Duration::from_secs(30 * 60))?;
        let mut request = http.get(&update.asset.url);
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
        publish(&app, |s| s.downloaded = start);
        let mut last = Instant::now();
        transfer_from(
            response,
            &partial,
            &update.asset,
            start,
            append,
            &mut |total| {
                if last.elapsed() >= Duration::from_millis(100) {
                    publish(&app, |s| s.downloaded = total);
                    last = Instant::now();
                }
            },
        )?;
        if destination.exists() {
            fs::remove_file(&destination).map_err(|e| e.to_string())?;
        }
        fs::rename(&partial, &destination).map_err(|e| e.to_string())?;
        let metadata_part = dir.join("completed.part");
        fs::write(
            &metadata_part,
            serde_json::to_vec(&update).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let metadata = dir.join("completed.json");
        if metadata.exists() {
            fs::remove_file(&metadata).map_err(|e| e.to_string())?;
        }
        fs::rename(metadata_part, metadata).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })();
    match result {
        Ok(()) => Ok(publish(&app, |s| {
            s.phase = "ready".into();
            s.downloaded = update.asset.size;
        })),
        Err(error) => {
            let _ = fs::remove_file(&partial);
            publish(&app, |s| {
                s.phase = "available".into();
                s.downloaded = 0;
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
}
