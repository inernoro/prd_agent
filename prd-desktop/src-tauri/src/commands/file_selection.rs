//! File authority is minted only by the native picker, never by a frontend path.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const MAX_FILE: u64 = 50 * 1024 * 1024;
const MAX_PENDING: usize = 100 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FilePurpose {
    Attachment,
    Document,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedFile {
    selection_id: String,
    name: String,
}

pub struct SelectedBytes {
    pub name: String,
    pub bytes: Vec<u8>,
}
struct Grant {
    file: SelectedBytes,
    purpose: FilePurpose,
    session_id: Option<String>,
    auth: Option<String>,
    api_origin: String,
    created: Instant,
}
#[derive(Default)]
pub struct FileSelections(Mutex<HashMap<String, Grant>>);

impl FileSelections {
    pub fn consume(
        &self,
        id: &str,
        purpose: FilePurpose,
        session_id: Option<&str>,
    ) -> Result<SelectedBytes, String> {
        let mut grants = self.0.lock().map_err(|_| "文件授权不可用")?;
        grants.retain(|_, g| g.created.elapsed() < TTL);
        let grant = grants
            .get(id)
            .ok_or("文件未经授权或已失效，请重新选择文件")?;
        if grant.purpose != purpose
            || grant.session_id.as_deref() != session_id
            || grant.auth != crate::services::api_client::get_auth_token()
            || grant.api_origin != crate::services::api_client::get_api_base_url()
        {
            return Err("文件授权不属于当前操作，请重新选择文件".into());
        }
        Ok(grants.remove(id).unwrap().file)
    }
}

#[tauri::command]
pub async fn select_upload_files(
    window: WebviewWindow,
    purpose: FilePurpose,
    session_id: Option<String>,
    multiple: bool,
) -> Result<Vec<SelectedFile>, String> {
    if window.label() != "main" {
        return Err("当前窗口不能选择上传文件".into());
    }
    if purpose == FilePurpose::Document && session_id.as_deref().unwrap_or("").is_empty() {
        return Err("请先打开会话再选择文件".into());
    }
    let auth = crate::services::api_client::get_auth_token();
    let api_origin = crate::services::api_client::get_api_base_url();
    let mut picker = window
        .dialog()
        .file()
        .set_title("选择要上传的文件")
        .set_parent(&window);
    if purpose == FilePurpose::Attachment {
        picker = picker.add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp", "svg"]);
    }
    let paths = if multiple {
        picker.blocking_pick_files().unwrap_or_default()
    } else {
        picker.blocking_pick_file().into_iter().collect()
    };
    if paths.len() > 20 {
        return Err("一次最多选择 20 个文件".into());
    }
    // Snapshot immediately after native consent. Later path/symlink replacement cannot change upload bytes.
    let mut pending = Vec::new();
    let mut total = 0;
    for path in paths {
        let path = path.into_path().map_err(|_| "无法打开所选文件")?;
        let file = std::fs::File::open(&path).map_err(|_| "无法打开所选文件，请重新选择")?;
        let metadata = file.metadata().map_err(|_| "无法检查所选文件")?;
        let limit = if purpose == FilePurpose::Attachment {
            5 * 1024 * 1024
        } else {
            MAX_FILE
        };
        if !metadata.is_file() || metadata.len() > limit {
            return Err("所选文件不是普通文件或超过大小限制".into());
        }
        let mut bytes = Vec::new();
        file.take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取所选文件")?;
        total += bytes.len();
        if bytes.len() as u64 > limit || total > MAX_PENDING {
            return Err("所选文件超过大小限制".into());
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        pending.push((
            uuid::Uuid::new_v4().to_string(),
            SelectedBytes { name, bytes },
        ));
    }
    let selections = window.state::<FileSelections>();
    let mut grants = selections.0.lock().map_err(|_| "文件授权不可用")?;
    grants.retain(|_, g| g.created.elapsed() < TTL);
    if grants.values().map(|g| g.file.bytes.len()).sum::<usize>() + total > MAX_PENDING {
        return Err("待上传文件过多，请稍后重新选择".into());
    }
    let mut result = Vec::new();
    for (id, file) in pending {
        result.push(SelectedFile {
            selection_id: id.clone(),
            name: file.name.clone(),
        });
        grants.insert(
            id,
            Grant {
                file,
                purpose: purpose.clone(),
                session_id: session_id.clone(),
                auth: auth.clone(),
                api_origin: api_origin.clone(),
                created: Instant::now(),
            },
        );
    }
    Ok(result)
}

pub fn consume_selection(
    window: &WebviewWindow,
    selections: State<'_, FileSelections>,
    id: &str,
    purpose: FilePurpose,
    session: Option<&str>,
) -> Result<SelectedBytes, String> {
    if window.label() != "main" {
        return Err("当前窗口不能上传文件".into());
    }
    selections.consume(id, purpose, session)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn grant(state: &FileSelections, age: Duration) {
        state.0.lock().unwrap().insert(
            "chosen".into(),
            Grant {
                file: SelectedBytes {
                    name: "chosen.txt".into(),
                    bytes: b"selected snapshot".to_vec(),
                },
                purpose: FilePurpose::Document,
                session_id: Some("session-a".into()),
                auth: crate::services::api_client::get_auth_token(),
                api_origin: crate::services::api_client::get_api_base_url(),
                created: Instant::now() - age,
            },
        );
    }
    #[test]
    fn arbitrary_paths_and_forged_grants_are_denied() {
        let state = FileSelections::default();
        for id in [
            "/tmp/sentinel",
            "../sentinel",
            "file:///tmp/sentinel",
            "forged",
        ] {
            assert!(state.consume(id, FilePurpose::Attachment, None).is_err());
        }
    }
    #[test]
    fn selection_is_bound_to_operation_and_single_use() {
        let state = FileSelections::default();
        grant(&state, Duration::ZERO);
        assert!(state
            .consume("chosen", FilePurpose::Attachment, None)
            .is_err());
        assert!(state
            .consume("chosen", FilePurpose::Document, Some("session-b"))
            .is_err());
        assert_eq!(
            state
                .consume("chosen", FilePurpose::Document, Some("session-a"))
                .unwrap()
                .bytes,
            b"selected snapshot"
        );
        assert!(state
            .consume("chosen", FilePurpose::Document, Some("session-a"))
            .is_err());
    }
    #[test]
    fn selection_cannot_follow_an_origin_or_identity_change() {
        let state = FileSelections::default();
        grant(&state, Duration::ZERO);
        state
            .0
            .lock()
            .unwrap()
            .get_mut("chosen")
            .unwrap()
            .api_origin = "https://different.invalid".into();
        assert!(state
            .consume("chosen", FilePurpose::Document, Some("session-a"))
            .is_err());
        grant(&state, Duration::ZERO);
        state.0.lock().unwrap().get_mut("chosen").unwrap().auth = Some("different-session".into());
        assert!(state
            .consume("chosen", FilePurpose::Document, Some("session-a"))
            .is_err());
    }

    #[test]
    fn stale_selection_is_denied() {
        let state = FileSelections::default();
        grant(&state, TTL + Duration::from_secs(1));
        assert!(state
            .consume("chosen", FilePurpose::Document, Some("session-a"))
            .is_err());
    }
}
