use reqwest::{Client, StatusCode, Url};
use serde::{de::DeserializeOwned, Serialize};
use std::sync::RwLock;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use crate::models::{ApiError, ApiResponse, LoginResponse};

/// 默认 API 地址（非开发者），可通过环境变量 API_BASE_URL 覆盖
const DEFAULT_API_URL: &str = "https://pa.759800.com";

lazy_static::lazy_static! {
    static ref API_BASE_URL: RwLock<String> = RwLock::new(
        std::env::var("API_BASE_URL").unwrap_or_else(|_| DEFAULT_API_URL.to_string())
    );
    static ref AUTH_TOKEN: RwLock<Option<String>> = RwLock::new(None);
    static ref AUTH_USER_ID: RwLock<Option<String>> = RwLock::new(None);
    static ref AUTH_REFRESH_TOKEN: RwLock<Option<String>> = RwLock::new(None);
    static ref AUTH_SESSION_KEY: RwLock<Option<String>> = RwLock::new(None);
    static ref AUTH_CLIENT_TYPE: RwLock<Option<String>> = RwLock::new(Some("desktop".to_string()));
    static ref CLIENT_ID: RwLock<Option<String>> = RwLock::new(None);
    static ref HEARTBEAT_TOKEN: std::sync::Mutex<Option<CancellationToken>> = std::sync::Mutex::new(None);
}

/// 设置 API 基础 URL
pub fn set_api_base_url(url: String) {
    let mut base_url = API_BASE_URL.write().unwrap();
    *base_url = url;
}

/// 设置 desktop 客户端实例 id（用于 X-Client-Id）
pub fn set_client_id(id: String) {
    let trimmed = id.trim().to_string();
    if trimmed.is_empty() {
        return;
    }
    *CLIENT_ID.write().unwrap() = Some(trimmed);
}

/// 获取当前 auth token（用于 SSE 等需要手动拼 header 的场景）
pub fn get_auth_token() -> Option<String> {
    AUTH_TOKEN.read().unwrap().clone()
}

/// 获取当前 API 基础 URL
#[allow(dead_code)]
pub fn get_api_base_url() -> String {
    API_BASE_URL.read().unwrap().clone()
}

/// 获取当前 client id（用于附件上传等手动拼 header 的场景）
pub fn get_client_id_pub() -> Option<String> {
    CLIENT_ID.read().unwrap().clone()
}

/// 获取默认 API 地址
pub fn get_default_api_url() -> String {
    DEFAULT_API_URL.to_string()
}

pub struct ApiClient {
    client: Client,
}

#[derive(Serialize)]
struct EmptyJson {}

fn start_desktop_presence_heartbeat() {
    let mut guard = HEARTBEAT_TOKEN.lock().unwrap();
    if guard.is_some() {
        return;
    }

    let token = CancellationToken::new();
    *guard = Some(token.clone());

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(30));
        // 立即执行一次，避免等 30s 才上线
        loop {
            if token.is_cancelled() {
                break;
            }

            // 仅在有 token 时发送心跳
            if AUTH_TOKEN.read().unwrap().is_some() {
                let base_url = API_BASE_URL.read().unwrap().clone();
                let url = format!(
                    "{}/api/v1/desktop/presence/heartbeat",
                    base_url.trim_end_matches('/')
                );
                let client = build_http_client(&base_url);

                let mut req = client.post(&url).json(&EmptyJson {});
                req = req.header("X-Client", "desktop");
                if let Some(cid) = CLIENT_ID.read().unwrap().clone() {
                    if !cid.trim().is_empty() {
                        req = req.header("X-Client-Id", cid);
                    }
                }
                if let Some(t) = AUTH_TOKEN.read().unwrap().clone() {
                    req = req.header("Authorization", format!("Bearer {}", t));
                }

                // 忽略失败：网络波动/服务端重启时不影响 UI
                let _ = req.send().await;
            }

            ticker.tick().await;
        }
    });
}

pub fn stop_desktop_presence_heartbeat() {
    let mut guard = HEARTBEAT_TOKEN.lock().unwrap();
    if let Some(t) = guard.take() {
        t.cancel();
    }
}

impl ApiClient {
    pub fn new() -> Self {
        let base_url = Self::get_base_url();
        Self {
            client: build_http_client(&base_url),
        }
    }

