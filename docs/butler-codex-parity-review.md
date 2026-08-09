# 管家对标 Codex App — 评审说明

> 文档状态：**历史评审证据**。截图和评审结论只对应当时工作树；当前交互以[管家任务](specs/butler-tasks.md)和[平台与桌面](specs/platform-and-desktop.md)为准。

## Demo

> 当时的两张视觉验收截图未保留在当前工作树；以下描述仅作为历史评审记录。

桌面端形成“RocketX 导航 → 管家控制 → 任务历史 → 当前任务”的稳定层级。

390px 下以单行页面切换器保留任务、动态、已安排、插件和设置，无横向溢出。

## What & why

原管家同时承载今日纸、了解你、技能中心、委托和自建 Memory，用户需要先理解产品概念，才能完成本应自然的任务。问题不是能力不足，而是 RocketX 在 Codex 之外又建立了一套控制模型。

本次把管家收敛为 Codex App 的控制层：用户创建任务，管家选择 Plugin、Skill 和工作区；运行状态进入动态，周期工作进入已安排，需要确认的事项按“替我审批”回到当前任务或动态。确定性的待办、日历和工作台继续保留在 RocketX 原模块。

## Decisions that matter

### 1. Memory 使用 Codex 原生能力

常驻线程在创建和恢复后启用 Codex Memory，不再把 RocketX 自建记忆文本注入提示，也不再暴露 remember、recall_memory 等动态工具。

Rejected: 继续维护双 Memory。两套事实会漂移，模型也无法判断哪一份是权威来源。

### 2. Skill 以 Codex Plugin 为来源

插件页直接使用 Codex marketplace/plugin 协议；已安排任务通过 skills/list 取得 Skill 的真实路径再执行，因此 Plugin 内的 Skill 不再被错误拼成 .agents/skills 路径。

Rejected: RocketX 自己维护第二个技能商店。它会重复安装、启停和路径解析能力。

### 3. UI 只保留五个控制入口

管家一级导航固定为任务、动态、已安排、插件、设置。旧今日纸入口重定向到任务；不可达的 ButlerIdentityPage、自建技能中心和 438 行专属样式已删除。

Rejected: 把旧功能藏进“更多”。隐藏并不会降低概念负担，只会让信息架构更难预测。

### 4. 兼容数据，不兼容旧运行方式

历史纸面、身份和旧 Memory 数据结构仍保留，避免升级丢数据；旧自建 Memory Skill、提示注入和模型工具已经退出运行路径。

Rejected: 一次性删除全部历史数据。收益很小，回滚与迁移风险过大。

## Unknowns found and answered

- 常驻线程原先会主动关闭原生 Memory：现在创建和恢复后都设为 enabled，调用失败按兼容方式降级，不阻塞任务。
- 例行任务原先只假设仓库 Skill 路径：现在显式向 Codex 查询真实 Skill metadata。
- Plugin Skill 的启停状态原先没有进入本地能力判断：现在原生 Skill 状态会同步给运行门禁。
- 旧 UI 测试绑定“委托、对话、在办”文案：已改为验证新的任务语义和真实可访问名称。

## What we did not do

- 未接入 Codex realtime 语音；该协议已存在，但应在控制层稳定后独立验证。
- 未删除历史 Memory、纸面和身份数据。
- 未做暗色主题像素复刻；视觉门禁验证的是结构、密度、可达性和响应式。
- 未处理仓库既有的 Vite 动态导入和大 chunk 警告。

## How to try it

```powershell
pnpm --filter @rcx/web dev
```

打开“管家”后依次验证：

1. 在“任务”新建任务并连续对话。
2. 在“插件”确认 Codex Plugin 可见。
3. 在“已安排”选择 Plugin Skill，新建安排后点击直接运行。
4. 在“动态”查看运行进度与待确认事项。
5. 在“设置”确认默认权限为替我审批、Memory 为 Codex 原生能力。

自动验证：

```powershell
pnpm exec playwright test tests/ui/butler-workspace.spec.ts
pnpm --filter @rcx/web typecheck
pnpm --filter @rcx/web build
```

## Risks & rollback

- 风险：Codex app-server 的 plugin/list、skills/list 或 memoryMode 协议变更。现有失败会以不可用状态呈现，不会伪造成功。
- 风险：旧版不规范 Skill 仍走兼容正文路径；移除兼容前需先完成数据迁移。
- 回滚：恢复原页面和旧 Skill 即可；本次没有破坏历史数据，因此无需回滚用户数据。
- 当前证据：逻辑回归 98/98、控制台 UI 7/7、既有交互 44/44、跨模块核心流程 3/3、生产构建通过、视觉门禁 93/100。
