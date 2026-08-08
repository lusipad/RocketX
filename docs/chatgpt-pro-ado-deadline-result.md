# ChatGPT Pro ADO deadline 审查结果

- 对话：<https://chatgpt.com/c/6a6d1045-bfa4-83ea-9c48-2a76bd0d66bc>
- 基线 commit：`3ab265f5356a37b39750f47c71d43122e5967c44`
- 最终候选：`rocketx-ado-safety-final-candidate-v2-3ab265f-20260801.zip`
- 文件数：12
- 大小：104393 bytes
- SHA-256：`6421956DB5EA4B562C309D00DAA549D4BBB0DB29C394C6E7A303D2BE2A95D171`
- 上传前高置信密钥扫描：PASS
- ChatGPT Pro 最终结论：**PASS / 无 blocker**
- Codex 本地 deadline 独立复审：**PASS**

## 被拒绝的外部候选

ChatGPT Pro 的首个 deadline 方案仅作为研究输入，没有直接落地：

- `ADO_DEADLINE_REVIEW.md`：1358 bytes，SHA-256 `ce675d2a81c17ff189de02b66c00114fe11b7338e2ce17cc550f0b0c90630c29`；
- `rocketx-ado-deadline-v2.patch`：87378 bytes，SHA-256 `0257d3188a92a1fd751b5f0673560dae0a897c22b57410353675d13478158393`。

拒绝原因：补丁包含大范围行尾变化、没有把 deadline helper 接入真实生产调用链、缺少消费者和 Rust 测试，并保留了不受共享 remaining budget 约束的阶段 timeout。

## 最终实现

- Web direct request 使用真实 `AbortController.signal`，不使用只停止 UI 等待的 `Promise.race` 假超时；
- PAT/NTLM 单次直连默认 15000ms；
- 受控 `GET -> PATCH -> GET` 共享 absolute deadline，PATCH 子预算预留 1000ms 回读；
- 预读预算不足时在写前失败，PATCH 为零；
- PATCH timeout、网络错误或 5xx 后最多一次有界回读，不重发 PATCH；
- 只有目标状态匹配且 revision 前进才确认成功，否则返回 typed unknown；
- TypeScript 将 remaining budget 传入 Tauri NTLM 命令；
- Rust 使用单一 `Instant` deadline，在阶段前检查，并将 WinHTTP resolve/connect/send/receive 四项 timeout 全部 clamp 到 remaining 且至少 1ms；
- `token_request` 继续传 `None`，不改变 Rocket.Chat token 旧行为。

## 验证

- ADO deadline/受控写回归：21/21 PASS；
- ADO 联合定向回归：50/50 PASS；
- ADO Playwright：4/4 PASS；
- 全仓 typecheck：PASS；
- 全量 regression：926/926 PASS；
- Cargo：75/75 PASS；
- 生产构建：PASS。

## 诚实边界

当前代码已收紧所有可控阶段，但不声称同步 WinHTTP 在数学意义上严格满足 wall-clock `<= 15000ms`。WinHTTP 内部调度、DNS resolver、Windows 网络栈和线程调度仍需真实 Windows + ADO Server + NTLM 环境验证。未进行真实网络写入。
