use reqwest::{Client, Url};
use serde::{de::DeserializeOwned, Serialize};
use std::sync::RwLock;
use std::time::Duration;

use crate::models::ApiResponse;

/// 默认 API 地址，可通过环境变量 API_BASE_URL 覆盖
const DEFAULT_API_URL: &str = "http://localhost:5000";

lazy_static::lazy_static! {
    static ref API_BASE_URL: RwLock<String> = RwLock::new(
        std::env::var("API_BASE_URL").unwrap_or_else(|_| DEFAULT_API_URL.to_string())
    );
    static ref AUTH_TOKEN: RwLock<Option<String>> = RwLock::new(None);
}

/// 设置 API 基础 URL
pub fn set_api_base_url(url: String) {
    let mut base_url = API_BASE_URL.write().unwrap();
    *base_url = url;
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

/// 获取默认 API 地址
pub fn get_default_api_url() -> String {
    DEFAULT_API_URL.to_string()
}

pub struct ApiClient {
    client: Client,
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
    }

    #[allow(dead_code)]
    pub fn clear_token() {
        let mut auth = AUTH_TOKEN.write().unwrap();
        *auth = None;
    }

    fn get_base_url() -> String {
        API_BASE_URL.read().unwrap().clone()
    }

    fn get_token() -> Option<String> {
        AUTH_TOKEN.read().unwrap().clone()
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<ApiResponse<T>, String> {
        let url = format!("{}/api/v1{}", Self::get_base_url(), path);

        let mut request = self.client.get(&url);

        if let Some(token) = Self::get_token() {
            request = request.header("Authorization", format!("Bearer {}", token));
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        if text.is_empty() {
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

    pub async fn post<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<ApiResponse<T>, String> {
        let url = format!("{}/api/v1{}", Self::get_base_url(), path);

        let mut request = self.client.post(&url).json(body);

        if let Some(token) = Self::get_token() {
            request = request.header("Authorization", format!("Bearer {}", token));
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();
        let headers = format!("{:?}", response.headers());

        let text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        if text.is_empty() {
            return Err(format!(
                "Empty response from server. Status: {}, Headers: {}",
                status, headers
            ));
        }

        serde_json::from_str::<ApiResponse<T>>(&text).map_err(|e| {
            format!(
                "Failed to parse response: {}. Response: {}",
                e,
                &text[..text.len().min(500)]
            )
        })
    }

    pub async fn put<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<ApiResponse<T>, String> {
        let url = format!("{}/api/v1{}", Self::get_base_url(), path);

        let mut request = self.client.put(&url).json(body);

        if let Some(token) = Self::get_token() {
            request = request.header("Authorization", format!("Bearer {}", token));
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        response
            .json::<ApiResponse<T>>()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))
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

    match parsed.host_str() {
        Some("localhost") | Some("127.0.0.1") | Some("::1") => true,
        _ => false,
    }
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
