use serde::Serialize;
use std::net::IpAddr;
use std::time::{Duration, Instant};
use tauri_plugin_http::reqwest;

const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const DEFAULT_MAX_CHARS: usize = 8_000;
const MAX_ALLOWED_CHARS: usize = 32_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInspectLink {
    pub text: String,
    pub href: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInspectResult {
    pub url: String,
    pub final_url: String,
    pub status: u16,
    pub content_type: Option<String>,
    pub title: Option<String>,
    pub headings: Vec<String>,
    pub text_excerpt: String,
    pub links: Vec<BrowserInspectLink>,
    pub duration_ms: u64,
}

fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }
    let clean = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = clean.parse::<IpAddr>() {
        return ip.is_loopback();
    }
    false
}

fn is_rfc1918_lan(host: &str) -> bool {
    let clean = host.trim_start_matches('[').trim_end_matches(']');
    let Ok(IpAddr::V4(v4)) = clean.parse::<IpAddr>() else {
        return false;
    };
    let octets = v4.octets();
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

fn is_metadata_or_unspecified(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    if lower == "metadata.google.internal" || lower == "metadata.goog" {
        return true;
    }
    let clean = lower.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = clean.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => v4.is_unspecified() || v4.is_link_local(),
            IpAddr::V6(v6) => {
                v6.is_unspecified()
                    || (v6.segments()[0] & 0xffc0 == 0xfe80)
                    || clean == "fd00:ec2::254"
            }
        };
    }
    false
}

