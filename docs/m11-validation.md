# M11 / v0.20.0 发布验收记录

日期：2026-07-17
状态：M11 与 v0.20.0 版本统一已合并 `main`，三平台干跑通过；正式发布等待标签构建与 npm 身份

## 已通过

| 范围 | 结果 |
| --- | --- |
| 工作区类型 | `pnpm -r typecheck` 通过 |
| 纯逻辑 | 219/219 |
| 专项回归 | 248/248 |
| 真实 Rocket.Chat | smoke 53/53；classify 5/5 |
| Codex | 0.144.4 协议生成树 671 文件一致；真实 app-server turn 返回 `RCX_M8_OK` |
| Agent Runner | 固定版本、工作区读写边界、只读附件与凭据拒绝通过 |
| Rust | 30/30；官方 IP Messenger 真实互通用例按设计为显式环境测试，默认忽略 |
| Web | TypeScript 与 Vite production build 通过 |
| 应用生态 | SDK/CLI 0.20.0 tarball、临时项目安装、脚手架、validate、回环 dev 预览通过 |
| Docker G3 代理 | `rocketx-m11-test` 首次拉取固定镜像、构建至三服务 healthy 约 164 秒；主页、健康端点、API 反代和登录均通过 |
| Windows Release | v0.20.0 本地 Release `rocketx.exe`，15,874,560 bytes，FileVersion / ProductVersion 均为 0.20.0，SHA-256 `DFF55CAB89EE01BC76C32FF34B39191A0BCC1936725C521AF30542CCA9EE5208` |
| 三平台工作流能力 | [Desktop Build #29574827877](https://github.com/lusipad/RocketX/actions/runs/29574827877)：最终 `main` 提交 `e62afdc` 的 v0.20.0 干跑通过，Ubuntu 6 分 20 秒、Windows 6 分 48 秒、macOS universal 8 分 13 秒 |
| GitHub 发布控制 | `npm-release` / `release` 环境仅允许 `main` 且需要 `lusipad` 审批；ruleset `19097369` 禁止更新、强推或删除已创建的 `v*` 标签 |

Docker 临时项目、网络和测试卷已清理；应用生态临时目录也在测试结束后删除。

## v0.20.0 正式发布门禁

- [x] PR #72 CI 通过并合并 `main`；合并提交 `c6658c6` 的 main CI 通过。
- [x] PR #73 发布链路加固已合并 `main`；合并提交 `874a257` 的 [main CI](https://github.com/lusipad/RocketX/actions/runs/29572269910) 通过。
- [x] PR #74 GitHub 发布控制已合并 `main`；合并提交 `a0ecca8` 的 [main CI](https://github.com/lusipad/RocketX/actions/runs/29572915784) 通过。
- [x] `npm-release` / `release` 受保护环境和不可变 `v*` 标签 ruleset 已配置；个人仓库不能把 GitHub Actions Integration 设为创建规则的唯一绕过者，因此创建边界仍由仓库写权限和 `Tag Version` 的受信任 `main` 校验共同承担。
- [x] v0.20.0 版本统一 PR #75 与工作流文案 PR #76 通过 CI 并合并 `main`；最终提交 `e62afdc` 的 [main CI](https://github.com/lusipad/RocketX/actions/runs/29574714302) 通过。
- [x] 最终 `main` 的 v0.20.0 三平台手动干跑通过；正式标签仍需单独生成并核验签名资产与 `SHA256SUMS.txt`。
- [ ] 从 `main` 创建 `v0.20.0` 标签，三平台 workflow 生成并核验 Windows、macOS、Linux 产物及 `SHA256SUMS.txt`。
- [ ] npm 登录且确认 `@rcx` scope 权限后公开发布 `@rcx/app-sdk@0.20.0` 与 `create-rcx-app@0.20.0`；本机当前为 `ENEEDAUTH`，不得声称已发布。
- [ ] 两个 npm 包和三平台资产核验通过后公开 GitHub Release。

## 未来 1.0 成熟度门禁

- [ ] G3：一位此前未接触 RocketX 的外部开发者，仅按公开文档在 30 分钟内完成自部署并登录。
- [ ] G4：另一位外部开发者，仅按公开文档在 30 分钟内创建、运行并校验第一个应用。
- [ ] 英文 README 加入真实产品截图与 GIF 演示；架构图已完成，当前 UI 控制入口无法可靠导出素材。

自动 clean-room 结果只证明脚本和文档在受控新环境中可执行，不能代替未来 1.0 要求的两位真人。
