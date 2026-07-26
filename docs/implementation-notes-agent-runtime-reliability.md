# Implementation notes — Agent Runtime 可靠性与 Codex 兼容

Plan: `docs/agent-runtime-reliability-design.md`

## Decisions

- 2026-07-26：首轮只做 Phase 0 的 compatibility provenance plumbing；继续由 Codex
  app-server 作为唯一 Agent Runtime。
- 2026-07-26：`0.144.4` 是协议基线和首个已验证版本；`0.140.0` 只保留为候选下限，
  未通过完整语义矩阵前不对外声明支持。
- 2026-07-26：复用现有 `codex_runtime_probe`、`AppServerClient` 和 session store，
  新字段均为可选并兼容旧数据，不引入新存储或新依赖。
- 2026-07-26：先锁定版本分类、启动 provenance 和会话版本记录回归，再修改实现。

## Deviations

- Phase 0 拆成两刀：本轮先贯通协议基线、候选下限、已验证版本、实际版本、来源与兼容状态；
  多版本真实语义矩阵作为后续独立切片。这样不会在没有证据时把 `0.140.0` 升格为已支持。
- 首轮不做所有入口统一 transcript rebuild。现有 Butler fallback 保留并记录恢复模式；
  Local Codex 继续遵守敏感 transcript 不落盘的合同。
- 首轮不建立全局 capability negotiation 模型；继续复用 app-server 握手与现有显式
  `-32601` 失败，后续按 surface 的 required/optional 能力补门禁。

## Surprises

- 2026-07-26：Rust runtime source 已支持 `manual`，但 Web 侧 `CodexProcessInfo` 类型遗漏该值。
- 2026-07-26：`AppServerClient.start()` 已拿到进程版本与来源，但当前丢弃了这份 metadata。
- 2026-07-26：Butler 已有 native resume 失败后的 transcript rebuild；Shared Agent 与
  Local Codex 并没有等价、可安全持久化的 transcript 合同。

## Implemented

- 2026-07-27：桌面探测返回协议基线、候选下限、已验证版本、实际版本、来源与兼容状态；
  旧的系统候选被阻止时仍可继续查找可用的标准路径或内置候选。
- 2026-07-27：Web 运行时 store 与设置页显示相同合同；高于基线的稳定版本标记为
  `untested-newer`，低版本和预发布基线明确阻止。
- 2026-07-27：`AppServerClient` 保留实际启动进程 metadata；Butler 和 Shared Agent
  会话记录创建/恢复所用的 Codex 版本与来源，Butler 同时区分原生恢复和 transcript rebuild。
- 2026-07-27：补充 Web/Rust 常量一致性、版本分类、候选回退、持久化兼容与恢复 provenance
  回归；Windows smoke 脚本优先使用仓库锁定的官方 Node 入口，并跳过无效的 shim。

## Verification

- `pnpm codex:protocol:check`：671 个协议文件与 Codex CLI `0.144.4` 一致。
- `pnpm test:regression`：760/760 通过。
- `pnpm test:pure`：220/220 通过。
- `pnpm --filter @rcx/web typecheck` 与生产构建通过。
- Rust 测试：58/58 通过。
- `pnpm smoke:codex-app-server` 已启动 `0.144.4`、完成 initialize 和 thread start；
  真实模型采样流两次断开并在 90 秒超时，因此不计为通过。

## Remaining

- 多版本语义矩阵跑通前，`verifiedVersions` 仅包含 `0.144.4`。
- 待 provenance 切片稳定后，再决定 `0.140.0` 是通过认证还是提高最低已验证版本。
- 下一刀建立 `0.140.0` / 基线 / 最新版的真实语义矩阵，再处理统一 capability gate；
  本轮不提前进入调度器、审批中心或存储拆分。
