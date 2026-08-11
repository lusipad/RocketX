# `RUN` Codex Runtime

> 当前状态：`受限可用`
> 基线：工作树 `2026-08-09`；已验证协议基线 `0.144.4`
> 平台：桌面端；网页版当前无执行传输

## 1. 目标

可靠发现、验证、启动和停止本机 Codex `app-server`，让 RocketX 复用 Codex 的 Thread、模型、Skills、Apps、Plugins、Memory、审批和流式协议，同时在版本或登录不满足时诚实降级。

## 2. 范围

### 包含

- 手动路径、系统 PATH 和标准安装位置的 Runtime 发现；
- 二进制、版本、`app-server --help` 与登录状态探测；
- 版本分类：verified、untested-newer、blocked；
- Tauri 管理的 `app-server` 进程、JSON-RPC 消息和退出事件；
- 中断、停止、重连和 Thread 恢复；
- 注册 RocketX 受管 Skill 根目录与业务 MCP 配置。

### 不包含

- 当前安装包内置 Codex；
- 自动安装、自动升级或替用户登录 Codex；
- 低于协议基线的“尽力兼容”；
- 生产可用的浏览器直连远程 `app-server`；
- 把“全量安装包”解释为包含 Codex。

## 3. 入口与前置条件

- 管家、Skills、已安排任务或共享 Agent 首次连接时触发探测。
- 设置页可配置手动 Codex 可执行文件。
- Runtime 必须可执行、能返回版本、支持 `app-server`，并处于已登录状态。

## 4. 主流程

1. Resolver 按明确优先级检查手动路径、系统/PATH、标准 Codex 安装位置和可选 bundled 候选。
2. 对每个候选逐一记录完整路径、来源、版本与拒绝原因；自动模式继续向后 fallback，手动路径模式只检查手动候选。
3. 通过版本门禁后执行 `app-server --help` 与登录检查；自动模式下单个候选失败不会阻断后续候选。
4. RocketX在用户选择的工作区启动隐藏子进程，通过 Tauri 事件转发 JSON-RPC。
5. Web 层初始化协议、加载目录并创建/恢复 Thread。
6. 停止、切换工作区、显式刷新或应用关闭时终止受管进程，清理请求并按需恢复 Thread。

## 5. 状态与交互

### 5.1 Runtime 状态

- `未探测`：尚未进入需要 Codex 的页面或性能模式关闭了探测。
- `探测中`：检查候选路径、版本、`app-server` 和登录；不允许并发启动任务。
- `verified`：版本进入完整验证列表且所有启动检查通过。
- `untested-newer`：版本高于验证基线，轻量检查通过但仍保留未验证提示。
- `blocked`：版本低于基线或协议条件不满足，不启动 `app-server`。
- `未登录/不可用`：保留诊断与重试入口，其他 RocketX 能力继续可用。
- `已中断`：受管进程异常退出，当前 Turn 不能显示为完成。
- `候选诊断`：设置页可按需展开查看被跳过的候选，只在本机 UI 显示完整路径；复制摘要统一脱敏。

### 5.2 版本与安装语义

| 条件 | 当前判定 |
| --- | --- |
| `0.144.4` | `verified`，当前唯一完整验证版本 |
| 高于 `0.144.4` | `untested-newer`；轻量探测通过后允许使用，保留未验证提示 |
| 低于 `0.144.4` | `blocked` |
| 内部最低候选常量 | 仅为探测元数据，不是可用承诺；实际低于基线仍阻止 |
| 没有 Runtime | 不可用；非 AI 功能继续运行 |
| 精简包/全量包 | 两者都不包含 Codex；全量包只增加 OCR 等资源 |

## 6. 平台与依赖

| 场景 | 当前状态 | 行为 |
| --- | --- | --- |
| Windows/macOS/Linux 桌面端，候选可解析 | 受限可用 | 通过本地 Tauri 进程启动 `app-server` |
| Codex App 标准安装位置可发现 | 受限可用 | 可作为系统/标准候选，仍需版本和登录探测 |
| 仅网页版 | 不可用 | 当前传输直接依赖 Tauri invoke/listen |
| 远程 WebSocket `app-server` | 未实现 | 上游仍标为实验能力，不作为当前生产架构 |

