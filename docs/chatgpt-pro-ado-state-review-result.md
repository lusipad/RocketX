# ChatGPT Pro ADO 状态写入审查记录

## 最终裁决（2026-08-01）

- 最终复审对话：<https://chatgpt.com/c/6a6caedb-4bf4-83ea-86de-ad67437ab690>
- 最终候选：`rocketx-ado-safety-final-candidate-v2-3ab265f-20260801.zip`
- 候选文件数：12
- 候选大小：104393 bytes
- 候选 SHA-256：`6421956DB5EA4B562C309D00DAA549D4BBB0DB29C394C6E7A303D2BE2A95D171`
- 基线 commit：`3ab265f5356a37b39750f47c71d43122e5967c44`
- 上传前高置信密钥扫描：PASS
- ChatGPT Pro 最终结论：**PASS / 无 blocker**
- Codex 本地身份与 unknown 独立复审：**PASS**

最终实现不是直接采用 ChatGPT Pro 生成的 patch。Codex 拒绝了以下不合格交付并在隔离工作树独立实现、复核：

- round 3 patch：路径不合法、消费者缺失、存在重复字段与编译问题，且缺少必要测试；
- round 4 patch：主动标注为未完成，仍缺 `butlerTools.ts`、确认前 identity 复核和消费者测试；
- deadline v2 patch：87 KB 以上行尾噪声、deadline helper 未进入生产路径、缺少测试，且阶段固定 timeout 不能证明共享预算。

最终安全边界：

- 草案冻结稳定且非秘密的 ADO identity id；旧草案缺 identity 时 fail closed；
- 确认时重新读取 identity，同一配置换用户会在 PATCH 前失败；
- running checkpoint 重启后恢复为 non-retryable failure，不自动重放副作用；
- PATCH 已尝试但 timeout、网络错误或 5xx 无法正向确认时锁卡并要求重新读取；
- 显式 4xx 保留为服务端确定性拒绝，不误标 unknown；
- PATCH 不重试，失败后最多一次有界回读；只有目标状态匹配且 revision 前进才确认成功；
- PAT、Authorization、Cookie 和 token 不进入草案、checkpoint 或审计。

主工作区验证：

- `pnpm typecheck`：PASS；
- `pnpm test:pure`：230/230 PASS；
- `pnpm test:regression`：926/926 PASS；
- ADO 定向 TypeScript 回归：50/50 PASS；
- ADO Playwright：4/4 PASS；
- `pnpm codex:protocol:check`：671 个生成文件一致；
- `pnpm build`：PASS（仅既有动态导入与 chunk-size 警告）；
- `cargo fmt --check`：PASS；
- `cargo test --no-fail-fast`：75/75 PASS。

未验证：真实 Azure DevOps Server 2022、真实 PAT/NTLM、Windows 极端网络与 wall-clock 边界。未执行真实业务写入，也未提交、推送或部署。

## 第一轮原始报告

- 对话：<https://chatgpt.com/c/6a6caedb-4bf4-83ea-86de-ad67437ab690>
- 源码快照：`rocketx-ado-state-review-3ab265f-20260731.zip`
- 快照大小：348192 bytes
- 快照 SHA-256：`2556df7e2b1500b7a42f1a59f6ad98cd0a45932b77967f4732a8203a756beb95`
- 基线 commit：`3ab265f5356a37b39750f47c71d43122e5967c44`
- 外部交付状态：报告已交付；所谓 patch 仅为 176-byte 的“未生成补丁”说明，不能应用，已要求第二轮修正。

以下为 ChatGPT Pro 第一轮原始报告正文；结论仍需由本地 Codex 独立复核，不能视为最终验收。

---

# RocketX ADO controlled state write review

- Snapshot: `rocketx-ado-state-review-3ab265f-20260731.zip`
- Size: 348192 bytes
- SHA-256: `2556df7e2b1500b7a42f1a59f6ad98cd0a45932b77967f4732a8203a756beb95`
- Baseline commit: `3ab265f5356a37b39750f47c71d43122e5967c44`

## Final conclusion

**结论：需修正。**

候选实现已经覆盖了主要链路：`draft_ado_state`、checkpoint、确认卡、受控 PATCH、revision test、写后回读的大方向正确；但是仍存在几个会违反任务合同的可触发问题，不能作为生产完成状态。

## P0/P1 findings

### P1: PATCH 失败后的自动回读违反“不确定结果只允许一次 GET”边界

位置：
- `apps/web/src/lib/adoDirect.ts`
- `directSetWorkItemStateControlled`

触发链：
1. PATCH 发出。
2. 网络错误/超时/响应丢失。
3. catch 分支执行 GET 回读。
4. 如果调用者之后再次确认同一草案，仍可能重新进入 PATCH。