    pub fn set_token(token: String) {
        let mut auth = AUTH_TOKEN.write().unwrap();
        *auth = Some(token);
        start_desktop_presence_heartbeat();
    }

    pub fn set_auth_session(
        user_id: Option<String>,
        refresh_token: Option<String>,
        session_key: Option<String>,
        client_type: Option<String>,
    ) {
        *AUTH_USER_ID.write().unwrap() = user_id.filter(|s| !s.trim().is_empty());
        *AUTH_REFRESH_TOKEN.write().unwrap() = refresh_token.filter(|s| !s.trim().is_empty());
        *AUTH_SESSION_KEY.write().unwrap() = session_key.filter(|s| !s.trim().is_empty());
        *AUTH_CLIENT_TYPE.write().unwrap() = client_type
            .map(|s| s.trim().to_lowercase())
            .filter(|s| s == "admin" || s == "desktop")
            .or_else(|| Some("desktop".to_string()));
    }

    #[allow(dead_code)]
    pub fn clear_token() {
        let mut auth = AUTH_TOKEN.write().unwrap();
        *auth = None;
        stop_desktop_presence_heartbeat();
    }

    fn get_base_url() -> String {
        API_BASE_URL.read().unwrap().clone()
    }

    fn get_token() -> Option<String> {
        AUTH_TOKEN.read().unwrap().clone()
    }

    fn get_client_id() -> Option<String> {
        CLIENT_ID.read().unwrap().clone()
    }

    fn apply_common_headers(
        &self,
        mut request: reqwest::RequestBuilder,
    ) -> reqwest::RequestBuilder {
        request = request.header("X-Client", "desktop");
        if let Some(cid) = Self::get_client_id() {
            if !cid.trim().is_empty() {
                request = request.header("X-Client-Id", cid);
            }
        }
        if let Some(token) = Self::get_token() {
            request = request.header("Authorization", format!("Bearer {}", token));
        }
        request
    }

