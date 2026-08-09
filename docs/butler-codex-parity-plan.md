# 管家对标 Codex App 改造计划

> 文档状态：**历史实施计划**。计划完成后不再承担现行合同；当前入口、Thread、模型、权限和跨 App 接续见[管家任务](specs/butler-tasks.md)。

## 1. 最可能调整的决策

### 管家是 Codex 任务控制层，不再是独立业务系统

```text
文字 / 后续语音
  -> 管家控制层
  -> Codex Thread / Turn / Approval / Memory
  -> Plugin -> Skill + MCP / Connector
  -> 必要时打开 RocketX 确定性工作台
```

- 决策：现有 Butler session 继续作为 Codex thread 的产品投影；不再新增“纸”“委托”等平行任务类型。
- Confidence: high
- What would flip it：Codex app-server 无法稳定恢复线程或流式返回审批事件；现有协议与回归已证明两者可用。

### 用户管理 Plugin，Codex 按需加载 Skill

- 决策：现有“技能中心”改为 Codex Plugin 目录；Plugin 卡片展示安装、连接与包含的 Skills。`$skill` 仍作为显式调用入口。
- Confidence: high
- What would flip it：目标 Codex 版本移除 Plugin 协议。当前 pinned `@openai/codex` 已生成并接入相关协议，但生产调用继续封装在适配器内。

### Memory 只使用 Codex 原生实现

- 决策：交互线程启用 `thread/memoryMode/set: enabled`，并用线程 config 开启 memories；停止注入 RocketX 自建轻量 Memory，也不再向模型暴露自建 Memory 工具。
- Confidence: high
- What would flip it：原生 Memory 在当前 pinned runtime 上不能被线程级启用。若发生，只保留无 Memory 的保守行为，不回退到两套 Memory 同时生效。

### 第一轮界面收敛到 Codex 的稳定心智模型

- 决策：一级工作面为“任务、动态、已安排、插件、设置”；隐藏“今日纸”，把“委托”改为任务动态，把“定时任务”改为“已安排”。
- Confidence: high
- What would flip it：既有入口必须依赖“今日纸”的日期浏览。日历中的旧入口会移除，历史数据保留但不再作为一级产品概念。

### 本轮不实现完整语音链路

- 决策：文字管家先统一控制上述原生能力；语音后续复用同一 thread/turn/steer 控制器，不另建语音意图系统。
- Confidence: high
- What would flip it：用户要求本候选版必须包含实时语音。当前协议已有 realtime 类型，但客户端和音频生命周期尚未实现，贸然加入会扩大候选版风险。

## 2. 假设

- 高置信：工作台继续作为确定性界面保留。来源：用户明确要求。
- 高置信：用户希望界面与交互语义对标 Codex App，而非只替换视觉。来源：本轮确认。
- 高置信：现有 Butler session 已持久化 Codex thread id，可作为任务列表的兼容基础。来源：`apps/web/src/stores/butler.ts`。
- 高置信：原生 Plugin、Skill 和 Memory mode 协议已生成并接入。来源：`apps/web/src/agent/protocol/client.ts` 与 `apps/web/src/stores/butlerCodex.ts`。
- 中置信：旧自建 Memory 数据暂不删除，后续只做显式迁移或归档。来源：避免不可逆的数据丢失。

## 3. 偏差策略

- 遇到边界情况时选择可回滚、最小影响、最接近 Codex 原生语义的方案，并记录到实现笔记后继续。
- 必须停止确认：需要删除用户历史数据、改变外部权限边界、或发现 pinned Codex 无法提供计划依赖的线程/Plugin/Memory 能力。
- 不因单个旧测试绑定旧文案而恢复“今日纸/委托”等概念；应更新测试验证新的可观察行为。

## 4. 机械工作（低审阅价值）

- 调整管家导航、标题、空状态和入口文案。
- 将 Plugin 目录从身份/学习页中独立出来。
- 启用原生 Memory，移除自建 Memory 的运行时注入和模型工具暴露。
- 清理日历中的“打开这天的纸”入口。
- 更新定向回归和 UI 测试。

## 5. 验证

- 打开管家默认进入任务对话，一级导航只出现“任务、动态、已安排、插件、设置”。
- 新任务、切换历史任务、执行进度、审批与追问仍在同一对话记录中工作。
- “插件”页面直接读取 Codex Plugin 目录，并能安装/卸载及刷新市场。
- 新建和恢复交互线程都会请求启用 Codex 原生 Memory；发送给模型的上下文不再包含 RocketX 自建 Memory 文本，动态工具也不再含自建 Memory 工具。
- “已安排”仍可创建、立即运行并查看结果；“动态”可查看运行中、待输入、完成和失败工作。
- 定向回归、typecheck 和构建通过；宽屏与移动截图经 visual-verdict 达到 90 分。

## Handoff

实现过程记录在 `docs/implementation-notes-butler-codex-parity.md`。第三次偏差或任一前提被推翻时停止补丁式修改，重新执行 kickoff。
