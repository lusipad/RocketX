# M10 Spike B：IPMSG / 飞秋兼容边界

日期：2026-07-17

## 结论

M10 的可验证交付基线收缩为 **原版 IP Messenger 5.x 双向消息与普通文件互通**。
飞秋 2013 的公开报文 fixture 纳入解析回归，但不在当前宿主机执行其二进制，也不声称完成
真实飞秋运行时验收。

这是蓝图 §5.2 / §8 Spike B 预先允许的收缩：国产变种没有可安全复现的真实客户端时，先保证
原版协议互通，避免把测试桩互通包装成飞秋互通。

## 实测与证据

### 原版 IP Messenger

- 官方协议仍使用 UDP/TCP 2425：UDP 负责发现与消息，TCP 负责文件拉取。
- 报文核心是 `Ver:PacketNo:User:Host:Command:Extra`；`SENDCHECKOPT` 要求接收方以
  `RECVMSG` 回执原 packet number。
- 文件不是发送方主动推送：`SENDMSG | FILEATTACHOPT` 携带文件元数据，接收方再通过 TCP
  发送 `GETFILEDATA`，发送方从指定 offset 流式返回原始字节。
- `CAPUTF8OPT` 表示能力，`UTF8OPT` 表示当前报文使用 UTF-8；未置位时官方实现按 CP932。
- 官方 Windows 5.8.3 安装器通过 HTTPS 下载，大小 4,560,416 字节，SHA-256：
  `13C85CC9EB55AB80B3A1C55462708CAAF454F4ECC89B036112BE9BBA30449276`；Authenticode
  状态为 Valid，签名主体为 FastCopy Lab, LLC。

参考：

- <https://ipmsg.org/protocol.txt>
- <https://ipmsg.org/help/ipmsghlp_eng.htm>
- <https://github.com/shirouzu/ipmsg>

### 飞秋变种

公开抓包与开源兼容项目显示，飞秋会在标准六段报文前加入形如
`1_lbt6_8#998#...` 的私有版本/资料前缀，并主要使用 GBK。标准 command 和 packet number
仍嵌在后半段，因此可以做有边界的兼容解析与按 peer 方言回包。

飞秋自称唯一官网提供的 `feiq.zip` 通过 HTTP 下载：

- ZIP 大小 9,699,097 字节，SHA-256：
  `0611D7963D25E47EE87D8859C225D1D9B087B2F5FE27152906F04E94FE9E5C72`
- 其中 `FeiQ.exe` 大小 18,290,688 字节，SHA-256：
  `480FF41B04BD8E93CE027B33A2D8DAE9531FDF9E4651C0D728E9F490C93F1AE6`
- 二进制无 Authenticode 签名；公开多引擎报告对同一 hash 给出 7/73 告警。
- 当前机器 Microsoft Defender、实时保护和 Windows Sandbox 均未启用，无法形成可信隔离执行环境。

因此本机不执行该二进制。相关 fixture 来源只用于重写协议语义，不复制第三方代码：

- <https://github.com/blisssayyid/feiX>
- <http://www.feiq18.com/config_nav.php?id=6>

## 语义取舍

| 参考行为 | 计划 | 原因 |
| --- | --- | --- |
| UDP `BR_ENTRY` / `ANSENTRY` / `BR_EXIT` | 保留 | 原版成员发现的最小闭环 |
| `SENDMSG` + `SENDCHECKOPT` + `RECVMSG` | 保留 | 提供可判定的送达和有限重试 |
| UTF-8 能力位；旧 peer 使用 CP932/GBK | 适配 | 原版按 CP932，飞秋主要是 GBK；接收端需按方言解码 |
| TCP `GETFILEDATA` offset 拉取 | 保留 | 真实客户端文件互通的协议核心 |
| 飞秋 `1_lbt6_*` 私有前缀 | 适配 | fixture 可验证；只在识别到该 peer 后按方言回包 |
| RSA/AES、封书、剪贴板图片、目录传输 | 暂不实现 | 蓝图 M10 验收只要求普通消息与文件；避免把旧协议面扩大成安全承诺 |
| 自动下载或自动打开附件 | 删除 | IPMSG peer 未认证，必须由用户显式确认 |
| Member Master、跨路由、IPv6 私有扩展 | 暂不实现 | M10 定位是同网段零部署共存，不做网关模式 |

## 通过阈值

1. 两套独立 socket 身份完成发现、双向中文消息、回执去重和普通文件 offset 拉取。
2. 官方签名版 IP Messenger 5.8.3 与实际 RocketX 桌面运行时双向消息、文件均成功。
3. 飞秋 fixture 的私有前缀、GBK 中文、重试包和异常长度均有回归测试；文档明确未做真实二进制运行验收。
4. IPMSG 未启用时不占用 2425；端口冲突时明确失败，不静默换随机端口伪装在线。
5. 收到的旧协议消息进入「局域网」虚拟频道和「今日」，但不会进入 M9 可信设备列表。
