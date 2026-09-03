use reqwest::Client;
use serde_json::Value;
use std::time::Duration;
use temari::rounds::Template;
use temari::template::template_from_json;

/// 从 wrapper-lite 密钥接口获取解密模板 JSON 及解析后的 Template 结构体
pub async fn fetch_key_template(
    client: &Client,
    wrapper_url: &str,
    adam_id: &str,
    uri: &str,
) -> Result<(String, Template), String> {
    let base = wrapper_url.trim_end_matches('/');
    let url = format!("{}/key", base);

    let resp = client
        .get(&url)
        .query(&[("adamId", adam_id), ("uri", uri)])
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Request to wrapper-lite failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "wrapper-lite returned HTTP {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read wrapper-lite response: {e}"))?;

    let v: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse wrapper-lite JSON: {e}"))?;

    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        let msg = v.get("msg").and_then(|m| m.as_str()).unwrap_or("unknown error");
        return Err(format!("wrapper-lite returned error code {code}: {msg}"));
    }

    let data = v
        .get("data")
        .ok_or_else(|| "wrapper-lite response missing 'data' field".to_string())?;

    let data_json = serde_json::to_string(data)
        .map_err(|e| format!("Failed to re-serialize data object: {e}"))?;

    let template = template_from_json(&data_json)
        .map_err(|e| format!("Temari failed to parse template: {e}"))?;

    Ok((data_json, template))
}
