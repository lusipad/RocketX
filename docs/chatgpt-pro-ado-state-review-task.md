# ChatGPT Pro 工程任务：审查并完善 Butler 的受控 Azure DevOps 状态写入

## 任务身份与责任

你是本任务的外部高级工程师。源码包是 RocketX 当前工作区针对本任务的最小快照；你不能访问本地仓库、私有远程、内部 Azure DevOps 或运行环境。

请深入审查现有候选实现，识别可触发的缺陷，并在需要时提供最小、完整、可应用的修正补丁。不要把包内实现、设计文档或已有测试默认视为正确。Codex 总负责人会独立复核你的结论、在隔离工作树应用补丁并执行最终验收。

## 基线与快照性质

- 仓库：RocketX / `rocketchatx`
- 分支：`main`
- Git commit：`3ab265f5356a37b39750f47c71d43122e5967c44`
- 快照日期：2026-07-31
- 工作区状态：**脏工作区快照**。源码包包含本任务依赖的未提交改动，不能仅根据基线 commit 推断当前代码。
- `CLAUDE.md`：仓库中不存在；约束来自根目录 `AGENTS.md`、README、package.json 和随包架构文档。
- 运行时：Windows、Node 22、pnpm 11；Web 为 React/Vite/Tauri。

压缩包大小和 SHA-256 由 Codex 在上传前补充到对话说明中；请在报告中引用该值，以表明审查的是同一快照。

## 背景与目标

RocketX 的产品定位是以文字聊天为主的个人管家，底层尽量复用 Codex 的原生工具、Skill 和沙箱能力。自然语言应该是主要入口；高风险业务写操作仍必须由 RocketX Host 显式确认并受控执行。

本批目标只包含两件事：

1. 用户说“把 ADO #123 改成已解决”时，系统生成专用的 Azure DevOps 状态修改确认卡；确认前不得 PATCH，确认后只执行一次有并发保护、可回读确认的状态变更。
2. 创建本地待办或承诺时，桌面 SQLite 持久化必须成功后，动作 checkpoint 才能标记为 completed；持久化失败不得向用户显示成功。

## 当前架构与不可破坏边界

- Rocket.Chat Server 不做修改。
- Codex-first：RocketX Host 负责上下文、确认、凭据注入和少量受控执行，不得新建一套并行 Agent Router/Runtime。
- Business MCP 保持 GET-only/read-only；不得向 Codex 暴露 PAT、Cookie、Bearer token 或通用 PATCH 能力。
- Azure DevOps 状态写入必须走 RocketX Host 的受控直连路径，并复用现有 Butler action checkpoint/确认卡。
- 草案和 checkpoint 不得保存 PAT 等秘密；只能冻结工作项信息、revision 和非秘密连接身份。
- 用户确认前只有 GET；确认后若目标已满足则零 PATCH。
- PATCH 不自动重试。若请求结果不确定，只允许一次 GET 回读；无法确认时必须明确失败或未知，不能静默重放。
- 草案创建后若 ADO 地址、认证方式或账号变化，必须 fail closed，要求重新发起。
- 不修改已有 Workbench 拖拽状态更新的兼容行为，除非你能证明本任务改动使其发生回归，并给出最小修复。
- 不新增依赖，不做无关重构，不扩大到 ADO 评论、删除、指派、PR、Build 或 Release 写操作。

## 候选实现的预期合同

自然语言和工具：

```text
“建一个 ADO 工作项” -> draft_action(kind = "ado")
“把 #123 改成已解决” -> draft_ado_state(workItemId = 123, targetState = "已解决")
```

确认后的远端流程：

```text
GET 当前工作项
  -> 已是目标状态：成功，PATCH = 0
  -> state/revision 与草案不一致：冲突失败，PATCH = 0
  -> PATCH [test /rev, add System.State]
  -> GET 回读
  -> 仅当状态为目标且 revision 前进时成功
```

Todo/commitment 流程：

```text
乐观 add
  -> await 本次 SQLite 写入
  -> 成功后 checkpoint completed
  -> 失败则回滚并 checkpoint failed
```

## 重点审查问题

请逐条给出结论和源码证据：

1. `draft_ado_state` 是否能被两条 Codex 运行路径正确暴露、调用和归一化，且不会与“创建 ADO 工作项”的 `draft_action(kind=ado)` 混淆。
2. 从草案、持久化恢复、preflight、确认卡到 Host 执行的参数是否完整，是否可能丢失或篡改 work item id、current state、target state、revision 或连接身份。
3. 是否存在确认前写入、重复确认导致二次有效 PATCH、PATCH 自动重试、失败后静默重放或恢复后越权执行。
4. JSON Patch 是否严格先 `test /rev` 再修改 `/fields/System.State`，请求头和 ADO Server 2022 / REST 7.1 合同是否正确。
5. PATCH 成功、确定性 4xx、网络错误、超时、写成功但响应丢失、回读失败、回读状态不符、revision 未前进等分支是否分类正确。
6. 状态名比较是否需要大小写或规范化处理；请基于 ADO 合同和当前产品语义判断，不要臆造固定状态枚举。
7. 架构文档要求 ADO 不可达/超时在 15 秒内结束。请特别审查 PAT/browser fetch 与 NTLM 原生路径是否都有可证明的有界超时；同时避免“客户端超时后远端 PATCH 迟到成功、随后用户重试造成歧义”的危险设计。
8. Todo/commitment 是否等待的确实是“本次”SQLite 写入，是否有并发写、旧 Promise、乐观回滚或 checkpoint 顺序错误。
9. UI 是否清楚展示 `#编号 + 标题 + 当前状态 -> 目标状态`，可编辑目标状态是否重新校验，键盘/可访问性和重复点击是否安全。
10. PAT 权限说明、Skill 文案、审计事件和错误消息是否与真实读写能力一致，是否有秘密泄漏风险。
11. 现有测试是否只在测试源码字符串，还是覆盖了可执行消费者路径；指出遗漏的高价值回归测试。
12. 识别 README/架构/实现说明与真实行为之间的文档漂移，但只修改本任务直接造成或暴露的漂移。