## 7. 数据与同步

- Runtime 路径和探测结果保存在本机设置/运行状态。
- Thread、Turn、Skills、Plugin 与 Memory 数据由 Codex Home 管理。
- RocketX 对每个受管进程分配会话/进程 ID，并限制消息和附件大小。
- 切换工作区时关闭旧控制器，避免同一 UI 把两个 `cwd` 的目录或 Thread 混合。

## 8. 权限与安全

- 只接受明确支持的 Codex 可执行文件/入口，手动路径必须解析为真实文件。
- 工作目录使用用户选择的本地路径；模型不能自行注册额外工作区。
- 子进程使用当前权限档和审批策略，Runtime 发现本身不授予 `danger-full-access`。
- 应用关闭、进程异常或请求取消时必须释放子进程，避免遗留后台执行。

## 9. 失败与降级

| 场景 | 用户可见结果 | 副作用与恢复 |
| --- | --- | --- |
| 路径不是支持的入口/文件不存在 | 显示路径错误 | 修改路径或清除手动设置后重新探测 |
| 版本低于基线 | 显示 blocked 与所需基线 | 升级 Codex；不尝试不兼容协议 |
| 新版本探测失败 | 显示未验证版本的具体失败 | 切换验证版本或升级 RocketX |
| `app-server --help` 失败 | 标记 Runtime 不可用 | 不创建 Thread |
| Codex 未登录 | 提示先完成 Codex 登录 | 登录后重新探测 |
| 运行中进程退出 | 当前 Turn 标为中断 | 重连并恢复 Thread，不宣称完成 |
| 网页版打开管家 | 显示缺少本地执行面 | 消息和工作台继续可用 |
| 手动路径失效 | 显示手动路径不可用，并提供“清除手动路径并自动检测” | 清除本地设置后立即重新回到自动探测链路 |

## 10. 验收标准

- `RUN-AC-01`：无 Codex 时 RocketX 能登录、收发消息和使用非 AI 界面，管家明确不可用。
- `RUN-AC-02`：低于 `0.144.4` 的版本被阻止，高于基线的版本被标为未验证而非 verified。
- `RUN-AC-03`：候选必须同时通过二进制、版本、`app-server --help` 和登录探测才进入 ready。
- `RUN-AC-03A`：自动模式会保留全部候选的结构化诊断，并在可用候选通过时继续 fallback，不因前一个候选失败而误报 unavailable。
- `RUN-AC-04`：切换工作区、刷新、停止和关闭应用不会遗留受管进程或旧请求。
- `RUN-AC-05`：精简与全量发布配置均不宣称/捆绑 Codex。
- `RUN-AC-06`：网页版不尝试调用不存在的 Tauri transport，也不显示伪成功。
- `RUN-AC-07`：中断后可通过同一原生 Thread 恢复已有 Turns。
- `RUN-AC-08`：复制出的诊断摘要只包含结构化字段与协议基线，必须脱敏用户主目录与 token/PAT，且不暴露自由文本错误原因。

## 11. 实现与测试证据

- 实现：`apps/desktop/src-tauri/src/proc.rs`
- 实现：`apps/web/src/agent/protocol/index.ts`、`apps/web/src/agent/AppServerController.ts`
- 发布配置：`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/tauri.full.conf.json`
- 自动化：`scripts/regressions/codex-runtime.test.ts`、`scripts/regressions/codex-bundled-resource.test.ts`
- 自动化：`scripts/regressions/codex-app-server-client.test.ts`、`scripts/regressions/app-server-controller.test.ts`
- 真实验证入口：`pnpm smoke:codex-lifecycle`
- 上游参考：[Codex app-server](https://learn.chatgpt.com/docs/app-server)

## 12. 已知差距与目标

- 网页版要支持 AI，需单独设计受认证的远端执行服务、租户隔离、工作区存储和审批回传；不能直接把实验 WebSocket 暴露给浏览器。
- 新于基线的 Codex 只做轻量启动探测，发布候选仍需跑完整语义回归后才能加入 verified 列表。
