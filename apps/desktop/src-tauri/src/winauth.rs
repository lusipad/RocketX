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

#[derive(Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

#[cfg(windows)]
mod imp {
    use super::HttpResponse;
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
                p.parse::<u16>()
                    .map_err(|_| format!("端口不是数字：{p}"))?,
            ),
            None => (
                authority.to_string(),
                if secure { 443u16 } else { 80u16 },
            ),
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

    fn read_body(request: *mut core::ffi::c_void) -> Result<String, String> {
        let mut buf: Vec<u8> = Vec::new();
        loop {
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
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    /// 发一次请求（不含认证重试）
    fn send(
        request: *mut core::ffi::c_void,
        headers: &str,
        body: Option<&str>,
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
        unsafe {
            WinHttpSendRequest(request, Some(&headers_w), ptr_opt, len, len, 0)
                .map_err(|e| format!("请求发送失败：{e}"))?;
            WinHttpReceiveResponse(request, ptr::null_mut())
                .map_err(|e| format!("没有收到响应：{e}"))?;
        }
        Ok(())
    }

    pub fn request(
        url: &str,
        method: &str,
        body: Option<&str>,
        content_type: &str,
    ) -> Result<HttpResponse, String> {
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

        let host_w = wide(&host);
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

        let headers = format!("Content-Type: {content_type}\r\nAccept: application/json\r\n");
        send(request.0, &headers, body)?;
        let mut status = query_status(request.0)?;

        // 401：问服务器支持哪些认证方式，选一个，用「当前用户凭据」(NULL/NULL) 重发。
        // 这就是 NTLM/Negotiate 的挑战-应答握手，WinHTTP 内部替我们走完。
        if status == 401 {
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
            send(request.0, &headers, body)?;
            status = query_status(request.0)?;
        }

        let body = read_body(request.0)?;
        Ok(HttpResponse { status, body })
    }

    // PWSTR 只在个别 API 里需要，这里显式引用一下避免未使用告警
    #[allow(dead_code)]
    fn _unused(_: PWSTR) {}
}

#[cfg(not(windows))]
mod imp {
    use super::HttpResponse;

    pub fn request(
        _url: &str,
        _method: &str,
        _body: Option<&str>,
        _content_type: &str,
    ) -> Result<HttpResponse, String> {
        Err("Windows 集成认证只在 Windows 上可用，请改用 PAT".into())
    }
}

/// 同步版本：给 examples / 测试用（不依赖 Tauri 运行时）
pub fn blocking_request(
    url: &str,
    method: &str,
    body: Option<&str>,
    content_type: &str,
) -> Result<HttpResponse, String> {
    imp::request(url, method, body, content_type)
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
) -> Result<HttpResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        imp::request(
            &url,
            &method,
            body.as_deref(),
            content_type.as_deref().unwrap_or("application/json"),
        )
    })
    .await
    .map_err(|e| format!("请求线程崩溃：{e}"))?
}
