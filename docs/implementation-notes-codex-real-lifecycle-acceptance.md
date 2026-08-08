# Implementation notes — Codex 真实生命周期验收

Plan: `docs/codex-real-lifecycle-acceptance-plan.md`

## Decisions

- 下一交付切片先补真实 Codex app-server 进程中断/重启证据；随后处理已确认的
  session/routine/memory 损坏覆写风险。
- 验收只终止脚本自己创建的子进程，使用临时工作区与 read-only/no-tools turn，不访问真实
  Rocket.Chat 或 Azure DevOps。
- 默认只认证仓库固定的 Codex 版本；system runtime 是显式可选诊断。

## Deviations

- Windows 下固定 `codex.js` 是 Node wrapper；验收的非预期退出必须用
  `taskkill /PID <test-owned-pid> /T /F` 终止 wrapper 及其底层 `codex.exe`，普通
  `child.kill()` 只能可靠结束外层进程。
- `0.144.4` 在持久 Goal 仍为 `active` 时，第二进程 `thread/resume` 可能恢复并自动
  启动一个新的 Goal turn。验收因此在读取恢复状态后先把 Goal 置为 `paused`，再中断
  当前活动 turn，最后只发送一个显式 `turn/start`；RocketX 自身在显式续跑前没有发出
  任何新的 `turn/start`。
- `thread/read` 的活动 turn 快照可能落后于服务端正在切换的 turn；验收只在服务端返回
  `expected active turn id ... but found ...` 时采用服务端给出的最新 ID 重试，最多五次，
  不做通用重试。

## Surprises

- 真实固定 runtime 的跨进程恢复证明了同一持久 Thread 与 Goal 可恢复，但也证明了
  “Goal active + app-server 重启”不是天然的无自动续跑语义；保守恢复必须先暂停 Goal，
  这与现有派活“叫停前先暂停 Goal”的设计一致。

## Questions for review

## Verification

- `pnpm exec tsx --test scripts/regressions/codex-spike-runtime.test.ts`：2/2 通过。
- `pnpm smoke:codex-lifecycle`：PASS；固定 Codex `0.144.4`，两次不同进程，保持同一
  `threadId`，Goal 恢复，观察并中断 1 个服务端自动恢复 turn，RocketX 在显式续跑前
  发出 0 个 `turn/start`，显式续跑 1 次并完成，线程归档且临时目录已清理。
