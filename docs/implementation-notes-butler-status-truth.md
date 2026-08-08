# Implementation notes — Butler 状态真相闭环

Plan: `docs/butler-status-truth-plan.md`

## Decisions

- 不扩充 `ButlerErrandStatus`。结果不确定或连接中断都使用现有 `paused`，通过可执行文案区分原因；只有已知不可恢复的终态才使用 `failed`。
- 本轮完成后 `thread/goal/get` 失败时，不自动重放，也不继续显示 `running`；保留 thread/workspace，清空活动态与失效审批，关闭本地 client，等待用户显式恢复。
- app-server 意外中断时，以是否已经存在持久 `threadId` 区分：有线程则可恢复暂停；尚未建线程才是启动失败。
- 不新增 `errorCode`：当前所有消费者只需要 `paused`、持久化 `error` 和现有 warning trace；没有按中断原因分支的行为消费者。以后出现统计、自动化或不同恢复策略时再提升为结构化 reason。
- 启动阶段尚无 `threadId` 时沿用现有派发契约：异常抛回草案卡并显示“派发失败”，临时 run 随派发回滚，不留下可恢复 paused 卡。这样既不撒谎，也避免失败重试同时堆积草案与不可恢复任务卡。

## Deviations

- ChatGPT Pro 建议新增结构化 `errorCode`，本切片未采纳；这是无当前消费者的持久模型扩张，不是修复两条假状态所必需。
- ChatGPT Pro 的测试草案写“无 threadId 时保留 failed run”；本仓库现有 UI 契约会保留派活草案并 toast 错误，`dispatchErrand` 会回滚尚未建立的 run。验收因此锁定“直接报错、没有 paused 持久项、没有 turn/start”，不改变派发失败 UX。
- 首版 UI 用例直接向 `useButler.errands` 注入 paused 卡片，只证明了卡片样式。测试审查指出它绕过 `useButlerErrandRuns.visibleRuns -> syncErrandsIntoButler()`；已改为从 errand-runs store 注入并在点击前断言没有自动 resume。

## Surprises

- `apps/web/src/lib/butlerWorkspace.ts` 当前工作树已将 `paused` 投影为 `needs-user`，并由 `scripts/regressions/butler-workspace.test.ts` 锁定；继承的“仍映射为 failed”结论已经过时，因此不重复修改该投影。
- 两条新增 RED 回归准确复现现状：Goal 读取失败实际仍为 `running`，已有线程的 app-server 中断实际为 `failed`。命令：`pnpm exec tsx --test --test-name-pattern="Goal 暂时读不到|app-server 意外中断" scripts/regressions/butler-errands.test.ts`，结果 0/2 通过。
- 最小生产改动后，三条状态回归 3/3、完整 `butler-errands` 34/34、paused 任务投影 1/1、结果不确定 UI 1/1、Web typecheck 通过。
- 复审后为 app-server 中断路径补齐了落盘与重载断言；UI seed 也改走真实 store 同步链。修正后定向 regression 3/3、UI 1/1 继续通过。
- ChatGPT Pro 在候选包复审时把 `settleCompletedTurn()` 的 `runtime/client` 缺失早退列为 blocker。逐一核对全部 `stopClient()` 调用方后，没有发现能留下永久 `running` 的可达序列：意外断连同步落到 paused/failed；主动停止的调用方随后终态、暂停、删除或恢复。迟到完成事件若发生在终态 stop 期间，早退还能避免把 replied/failed 错降为 paused。把完整事件序列反馈给 Pro 后，其最终撤销该 blocker 并回复 `PASS`，因此没有加入无法经公开接口写出 RED 的防御分支。
- 完整门禁通过：`test:pure` 230/230、`test:regression` 936/936、Butler errand 34/34、相关 UI 42/42、协议一致性检查、typecheck、生产 build 与 `git diff --check`。仓库没有配置 lint script，未把其他检查冒充 lint。

## Questions for review
