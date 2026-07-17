//! 用当前 Windows 登录用户的凭据打一次 Azure DevOps Server，验证 NTLM/Negotiate 真的通。
//!
//! 编译期不依赖 Tauri 运行时，可以直接跑：
//!   cargo run --example ntlm_probe -- http://localhost:8081/DefaultCollection
//!
//! 不传参数时用上面的默认地址。

#[path = "../src/winauth.rs"]
mod winauth;

fn main() {
    let base = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "http://localhost:8081/DefaultCollection".to_string());

    for (label, path) in [
        ("项目列表", "/_apis/projects?api-version=7.0"),
        // connectionData 会回显「服务器认为你是谁」——用来确认 NTLM 认到的是当前 Windows 用户
        ("当前身份", "/_apis/connectionData?api-version=7.0-preview"),
    ] {
        let url = format!("{base}{path}");
        print!("{label:<8} {url}\n  -> ");
        match winauth::blocking_request(&url, "GET", None, "application/json") {
            Ok(res) => {
                let preview: String = res.body.chars().take(220).collect();
                println!("HTTP {}\n     {}", res.status, preview);
            }
            Err(e) => println!("失败：{e}"),
        }
        println!();
    }
}
