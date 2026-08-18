//! Windows 集成认证（NTLM / Negotiate）的 HTTP 请求。
//!
//! 为什么必须走原生 WinHTTP，而不能用 webview 的 fetch 或 reqwest：
//!
//! - webview（含 Tauri 的 WebView2）：跨源请求要带上 NTLM 凭据就得 `credentials: 'include'`，
//!   而 CORS 规定此时服务端不能返回 `Access-Control-Allow-Origin: *` —— Azure DevOps Server
//!   返回的恰恰是 `*`。这条规则绕不过去。
//! - reqwest（tauri-plugin-http 的底层）：不支持 NTLM。
//!
//! WinHTTP 能拿**当前登录用户**的凭据自动完成挑战-应答，域内用户不用输任何东西。
//! 这正是 Azure DevOps Server 在企业内网里的默认认证方式。

use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// 二进制响应：给附件原图下载用，保留原始字节和响应 Content-Type。
pub struct BinaryHttpResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 15_000;
const RESOLVE_TIMEOUT_MS: u32 = 2_000;
const CONNECT_TIMEOUT_MS: u32 = 3_000;
const SEND_TIMEOUT_MS: u32 = 3_000;
const RECEIVE_TIMEOUT_MS: u32 = 7_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeadlinePhase {
    Connect,
    Send,
    Receive,
    QueryAuth,
    Read,
}

impl DeadlinePhase {
    fn label(self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::Send => "send",
            Self::Receive => "receive",
            Self::QueryAuth => "query-auth",
            Self::Read => "read",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DeadlineExceeded {
    phase: DeadlinePhase,
}

impl DeadlineExceeded {
    fn new(phase: DeadlinePhase) -> Self {
        Self { phase }
    }
}

impl std::fmt::Display for DeadlineExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "WinHTTP {} 阶段超过剩余 deadline", self.phase.label())
    }
}

struct RequestDeadline {
    deadline: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WinHttpTimeouts {
    resolve_ms: i32,
    connect_ms: i32,
    send_ms: i32,
    receive_ms: i32,
}

impl RequestDeadline {
    fn from_timeout_ms(timeout_ms: Option<u64>) -> Result<Self, String> {
        let timeout_ms = timeout_ms.unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS);
        if timeout_ms == 0 {
            return Err(DeadlineExceeded::new(DeadlinePhase::Connect).to_string());
        }
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(timeout_ms))
            .ok_or_else(|| "请求 deadline 溢出".to_string())?;
        Ok(Self { deadline })
    }

    fn remaining_ms(&self, phase: DeadlinePhase) -> Result<u32, DeadlineExceeded> {
        self.remaining_ms_at(Instant::now(), phase)
    }

    fn remaining_ms_at(&self, now: Instant, phase: DeadlinePhase) -> Result<u32, DeadlineExceeded> {
        let remaining = self
            .deadline
            .checked_duration_since(now)
            .ok_or_else(|| DeadlineExceeded::new(phase))?;
        if remaining.is_zero() {
            return Err(DeadlineExceeded::new(phase));
        }
        let millis = remaining.as_millis().min(u32::MAX as u128) as u32;
        Ok(millis.max(1))
    }

    fn clamped_timeout_ms_at(
        &self,
        now: Instant,
        phase: DeadlinePhase,
        stage_cap_ms: u32,
    ) -> Result<i32, DeadlineExceeded> {
        let remaining = self.remaining_ms_at(now, phase)?;
        Ok(remaining.min(stage_cap_ms) as i32)
    }

    fn winhttp_timeouts(&self, phase: DeadlinePhase) -> Result<WinHttpTimeouts, DeadlineExceeded> {
        self.winhttp_timeouts_at(Instant::now(), phase)
    }

    fn winhttp_timeouts_at(
        &self,
        now: Instant,
        phase: DeadlinePhase,
    ) -> Result<WinHttpTimeouts, DeadlineExceeded> {
        Ok(WinHttpTimeouts {
            resolve_ms: self.clamped_timeout_ms_at(now, phase, RESOLVE_TIMEOUT_MS)?,
            connect_ms: self.clamped_timeout_ms_at(now, phase, CONNECT_TIMEOUT_MS)?,
            send_ms: self.clamped_timeout_ms_at(now, phase, SEND_TIMEOUT_MS)?,
            receive_ms: self.clamped_timeout_ms_at(now, phase, RECEIVE_TIMEOUT_MS)?,
        })
    }

    #[cfg(test)]
    fn from_deadline(deadline: Instant) -> Self {
        Self { deadline }
    }
}

