# M11 / v0.20.1 发布验收记录

日期：2026-07-17
状态：v0.20.0 标签与三平台草稿资产已核验；根据产品反馈移除 Codex Docker Runner 并升为 v0.20.1，正式发布等待合并、v0.20.1 标签构建与 npm 身份

## 已通过

| 范围 | 结果 |
| --- | --- |
| 工作区类型 | `pnpm -r typecheck` 通过 |
| 纯逻辑 | 219/219 |
| 专项回归 | 256/256；新增覆盖 AI 助手白名单/回退、一级入口和 Codex 本地持久化/安全边界 |
| UI 渲染冒烟 | Playwright Chromium 6/6；覆盖登录、发消息、切会话、全局搜索、右键菜单和 AI 助手/Codex 一级入口，已纳入 CI |
| 真实 Rocket.Chat | smoke 53/53；classify 5/5 |
| Codex | 0.144.4 协议生成树 671 文件一致；真实 app-server turn 返回 `RCX_M8_OK` |
| Codex 本机运行时 | 独立入口与共享 Agent 均使用所选真实本地目录；原生只读/工作区写入 sandbox、审批路径和附件运行时根合同通过 |
| Rust | 29 通过、1 项官方 IP Messenger 真实互通环境测试按设计忽略 |
| Web | TypeScript 与 Vite production build 通过 |
| M7/M8 可见入口 | Codex 默认支持聊天和本地工作；AI 助手明确指令本地解析、模糊意图走 Codex exec，并支持搜索、只读查询和确认式工作项创建 |
| 应用生态 | SDK/CLI 0.20.1 tarball、临时项目安装、脚手架、validate、回环 dev 预览全部通过；临时目录已清理 |
| Docker G3 代理 | `rocketx-m11-test` 首次拉取固定镜像、构建至三服务 healthy 约 164 秒；主页、健康端点、API 反代和登录均通过 |
| Windows Release 基线 | v0.20.0 本地 Release `rocketx.exe`，15,874,560 bytes，FileVersion / ProductVersion 均为 0.20.0，SHA-256 `DFF55CAB89EE01BC76C32FF34B39191A0BCC1936725C521AF30542CCA9EE5208`；v0.20.1 待重建 |
| 三平台工作流能力 | [Desktop Build #29574827877](https://github.com/lusipad/RocketX/actions/runs/29574827877)：最终 `main` 提交 `e62afdc` 的 v0.20.0 干跑通过，Ubuntu 6 分 20 秒、Windows 6 分 48 秒、macOS universal 8 分 13 秒 |
| v0.20.0 标签产物演练 | [Desktop Build #29580167570](https://github.com/lusipad/RocketX/actions/runs/29580167570) 三平台及 prepare-release 全部成功；草稿 Release 15 个资产齐全，`SHA256SUMS.txt` 的 8 个主体文件全部匹配 |
| GitHub 发布控制 | `npm-release` / `release` 环境仅允许 `main` 且需要 `lusipad` 审批；ruleset `19097369` 禁止更新、强推或删除已创建的 `v*` 标签 |

Docker 临时项目、网络和测试卷已清理；应用生态临时目录也在测试结束后删除。

## v0.20.1 正式发布门禁

- [x] PR #72 CI 通过并合并 `main`；合并提交 `c6658c6` 的 main CI 通过。
- [x] PR #73 发布链路加固已合并 `main`；合并提交 `874a257` 的 [main CI](https://github.com/lusipad/RocketX/actions/runs/29572269910) 通过。
- [x] PR #74 GitHub 发布控制已合并 `main`；合并提交 `a0ecca8` 的 [main CI](https://github.com/lusipad/RocketX/actions/runs/29572915784) 通过。
- [x] `npm-release` / `release` 受保护环境和不可变 `v*` 标签 ruleset 已配置；个人仓库不能把 GitHub Actions Integration 设为创建规则的唯一绕过者，因此创建边界仍由仓库写权限和 `Tag Version` 的受信任 `main` 校验共同承担。
- [x] v0.20.0 版本统一 PR #75 与工作流文案 PR #76 通过 CI 并合并 `main`；最终提交 `e62afdc` 的 [main CI](https://github.com/lusipad/RocketX/actions/runs/29574714302) 通过。
- [x] 最终 `main` 的 v0.20.0 三平台手动干跑、标签构建和草稿资产核验通过；该标签保留为不可变演练基线，不公开为最新版本。
- [ ] Codex 本机目录与默认 exec 路由变更以 v0.20.1 合并 `main`，主 CI 全绿。
- [ ] 从 `main` 创建 `v0.20.1` 标签，三平台 workflow 生成并核验 Windows、macOS、Linux 产物及 `SHA256SUMS.txt`。
- [ ] 由 `lusipad` 首次公开发布 `@lusipad/rocketx` 与 `create-rcx-app`，随后为 `.github/workflows/npm-publish.yml` 配置 Trusted Publishing；registry 验证前不得声称已发布。
- [ ] 两个 npm 包和三平台资产核验通过后公开 GitHub Release。

## 未来 1.0 成熟度门禁

- [ ] G3：一位此前未接触 RocketX 的外部开发者，仅按公开文档在 30 分钟内完成自部署并登录。
- [ ] G4：另一位外部开发者，仅按公开文档在 30 分钟内创建、运行并校验第一个应用。
- [ ] 英文 README 加入真实产品截图与 GIF 演示；架构图已完成，当前 UI 控制入口无法可靠导出素材。

自动 clean-room 结果只证明脚本和文档在受控新环境中可执行，不能代替未来 1.0 要求的两位真人。
