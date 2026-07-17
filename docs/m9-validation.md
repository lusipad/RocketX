# M9 验收记录：LAN P2P 直传与断网降级

日期：2026-07-17
环境：Windows x64；Rocket.Chat 8.6.1；本机回环 TCP；两套独立 Ed25519 设备身份。

## 结果

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 5 GiB P2P | 通过 | 5,368,709,120 字节，四条认证 TCP 流，57.643 秒，约 88.8 MiB/s；发送端与接收端最终 BLAKE3 相同 |
| 5 GiB Rocket.Chat 对比 | 服务端配置不支持 | `FileUpload_MaxFileSize=104857600`（100 MiB），5 GiB 是其 51.2 倍；未修改服务器设置，也未伪造上传耗时 |
| 断点续传 | 通过 | 接收端预置已校验首块并重新建立连接；新 offer 只返回其余缺块，完成后整文件 BLAKE3 通过 |
| Windows socket 行为 | 通过并修复 | 真实回环测试发现接受连接继承非阻塞状态；现已对每条连接显式恢复阻塞 I/O，复测通过 |
| 冒充广播 | 通过 | 攻击者用他人 userId 和未固定公钥签名时，严格 Ed25519 验证失败；替换公钥与重放 nonce 均拒绝 |
| Rocket.Chat 不可达时聊天 | 通过 | 不建立任何 Rocket.Chat 连接，仅用两套固定公钥身份完成 TCP Chat/ACK |
| 幂等回灌 | 通过 | Spike C 验证自定义 `_id` 首次落库、重复请求虽返回 500 但历史仅一条；实现按 `_id` 回查确认 |
| 原始时间 | 有条件通过 | 8.6.1 拒绝历史 `ts`，且当前实例未启用 customFields；参与原 LAN 会话的设备从本地 outbox 保留原时间，其他设备只能看到服务器回灌时间 |
| 应用能力 | 通过 | `lan.peers` 只返回用户/设备显示信息、可信状态、来源和最后发现时间；不返回 IP、端口、公钥或挑战材料 |
| 自动化门禁 | 通过 | `test:pure` 219、`test:regression` 235、真实 RC smoke 53、Rust 24，均为 0 失败；前端生产构建通过 |
| Windows release 构建 | 通过 | Tauri `--no-bundle` release 构建成功，产物为 `apps/desktop/src-tauri/target/release/rocketx.exe` |

## 可复现命令

```powershell
$env:ROCKETX_LAN_E2E_BYTES='5368709120'
cargo test --locked tcp_file_transfer_resumes_across_four_authenticated_streams -- --nocapture
```

在 `apps/desktop/src-tauri` 执行。测试使用系统临时目录生成源文件与接收文件，成功后自动清理。

完整门禁还包括：

```powershell
pnpm typecheck
pnpm test:pure
pnpm test:regression
pnpm smoke
pnpm --filter @rcx/web build
cargo test --locked
```

## 说明

- “拔网线”采用确定性故障注入：先持久化一个已校验分片，关闭旧连接后由新连接重新协商缺块。它覆盖同一恢复状态机，不需要自动化脚本禁用用户机器的物理网卡。
- Rocket.Chat 服务端上限来自公开设置 API。M9 不自动修改管理员配置；P2P 不可用且文件超限时会在读取大文件前明确失败。
- 当前自动化验证了原生协议与前端门禁；Windows 双窗口的视觉点测不影响传输协议判定，但仍保留在发布安装包的人工冒烟清单中。