影响：
- 虽然当前代码没有自动 PATCH 重试，但没有持久化“已提交但未知”的状态。
- 用户重试时无法区分“第一次 PATCH 可能已成功”和“尚未执行”。

修正原则：
- checkpoint 必须保存执行状态（pending-write-unknown or equivalent）。
- 未确认结果不得重新允许 PATCH。

### P1: NTLM 路径没有在 TypeScript 层证明 15 秒硬上限

位置：
- `apps/web/src/lib/adoDirect.ts`
- `ntlmRequest`

现状：
- Rust `WinHttpSetTimeouts` 设置了 resolve/connect/send/receive。
- 但 TypeScript invoke 本身没有 timeout wrapper。

风险：
- Tauri command 卡住时，Host 无法证明 ADO 不可达路径 15 秒内结束。

修正原则：
- Host 层增加 Abort/Promise timeout 或等价 command deadline。
- 超时错误必须进入 unknown 状态，不触发重放。

### P1: 状态比较没有统一规范化

位置：
- `describeWorkItemStateConflict`

问题：
- 任务要求判断是否需要大小写/规范化。
- 当前比较使用严格字符串比较。

风险：
- ADO 状态是流程模板定义字符串，通常大小写敏感语义不应擅自改变。
- 但用户输入目标状态时，前后空格已处理，确认卡编辑后缺少重新验证路径。

修正原则：
- 保留 ADO 状态大小写语义。
- UI 编辑目标状态后必须重新 preflight/re-read。

### P1: Todo 乐观状态存在浏览器路径与桌面路径语义不一致

位置：
- `apps/web/src/stores/todos.ts`

现状：
- Tauri 路径等待 `lastEnqueued`。
- 非 Tauri localStorage 直接成功。

风险：
- 任务目标是桌面 SQLite。
- 需要确保失败不会先完成 checkpoint。

需要增加：
- 本次 add 的写入 promise，而不是全局最近 promise。
- checkpoint 必须绑定该 promise。

## 重点问题逐项结论

1. `draft_ado_state` 暴露：
   - 已有独立 provider 和 kind，未发现与 `draft_action(kind=ado)` 混淆。

2. 参数链：
   - workItemId/currentState/targetState/revision/connection identity 基本保留。
   - 缺少执行后未知状态持久化。

3. 确认前写入：
   - 未发现确认前 PATCH。

4. JSON Patch：
   - 正确生成 `test /rev` 后 `add /fields/System.State`。
   - contentType 正确。

5. 错误分类：
   - 已覆盖部分。
   - 网络不确定状态需要阻止后续重复 PATCH。

6. 状态比较：
   - ADO 状态不应简单 lower-case。
   - 需要 UI 修改后的重新校验。

7. 15 秒：
   - Rust WinHTTP 有 timeout。
   - Host 侧缺少可证明 deadline。

8. Todo：
   - optimistic add 存在。
   - 需要保证 checkpoint 等待的是当前 add。

9. UI：
   - 基本展示编号/标题/状态。
   - 编辑后二次校验需加强。

10. PAT/文案：
   - 未发现明显秘密泄漏。
   - 能力描述基本匹配。

11. 测试：
   - 已有 HTTP mock 契约测试。
   - 缺少：
     - PATCH 响应丢失后的 checkpoint 恢复测试
     - 同一草案二次确认禁止 PATCH
     - NTLM timeout 测试
     - SQLite 单次写失败测试

12. 文档漂移：
   - 文档描述受控写入流程与代码大体一致。
   - 未发现需要大范围修改。

## 执行命令

由于当前环境未安装项目依赖，以下命令**未执行**：

```
pnpm --filter @rcx/web typecheck
pnpm exec tsx --test scripts/regressions/ado-write-actions.test.ts
pnpm exec tsx --test scripts/regressions/butler-action-proposals.test.ts scripts/regressions/butler-tool-runtime.test.ts scripts/regressions/butler-profile.test.ts scripts/regressions/butler-progress.test.ts
pnpm test:regression
pnpm --filter @rcx/web build
pnpm exec playwright test tests/ui/butler-interactions.spec.ts --grep "ADO 状态修改确认前"
```

## 未验证风险

- 未连接真实 Azure DevOps Server。
- 未使用真实 PAT/Windows 集成认证。
- mock fetch 测试不能证明 ADO Server 2022 行为。
- 未验证 Tauri WinHTTP 超时边界。

## 建议验收顺序

1. 增加 checkpoint unknown-write 状态。
2. 增加一次性执行 token/idempotency guard。
3. 增加真实桌面环境 timeout 验证。
4. 再执行完整 regression 和 Playwright。
