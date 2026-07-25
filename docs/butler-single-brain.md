# 切片规格：管家单大脑（W1 拆桥）

**决策 13**：管家层按职责重切。Codex app-server 是唯一大脑；我们只做 Codex 结构上做不到的三件事——**时机**（什么时候开口）、**呈现与闸门**（卡片 / 结论 / 确认 / 撤销）、**可见的记忆与人设**。

## 为什么现在做

现在的分层是按「引擎」切的（api 大脑 / codex 大脑）。后果是每加一个能力要在两边各实现一遍，中间还得养一座桥：`resumeRevisionByBrain`、`compatibility: 'brain-switched'`、`butler.ts` 里的 `brain === 'api'` 分叉。这座桥不产生任何用户价值，纯粹是双引擎的税。决策 12 已冻结 API 大脑，于是现在的状态最难受：**它活着，功能永远落后，还在持续收维护税。**

## 用户可见变化

1. **设置里不再有「API 大脑 / Codex 大脑」切换**——少一个你从来不该关心的选择。
2. **Codex 没装 / 没登录时，管家不再悄悄换一个更弱的大脑**，而是直接说明缺什么、怎么修。今天的行为是静默降级（`codexRuntime.ts:34`），你无从知道自己正在用哪个大脑，而两者能力不同——这违反「透明可控」。
3. **浏览器里打开管家**，不再是一个能力残缺的对话框，而是明说「管家在桌面端」。（真正让非桌面端有东西可看的是 W2：简报以普通消息投递到 RC 房间，任何 RC 客户端——包括手机官方 App——都能看到，零同步基础设施。）

## 不做什么（避免推倒重来）

`ButlerEngineState` **不整个删**。它同时承担单大脑也需要的职责：`status: running/paused/failed`、`transcriptRevision`（哪些行已喂给引擎）、`'interrupted-turn'` 的中断恢复。Codex thread 断了要 resume，仍然需要增量 transcript。

**桥不是全废，是超配。降配，不是推倒。**

## 改动清单

| 文件 | 动作 |
|---|---|
| `lib/butlerEngineContract.ts` | 删 `activeBrain`；`resumeRevisionByBrain` → `resumeRevision: number`；`prepareButlerEngineTurn` 去掉 `targetBrain` 与 `'brain-switched'` 分支；`version` 1 → 2 |
| `lib/butlerBrain.ts` | 删 `getButlerBrain` / `setButlerBrain` / `ButlerBrainKind`；只留 codex model/effort 与 availability |
| `lib/butlerRoundsBrain.ts` | `selectedButlerGateway` 去分叉，只走 codex ephemeral gateway |
| `stores/codexRuntime.ts` | 删静默降级 `setButlerBrain('api')`，改为记录不可用原因供 UI 呈现 |
| `stores/butler.ts` | 删 `brain === 'api'` 分支与 `runAgentLoop` 调用路径 |
| `stores/routines.ts` | 同上 |
| `components/AiSettings.tsx` | 删大脑切换 UI；不可用时呈现修复指引 |

`kernel/ai` **不退役**——`stores/aiAssistant.ts`、`MessageItem.tsx` 的消息实体提取、`AiSettings` 的密钥配置仍在用。本切片只摘掉「管家走 API 大脑」这条路径。

## 迁移

`normalizeButlerEngineState` 对 `version !== 2` 返回 `undefined`，调用方回退到 `initialEngineState`——旧会话优雅降级为「从 transcript 冷启动」，不崩、不丢对话内容。

## 验收

- 全量回归通过；`butler-engine-integration.test.ts` 改写为单大脑语义后仍覆盖中断恢复与增量 transcript
- 源码中不再有 `brain === 'api'`、`activeBrain`、`resumeRevisionByBrain`
- 桌面端 Codex 不可用时，管家给出可执行的修复指引而非静默降级
