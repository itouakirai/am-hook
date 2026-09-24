use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;
use serde_json::value::RawValue;
use temari::rounds::Template;
use temari::template::template_from_json;

#[derive(Deserialize)]
struct KeyResponse<'a> {
    code: i64,
    #[serde(default)]
    msg: Option<String>,
    #[serde(borrow)]
    data: Option<&'a RawValue>,
}

/// 从 wrapper-lite `/key` 接口获取 `data` 并解析为解密模板
pub async fn fetch_key_template(client: &Client, wrapper_url: &str, adam_id: &str, uri: &str) -> Result<Template, String> {
    let data = fetch_key_json(client, wrapper_url, adam_id, uri).await?;
    template_from_json(&data).map_err(|e| format!("Temari failed to parse template: {e}"))
}

/// 从 wrapper-lite `/key` 接口获取原始模板 JSON（响应中的 `data` 字段），供浏览器端解密使用
pub async fn fetch_key_json(client: &Client, wrapper_url: &str, adam_id: &str, uri: &str) -> Result<String, String> {
    let resp = client
        .get(format!("{wrapper_url}/key"))
        .query(&[("adamId", adam_id), ("uri", uri)])
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Request to wrapper-lite failed: {e}"))?;

    let status = resp.status();
    let body = resp.bytes().await.map_err(|e| format!("Failed to read wrapper-lite response: {e}"))?;
    if !status.is_success() {
        return Err(format!("wrapper-lite returned HTTP {status}: {}", String::from_utf8_lossy(&body)));
    }

    let v: KeyResponse = serde_json::from_slice(&body).map_err(|e| format!("Failed to parse wrapper-lite JSON: {e}"))?;
    if v.code != 0 {
        return Err(format!("wrapper-lite returned error code {}: {}", v.code, v.msg.as_deref().unwrap_or("unknown error")));
    }
    let data = v.data.ok_or("wrapper-lite response missing 'data' field")?;
    Ok(data.get().to_string())
}
