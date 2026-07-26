# 切片规格：管家是唯一界面（执行间退役）

**决策 14**：管家页是用户与 AI 打交道的唯一界面。执行发生在 codex 侧（持久线程），厨房可达但不可见——想验货就 `codex resume <threadId>` 或打开 Codex App。执行间（CodexPage / AgentPanel 本机路径）整页退役。

## 依据（2026-07-26 实测，不是推演）

1. **openai-codex 插件和我们走同一条路**：`spawn("codex", ["app-server"])` + `thread/start`/`turn/start`，与 `localCodex.ts` 同协议；两边的线程躺在同一个 `~/.codex/state_5.sqlite`，rollout 同构。「改用插件模式」是个伪命题——我们已经在里面了。
2. **全库 1527 条线程里，`approval_mode=granular` 只有 10 条，全部是 RocketX 派活建的**。插件与 automation 全是 `never`（并对 server→client 请求一律回 -32601）。中途审批是这台机器上只有我们提供的能力，也是决策 13 给管家保留的「闸门」本体——**不外包**。
3. **孤儿线程是历史问题**：v0.25.9 那条「自建线程 + 塞对话记录当首轮」的路径已死；现在的派活线程与插件线程 rollout 完全同构、零 systemError。Desktop 可见性不再是砍执行间的顾虑。
4. **codex 自己维护 TODO list**：派工线程里 `update_plan` 工具调用实测 9 次。进度呈现直接消费它，不从 trace 反解。

## 用户可见变化

1. **「派出去的活」独立成区**，不再埋在对话流里。三个表面（桌面页 / 对话页 / 房间侧栏）共享同一份列表。排序即优先级：等你点头 > 正在干 > 回话了。
2. **可以同时派多件活**，每件独立线程、独立审批、独立进度。
3. **「正在干」的活点开是 TODO list**：codex 报的计划原样呈现（做完打勾），不是 trace。
4. **「回话了」的活要「收下」**——看过结论后签收归档，区清空。GTD 的收件箱语义：清零靠你的动作，不靠超时。
5. **执行间从界面消失**。它独有的能力各有去处：工作目录/沙箱选择在规格卡上（已有）；进度是人话（已有）+ TODO list（本次）；想看原文，活卡角落有 `codex resume <id>`。
6. **简报吸收 automation**：codex 定时任务（如「每小时处理新 Issue」）的结果聚合进今日简报（「昨晚替你看了 3 个新 issue，1 个要你定夺」），不单独弹通知。blueprint 支柱二「聚合投递」的落点。

## 不做什么

- **不接插件的 job runtime**：它 `approvalPolicy: never` + 事后 review gate，是给「Claude 派活给 codex」设计的；「人把活交给管家」需要中途闸门。审批模式保持 `granular` 不动。
- **不自建常驻 agent-loop**：感知层 = codex automation（已在用）+ 管家的定时/事件触发。`runAgentLoop` 决策 13 刚删干净，不让它换名字回来。
- **群托管（sharedAgent）不动**：它已是每会话自持连接的正确形态，反而是本次派活重构的参照物。

## 改动清单（按刀）

| 刀 | 内容 | 依赖 |
|---|---|---|
| 1 | `errandRun` 单例 → `errands` 列表；每活自持 AppServerClient（仿 sharedAgent per-tmid 模式），不再借 localCodex 的线程；per-errand 审批与 watch；三表面列表渲染 + 排序 + 收下归档 | 无 |
| 2 | 跨重启恢复：errand 元数据（id/title/threadId/状态）落 localStorage，重启后「失联的活」可一键 `thread/resume` 接回 | 刀 1 |
| 3 | TODO list 进度：消费 `update_plan` 工具调用（item 流里的 function_call），活卡展开渲染计划与完成态 | 刀 1 |
| 4 | **感知规则 v1**（简报吸收 automation 扩容而来）：管家主动看三类事，分析结果聚合进今日简报。①「@我必析」——收到 @ 后台分析消息上下文，产出「他要你干什么 + 建议动作」；②「新 issue 必析」——接住 automation 已在跑的每小时 issue 处理，结论进简报；③「群讨论汇总」——定时对活跃群产出「今天聊了什么、有没有落到你头上的事」。三条规则独立开关（默认开 ①②、关 ③）。**主动看不主动干**：分析全走 read-only 临时会话；要动手（回复/发消息）必须转成规格卡走审批。出口只有简报，不新增弹窗——@ 的 RC 原生通知照旧，管家的增值是「你点开时分析已经在了」 | 刀 1（建议动作转规格卡） |
| 5 | 执行间退役：`localCodex.hydrate` 迁到 app 启动（或随 localCodex 一起删）；删 CodexPage 与 AgentPanel 本机路径；nav 注册、快捷键序列、butlerSurface 标签清理；改三处焊死断言（core-flows:1219、navigation-entry、codex-thread-name、im-usability 的 MODULE_ORDER） | 1–3 全落地后 |

刀 5 必须最后：新呈现全部站住之前，厨房的门不拆。
