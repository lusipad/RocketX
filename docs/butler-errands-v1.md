# 切片规格：派活 v1（薄路径）

管家能把工程任务派给 Codex 干——像 GPT Live 那样「说一句，活就有人干了」。
v1 走薄路径：**不新建派工 store，规格卡直接送进执行间（`localCodex`）开跑。**

## 为什么这么薄

施工图原本建议新建平级 store 管派工线程的生命周期、审批、恢复。但执行间已经
在做这些事（`thread/start` / `onServerRequest` 审批回路 / sandboxPolicy / 持久化恢复），
照做要写 300+ 行去复刻一份已经存在的东西。派活真正比执行间多出来的只有
「同时跑多个活」——等这个需求真的出现，再把执行间升级成多会话，那是一次
有理由的重构，而不是提前造（决策 13：复用优先）。

## 用户可见变化

以前：想让 AI 改代码，得自己切到执行间、选目录、把任务描述一遍。
现在：

1. 对管家说「帮我修掉登录页那个报错」——管家调 `draft_errand` 拟一张**任务规格卡**：
   标题、目标、验收标准、边界（不要做的事），逐字可核。
2. 卡上选工作区——默认就是**上次派过的那个**，常见路径一次点击；模型只能
   建议名字（`workspaceHint`），候选永远来自你亲手添加的工作区白名单。
3. 点「送进执行间开跑」——活立刻开始，页面自动切到执行间看进度。
4. 派发失败（执行间正忙 / 桌面端不可用）时草案留在卡上，换个目标可直接重试。

## 安全边界（谁都拿不到手）

- **大脑没有手**：`draft_errand` 只拟草案（`effect: 'write'` 走 checkpoint），
  模型传 `cwd` / `approvalPolicy` 等越权字段在参数验证层直接被拒。
- **白名单闸**：`assertRegisteredWorkspace` 是派发前最后一道闸，目标必须是
  已注册工作区；聊天内容再怎么诱导也变不出新目录。
- **分框防注入**：送进执行间的首轮输入由 `renderDispatchSpec` 渲染，
  用户确认过的规格在 `<rocketx_task_spec>`，不可信证据（若有）单独装进
  `<rocketx_untrusted_evidence>` 并明说只是数据。
- **执行间原有防线不变**：审批回路、sandboxPolicy、敏感路径拦截照旧生效。

## v1 的代价（明说）

- 同一时刻只能有一个活在跑（执行间是单会话）；执行间正忙时派发被拒。
- 进度在执行间看，管家页不复述。
- 刷新后未派发的草案不恢复（与例行事务草案同待遇）。

## 实现

| 文件 | 职责 |
|---|---|
| `lib/butlerErrands.ts` | `dispatchButlerErrand`：落库兜底候选 → 白名单闸 → 忙碌闸 → setWorkspaceRoot → startNew（仅在无线程时）→ send(分框规格) → 记住选择 |
| `components/ButlerErrandCard.tsx` | 规格卡：逐字展示 + 工作区选择 + 派发/取消；挂在对话与房间面板两个表面 |
| `stores/butler.ts` | `errandDraft` 状态、`confirmErrandDraft`（先派发成功才 approve checkpoint）、`dismissErrandDraft` |
| `scripts/regressions/butler-errands.test.ts` | 越权字段拒绝 / 一键派发全链 / 忙碌拒绝留卡 / 零配置落库 / 白名单拒绝 |