#[cfg(windows)]
mod imp {
    use super::{
        BinaryHttpResponse, DeadlinePhase, HttpResponse, RequestDeadline, CONNECT_TIMEOUT_MS,
        RECEIVE_TIMEOUT_MS, RESOLVE_TIMEOUT_MS, SEND_TIMEOUT_MS,
    };
    use std::ptr;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Networking::WinHttp::*;

    /// Rust 字符串 → 以 NUL 结尾的 UTF-16，供 Win32 宽字符 API 使用
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 关闭 WinHTTP 句柄的 RAII 包装：中途 return 时不会漏句柄
    struct Handle(*mut core::ffi::c_void);

    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = WinHttpCloseHandle(self.0);
                }
            }
        }
    }

    /// 拆出 host / port / path?query / 是否 https —— WinHTTP 要分开传
    fn split_url(url: &str) -> Result<(String, u16, String, bool), String> {
        let (scheme, rest) = url
            .split_once("://")
            .ok_or_else(|| format!("地址不是合法的 URL：{url}"))?;
        let secure = scheme.eq_ignore_ascii_case("https");
        if !secure && !scheme.eq_ignore_ascii_case("http") {
            return Err(format!("不支持的协议：{scheme}"));
        }
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) => (
                h.to_string(),
                p.parse::<u16>().map_err(|_| format!("端口不是数字：{p}"))?,
            ),
            None => (authority.to_string(), if secure { 443u16 } else { 80u16 }),
        };
        if host.is_empty() {
            return Err(format!("地址里没有主机名：{url}"));
        }
        Ok((host, port, path.to_string(), secure))
    }

    fn query_status(request: *mut core::ffi::c_void) -> Result<u16, String> {
        let mut code: u32 = 0;
        let mut len: u32 = std::mem::size_of::<u32>() as u32;
        let mut index: u32 = 0;
        unsafe {
            WinHttpQueryHeaders(
                request,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                PCWSTR::null(),
                Some(&mut code as *mut u32 as *mut core::ffi::c_void),
                &mut len,
                &mut index,
            )
            .map_err(|e| format!("读取状态码失败：{e}"))?;
        }
        Ok(code as u16)
    }

    /// 读响应 Content-Type；服务器没给时返回空串，由调用方决定怎么兜底
    fn query_content_type(request: *mut core::ffi::c_void) -> String {
        let mut buf = [0u16; 256];
        let mut len = (buf.len() * std::mem::size_of::<u16>()) as u32;
        let mut index: u32 = 0;
        let result = unsafe {
            WinHttpQueryHeaders(
                request,
                WINHTTP_QUERY_CONTENT_TYPE,
                PCWSTR::null(),
                Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                &mut len,
                &mut index,
            )
        };
        if result.is_err() {
            return String::new();
        }
        let chars = (len as usize / std::mem::size_of::<u16>()).min(buf.len());
        let end = buf[..chars].iter().position(|&c| c == 0).unwrap_or(chars);
        String::from_utf16_lossy(&buf[..end])
    }

    fn set_timeouts(
        handle: *mut core::ffi::c_void,
        resolve_timeout_ms: i32,
        connect_timeout_ms: i32,
        send_timeout_ms: i32,
        receive_timeout_ms: i32,
    ) -> Result<(), String> {
        unsafe {
            WinHttpSetTimeouts(
                handle,
                resolve_timeout_ms,
                connect_timeout_ms,
                send_timeout_ms,
                receive_timeout_ms,
            )
            .map_err(|e| format!("设置网络超时失败：{e}"))?;
        }
        Ok(())
    }

    fn set_connect_timeouts(
        session: *mut core::ffi::c_void,
        deadline: Option<&RequestDeadline>,
    ) -> Result<(), String> {
        let Some(timeouts) = deadline
            .map(|value| value.winhttp_timeouts(DeadlinePhase::Connect))
            .transpose()
            .map_err(|e| e.to_string())?
        else {
            return set_timeouts(
                session,
                RESOLVE_TIMEOUT_MS as i32,
                CONNECT_TIMEOUT_MS as i32,
                SEND_TIMEOUT_MS as i32,
                RECEIVE_TIMEOUT_MS as i32,
            );
        };
        set_timeouts(
            session,
            timeouts.resolve_ms,
            timeouts.connect_ms,
            timeouts.send_ms,
            timeouts.receive_ms,
        )
    }

    fn set_io_timeouts(
        request: *mut core::ffi::c_void,
        deadline: Option<&RequestDeadline>,
        phase: DeadlinePhase,
    ) -> Result<(), String> {
        let Some(timeouts) = deadline
            .map(|value| value.winhttp_timeouts(phase))
            .transpose()
            .map_err(|e| e.to_string())?
        else {
            return set_timeouts(
                request,
                RESOLVE_TIMEOUT_MS as i32,
                CONNECT_TIMEOUT_MS as i32,
                SEND_TIMEOUT_MS as i32,
                RECEIVE_TIMEOUT_MS as i32,
            );
        };
        set_timeouts(
            request,
            timeouts.resolve_ms,
            timeouts.connect_ms,
            timeouts.send_ms,
            timeouts.receive_ms,
        )
    }

    fn read_body_bytes(
        request: *mut core::ffi::c_void,
        deadline: Option<&RequestDeadline>,
    ) -> Result<Vec<u8>, String> {
        let mut buf: Vec<u8> = Vec::new();
        loop {
            if let Some(deadline) = deadline {
                deadline
                    .remaining_ms(DeadlinePhase::Read)
                    .map_err(|e| e.to_string())?;
            }
            set_io_timeouts(request, deadline, DeadlinePhase::Read)?;
            let mut available: u32 = 0;
            unsafe {
                WinHttpQueryDataAvailable(request, &mut available)
                    .map_err(|e| format!("读取响应失败：{e}"))?;
            }
            if available == 0 {
                break;
            }
            let start = buf.len();
            buf.resize(start + available as usize, 0);
            if let Some(deadline) = deadline {
                deadline
                    .remaining_ms(DeadlinePhase::Read)
                    .map_err(|e| e.to_string())?;
            }
            set_io_timeouts(request, deadline, DeadlinePhase::Read)?;
            let mut read: u32 = 0;
            unsafe {
                WinHttpReadData(
                    request,
                    buf[start..].as_mut_ptr() as *mut _,
                    available,
                    &mut read,
                )
                .map_err(|e| format!("读取响应失败：{e}"))?;
            }
            buf.truncate(start + read as usize);
            if read == 0 {
                break;
            }
        }
        Ok(buf)
    }

    /// 发一次请求（不含认证重试）
    fn send(
        request: *mut core::ffi::c_void,
        headers: &str,
        body: Option<&str>,
        deadline: Option<&RequestDeadline>,
    ) -> Result<(), String> {
        // WinHttpSendRequest 取的是 UTF-16 切片长度，不能带结尾的 NUL
        let headers_w: Vec<u16> = headers.encode_utf16().collect();
        let body_bytes = body.map(|b| b.as_bytes()).unwrap_or(&[]);
        let (ptr_opt, len) = if body_bytes.is_empty() {
            (None, 0u32)
        } else {
            (
                Some(body_bytes.as_ptr() as *const core::ffi::c_void),
                body_bytes.len() as u32,
            )
        };
        if let Some(deadline) = deadline {
            deadline
                .remaining_ms(DeadlinePhase::Send)
                .map_err(|e| e.to_string())?;
        }
        set_io_timeouts(request, deadline, DeadlinePhase::Send)?;
        unsafe {
            WinHttpSendRequest(request, Some(&headers_w), ptr_opt, len, len, 0)
                .map_err(|e| format!("请求发送失败：{e}"))?;
        }
        if let Some(deadline) = deadline {
            deadline
                .remaining_ms(DeadlinePhase::Receive)
                .map_err(|e| e.to_string())?;
        }
        set_io_timeouts(request, deadline, DeadlinePhase::Receive)?;
        unsafe {
            WinHttpReceiveResponse(request, ptr::null_mut())
                .map_err(|e| format!("没有收到响应：{e}"))?;
        }
        Ok(())
    }

    /// 返回 (状态码, 响应 Content-Type, 原始响应字节)
    fn request_inner(
        url: &str,
        method: &str,
        body: Option<&str>,
        content_type: &str,
        extra_headers: &str,
        integrated_auth: bool,
        timeout_ms: Option<u64>,
    ) -> Result<(u16, String, Vec<u8>), String> {
        let deadline = timeout_ms
            .map(|ms| RequestDeadline::from_timeout_ms(Some(ms)))
            .transpose()?;
        let (host, port, path, secure) = split_url(url)?;

        let agent = wide("RocketX");
        let session = unsafe {
            WinHttpOpen(
                PCWSTR(agent.as_ptr()),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                PCWSTR::null(),
                PCWSTR::null(),
                0,
            )
        };
        if session.is_null() {
            return Err("WinHttpOpen 失败".into());
        }
        let session = Handle(session);
        set_connect_timeouts(session.0, deadline.as_ref())?;

        let host_w = wide(&host);
        if let Some(deadline) = deadline.as_ref() {
            deadline
                .remaining_ms(DeadlinePhase::Connect)
                .map_err(|e| e.to_string())?;
        }
        let connect = unsafe { WinHttpConnect(session.0, PCWSTR(host_w.as_ptr()), port, 0) };
        if connect.is_null() {
            return Err(format!("无法连接 {host}:{port}"));
        }
        let connect = Handle(connect);

        let method_w = wide(method);
        let path_w = wide(&path);
        let flags = if secure {
            WINHTTP_FLAG_SECURE
        } else {
            WINHTTP_OPEN_REQUEST_FLAGS(0)
        };
        let request = unsafe {
            WinHttpOpenRequest(
                connect.0,
                PCWSTR(method_w.as_ptr()),
                PCWSTR(path_w.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                ptr::null(),
                flags,
            )
        };
        if request.is_null() {
            return Err("WinHttpOpenRequest 失败".into());
        }
        let request = Handle(request);

        // 关键：允许自动使用当前登录用户的凭据。
        // 默认策略（MEDIUM）只对「本地内网」站点自动登录，把它放开到 LOW，
        // 否则连内网里按 IP/主机名访问的 ADO Server 会一直 401。
        let policy: u32 = WINHTTP_AUTOLOGON_SECURITY_LEVEL_LOW;
        unsafe {
            WinHttpSetOption(
                Some(request.0 as *const core::ffi::c_void),
                WINHTTP_OPTION_AUTOLOGON_POLICY,
                Some(&policy.to_ne_bytes()),
            )
            .map_err(|e| format!("设置自动登录策略失败：{e}"))?;
        }

        let headers =
            format!("Content-Type: {content_type}\r\nAccept: application/json\r\n{extra_headers}");
        send(request.0, &headers, body, deadline.as_ref())?;
        if let Some(deadline) = deadline.as_ref() {
            deadline
                .remaining_ms(DeadlinePhase::Receive)
                .map_err(|e| e.to_string())?;
        }
        let mut status = query_status(request.0)?;

        // 401：问服务器支持哪些认证方式，选一个，用「当前用户凭据」(NULL/NULL) 重发。
        // 这就是 NTLM/Negotiate 的挑战-应答握手，WinHTTP 内部替我们走完。
        if integrated_auth && status == 401 {
            if let Some(deadline) = deadline.as_ref() {
                deadline
                    .remaining_ms(DeadlinePhase::QueryAuth)
                    .map_err(|e| e.to_string())?;
            }
            let mut supported: u32 = 0;
            let mut first: u32 = 0;
            let mut target: u32 = 0;
            unsafe {
                WinHttpQueryAuthSchemes(request.0, &mut supported, &mut first, &mut target)
                    .map_err(|e| format!("查询认证方式失败：{e}"))?;
            }
            // 优先 Negotiate（域内可直接走 Kerberos），退回 NTLM
            let scheme = if supported & WINHTTP_AUTH_SCHEME_NEGOTIATE.0 != 0 {
                WINHTTP_AUTH_SCHEME_NEGOTIATE.0
            } else if supported & WINHTTP_AUTH_SCHEME_NTLM.0 != 0 {
                WINHTTP_AUTH_SCHEME_NTLM.0
            } else {
                return Err("服务器不支持 Windows 集成认证（NTLM/Negotiate），请改用 PAT".into());
            };
            unsafe {
                WinHttpSetCredentials(
                    request.0,
                    WINHTTP_AUTH_TARGET_SERVER,
                    scheme,
                    PCWSTR::null(), // 用户名留空 = 用当前登录用户的凭据
                    PCWSTR::null(),
                    ptr::null_mut(),
                )
                .map_err(|e| format!("设置凭据失败：{e}"))?;
            }
            send(request.0, &headers, body, deadline.as_ref())?;
            if let Some(deadline) = deadline.as_ref() {
                deadline
                    .remaining_ms(DeadlinePhase::Receive)
                    .map_err(|e| e.to_string())?;
            }
            status = query_status(request.0)?;
        }

        let response_content_type = query_content_type(request.0);
        let body = read_body_bytes(request.0, deadline.as_ref())?;
        Ok((status, response_content_type, body))
    }

    pub fn request(
        url: &str,
        method: &str,
        body: Option<&str>,
        content_type: &str,
        timeout_ms: Option<u64>,
    ) -> Result<HttpResponse, String> {
        let (status, _response_content_type, body) = request_inner(
            url,
            method,
            body,
            content_type,
            "",
            true,
            Some(timeout_ms.unwrap_or(super::DEFAULT_REQUEST_TIMEOUT_MS)),
        )?;
        Ok(HttpResponse {
            status,
            body: String::from_utf8_lossy(&body).into_owned(),
        })
    }

    fn validate_token_credentials(user_id: &str, token: &str) -> Result<(), String> {
        if user_id.is_empty()
            || token.is_empty()
            || user_id.len() > 512
            || token.len() > 8192
            || user_id.chars().any(char::is_control)
            || token.chars().any(char::is_control)
        {
            return Err("Rocket.Chat credentials are invalid".to_string());
        }
        Ok(())
    }

    pub fn token_request(
        url: &str,
        method: &str,
        user_id: &str,
        token: &str,
        body: Option<&str>,
    ) -> Result<HttpResponse, String> {
        validate_token_credentials(user_id, token)?;
        let headers = format!("X-User-Id: {user_id}\r\nX-Auth-Token: {token}\r\n");
        let (status, _response_content_type, body) =
            request_inner(url, method, body, "application/json", &headers, false, None)?;
        Ok(HttpResponse {
            status,
            body: String::from_utf8_lossy(&body).into_owned(),
        })
    }

    /// 带 X-Auth-Token/X-User-Id 拉站内文件（附件原图）的字节版本：
    /// 图片不能走 from_utf8_lossy，否则二进制内容会被破坏。
    pub fn token_request_bytes(
        url: &str,
        user_id: &str,
        token: &str,
    ) -> Result<BinaryHttpResponse, String> {
        validate_token_credentials(user_id, token)?;
        let headers = format!("X-User-Id: {user_id}\r\nX-Auth-Token: {token}\r\n");
        let (status, content_type, body) =
            request_inner(url, "GET", None, "application/json", &headers, false, None)?;
        Ok(BinaryHttpResponse {
            status,
            content_type,
            body,
        })
    }

    // PWSTR 只在个别 API 里需要，这里显式引用一下避免未使用告警
    #[allow(dead_code)]
    fn _unused(_: PWSTR) {}
}

