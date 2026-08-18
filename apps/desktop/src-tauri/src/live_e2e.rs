//! Live 端到端验证的共享辅助（仅 `cargo test` 编译，所有用例都是 `#[ignore]`）。
//!
//! 前置条件：
//! - 真实 Rocket.Chat 8.6 跑在 http://127.0.0.1:3300，管理员 admin / rcxdev123。
//! - ADO 用例另需环境变量 ADO_BASE_URL / ADO_PAT / ADO_PROJECT。
//!
//! 运行方式（在 apps/desktop/src-tauri 下）：
//! - cargo test -- --ignored live_reverse_mcp_reads_real_attachment
//! - cargo test -- --ignored live_dsh_version_gate
//! - cargo test -- --ignored live_business_mcp_reads_azure_devops
//!
//! 约束：keychain 写入全部经过 [`KeychainGuard`]（先备份、Drop 时恢复）；
//! RC 上创建的测试房间由 [`RcRoomCleanup`] 在 Drop 时删除；任何秘密
//! （authToken / ADO PAT）都不会打印，断言只用长度与布尔结果。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::Value;

pub(crate) const RC_BASE: &str = "http://127.0.0.1:3300";
const RC_HOST: &str = "127.0.0.1";
const RC_PORT: u16 = 3300;

pub(crate) struct RawResponse {
    pub(crate) status: u16,
    pub(crate) body: Vec<u8>,
}

fn decode_chunked(mut cursor: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let line_end = cursor
            .windows(2)
            .position(|pair| pair == b"\r\n")
            .ok_or_else(|| "chunked 响应缺少块长度行".to_string())?;
        let size_text = std::str::from_utf8(&cursor[..line_end])
            .map_err(|_| "chunked 块长度不是 ASCII".to_string())?;
        let size_text = size_text.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| format!("chunked 块长度无效：{size_text}"))?;
        cursor = &cursor[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if cursor.len() < size + 2 {
            return Err("chunked 响应数据不完整".to_string());
        }
        out.extend_from_slice(&cursor[..size]);
        cursor = &cursor[size + 2..];
    }
}

