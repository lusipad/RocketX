# 飞鸽 / 飞秋 / 内网通互通失败:实测定位报告

日期:2026-07-21
对象:`plugins/intranet-link/native`(commit 549a5aa,分支 HEAD)
方法:在 Linux 回环上以调试构建启动 Sidecar(`ROCKETX_IPMSG_BIND=127.0.0.1`),
用 `scripts/ipmsg_probe.py` 及配套 harness 在 `127.0.0.2:2425` 模拟飞秋、内网通、
中文飞鸽三类对端,逐项观察线上字节与 Sidecar 事件。

## 实测结果

| # | 场景 | 结果 |
|---|------|------|
| T0 | Sidecar 上线广播 | 只发版本串 `"1"` 的标准方言,命令 `BR_ENTRY\|CAPUTF8\|FILEATTACH`,**不带 UTF8OPT** |
| T1 | 飞秋(`1_lbt6…`,GBK 昵称"张三丰")发 BR_ENTRY | 能发现,昵称解码正确;但 ANSENTRY 回复版本串为 `1_lbt6_0#128#ROCKETX#0#0#0#4001#9`,**MAC 段是字面量 `ROCKETX`,不是合法 MAC** |
| T2 | 内网通(`1@shiyeline`,GBK)发 BR_ENTRY | 能发现并以 `1@shiyeline` 回复(仅限旧版 2425 路径) |
| T3 | 中文飞鸽(版本串 `"1"`,GBK 中文 user/host/昵称)发 BR_ENTRY | **静默丢弃**:无 ANSENTRY、无 peer 事件 |
| T3b | 同上,但仅昵称为 GBK 中文 | **仍被静默丢弃**;纯 ASCII 报文才能通过 |
| T4 | 中文飞鸽发 GBK 消息(带 SENDCHECK) | **静默丢弃**:无 RECVMSG 回执、无 message 事件 |
| T5 | RocketX 向飞秋 peer 发中文消息 | 文本 GBK 编码正确、可收回执;但版本串仍是假 MAC 的 `…#ROCKETX#…` |
| T6 | 以中文昵称(如"飞鸽测试")调用 `start` | **整个运行时启动失败**,报 `IPMSG peer cannot represent this text encoding`,状态回落为 `enabled:false` |

## 根因(对应代码)

1. **"标准"方言硬编码为日文 Shift_JIS**(`runtime.rs` 的 `decode`/`encode`):
   版本串 `"1"` 的包按 CP932 解码,GBK 中文字节大概率 malformed → `parse_packet`
   返回 Err → 整包丢弃。中文版飞鸽传书的版本串恰好也是 `"1"`、正文 GBK,
   因此**中文飞鸽用户永远无法被发现,消息全部丢失,且无任何日志或事件**(T3/T4)。
2. **上线广播不带 UTF8OPT**(`announce`,runtime.rs:597):昵称/组名按 CP932 编码。
   简体中文常用字大量不在 JIS 字库 → `encode` 报错 → 每个广播地址都失败 →
   **`start()` 整体失败,插件等于无法启用**(T6)。这是中文用户"根本达不到"最直接
   的一条:只要昵称含中文,监听都起不来。侥幸可编码的字符,飞秋/内网通端也按
   GBK 解码成乱码。
3. **广播只发标准方言**(`announce` 恒用 `Dialect::Standard`):内网通只认
   `1@shiyeline` 报文,收到 `"1"` 版本串不会应答;只有内网通先广播时 RocketX 才能
   单向看到它,对端永远看不到 RocketX。飞秋依赖其飞鸽兼容模式才可能显示。
4. **回复飞秋的版本串 MAC 段为假值**(`FEIQ_VERSION`,runtime.rs:46):飞秋以该段
   作为主机标识,`ROCKETX` 非法值可能导致列表不显示或被丢弃(需真机确认)。
5. **内网通 9011 私有协议已在 #142 移除**:现网内网通主要走 9011,2425
   `1@shiyeline` 仅老版本遗留;与新版内网通无法互通是当前代码的预期行为。
6. 环境门槛(非代码 bug,但常见):Sidecar 仅随 Windows 签名包分发且默认关闭;
   与飞秋/飞鸽/内网通同机运行时 2425 独占绑定冲突,必须两台机器;Windows
   防火墙需放行;255.255.255.255 广播不跨网段、Wi-Fi AP 隔离会拦截。

## 修复建议(按优先级)

1. `start()`/`announce` 对无法用传统编码表示的昵称降级(改发 UTF8OPT 包或替换
   字符),绝不能让编码失败阻断整个运行时。
2. "标准"方言的传统编码按区域/配置在 GBK 与 CP932 间选择;解码失败降级为
   lossy 解码保留 peer,而不是丢包。
3. BR_ENTRY 轮流以 `"1"`、`1_lbt…`(真实网卡 MAC)、`1@shiyeline` 三种版本串广播。
4. `FEIQ_VERSION` 填真实 MAC。
5. 内网通如需真互通,需恢复/逆向 9011 协议(产品决策)。

## 真机排查工具

`scripts/ipmsg_probe.py`(仅标准库,Python 3.8+,Windows 可直接 `py` 运行):

```text
python ipmsg_probe.py announce            # 摸清网段里有哪些旧协议客户端
python ipmsg_probe.py probe <RocketX-IP>  # 逐方言验证 RocketX 应答哪种客户端
python ipmsg_probe.py listen              # 抓取并三编码解码所有 2425 报文
python ipmsg_probe.py send <IP> "你好" --dialect feiq   # 定向发消息验证回执
```

若绑定 2425 失败,工具会直接提示本机端口被占用——这本身即一类互通失败原因。

## 复现本报告

```bash
cargo build --manifest-path plugins/intranet-link/native/Cargo.toml --locked
# 终端 A:
sleep 600 | ROCKETX_IPMSG_BIND=127.0.0.1 \
  ./plugins/intranet-link/native/target/debug/rcx-plugin-intranet-link
# 终端 B:
python3 scripts/ipmsg_probe.py --bind 127.0.0.2 probe 127.0.0.1 --wait 3
```

探测输出中可直接看到:仅 ASCII 内容的 `"1"` 版本串报文获得应答、飞秋应答版本串
中的 `#ROCKETX#` 假 MAC,以及全部应答均不含 GBK 中文昵称的能力。