#[cfg(not(windows))]
mod imp {
    use super::{BinaryHttpResponse, HttpResponse};

    pub fn request(
        _url: &str,
        _method: &str,
        _body: Option<&str>,
        _content_type: &str,
        _timeout_ms: Option<u64>,
    ) -> Result<HttpResponse, String> {
        Err("Windows 集成认证只在 Windows 上可用，请改用 PAT".into())
    }

    pub fn token_request(
        _url: &str,
        _method: &str,
        _user_id: &str,
        _token: &str,
        _body: Option<&str>,
    ) -> Result<HttpResponse, String> {
        Err("RocketX reverse MCP currently requires Windows".into())
    }

    pub fn token_request_bytes(
        _url: &str,
        _user_id: &str,
        _token: &str,
    ) -> Result<BinaryHttpResponse, String> {
        Err("RocketX reverse MCP currently requires Windows".into())
    }
}

/// 同步版本：给 examples / 测试用（不依赖 Tauri 运行时）
pub fn blocking_request(
    url: &str,
    method: &str,
    body: Option<&str>,
    content_type: &str,
) -> Result<HttpResponse, String> {
    imp::request(url, method, body, content_type, None)
}

pub fn blocking_token_request(
    url: &str,
    method: &str,
    user_id: &str,
    token: &str,
    body: Option<&str>,
) -> Result<HttpResponse, String> {
    imp::token_request(url, method, user_id, token, body)
}