/// 极简 HTTP/1.1 客户端：测试准备（登录/建房/上传/删房）需要发送二进制
/// multipart 字节，winauth 的字符串 body 做不到，这里直接用 TcpStream。
pub(crate) fn raw_http(
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Result<RawResponse, String> {
    let mut stream = TcpStream::connect((RC_HOST, RC_PORT))
        .map_err(|error| format!("无法连接 {RC_HOST}:{RC_PORT}：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .and_then(|_| stream.set_write_timeout(Some(Duration::from_secs(15))))
        .map_err(|error| format!("无法设置超时：{error}"))?;
    let mut request =
        format!("{method} {path} HTTP/1.1\r\nHost: {RC_HOST}:{RC_PORT}\r\nConnection: close\r\n");
    for (key, value) in headers {
        request.push_str(&format!("{key}: {value}\r\n"));
    }
    if !body.is_empty() {
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|error| format!("请求发送失败：{error}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|error| format!("响应读取失败：{error}"))?;
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "响应缺少头体分隔".to_string())?;
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "响应状态行无效".to_string())?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| {
            line.split_once(':')
                .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        })
        .collect();
    let mut payload = raw[split + 4..].to_vec();
    let chunked = headers.iter().any(|(key, value)| {
        key == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked")
    });
    if chunked {
        payload = decode_chunked(&payload)?;
    }
    Ok(RawResponse {
        status,
        body: payload,
    })
}

impl RawResponse {
    fn json(&self) -> Result<Value, String> {
        serde_json::from_slice(&self.body)
            .map_err(|error| format!("响应不是有效 JSON（HTTP {}）：{error}", self.status))
    }
}

pub(crate) fn rc_server_reachable() -> bool {
    raw_http("GET", "/api/info", &[], &[])
        .map(|response| response.status == 200)
        .unwrap_or(false)
}

pub(crate) struct RcSession {
    pub(crate) user_id: String,
    pub(crate) auth_token: String,
}

impl RcSession {
    fn auth_headers(&self) -> [(&str, &str); 2] {
        [
            ("X-User-Id", self.user_id.as_str()),
            ("X-Auth-Token", self.auth_token.as_str()),
        ]
    }
}

pub(crate) fn rc_login() -> Result<RcSession, String> {
    let response = raw_http(
        "POST",
        "/api/v1/login",
        &[("Content-Type", "application/json")],
        br#"{"user":"admin","password":"rcxdev123"}"#,
    )?;
    let body = response.json()?;
    if response.status != 200 || body["status"] != "success" {
        return Err(format!("Rocket.Chat 登录失败：HTTP {}", response.status));
    }
    Ok(RcSession {
        user_id: body["data"]["userId"]
            .as_str()
            .ok_or_else(|| "登录响应缺少 userId".to_string())?
            .to_string(),
        auth_token: body["data"]["authToken"]
            .as_str()
            .ok_or_else(|| "登录响应缺少 authToken".to_string())?
            .to_string(),
    })
}

pub(crate) fn rc_create_channel(session: &RcSession, name: &str) -> Result<String, String> {
    let payload = serde_json::json!({"name": name}).to_string();
    let mut headers = session.auth_headers().to_vec();
    headers.push(("Content-Type", "application/json"));
    let response = raw_http(
        "POST",
        "/api/v1/channels.create",
        &headers,
        payload.as_bytes(),
    )?;
    let body = response.json()?;
    if !body["success"].as_bool().unwrap_or(false) {
        return Err(format!("channels.create 失败：HTTP {}", response.status));
    }
    body["channel"]["_id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "channels.create 响应缺少房间 ID".to_string())
}

/// 上传 PNG 到房间（RC 8.6 的 rooms.media/:rid 接口；rooms.upload 已在 8.x 移除），
/// 返回站内 /file-upload/ 相对路径（剥掉查询串）。
pub(crate) fn rc_upload_png(
    session: &RcSession,
    room_id: &str,
    png: &[u8],
) -> Result<String, String> {
    let boundary = "----rcx-live-e2e-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"rcx-live-e2e.png\"\r\nContent-Type: image/png\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(png);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let content_type = format!("multipart/form-data; boundary={boundary}");
    let mut headers = session.auth_headers().to_vec();
    headers.push(("Content-Type", content_type.as_str()));
    let response = raw_http(
        "POST",
        &format!("/api/v1/rooms.media/{room_id}"),
        &headers,
        &body,
    )?;
    let payload = response.json()?;
    if !payload["success"].as_bool().unwrap_or(false) {
        return Err(format!("rooms.media 上传失败：HTTP {}", response.status));
    }
    let link = payload["file"]["url"]
        .as_str()
        .ok_or_else(|| "rooms.media 响应缺少 file.url".to_string())?;
    let path = link.split('?').next().unwrap_or(link).to_string();
    if !path.starts_with("/file-upload/") {
        return Err(format!("附件链接不是 /file-upload/ 路径：{path}"));
    }
    Ok(path)
}

/// 删除测试房间的 Drop guard：失败路径也会执行清理。
pub(crate) struct RcRoomCleanup {
    user_id: String,
    auth_token: String,
    room_id: String,
}

impl RcRoomCleanup {
    pub(crate) fn new(session: &RcSession, room_id: &str) -> Self {
        Self {
            user_id: session.user_id.clone(),
            auth_token: session.auth_token.clone(),
            room_id: room_id.to_string(),
        }
    }
}

impl Drop for RcRoomCleanup {
    fn drop(&mut self) {
        let session = RcSession {
            user_id: self.user_id.clone(),
            auth_token: self.auth_token.clone(),
        };
        let payload = serde_json::json!({"roomId": self.room_id}).to_string();
        let mut headers = session.auth_headers().to_vec();
        headers.push(("Content-Type", "application/json"));
        match raw_http(
            "POST",
            "/api/v1/channels.delete",
            &headers,
            payload.as_bytes(),
        ) {
            Ok(response) if response.status == 200 => {}
            Ok(response) => eprintln!(
                "live-e2e 清理告警：channels.delete {} 返回 HTTP {}",
                self.room_id, response.status
            ),
            Err(error) => eprintln!("live-e2e 清理告警：channels.delete 失败：{error}"),
        }
    }
}

/// 用 image crate 现场编码一张 2x2 PNG，保证字节必然是合法图片。
pub(crate) fn sample_png() -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(2, 2, image::Rgba([0x40, 0x80, 0xff, 0xff]));
    let mut buffer = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut buffer);
    image::ImageEncoder::write_image(
        encoder,
        image.as_raw(),
        2,
        2,
        image::ExtendedColorType::Rgba8,
    )
    .expect("PNG 编码不应失败");
    buffer
}

/// Windows 凭据管理器条目的备份/恢复 guard：install 时先备份原值并写入
/// 测试配置，Drop 时恢复原值（原本没有则删除测试写入）。任何路径都会恢复。
pub(crate) struct KeychainGuard {
    service: &'static str,
    account: &'static str,
    original: Option<String>,
}

impl KeychainGuard {
    pub(crate) fn install(
        service: &'static str,
        account: &'static str,
        value: &str,
    ) -> Result<Self, String> {
        let entry = keyring::Entry::new(service, account)
            .map_err(|error| format!("keychain 不可用（{service}）：{error}"))?;
        let original = match entry.get_password() {
            Ok(value) => Some(value),
            Err(keyring::Error::NoEntry) => None,
            Err(error) => return Err(format!("无法备份 keychain（{service}）：{error}")),
        };
        entry
            .set_password(value)
            .map_err(|error| format!("无法写入 keychain（{service}）：{error}"))?;
        Ok(Self {
            service,
            account,
            original,
        })
    }
}

impl Drop for KeychainGuard {
    fn drop(&mut self) {
        let Ok(entry) = keyring::Entry::new(self.service, self.account) else {
            eprintln!("live-e2e 清理告警：keychain 不可用（{}）", self.service);
            return;
        };
        let result = match &self.original {
            Some(value) => entry.set_password(value),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(error),
            },
        };
        if let Err(error) = result {
            eprintln!(
                "live-e2e 清理告警：恢复 keychain（{}）失败：{error}",
                self.service
            );
        }
    }
}