    fn get_refresh_ctx() -> Option<(String, String, String, String)> {
        let uid = AUTH_USER_ID.read().unwrap().clone()?;
        let rt = AUTH_REFRESH_TOKEN.read().unwrap().clone()?;
        let sk = AUTH_SESSION_KEY.read().unwrap().clone()?;
        let ct = AUTH_CLIENT_TYPE
            .read()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "desktop".to_string());
        Some((uid, rt, sk, ct))
    }

    async fn try_refresh(&self) -> Result<bool, String> {
        let Some((user_id, refresh_token, session_key, client_type)) = Self::get_refresh_ctx()
        else {
            return Ok(false);
        };

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct RefreshRequest {
            refresh_token: String,
            user_id: String,
            client_type: String,
            session_key: String,
        }

        let url = format!("{}/api/v1/auth/refresh", Self::get_base_url());
        #[cfg(debug_assertions)]
        eprintln!("[api] POST {} (refresh)", url);

        let req = RefreshRequest {
            refresh_token,
            user_id,
            client_type,
            session_key,
        };

        let request = self.apply_common_headers(self.client.post(&url).json(&req));
        let response = request
            .send()
            .await
            .map_err(|e| format!("Refresh request failed: {}", e))?;

        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read refresh response: {}", e))?;

        if text.is_empty() || status != StatusCode::OK {
            return Ok(false);
        }

        let parsed = serde_json::from_str::<ApiResponse<LoginResponse>>(&text).map_err(|e| {
            format!(
                "Failed to parse refresh response: {}. Status: {}. Body: {}",
                e,
                status,
                &text[..text.len().min(500)]
            )
        })?;

        if !parsed.success {
            return Ok(false);
        }

        if let Some(data) = parsed.data {
            ApiClient::set_token(data.access_token.clone());
            ApiClient::set_auth_session(
                Some(data.user.user_id),
                Some(data.refresh_token),
                Some(data.session_key),
                Some(data.client_type),
            );
            return Ok(true);
        }

        Ok(false)
    }

    /// 尝试刷新 access token（用于 SSE 场景手动处理 401）
    pub async fn refresh_auth(&self) -> Result<bool, String> {
        self.try_refresh().await
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<ApiResponse<T>, String> {
        let url = format!("{}/api/v1{}", Self::get_base_url(), path);

        #[cfg(debug_assertions)]
        eprintln!("[api] GET {}", url);

        for attempt in 0..2 {
            let request = self.apply_common_headers(self.client.get(&url));

            let response = request
                .send()
                .await
                .map_err(|e| format!("Request failed: {}", e))?;

            let status = response.status();

            // access 过期：尝试 refresh 后重试一次（避免递归 async）
            if status == StatusCode::UNAUTHORIZED
                && attempt == 0
                && self.try_refresh().await.unwrap_or(false)
            {
                continue;
            }

            #[cfg(debug_assertions)]
            eprintln!("[api] <- {} {}", status.as_u16(), url);

            let text = response
                .text()
                .await
                .map_err(|e| format!("Failed to read response: {}", e))?;

            if text.is_empty() {
                // 某些中间件/默认认证挑战会返回空 body（401/403），这里做兼容，避免前端看到 "Empty response..."
                if status == StatusCode::UNAUTHORIZED {
                    return Ok(ApiResponse::<T> {
                        success: false,
                        data: None,
                        error: Some(ApiError {
                            code: "UNAUTHORIZED".to_string(),
                            message: "未授权".to_string(),
                        }),
                    });
                }
                if status == StatusCode::FORBIDDEN {
                    return Ok(ApiResponse::<T> {
                        success: false,
                        data: None,
                        error: Some(ApiError {
                            code: "PERMISSION_DENIED".to_string(),
                            message: "无权限".to_string(),
                        }),
                    });
                }
                return Err(format!(
                    "Empty response from server. Status: {}, URL: {}",
                    status, url
                ));
            }

            return serde_json::from_str::<ApiResponse<T>>(&text).map_err(|e| {
                format!(
                    "Failed to parse response: {}. Status: {}. Response body: {}",
                    e,
                    status,
                    &text[..text.len().min(500)]
                )
            });
        }

        // 理论不会到达
        Ok(ApiResponse::<T> {
            success: false,
            data: None,
            error: Some(ApiError {
                code: "UNAUTHORIZED".to_string(),
                message: "未授权".to_string(),
            }),
        })
    }

    pub async fn post<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<ApiResponse<T>, String> {
        let url = format!("{}/api/v1{}", Self::get_base_url(), path);

        #[cfg(debug_assertions)]
        eprintln!("[api] POST {}", url);

        for attempt in 0..2 {
            let request = self.apply_common_headers(self.client.post(&url).json(body));

            let response = request
                .send()
                .await
                .map_err(|e| format!("Request failed: {}", e))?;

            let status = response.status();

            if status == StatusCode::UNAUTHORIZED
                && attempt == 0
                && self.try_refresh().await.unwrap_or(false)
            {
                continue;
            }

            let headers = format!("{:?}", response.headers());
            #[cfg(debug_assertions)]
            eprintln!("[api] <- {} {}", status.as_u16(), url);

            let text = response
                .text()
                .await
                .map_err(|e| format!("Failed to read response: {}", e))?;

            if text.is_empty() {
                if status == StatusCode::UNAUTHORIZED {
                    return Ok(ApiResponse::<T> {
                        success: false,
                        data: None,
                        error: Some(ApiError {
                            code: "UNAUTHORIZED".to_string(),
                            message: "未授权".to_string(),
                        }),
                    });
                }
                if status == StatusCode::FORBIDDEN {
                    return Ok(ApiResponse::<T> {
                        success: false,
                        data: None,
                        error: Some(ApiError {
                            code: "PERMISSION_DENIED".to_string(),
                            message: "无权限".to_string(),
                        }),
                    });
                }
                return Err(format!(
                    "Empty response from server. Status: {}, Headers: {}",
                    status, headers
                ));
            }

            return serde_json::from_str::<ApiResponse<T>>(&text).map_err(|e| {
                format!(
                    "Failed to parse response: {}. Response: {}",
                    e,
                    &text[..text.len().min(500)]
                )
            });
        }

        Ok(ApiResponse::<T> {
            success: false,
            data: None,
            error: Some(ApiError {
                code: "UNAUTHORIZED".to_string(),
                message: "未授权".to_string(),
            }),
        })
    }

    pub async fn put<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<ApiResponse<T>, String> {
        let url = format!("{}/api/v1{}", Self::get_base_url(), path);

        #[cfg(debug_assertions)]
        eprintln!("[api] PUT {}", url);

        for attempt in 0..2 {
            let request = self.apply_common_headers(self.client.put(&url).json(body));

            let response = request
                .send()
                .await
                .map_err(|e| format!("Request failed: {}", e))?;

            let status = response.status();
            if status == StatusCode::UNAUTHORIZED
                && attempt == 0
                && self.try_refresh().await.unwrap_or(false)
            {
                continue;
            }

            #[cfg(debug_assertions)]
            eprintln!("[api] <- {} {}", status.as_u16(), url);

            let text = response
                .text()
                .await
                .map_err(|e| format!("Failed to read response: {}", e))?;

            if text.is_empty() {
                if status == StatusCode::UNAUTHORIZED {
                    return Ok(ApiResponse::<T> {
                        success: false,
                        data: None,
                        error: Some(ApiError {
                            code: "UNAUTHORIZED".to_string(),
                            message: "未授权".to_string(),
                        }),
                    });
                }
                if status == StatusCode::FORBIDDEN {
                    return Ok(ApiResponse::<T> {
                        success: false,
                        data: None,
                        error: Some(ApiError {
                            code: "PERMISSION_DENIED".to_string(),
                            message: "无权限".to_string(),
                        }),
                    });
                }
                return Err(format!(
                    "Empty response from server. Status: {}, URL: {}",
                    status, url
                ));
            }

            return serde_json::from_str::<ApiResponse<T>>(&text).map_err(|e| {
                format!(
                    "Failed to parse response: {}. Status: {}. Response body: {}",
                    e,
                    status,
                    &text[..text.len().min(500)]
                )
            });
        }

        Ok(ApiResponse::<T> {
            success: false,
            data: None,
            error: Some(ApiError {
                code: "UNAUTHORIZED".to_string(),
                message: "未授权".to_string(),
            }),
        })
    }

    pub async fn delete<T: DeserializeOwned>(&self, path: &str) -> Result<ApiResponse<T>, String> {
        let url = format!("{}/api/v1{}", Self::get_base_url(), path);

        #[cfg(debug_assertions)]
        eprintln!("[api] DELETE {}", url);

        let request = self.apply_common_headers(self.client.delete(&url));

        let response = request
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();
        #[cfg(debug_assertions)]
        eprintln!("[api] <- {} {}", status.as_u16(), url);
        let text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        if text.is_empty() {
            if status == StatusCode::UNAUTHORIZED {
                return Ok(ApiResponse::<T> {
                    success: false,
                    data: None,
                    error: Some(ApiError {
                        code: "UNAUTHORIZED".to_string(),
                        message: "未授权".to_string(),
                    }),
                });
            }
            if status == StatusCode::FORBIDDEN {
                return Ok(ApiResponse::<T> {
                    success: false,
                    data: None,
                    error: Some(ApiError {
                        code: "PERMISSION_DENIED".to_string(),
                        message: "无权限".to_string(),
                    }),
                });
            }
            return Err(format!(
                "Empty response from server. Status: {}, URL: {}",
                status, url
            ));
        }

        serde_json::from_str::<ApiResponse<T>>(&text).map_err(|e| {
            format!(
                "Failed to parse response: {}. Status: {}. Response body: {}",
                e,
                status,
                &text[..text.len().min(500)]
            )
        })
    }
}

impl Default for ApiClient {
    fn default() -> Self {
        Self::new()
    }
}

fn is_localhost_url(api_base_url: &str) -> bool {
    let parsed = match Url::parse(api_base_url) {
        Ok(v) => v,
        Err(_) => return false,
    };

    matches!(
        parsed.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

/// 统一构建 HTTP client：
/// - 对 localhost/127.0.0.1/::1 自动绕过系统/环境代理，避免被全局代理截胡导致 503
/// - 其他地址保持 reqwest 默认行为（允许使用环境代理）
pub fn build_http_client(api_base_url: &str) -> Client {
    let mut builder = Client::builder().timeout(Duration::from_secs(60));

    if is_localhost_url(api_base_url) {
        builder = builder.no_proxy();
    }

    builder.build().unwrap_or_else(|_| Client::new())
}

/// SSE/流式请求专用：不设置总超时（避免长对话被客户端超时切断），但仍对 localhost 绕过代理
pub fn build_streaming_client(api_base_url: &str) -> Client {
    let mut builder = Client::builder();
    if is_localhost_url(api_base_url) {
        builder = builder.no_proxy();
    }
    builder.build().unwrap_or_else(|_| Client::new())
}
