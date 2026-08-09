# 切片规格：发布物瘦身——系统优先，重资源不捆绑（决策 15）

> 文档状态：**已废弃的实现切片**。不捆绑 Codex 的结论仍有效，但本文的版本门禁、候选顺序、内置兜底和包体数据属于旧实现；当前合同见[Codex Runtime](specs/codex-runtime.md)、[平台与桌面](specs/platform-and-desktop.md)和[兼容性](compatibility.md)。

**决策 15**（2026-07-26，用户确认）：**壳自带的越少越好，能用系统的用系统的，重资源全部外置。** 两刀：① Codex 解析翻转为系统优先、捆绑兜底，发布物不带 codex 二进制（决策 12 捆绑翻案）；② 默认发布物不带 PP-OCRv5 模型与 ONNX Runtime，识别默认走 Windows.Media.Ocr，增强 OCR 变可选装。两刀合计：安装包 126MB → 约几 MB～10MB 级，构建时间大降。

## 依据（实测，不是推演）

1. **系统 codex 的支持早已在代码里**：`proc.rs` 的 `resolve_codex_from_candidates` 本就扫描系统 PATH 与标准安装路径（`CodexRuntimeSource::System`），只是排在捆绑之后。翻转是交换顺序，不是新功能。
2. **版本兼容有实证**：同一台机器上，桌面端捆绑版 0.144.4 与本机 npm 0.145.0 同日各自跑 app-server 协议（thread/start、turn/start、granular 审批），全部正常——协议稳定性不需要靠锁版本保障。
3. **捆绑的真实代价**：`codex-resources` 未压缩 391MB，是 126MB 安装包的绝对大头；NSIS 与 MSI 各压一遍，桌面构建时间的主要成本就在这。
4. **「内网需要捆绑」是伪需求**：codex 必须登录 OpenAI 才能干活，真离线内网捆不捆绑都用不了它；内网 AI 的正解是内网模型 Provider 路线（决策 12 已冻结）。能用 codex 的环境必然装得了 codex。

## 用户可见变化

1. 安装包从 ~126MB 降到 ~30MB（落地后报实测数），下载、安装、构建全面提速。
2. 已装系统 codex 的用户（目标人群几乎全部）：无感，且从此桌面端跟随系统 codex 升级，不再被捆绑版锁旧。
3. 未装 codex 的用户：首启管家页明说「差一个 codex」，给两条命令（npm / 官网），装完点重试即可——复用决策 13 的不可用引导，只改文案。
4. 旧版本用户升级：本地已解压的捆绑 codex 仍会被兜底扫描认到，不会突然失灵。

## 改动清单

| 处 | 动作 |
|---|---|
| `apps/desktop/src-tauri/src/proc.rs` | `resolve_codex_from_candidates` 顺序翻转：system → standard → bundled；`ResolvedCodex` 带上来源与版本供 UI 呈现 |
| 版本下限 | 解析到的 codex 跑 `--version`，低于 `MIN_CODEX_VERSION`（定 0.140.0，app-server 协议成熟线）时不采用并提示升级；常量注释写为什么 |
| `tauri.conf.json` | resources 去掉 `"target/codex-resources/codex/": "codex/"` |
| 构建脚本 | codex 资源准备步骤跳过/删除（保留 OCR 的）；CI 的 windows-desktop-check 同步 |
| 不可用引导文案 | 「管家暂时用不了」的原因分支加「没找到 codex」：两条安装命令 + 重试按钮 |
| 设置 | AI 设置显示当前 codex 来源与版本（系统 / 捆绑 + 路径），可手动指定路径覆盖 |

## 第二刀：OCR 外置（用户 2026-07-26 追加确认）

默认发布物不带 PP-OCRv5 模型与 ONNX Runtime。`ocr.rs` 的回退链现成（本地资源缺失 → 自动 Windows.Media.Ocr），几乎零代码：

- `tauri.conf.json` resources 去掉 `"target/ocr-resources/ocr/": "ocr/"`；构建跳过模型下载
- 设置里显示当前识别引擎（增强 / 系统），给「想要增强版怎么装」的指引（模型目录 + 下载地址）
- 诚实预告：Windows.Media.Ocr 中文质量不如 PP-OCRv5——装了增强模型的人 #235 的内存修复照常生效
- #192 的最终答案就是这个形态：一个瘦包 + 可选资源，落地后关闭该 issue

## 第三刀：full 版（用户 2026-07-26 追加确认）

同时发布 `RocketX_x.y.z_full-setup.exe`：同一个壳，只额外捆绑增强 OCR 资源。两个安装包都要求用户已安装系统 codex，不再分发 `codex.exe`。

**唯一的坑与解法**：updater 的 latest.json 只有一个地址，full 用户自动更新会拉到瘦壳——若资源装在安装目录，会被全量覆盖清掉，静默降级。所以 **full 版把重资源装到不受壳更新影响的位置（LOCALAPPDATA 下约定目录），运行时兜底扫描加上该路径**。壳统一更新（永远只发瘦壳），资源一次性落地，full 用户永不降级。

- Rust 只编译一次，NSIS 多打一份只含增强 OCR 的 full 包（仅 release 时，CI check 不打）
- SHA256SUMS 与 verify-release-assets 的资产清单同步加 full 包
- MSI 暂只发瘦版，有诉求再说

## 不做什么

- 不删捆绑扫描逻辑——已装旧版的用户与 full 版用户都靠它。
- 不做 codex/模型的运行期自动下载——各自有安装渠道，别替它管；full 版就是给不想折腾的人的。
