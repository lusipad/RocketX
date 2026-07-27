# Implementation notes — 管家逐项体验验收与发布

Plan: [butler-release-acceptance-plan.md](./butler-release-acceptance-plan.md)

## Assumptions

- 之前多轮反馈已经明确了产品方向，本轮不重新打开信息架构选择，而是把这些判断转换成可执行验收。
- 本轮采用 exhaustive 级别：管家范围内已确认的功能、可用性和视觉问题都处理后才发布。
- 现有工作树来自同一条管家改造主线，应保留并作为验收基线，不进行 stash、reset 或无关清理。

## Decisions

- QA 与设计审计都以真实渲染界面为依据；源码只用于定位已经复现的问题。
- 虽然通用 QA 工作流建议每个问题单独提交，本轮遵循用户“全部处理完后提交”的明确交付顺序，修复期间保留一份连续工作树，最终按逻辑范围提交。
- `v0.33.1` 的提前标签已被远端发布合同拒绝且没有产物；`v0.33.2` 在体验验收完成前被提前打标，构建已取消且没有公开 Release。不可变标签均不重写，正式发布使用 `v0.33.3`。

## Findings

- 管家的一页纸、独立入口、双侧完整对话和房间浮层方向正确，不需要再做信息架构级重构。
- 临时问答原先依赖组件局部状态，离开模块后消失；提升到运行期 UI store 后可以连续阅读。
- 第一次从纸面提问前必须等待 Butler 会话恢复完成，否则冷启动时可能把问题发到空会话。
- 最近一次临时问答还需要同时绑定日期、Butler 会话和原问题；否则会跨日期串纸，或被后续完整对话的全局错误状态覆盖。
- “再试一次”不能算新对话轮次，否则网络失败会把用户意外推入完整对话。
- 房间全屏入口虽然复用同一会话，但模块恢复流程会覆盖刚写入的房间上下文；把房间上下文作为入口的最后一步写入后，真实桌面页头稳定显示当前工作面。
- 例行事务的开启、房间选择与刷新持久化已经存在，缺的是用户视角的闭环测试；已补 Playwright。
- Desktop Todo SQLite 命令具备完整语义，但缺少直接单测；已补 CRUD、过滤、逾期、补丁与旧 JSON 幂等迁移。

## Verification

- 真实 Tauri dogfooding：临时问答离页返回仍在；`general-test` 房间连续两轮问答、关闭重开、全屏上下文均通过。
- 发布合同、Codex 协议 671 个文件和全仓 typecheck 通过。
- 纯测试 220/220、回归 763/763、Playwright 67/67。
- Desktop Rust 60/60；局域网插件 Rust 13 通过、2 个显式外部集成测试忽略。
- 真实 Rocket.Chat smoke 53/53；Butler 动态工具、原生 Skill、ADO 适配器和 Codex app-server turn 探针全部通过。
- 全仓生产构建和插件包 `rocketx-plugins-0.33.3.zip` 通过。
- 本地生成且只生成两个 `v0.33.3` NSIS：
  - slim：`RocketX_0.33.3_x64-setup.exe`，7,390,464 bytes，SHA256 `F94DACACC5FA5CAEB5F5776241F3C8A627DAB995859C6B5345C8C31234D13350`
  - full：`RocketX_0.33.3_full-setup.exe`，35,797,481 bytes，SHA256 `5DB543DB6450D0A18B1660E34CA07E36F010D2416782352B7A45B82FD0FDB782`
- 7-Zip 逐项检查：slim 没有 OCR；full 有 9 个 OCR/ONNX Runtime 资源；两包都没有 `codex.exe`。

## Remaining risks

- 临时问答只保证应用运行期内跨模块连续；重启后的完整历史由既有 Butler 会话负责，不另建纸面数据库。
- 当前共享测试服务器的会话分类探针有 3 个历史 `t=d` 数据不满足成员数假设；该非 Butler 探针不属于发布门禁，未修改产品代码规避。
- 本地安装包使用 `--no-sign` 只验证结构和内容；公开 Release 的签名、Updater、SHA256 与 Latest 由受保护发布工作流重新生成并验证。
