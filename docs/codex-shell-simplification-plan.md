# Codex 壳层简化计划

## 目标

RocketX Butler 不再维护第二套 Agent Runtime。Codex app-server 负责推理、线程、
Goal、子代理、沙箱和审批；RocketX 只保留 UI、项目配置、业务 MCP、透明的
Skill 文件、受控 Memory 数据，以及在 Codex 尚未开放管理接口时所需的最小
定时触发器。

## 第四阶段：原生 Skill 入口与市场

1. **手动调用完全使用 Codex 的 `$skill` 合同。**
   - 三个管家 Composer 都从 `skills/list` 获取候选；UI 只补全 `$name `。
   - 手写 `$name 参数` 和菜单选择最终都提交原生 Skill `UserInput`，不存在
     RocketX Skill Router。
2. **分发完全使用 Codex Plugin/Marketplace 协议。**
   - 市场读取、添加、移除、更新和 Plugin 安装/卸载分别走 `plugin/*` 与
     `marketplace/*`；RocketX 不定义包格式、索引或安装目录。
   - `skills/changed` 只作为失效信号，界面重新读取 `skills/list`。
   - 离线时只读取 `plugin/installed`；在线目录读取有截止时间并失败回退本地，
     网络恢复后自动重新加载，不让 Marketplace 阻塞 Skill 管理页。
3. **只暴露可执行 Skill。**
   - 七个仅描述内部学习算法、没有 Codex 工具入口的分析伪 Skill 已删除。
   - 学习分析继续作为 TypeScript 扩展运行；真正调用 `list_mentions` 的
     `butler-reply-guardian` 归入核心 Skill。

## 第二阶段边界校准

1. **宿主本地状态能力继续使用 Codex 官方 `dynamicTools`。**
   - 置信度：高。
   - 原因：待办、日历、已加载工作台和审批卡目前存在 WebView/宿主状态中；
     为了把它们形式化成 stdio MCP 而新建一条跨进程桥，会增加而不是减少运行时。
   - 会推翻本决定的证据：Codex 提供可直接注册宿主内存函数的 MCP 接口，或这些
     数据已有独立、可信、可由子进程直接访问的服务边界。
2. **外部系统或独立进程能力优先配置为 Codex MCP。**
   - 置信度：高。
   - 先用双运行时探针锁定项目级 MCP 配置、发现和调用合同，再迁移具体工具。
3. **原生 Agent Skills 不再重复注册 `load_skill`。**
   - 置信度：高。
   - 只有旧数据中无法渲染为标准 `SKILL.md` 的技能继续获得兼容入口；新技能只走
     Codex 原生发现与启停。
4. **现有 `rcx-mcp` 不作为 Butler 业务 MCP 复用。**
   - 置信度：高。
   - 它是给外部 Agent 使用的只读 Rocket.Chat 上下文服务，凭据、进程和数据边界
     都不同；强行扩展会把两个产品方向耦合起来。

## 第三阶段切片

1. **长期记忆方法论进入原生 `butler-memory` Skill。**
   - 基础 Persona 只保留不可绕过的硬边界：只有经确认的 alias、偏好和跨会话
     承诺可以持久化，动态工作状态不能写入。
   - 召回、确认写入、撤销、恢复、legacy 导入和简报偏好的具体流程由 Skill
     维护；数据访问和确认卡仍由最小 Host Tool 提供。
2. **MCP 凭据传递必须通过双运行时假凭据探针。**
   - Codex 官方配置允许通过 stdio MCP 的 `env` 注入环境变量，但这不等于承诺
     配置值永不持久化。
   - 探针只使用明确的假值，验证子进程收到后停止 App Server，并扫描临时
     Codex Home。固定版 `0.144.4` 与系统版 `0.145.0` 当前均未发现假值落盘。
   - 该结果是版本门禁，不是永久安全保证；运行时变化后必须重跑。
3. **Azure DevOps Server MCP 仍需先补齐生产进程边界。**
   - 当前只读执行器是 PowerShell 子进程，但 MCP 长驻服务、跨平台 PowerShell
     解析、打包路径和启动失败回退尚未形成生产合同。
   - 在这些合同完成前，真实 PAT 不进入 MCP 配置，现有只读 Host Tool 保持不变。

## 开源 Memory Skill 适配

