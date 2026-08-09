# Implementation notes — RocketX 功能规格体系

> 文档状态：**历史实施记录**。本文说明规格体系建立过程；当前事实源直接从[功能规格目录](specs/README.md)进入。

Plan: `.omx/plans/feature-specification-system.md`

## Summary

已建立 RocketX 功能规格事实源，覆盖产品原则、平台能力矩阵、12 个能力域、验收标准和实现/测试追踪。文档显式区分“当前行为”和“目标”，并修正 README 中旧自建 Memory 与旧 AI 架构的现状描述。

## Decisions

- 2026-08-09：以用户可感知能力为文档边界；页面和控件只作为入口与交互细节记录。
- 2026-08-09：官方 Codex 语义与 RocketX 当前支持状态分开描述，防止上游能力被误写为本产品能力。
- 2026-08-09：确定性消息、工作台和个人效率界面保留为业务真源；AI 统一走 Codex Thread、Skills/Plugins/Apps 和原生 Memory。
- 2026-08-09：网页版当前定位为可用的消息与确定性工作客户端，不把缺少 Tauri `app-server` 传输的 AI 入口标为可用。
- 2026-08-09：已安排任务按“本机进程内计划”定义，不等同于上游云端 Scheduled。
- 2026-08-09：独立委托标为未实现；房间/Discussion 共享 Agent 单独按真实流程验收。

## Deviations

- 未修改产品代码；本轮只建立规格、追踪和 README 事实入口。

## Surprises

- 两种桌面发布配置都没有捆绑 Codex；“全量包”只增加 OCR 等资源。
- README 仍描述已删除的自建 Butler Memory、审阅/撤销 UI，并称禁用 Codex 内置 Memory；当前代码实际强制启用 Codex 原生 Thread Memory。
- 网页版仍可看到部分本机 AI 页面，但当前 Transport 只支持 Tauri，不能完成 Turn。
- 已安排任务由页面内每分钟计时器触发，应用真正退出、电脑关机或休眠时不运行。
- 独立“派出去”主流程已删除，但本地环境设置仍有历史“管家派活”文案。
- 团队配置解析器已拒绝旧 AI 配置字段，但首次引导仍有“一次设置 AI”的历史说明；规格按解析器真实合同记录，并把 UI 文案列为后续差距。

## Questions for review

- 无阻塞问题。上述差距已进入对应规格的“已知差距与目标”。

## Verification

- 规格结构：17 份规格文档，其中 12 个能力域均包含模板要求的 12 个章节。
- 验收追踪：77 个唯一 AC，追踪索引覆盖率 100%。
- 静态校验：Markdown 本地链接、引用源码/测试路径、行尾空白和 `git diff --check` 均通过。
- 类型检查：`pnpm typecheck` 通过（7 个工作区项目）。
- 关键回归第一组：51/51 通过，覆盖 Runtime、安装包、原生 Memory、权限、管家、已安排、共享 Agent、工作台、待办、中文用户目录、私聊状态、开机启动和性能模式。
- 关键回归第二组：150/150 通过，覆盖引导、团队配置、消息/搜索/文件、Plugins/Skills、Agent 环境、跨 App 转移、更新、OCR、托盘、任务栏和通知。
- 未执行：完整 Playwright、真实 Rocket.Chat/ADO/Codex 集成和三平台候选产物人工验证；这些缺口已逐项记录在 `docs/specs/traceability.md`。
