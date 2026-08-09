# Implementation notes — RocketX 文档更新与废弃

> 文档状态：**历史实施记录**。当前文档入口与生命周期规则见[文档目录](README.md)。

Plan: `.omx/plans/document-lifecycle-normalization.md`

## Summary

已完成现行文档校准和旧方案退役：`docs/specs/` 成为用户可见行为事实源，README、架构、兼容性、工作区配置、应用开发与发布文档只承担各自领域；旧 Butler/Codex 设计保留原路径并在首屏标记为历史或已废弃。

## Decisions

- 2026-08-09：历史计划和实施记录保留原路径，不批量移动或删除，避免破坏引用。
- 2026-08-09：当前能力统一以 `docs/specs/` 为事实源，其他文档只保留领域说明或历史背景。
- 2026-08-09：现行文档使用白名单；未列入白名单且没有显式“当前”状态的 `docs/` 根目录 Markdown 默认按历史资料处理。
- 2026-08-09：会直接误导实现的旧 Errand、Presence Engine、自建 Profile/Memory、旧 Agent Runtime 和 Codex 打包方案额外标记“已废弃”，并链接到替代规格。

## Deviations

- `document-release` 标准流程要求功能分支并自动提交推送；当前在 `main` 且有 271 项既有改动，因此只使用审查方法，不执行提交、推送和版本步骤。

## Surprises

- 中文 README 仍把 2026-07-17 蓝图称为“唯一路线图”，已改为功能规格、Changelog、产品原则和愿景四类入口。
- 工作区配置指南仍声称 CLI 共用 `parseWorkspaceConfig()`，源码只在 Web 与复用该前端的桌面端使用，已修正。
- 历史 Codex parity 评审引用的两张截图不在当前工作树，已改成明确的缺失说明，避免保留死链接。

## Verification

- 本地 Markdown 链接：27 份现行文档全量通过；99 份根目录历史文档首屏通过。
- 旧概念扫描：38 个命中文档均在首屏声明历史、愿景或已废弃状态。
- 现行权威扫描：不再出现“唯一运行时合同”“唯一路线图”或以旧 implementation notes/blueprint 充当当前实现的表述。
- 功能规格追踪：12 个能力域、77 个唯一验收 ID，全部进入追踪索引。
- `pnpm typecheck`：通过。
- `pnpm test:pure`：230 通过，0 失败。
- `git diff --check`：通过；仅有仓库既有 CRLF 转换提示。

## Questions for review

- 无。