## 允许研究和修改的范围

主要生产代码：

- `apps/web/src/lib/adoDirect.ts`
- `apps/web/src/stores/workbench.ts`
- `apps/web/src/lib/butlerActions.ts`
- `apps/web/src/lib/butlerTools.ts`
- `apps/web/src/lib/butlerProfile.ts`
- `apps/web/src/lib/butlerToolLabels.ts`
- `apps/web/src/components/ButlerActions.tsx`
- `apps/web/src/components/ButlerAuditTrail.tsx`
- `apps/web/src/stores/butler.ts`
- `apps/web/src/pages/SettingsPage.tsx`
- `apps/web/src/butler/skills/host/azure-devops-server/SKILL.md`

相关依赖和边界文件随包提供，仅在证明必须时修改。测试文件可按验收需要最小增补。

## 明确交付物

请交付：

1. `REVIEW_REPORT.md`
   - 结论：通过 / 需修正 / 外部阻塞；
   - 按严重级别列出每个可触发问题，给出路径、行或符号、触发链、影响和修正原则；
   - 对上述 12 个重点问题逐项作答；
   - 列出你实际执行的命令及完整结果摘要；未执行必须明确写“未执行”；
   - 列出仍未验证风险，区分 mock、离线测试和真实 ADO 验证。
2. 如需改代码，交付一个统一 diff：`rocketx-ado-state-pro-review.patch`
   - 从源码包快照生成；
   - 仅包含必要代码、测试和直接相关文档；
   - 不包含二进制、锁文件噪声、格式化噪声或生成产物。
3. 如提供其他附件，列出文件名、字节数和 SHA-256。

如果候选实现已经正确，请明确说明“无需补丁”，但仍必须提交完整审查报告和未验证风险，不能用泛泛认可代替证据。

## 必须执行或评估的测试

在你的环境可运行时，请执行：

```powershell
pnpm --filter @rcx/web typecheck
pnpm exec tsx --test scripts/regressions/ado-write-actions.test.ts
pnpm exec tsx --test scripts/regressions/butler-action-proposals.test.ts scripts/regressions/butler-tool-runtime.test.ts scripts/regressions/butler-profile.test.ts scripts/regressions/butler-progress.test.ts
pnpm test:regression
pnpm --filter @rcx/web build
pnpm exec playwright test tests/ui/butler-interactions.spec.ts --grep "ADO 状态修改确认前"
```

若无法安装依赖或执行浏览器测试，给出静态评估和应补测试，不得声称已通过。不得为了运行测试调用真实 Rocket.Chat、Azure DevOps 或生产数据。

## 禁止执行或禁止声称的操作

- 不得提交 Git、推送、创建 PR、部署、迁移数据库或修改线上配置。
- 不得调用真实 ADO PATCH、真实用户数据或需要内部凭据的 smoke/classify 测试。
- 不得索取、读取、输出或嵌入密码、PAT、Token、Cookie、私钥或其他凭据。
- 不得把 mock HTTP、静态审查或本地 UI 测试称为真实 Azure DevOps Server 生产验证。
- 不得引入新依赖，除非先证明现有能力无法满足且只在报告中提出；不要直接修改依赖或锁文件。
- 不得扩大产品范围或改写无关脏工作区内容。

## 验收标准

- 确认前远端 PATCH 为零；Business MCP 继续 GET-only。
- 草案/恢复/确认链冻结并验证必要参数，不保存秘密。
- 目标状态幂等、revision 冲突、连接切换均 fail safe，且冲突分支 PATCH 为零。
- PATCH 使用 `test /rev` + `System.State`，不自动重试；写后必须回读，只有目标状态且 revision 前进才成功。
- 网络不确定和回读失败不伪报成功；同一草案重试不会产生第二次有效状态写。
- ADO 不可达路径有明确、可测试的 15 秒内结束策略，且不会因此引入迟到写重放。
- Todo/commitment 在本次持久化完成前不标记 completed；失败会回滚并显示失败。
- UI 信息清楚、目标可编辑但仍受校验，重复点击不会重复执行。
- PAT/Skill/审计文案与实际边界一致，无凭据泄漏。
- 必需类型检查、定向回归、全量 regression、生产构建和相关 Playwright 在 Codex 独立环境通过；真实 ADO 验证若未获授权必须明确留作未验证风险。
- 修改小而可审查，无新依赖、无锁文件变更、无无关重构。

