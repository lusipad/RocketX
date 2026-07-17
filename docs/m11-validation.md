# M11 / v1.0.0 发布验收记录

日期：2026-07-17
状态：实现候选已通过本地门禁；正式标签被外部真人验收与视觉素材阻塞

## 已通过

| 范围 | 结果 |
| --- | --- |
| 工作区类型 | `pnpm -r typecheck` 通过 |
| 纯逻辑 | 219/219 |
| 专项回归 | 243/243 |
| 真实 Rocket.Chat | smoke 53/53；classify 5/5 |
| Codex | 0.144.4 协议生成树 671 文件一致；真实 app-server turn 返回 `RCX_M8_OK` |
| Agent Runner | 固定版本、工作区读写边界、只读附件与凭据拒绝通过 |
| Rust | 30/30；官方 IP Messenger 真实互通用例按设计为显式环境测试，默认忽略 |
| Web | TypeScript 与 Vite production build 通过 |
| 应用生态 | SDK/CLI 1.0.0 tarball、临时项目安装、脚手架、validate、回环 dev 预览通过；约 7.3 秒 |
| Docker G3 代理 | `rocketx-m11-test` 首次拉取固定镜像、构建至三服务 healthy 约 164 秒；主页、健康端点、API 反代和登录均通过 |
| Windows Release | `rocketx.exe`，15,874,560 bytes，ProductVersion 1.0.0，SHA-256 `DF1029D4EEA21872DD45296492E68CEAA9E3AC1CF1EFC6A3698C5F9E0A69A9D9` |

Docker 临时项目、网络和测试卷已清理；应用生态临时目录也在测试结束后删除。

## 正式发布门禁

- [ ] G3：一位此前未接触 RocketX 的外部开发者，仅按公开文档在 30 分钟内完成自部署并登录。
- [ ] G4：另一位外部开发者，仅按公开文档在 30 分钟内创建、运行并校验第一个应用。
- [ ] 英文 README 加入真实产品截图与 GIF 演示；架构图已完成，当前 UI 控制入口无法可靠导出素材。
- [ ] PR CI 通过并合并 `main`。
- [ ] 从 `main` 创建 `v1.0.0` 标签，三平台 workflow 生成并核验 Windows、macOS、Linux 产物及 `SHA256SUMS.txt`。
- [ ] npm 登录且确认 `@rcx` scope 权限后公开发布 `@rcx/app-sdk` 与 `create-rcx-app`；本机当前为 `ENEEDAUTH`，不得声称已发布。

自动 clean-room 结果只证明脚本和文档在受控新环境中可执行，不能代替蓝图要求的两位真人。
