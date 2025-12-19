use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAskHistoryItem {
    pub id: String,
    pub question: String,
    pub answer: String,
    pub heading_id: String,
    pub heading_title: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct PreviewAskHistoryFile {
    /// sessionId -> headingId -> items
    #[serde(default)]
    sessions: HashMap<String, HashMap<String, Vec<PreviewAskHistoryItem>>>,
}

fn now_ms() -> i64 {
    // SystemTime 可能因系统时钟被调整而不单调，但用于“历史记录时间戳”足够
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_else(|_| std::time::Duration::from_millis(0));
    dur.as_millis() as i64
}

fn get_history_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    }

    Ok(app_data_dir.join("preview_ask_history.json"))
}

fn load_history(app: &tauri::AppHandle) -> Result<PreviewAskHistoryFile, String> {
    let path = get_history_path(app)?;
    if !path.exists() {
        return Ok(PreviewAskHistoryFile::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read history file: {}", e))?;
    match serde_json::from_str::<PreviewAskHistoryFile>(&content) {
        Ok(v) => Ok(v),
        Err(_) => {
            // 容错：历史文件损坏时不阻塞功能，返回空并允许后续覆盖写回
            Ok(PreviewAskHistoryFile::default())
        }
    }
}

fn save_history(app: &tauri::AppHandle, store: &PreviewAskHistoryFile) -> Result<(), String> {
    let path = get_history_path(app)?;
    let content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize history: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write history file: {}", e))
}

#[tauri::command]
pub async fn get_preview_ask_history(
    app: tauri::AppHandle,
    session_id: String,
    heading_id: String,
    limit: Option<usize>,
) -> Result<Vec<PreviewAskHistoryItem>, String> {
    let store = load_history(&app)?;
    let mut items = store
        .sessions
        .get(&session_id)
        .and_then(|m| m.get(&heading_id))
        .cloned()
        .unwrap_or_default();

    // 按时间升序保证稳定（文件里可能已是升序，但这里再保守排序一次）
    items.sort_by_key(|x| x.created_at_ms);

    if let Some(l) = limit {
        if items.len() > l {
            items = items[items.len().saturating_sub(l)..].to_vec();
        }
    }
    Ok(items)
}

#[tauri::command]
pub async fn append_preview_ask_history(
    app: tauri::AppHandle,
    session_id: String,
    heading_id: String,
    heading_title: Option<String>,
    question: String,
    answer: String,
) -> Result<(), String> {
    let mut store = load_history(&app)?;
    let by_session = store.sessions.entry(session_id).or_default();
    let list = by_session.entry(heading_id.clone()).or_default();

    let item = PreviewAskHistoryItem {
        id: Uuid::new_v4().to_string(),
        question,
        answer,
        heading_id,
        heading_title,
        created_at_ms: now_ms(),
    };
    list.push(item);

    // 防止文件无限增长：每个章节最多保留最近 50 条
    const MAX_PER_HEADING: usize = 50;
    if list.len() > MAX_PER_HEADING {
        let start = list.len() - MAX_PER_HEADING;
        *list = list[start..].to_vec();
    }

    save_history(&app, &store)
}

#[tauri::command]
pub async fn clear_preview_ask_history(
    app: tauri::AppHandle,
    session_id: String,
    heading_id: String,
) -> Result<(), String> {
    let mut store = load_history(&app)?;
    if let Some(by_heading) = store.sessions.get_mut(&session_id) {
        by_heading.remove(&heading_id);
        if by_heading.is_empty() {
            store.sessions.remove(&session_id);
        }
    }
    save_history(&app, &store)
}
