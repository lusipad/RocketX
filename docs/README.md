# RocketX 文档目录

> 文档状态：**当前文档索引**。

这个目录同时保存当前说明、产品愿景、设计过程和实施证据。它们的用途不同，不能互相替代。

## 文档状态

| 状态 | 含义 |
| --- | --- |
| `当前` | 仍承担产品、架构、配置、开发或发布事实说明，必须随实现同步更新 |
| `愿景` | 用于判断方向，不表示已经实现，也不构成版本承诺 |
| `历史` | 某一时点的计划、实现、审查或验收快照，只用于追溯 |
| `已废弃` | 核心模型已被替代，正文不得用于推断当前行为 |

当前文档采用白名单：只有下方“当前文档”表、`docs/specs/` 和文件顶部明确标为“当前”的说明承担现行合同。除此之外，`docs/` 根目录的 Markdown 默认属于历史资料；旧方案若会直接误导实现，则额外标为“已废弃”。

## 事实优先级

发生冲突时按以下顺序判断当前行为：

1. 可执行代码与真实集成结果；
2. 当前自动化测试；
3. [功能规格](specs/README.md)；
4. 当前架构、兼容性和配置指南；
5. 愿景、蓝图、计划、审查与实施记录；
6. 旧版本 README、截图或聊天记录。

历史文档解释“当时为什么这样想”，不证明“现在仍然这样工作”。

## 当前文档

| 文档 | 职责 |
| --- | --- |
| [功能规格](specs/README.md) | 用户可见能力、平台边界、状态、失败语义与验收标准 |
| [能力矩阵](specs/capability-matrix.md) | 桌面端、网页版、无 Codex 和性能模式的快速判断 |
| [追踪索引](specs/traceability.md) | 从验收 ID 定位实现、自动化和真实验证缺口 |
| [架构决策](architecture.md) | 稳定技术边界、数据落点和已验证实现陷阱 |
| [兼容性](compatibility.md) | Rocket.Chat、桌面平台和 Codex Runtime 兼容合同 |
| [工作区配置](proposal-config-provisioning.md) | `rcx.workspace.json` 当前格式、同步和安全规则 |
| [应用开发](app-development.md) | RocketX App manifest、Bridge、权限和本地验证 |
| [发布指南](release/README.md) | 候选版、签名、产物和公开发布流程 |
| [安全政策](../SECURITY.md) | 漏洞报告与信任边界 |
| [贡献指南](../CONTRIBUTING.md) | 开发、测试、文档和提交要求 |

## 愿景与方向

| 文档 | 状态 |
| --- | --- |
| [终局设想](vision.md) | 愿景。描述希望解决的问题，不承诺当前已实现 |
| [产品蓝图](blueprint.md) | 规划与历史路线图。当前完成度必须回到功能规格确认 |

## 历史与废弃文档

以下文件保留用于追溯，不承担当前功能说明：

- `*-plan.md`、`*-implementation-plan.md`：当时的执行计划；完成后自动转为历史。
- `implementation-notes*.md`：实施过程、偏离和验证记录。
- `chatgpt-pro-*-task.md`、`chatgpt-pro-*-result.md`：外部协作任务与结果快照。
- `*-review.md`、`*-audit*.md`、带日期的 `*-acceptance-*.md`：某一时点的审查证据。
- `m8-*` 至 `m12-*`：旧里程碑计划与验证记录。
- 其他未列入“当前文档”或“愿景与方向”的根目录 Markdown：默认按历史资料处理，即使正文保留“当前”“已实现”或版本号等当时措辞。

以下旧 Butler/Codex 方案已经被当前原生 Codex 架构替代，打开时应先阅读文件顶部的废弃说明：

| 历史文档 | 当前替代 |
| --- | --- |
| [旧 AI 管家设计](ai-design.md) | [产品原则](specs/product-principles.md)、[管家任务](specs/butler-tasks.md) |
| [单大脑](butler-single-brain.md) | [Codex Runtime](specs/codex-runtime.md) |
| [派活 v1](butler-errands-v1.md)、[唯一界面](butler-sole-surface.md) | [共享 Agent 与委托现状](specs/delegation-and-shared-agent.md) |
| [持续工作系统](butler-continuous-work-system-design.md) | [已安排任务](specs/scheduled-tasks.md)、[Memory](specs/memory.md) |
| [Agent Runtime 可靠性设计](agent-runtime-reliability-design.md) | [管家任务](specs/butler-tasks.md)、[审批](specs/approvals-and-permissions.md) |
| [系统优先发布切片](codex-system-first.md) | [Codex Runtime](specs/codex-runtime.md)、[平台与桌面](specs/platform-and-desktop.md) |

## 生命周期规则

- 当前行为改变时，同时更新对应功能规格、能力矩阵和追踪索引。
- 架构或配置指南只解释各自领域，不复制完整功能清单。
- 新计划必须写明日期、目标和退出条件；实施完成后标记“历史”，不能继续被 README 当作现状引用。
- 废弃方案保留原文和路径，在标题后增加状态、替代文档和废弃原因；不通过重写旧记录伪造历史。
- 删除文档前先确认没有代码、CI、Issue 或其他当前文档引用；默认优先保留并标记。