上游参考改为 [Mem0](https://github.com/mem0ai/mem0) 提交
`74f6dc6f0d60906c4babf762fc8d14b7169c196c` 中 Apache-2.0 授权的
`remember`、`forget`、`context-loader` 和 `memory-reviewer` Skills。RocketX
不逐字复制上游正文，而是按以下边界重写为一个薄 `butler-memory` Skill：

- **Keep**
  - 任务需要历史上下文时才召回，召回保持只读、去重和有限条数。
  - 写入内容保持单条、原子化；记忆质量检查只报告重复、冲突和过期候选。
  - 显式区分用户确认事实和模型推断。
- **Adapt**
  - 上游的多类记忆收窄为 RocketX 的 `alias`、`preference`、`commitment`。
  - 上游直接 `add_memory` 改为 RocketX 确认卡；一张卡只批准一条记忆。
  - 上游删除改为 `revoke_memory`，保留 `restore_memory` 恢复路径。
  - 上游 `user_id` / `app_id` 过滤改为宿主捕获的可信
    `account` / `project` / `room` scope。
- **Drop**
  - 不接入需要 `MEM0_API_KEY` 的远程 MCP，不增加 Mem0 SDK 或服务进程。
  - 不启用自动捕获、Stop Hook、自动反思写入、dream 合并或后台整理。
  - 不保存环境快照、会话状态、动态工作项或凭据，也不使用硬删除。

因此 Mem0 在本阶段是有明确版本和许可证的 Skill 设计参考，不是 RocketX 的第二套
Memory Runtime。持久化、可信 scope 和确认审批仍由现有最小 Host Tools 负责。

## 已确认决策

1. `apps/web/src/butler/skills/<category>/<name>/SKILL.md` 是 Butler 自有目录/API
   Skill 的仓库真相源；其中 core Skill 在 Butler home 中以
   `.agents/skills/<name>/SKILL.md` 逐字镜像，由 Codex 原生消费。
   - TypeScript 只保留目录装载、展示顺序、启停和来源版本，不再维护 Skill 正文。
   - Vite 构建通过 eager glob 装载 Markdown；Node 回归测试同步读取相同文件，
     不生成第二份 TS/JSON 技能清单。
   - Azure DevOps Server 的 API 适配说明同样使用 Markdown；Codex 侧继续消费
     Desktop resources 中已有的完整、直接 `SKILL.md`，不把简化适配说明冒充
     完整原生 Skill。
2. Memory 由原生 `butler-memory` Skill 定义行为；数据、可信 scope 和确认语义
   继续由最小 Host Tool 维护。
   - Butler home 是 Codex 的工作目录，不能把跨账号、项目或房间的真实记忆明文
     写入其中的 `memory/*.md`，否则模型可以绕过 `recall_memory` 的 scope 过滤。
   - 在 Codex 提供可验证的读取隔离前，不把 Memory 数据文件化到 Agent 工作区；
     用户导出必须是显式、按 scope、可审计的产品操作，而不是运行时真相源。
3. 可独立运行的业务能力逐步迁入 RocketX MCP；仅依赖宿主本地状态的能力保留为
   最小 `dynamicTools` 适配，不再建立自研工具选择或 Agent 路由。
4. Errand 使用持久 Codex Thread、Goal 和 Subagent；临时线程不承担可恢复任务。
5. Routine 只负责定时触发 Skill。App Server 没有 Scheduled Task 管理协议时，
   保留最小宿主触发器。
   - 四个内置模板都只保存 `skillName`、触发条件和必要参数；房间汇总的方法论已从
     TypeScript prompt 迁入 `room-digest/SKILL.md`。
   - 宿主继续负责到点判断、无数据预检、登录 scope、暂停、审批卡和 Today 投递；
     这些是本地产品状态边界，不是第二套 Agent 路由。
   - 旧版未编辑的房间汇总自动切到原生 Skill；用户改过的方法保留 prompt，
     不以架构迁移覆盖用户配置。
6. 沙箱和审批完全服从 Codex；RocketX 只负责展示和响应协议请求。
7. Skill 市场完全服从 Codex Plugin/Marketplace；RocketX 只展示协议结果并
   触发安装操作。本地粘贴 `SKILL.md` 仅作为既有项目 Skill 的兼容导入入口。

## 偏离策略

- 遇到兼容差异时选择可逆、最小影响、最接近本计划意图的实现，并记录到
  `docs/implementation-notes-codex-shell-simplification.md`。
- 子代理实时事件不完整时，通过 `thread/read` 恢复，不建立第二套事件存储。
- 不删除旧 Skill、Memory 或 Routine 数据，直到迁移结果通过双读校验。
- 若发现需要扩大文件权限、改变审批语义、破坏用户数据或推翻 Codex 唯一大脑
  的前提，停止实施并重新评审。

## 阶段

1. 固化系统版与协议固定版 Codex 的能力矩阵。
2. 将 Butler Skill 迁移为真实工作区 Skill。
3. 固化项目级 MCP 合同，并迁移具备独立进程边界的业务工具。
4. 将 Errand 映射到持久 Thread、Goal 和 Subagent。
5. 将 Routine 收口为最小定时触发器。
6. 删除旧 Skill Registry、自研工具路由、冗余 Dynamic Tool 和重复运行时状态；
   只保留宿主本地状态所需的最小 Codex Host Tool 适配。

## 验收

- 系统版和固定版的协议来源、路径、版本以及能力结果可独立核对。
- Skill 能被发现、禁用、重新启用并显式调用。
- 输入 `$` 能列出当前工作区的全部原生 Skill，市场安装后无需第二次注册。
- Marketplace 能通过原生协议添加和更新，Plugin 能通过原生协议安装和卸载。
- Marketplace 配置能读取 Codex 当前状态，并移除用户添加的市场而不建立本地配置副本。
- 离线打开 Skill 管理页不会调用在线目录；在线目录超时后退出加载态并展示本地 Plugin。
- ephemeral Thread 拒绝 Goal，持久 Thread 支持完整 Goal 生命周期。
- Subagent 保留父子线程关系并可从持久历史恢复。
- App Server 未提供 Automation CRUD 时，检测结果明确且不会误判为原生支持。
- Butler 核心流程最终只依赖 Codex、Skill、MCP 和透明数据文件。
