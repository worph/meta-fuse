use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct ApiClient {
    base_url: String,
    client: Client,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileAttributes {
    pub size: u64,
    pub mode: u32,
    pub mtime: f64,
    pub atime: f64,
    pub ctime: f64,
    pub nlink: u32,
    pub uid: u32,
    pub gid: u32,
}

#[derive(Debug, Deserialize)]
pub struct ReadResult {
    #[serde(rename = "sourcePath")]
    pub source_path: Option<String>,
    #[serde(rename = "webdavUrl")]
    pub webdav_url: Option<String>,
    pub content: Option<String>,
    #[serde(rename = "contentEncoding")]
    pub content_encoding: Option<String>,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
pub struct ReaddirResponse {
    pub entries: Vec<String>,
}

#[derive(Debug, Serialize)]
struct PathRequest {
    path: String,
}

impl ApiClient {
    pub fn new(base_url: String) -> Result<Self, Box<dyn std::error::Error>> {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;

        Ok(ApiClient { base_url, client })
    }

    pub fn readdir(&self, path: &str) -> Result<Vec<String>, Box<dyn std::error::Error>> {
        let url = format!("{}/api/fuse/readdir", self.base_url);
        let request = PathRequest {
            path: path.to_string(),
        };

        let response = self.client.post(&url).json(&request).send()?;

        if response.status().is_success() {
            let result: ReaddirResponse = response.json()?;
            Ok(result.entries)
        } else {
            Err(format!("API error: {}", response.status()).into())
        }
    }

    pub fn getattr(&self, path: &str) -> Result<FileAttributes, Box<dyn std::error::Error>> {
        let url = format!("{}/api/fuse/getattr", self.base_url);
        let request = PathRequest {
            path: path.to_string(),
        };

        let response = self.client.post(&url).json(&request).send()?;

        if response.status().is_success() {
            let attrs: FileAttributes = response.json()?;
            Ok(attrs)
        } else {
            Err(format!("API error: {}", response.status()).into())
        }
    }

    pub fn exists(&self, path: &str) -> Result<bool, Box<dyn std::error::Error>> {
        let url = format!("{}/api/fuse/exists", self.base_url);
        let request = PathRequest {
            path: path.to_string(),
        };

        let response = self.client.post(&url).json(&request).send()?;

        if response.status().is_success() {
            let result: HashMap<String, bool> = response.json()?;
            Ok(result.get("exists").copied().unwrap_or(false))
        } else {
            Err(format!("API error: {}", response.status()).into())
        }
    }

    pub fn read(&self, path: &str) -> Result<ReadResult, Box<dyn std::error::Error>> {
        let url = format!("{}/api/fuse/read", self.base_url);
        let request = PathRequest {
            path: path.to_string(),
        };

        let response = self.client.post(&url).json(&request).send()?;

        if response.status().is_success() {
            let result: ReadResult = response.json()?;
            Ok(result)
        } else {
            Err(format!("API error: {}", response.status()).into())
        }
    }

    pub fn health_check(&self) -> Result<bool, Box<dyn std::error::Error>> {
        let url = format!("{}/api/fuse/health", self.base_url);
        let response = self.client.get(&url).send()?;
        Ok(response.status().is_success())
    }
}