/// 同步二进制版本：反向 MCP 读附件原图用（issue #347）。
pub fn blocking_token_request_bytes(
    url: &str,
    user_id: &str,
    token: &str,
) -> Result<BinaryHttpResponse, String> {
    imp::token_request_bytes(url, user_id, token)
}

/// 用 Windows 当前登录用户的凭据发一次 HTTP 请求（NTLM / Negotiate 自动握手）。
///
/// WinHTTP 是阻塞 API，放到线程池里跑，别卡住 UI。
#[tauri::command]
pub async fn win_auth_request(
    url: String,
    method: String,
    body: Option<String>,
    content_type: Option<String>,
    remaining_ms: Option<u64>,
) -> Result<HttpResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        imp::request(
            &url,
            &method,
            body.as_deref(),
            content_type.as_deref().unwrap_or("application/json"),
            remaining_ms,
        )
    })
    .await
    .map_err(|e| format!("请求线程崩溃：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        DeadlineExceeded, DeadlinePhase, RequestDeadline, RECEIVE_TIMEOUT_MS, SEND_TIMEOUT_MS,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn winauth_deadline_remaining_shrinks_without_reset() {
        let start = Instant::now();
        let deadline = RequestDeadline::from_deadline(start + Duration::from_millis(15));
        let first = deadline
            .remaining_ms_at(start + Duration::from_millis(2), DeadlinePhase::Send)
            .unwrap();
        let second = deadline
            .remaining_ms_at(start + Duration::from_millis(9), DeadlinePhase::Receive)
            .unwrap();
        assert!(second < first, "same absolute deadline must keep shrinking");
    }

    #[test]
    fn winauth_deadline_clamp_uses_remaining_budget() {
        let start = Instant::now();
        let deadline = RequestDeadline::from_deadline(start + Duration::from_millis(20));
        assert_eq!(
            deadline
                .clamped_timeout_ms_at(start, DeadlinePhase::Send, SEND_TIMEOUT_MS)
                .unwrap(),
            20
        );
        assert_eq!(
            deadline
                .clamped_timeout_ms_at(
                    start + Duration::from_millis(18),
                    DeadlinePhase::Read,
                    RECEIVE_TIMEOUT_MS
                )
                .unwrap(),
            2
        );
    }

    #[test]
    fn winauth_request_timeouts_clamp_all_four_fields_to_same_remaining_budget() {
        let start = Instant::now();
        let deadline = RequestDeadline::from_deadline(start + Duration::from_millis(500));
        let timeouts = deadline
            .winhttp_timeouts_at(start, DeadlinePhase::Receive)
            .unwrap();
        assert!(timeouts.resolve_ms >= 1 && timeouts.resolve_ms <= 500);
        assert!(timeouts.connect_ms >= 1 && timeouts.connect_ms <= 500);
        assert!(timeouts.send_ms >= 1 && timeouts.send_ms <= 500);
        assert!(timeouts.receive_ms >= 1 && timeouts.receive_ms <= 500);
    }

    #[test]
    fn winauth_deadline_exhaustion_reports_stable_phase() {
        let start = Instant::now();
        let deadline = RequestDeadline::from_deadline(start + Duration::from_millis(5));
        let err = deadline
            .remaining_ms_at(start + Duration::from_millis(6), DeadlinePhase::Read)
            .unwrap_err();
        assert_eq!(err, DeadlineExceeded::new(DeadlinePhase::Read));
        assert_eq!(err.to_string(), "WinHTTP read 阶段超过剩余 deadline");
    }
}
