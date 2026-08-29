use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInstance {
    pub instance_id: String,
    pub pid: u32,
    pub host: String,
    pub port: u16,
    pub base_url: String,
    pub api_version: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    #[serde(default)]
    pub ready: bool,
    #[serde(default)]
    pub instance_id: String,
    #[serde(default)]
    pub api_version: String,
    #[serde(default)]
    pub port: u16,
    pub version: Option<String>,
    #[serde(default)]
    pub uptime_seconds: u64,
    #[serde(default)]
    pub setup_completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum DiagnosticItem {
    #[serde(rename = "ok")]
    Ok { key: String, message: String },
    #[serde(rename = "warn")]
    Warn { key: String, message: String, detail: Option<String> },
    #[serde(rename = "error")]
    Error { key: String, message: String, detail: Option<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BootState {
    Booting,
    Ready,
    ExistingInstance,
    Degraded,
    Recovery,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootEvent {
    pub state: BootState,
    pub instance: Option<AppInstance>,
    pub diagnostics: Vec<DiagnosticItem>,
}