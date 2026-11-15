//! 安全相关的响应头：所有响应（页面外壳、静态资源、接口）都带同一组。
//!
//! - CSP 只限制脚本来源（外壳没有内联脚本，脚本、Worker 与 AudioWorklet 都来自本站；wasm 需要 `'wasm-unsafe-eval'`），
//!   禁止插件与 `<base>`，不允许被嵌入 iframe。图片、媒体、字体与网络请求不限：封面与音频来自 Apple CDN，
//!   wrapper-lite 与歌词字体的地址由用户设置。Worker 脚本的响应也带这条 CSP（Worker 按自己脚本的响应头生效）。
//! - `nosniff`：接口返回的 JSON 不会被当作脚本或样式加载。
//!
//! serverless 部署的同一组响应头在 `serverless/core.mjs`（`SECURITY_HEADERS`）、`vercel.json` 与
//! `scripts/build-static.mjs`（Cloudflare 的 `_headers`），测试比对它们与这里一致。

use axum::extract::Request;
use axum::http::HeaderValue;
use axum::middleware::Next;
use axum::response::Response;

pub const CONTENT_SECURITY_POLICY: &str = "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

pub const HEADERS: [(&str, &str); 5] = [
    ("content-security-policy", CONTENT_SECURITY_POLICY),
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "strict-origin-when-cross-origin"),
    ("cross-origin-opener-policy", "same-origin-allow-popups"),
];

/// 给响应补上 [`HEADERS`]（处理函数自己设置了同名响应头时不覆盖）
pub async fn headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let map = response.headers_mut();
    for (name, value) in HEADERS {
        map.entry(name).or_insert(HeaderValue::from_static(value));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    /// vercel.json 对所有地址设置的响应头与这里一致（serverless/core.mjs 与 vercel.json 的一致性见 tests/unit/serverless.mjs）
    #[test]
    fn vercel_headers_match() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../vercel.json")).unwrap();
        let rule = config["headers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|rule| rule["source"] == "/(.*)")
            .expect("vercel.json has a headers rule for /(.*)");
        let mut found: Vec<(String, String)> = rule["headers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| (h["key"].as_str().unwrap().to_ascii_lowercase(), h["value"].as_str().unwrap().to_owned()))
            .collect();
        found.sort();
        let mut expected: Vec<(String, String)> = HEADERS.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        expected.sort();
        assert_eq!(found, expected);
    }
}
