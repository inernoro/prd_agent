use reqwest::Client;
use serde::{de::DeserializeOwned, Serialize};
use std::sync::RwLock;

use crate::models::ApiResponse;

/// 默认 API 地址，可通过环境变量 API_BASE_URL 覆盖
const DEFAULT_API_URL: &str = "https://agentapi.759800.com";

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
        Self {
            client: Client::new(),
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

        response
            .json::<ApiResponse<T>>()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))
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

        response
            .json::<ApiResponse<T>>()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))
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
