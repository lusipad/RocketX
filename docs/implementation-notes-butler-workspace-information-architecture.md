# Implementation notes — 管家托管项目与团队配置分层

Plan: 当前任务计划

## Decisions

- “托管项目”归管家管理；设置页不再提供第二个本地目录入口。
- `agentEnvironments` 是用户管理的 AI 项目配置来源，保存目录、ADO 项目和分支策略。
- `codexWorkspace` 继续负责系统目录、当前运行目录、线程和 Runtime 生命周期，不与项目元数据合并。
- `rcx.workspace.json` 只承载团队共享的非敏感默认值，设置入口统一命名为“团队配置”。

## Deviations

- 暂不把 `rcx-agent-environments` 改成按 Rocket.Chat 账号分区；这需要独立的 v2 数据迁移，超出本次信息架构收敛范围。

## Surprises

- 设置里的“本地工作区”和管家里的“托管项目”分别写入 `agentEnvironments` 与 `codexWorkspace.workspaceRoots`，两套列表都能影响托管准入，已经形成双白名单。
- 历史实施记录要求 `agentEnvironments` 是唯一白名单，但后续原生 Codex 工作区列表重新引入了第二套用户目录状态。

## Questions for review

- 无。

## Summary

- 管家项目树直接投影 `agentEnvironments`，并在同一处完成添加、移除、启停和项目元数据配置。
- 设置页移除本地 AI 项目入口，只保留“团队配置 → 配置来源”。
- 旧 `workspaceRoots` 采用 destination-first 迁移：目标持久化成功后才清理旧用户目录；系统目录和当前 Runtime 状态继续由 `codexWorkspace` 管理。
- 线程枚举统一派生自系统目录、托管项目和必要的当前目录，不因完成迁移而丢失历史会话。

## Verification

- `pnpm test:regression`：680/680 通过。
- `pnpm --filter @rcx/web typecheck`：通过。
- 管家迁移、environment-only 历史、项目配置与添加项目定向 E2E：4/4 通过。
- 团队配置导入、旧配置兼容、管家入口与目录持久化定向 E2E：5/5 通过。
- 桌面与移动端截图生成通过；桌面信息架构视觉门禁 95/100。