pub(crate) fn validate_browser_inspect_url(
    raw_url: &str,
    allow_insecure_lan: bool,
) -> Result<reqwest::Url, String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 || trimmed.chars().any(char::is_control) {
        return Err("无效的目标 URL".to_string());
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|error| format!("URL 解析失败：{error}"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("不允许在检查 URL 中携带凭据".to_string());
    }
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("仅允许 http/https URL（已拒绝 {scheme}://）"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL 缺少有效主机名".to_string())?;
    if is_metadata_or_unspecified(host) {
        return Err(format!("安全拦截：拒绝访问元数据或未指定地址 ({host})"));
    }
    if scheme == "http" {
        let loopback = is_loopback_host(host);
        let lan_ok = allow_insecure_lan && is_rfc1918_lan(host);
        if !loopback && !lan_ok {
            return Err(format!(
                "安全拦截：非本地回环地址仅允许 HTTPS（拒绝 http://{host}）"
            ));
        }
    }
    Ok(parsed)
}

fn decode_entities(raw: &str) -> String {
    raw.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn strip_tag_block(input: &str, tag: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let open_pat = format!("<{tag}");
    let close_pat = format!("</{tag}>");
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;

    while let Some(rel_start) = lower[cursor..].find(&open_pat) {
        let start = cursor + rel_start;
        out.push_str(&input[cursor..start]);
        let after_open = start + open_pat.len();
        if let Some(rel_end) = lower[after_open..].find(&close_pat) {
            cursor = after_open + rel_end + close_pat.len();
        } else {
            cursor = input.len();
            break;
        }
    }
    if cursor < input.len() {
        out.push_str(&input[cursor..]);
    }
    out
}

fn strip_all_tags(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    decode_entities(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn extract_tag_inner_all(html: &str, tag: &str, limit: usize) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let open_pat = format!("<{tag}");
    let close_pat = format!("</{tag}>");
    let mut results = Vec::new();
    let mut cursor = 0usize;

    while results.len() < limit {
        let Some(rel_start) = lower[cursor..].find(&open_pat) else {
            break;
        };
        let start = cursor + rel_start;
        let Some(rel_gt) = html[start..].find('>') else {
            break;
        };
        let content_start = start + rel_gt + 1;
        let Some(rel_end) = lower[content_start..].find(&close_pat) else {
            break;
        };
        let inner = strip_all_tags(&html[content_start..content_start + rel_end]);
        if !inner.is_empty() {
            results.push(inner);
        }
        cursor = content_start + rel_end + close_pat.len();
    }
    results
}

fn extract_links(html: &str, limit: usize) -> Vec<BrowserInspectLink> {
    let lower = html.to_ascii_lowercase();
    let mut links = Vec::new();
    let mut cursor = 0usize;

    while links.len() < limit {
        let Some(rel_start) = lower[cursor..].find("<a ") else {
            break;
        };
        let start = cursor + rel_start;
        let Some(rel_gt) = html[start..].find('>') else {
            break;
        };
        let tag_attrs = &html[start..start + rel_gt];
        let content_start = start + rel_gt + 1;
        let Some(rel_end) = lower[content_start..].find("</a>") else {
            break;
        };
        let label = strip_all_tags(&html[content_start..content_start + rel_end]);
        let attrs_lower = tag_attrs.to_ascii_lowercase();
        if let Some(href_pos) = attrs_lower.find("href=") {
            let val_slice = tag_attrs[href_pos + 5..].trim_start();
            let href = if let Some(rest) = val_slice.strip_prefix('"') {
                rest.split('"').next().unwrap_or("")
            } else if let Some(rest) = val_slice.strip_prefix('\'') {
                rest.split('\'').next().unwrap_or("")
            } else {
                val_slice.split_whitespace().next().unwrap_or("")
            };
            let clean_href = decode_entities(href).trim().to_string();
            if !clean_href.is_empty()
                && !clean_href.starts_with("javascript:")
                && !links
                    .iter()
                    .any(|l: &BrowserInspectLink| l.href == clean_href)
            {
                links.push(BrowserInspectLink {
                    text: label,
                    href: clean_href,
                });
            }
        }
        cursor = content_start + rel_end + 4;
    }
    links
}

pub(crate) fn extract_html_summary(
    html: &str,
    max_chars: usize,
) -> (Option<String>, Vec<String>, String, Vec<BrowserInspectLink>) {
    let without_scripts = strip_tag_block(html, "script");
    let without_styles = strip_tag_block(&without_scripts, "style");
    let without_noscript = strip_tag_block(&without_styles, "noscript");
    let cleaned = strip_tag_block(&without_noscript, "svg");

    let title = extract_tag_inner_all(&cleaned, "title", 1)
        .into_iter()
        .next();
    let mut headings = Vec::new();
    for tag in ["h1", "h2", "h3"] {
        for heading in extract_tag_inner_all(&cleaned, tag, 10) {
            if !headings.contains(&heading) {
                headings.push(heading);
            }
        }
    }
    let links = extract_links(&cleaned, 20);
    let full_text = strip_all_tags(&cleaned);
    let excerpt: String = full_text.chars().take(max_chars).collect();
    (title, headings, excerpt, links)
}

#[tauri::command]
pub async fn butler_browser_inspect(
    url: String,
    max_chars: Option<usize>,
    allow_insecure_lan: Option<bool>,
) -> Result<BrowserInspectResult, String> {
    let allow_lan = allow_insecure_lan.unwrap_or(false);
    let parsed_url = validate_browser_inspect_url(&url, allow_lan)?;
    let bounded_chars = max_chars
        .unwrap_or(DEFAULT_MAX_CHARS)
        .clamp(200, MAX_ALLOWED_CHARS);
    let started = Instant::now();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 3 {
                return attempt.stop();
            }
            if validate_browser_inspect_url(attempt.url().as_str(), allow_lan).is_err() {
                return attempt.error("重定向目标未通过 URL 安全检查");
            }
            attempt.follow()
        }))
        .build()
        .map_err(|error| format!("无法创建浏览器检查客户端：{error}"))?;

    let mut resp = client
        .get(parsed_url.clone())
        .header(reqwest::header::USER_AGENT, "RocketX-Inspector/0.44")
        .send()
        .await
        .map_err(|error| format!("请求目标页面失败：{error}"))?;

    let final_url = resp.url().to_string();
    validate_browser_inspect_url(&final_url, allow_lan)?;

    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let mut bytes = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|error| format!("读取页面响应失败：{error}"))?
    {
        let remaining = MAX_RESPONSE_BYTES.saturating_sub(bytes.len());
        if remaining == 0 {
            break;
        }
        let take = chunk.len().min(remaining);
        bytes.extend_from_slice(&chunk[..take]);
        if bytes.len() >= MAX_RESPONSE_BYTES {
            break;
        }
    }

    let raw_body = String::from_utf8_lossy(&bytes).to_string();
    let is_html = content_type
        .as_deref()
        .map(|ct| ct.to_ascii_lowercase().contains("html"))
        .unwrap_or_else(|| raw_body.trim_start().starts_with('<'));

    let (title, headings, text_excerpt, links) = if is_html {
        extract_html_summary(&raw_body, bounded_chars)
    } else {
        (
            None,
            Vec::new(),
            raw_body.chars().take(bounded_chars).collect(),
            Vec::new(),
        )
    };

    Ok(BrowserInspectResult {
        url: parsed_url.to_string(),
        final_url,
        status,
        content_type,
        title,
        headings,
        text_excerpt,
        links,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_ssrf_and_protocol_restrictions() {
        assert!(validate_browser_inspect_url("file:///etc/passwd", false).is_err());
        assert!(validate_browser_inspect_url("http://169.254.169.254/latest", false).is_err());
        assert!(validate_browser_inspect_url("http://example.com", false).is_err());
        assert!(validate_browser_inspect_url("http://192.168.1.50:3000", false).is_err());

        assert!(validate_browser_inspect_url("http://127.0.0.1:1420/app", false).is_ok());
        assert!(validate_browser_inspect_url("http://localhost:3300", false).is_ok());
        assert!(validate_browser_inspect_url("https://example.com/docs", false).is_ok());
        assert!(validate_browser_inspect_url("http://192.168.1.50:3000", true).is_ok());
    }

    #[test]
    fn extracts_title_headings_links_and_strips_scripts() {
        let html = r#"
          <html>
            <head><title>RocketX Preview &amp; Status</title><style>.x{color:red}</style></head>
            <body>
              <script>alert("secret_xss")</script>
              <h1>Dashboard Overview</h1>
              <h2>Active Tasks</h2>
              <p>Welcome to <strong>RocketX</strong> workspace.</p>
              <a href="https://example.com/prs">Pull Requests</a>
              <a href="javascript:void(0)">Skip JS</a>
            </body>
          </html>
        "#;
        let (title, headings, text, links) = extract_html_summary(html, 500);
        assert_eq!(title.as_deref(), Some("RocketX Preview & Status"));
        assert_eq!(headings, vec!["Dashboard Overview", "Active Tasks"]);
        assert!(text.contains("Welcome to RocketX workspace."));
        assert!(!text.contains("secret_xss"));
        assert_eq!(
            links,
            vec![BrowserInspectLink {
                text: "Pull Requests".to_string(),
                href: "https://example.com/prs".to_string()
            }]
        );
    }
}
