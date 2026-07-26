# 决策 15 实施记录

## 已落地

- Codex 解析顺序改为手动覆盖 → PATH → 标准安装目录 → 旧版内置资源兜底，并拒绝低于 0.140.0 的版本。
- 默认 Tauri 构建不再准备或捆绑 Codex、PP-OCRv5 模型和 ONNX Runtime。
- AI 设置显示 Codex 来源、版本、路径与当前 OCR 引擎；缺失 Codex 时提供官方安装入口和重试。
- full NSIS 复用已编译的 RocketX 二进制，只把增强 OCR 资源一次性安装到
  `%LOCALAPPDATA%\RocketX\resources`；自动更新清单继续只指向瘦版。
- 发布资产门禁只要求两个安装包（瘦版、full）、更新清单和插件包，并拒绝让
  `latest.json` 指向 full。

## 实施中发现

- 仅从 `tauri.conf.json` 删除资源不够：`build.rs` 原本仍会无条件下载 Codex 和
  OCR。Codex 资源准备已删除；OCR 只在 `ROCKETX_BUNDLE_OCR` 显式开启时准备，
  普通编译与 CI check 不再承担重资源成本。
- Tauri 的 `tauri bundle` 可以对已构建二进制再次封装，因此发布构建可先产出瘦版，
  再只重跑 NSIS 封装生成 full，不需要第二套 Rust 源码或功能分支。
- full 的 OCR 资源不能留在安装目录，否则瘦版自动更新会覆盖掉它们；安装 hook 会复制到
  LOCALAPPDATA 后删除安装目录中的临时副本。

## 验证与限制

- `cargo test --bin rocketx`：56/56。
- `pnpm typecheck`：全工作区通过。
- `pnpm test:regression`：757/757。
- Playwright AI 设置用例通过，并生成设置页截图。
- 本机实际 release 封装：瘦版 7,377,169 bytes；只含增强 OCR 的 full
  35,794,851 bytes。生成的 full NSIS 清单不含 `codex.exe`。
- 尚未在真实 tag、签名密钥和 GitHub 草稿 Release 环境执行完整发布工作流。
- 为保证自动更新后资源仍在，外置资源不会由瘦版 updater 主动删除；显式卸载后的
  资源清理需要后续单独定义合同。
