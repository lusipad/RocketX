# Third-Party Notices

RocketX is licensed under the [MIT License](LICENSE). It uses third-party software that remains subject to its own license terms. This file is a practical inventory, not a replacement for the license files distributed by those projects.

## Web and Node.js components

The production Web client directly uses the following packages. Exact resolved versions and transitive dependencies are recorded in `pnpm-lock.yaml`.

| Component | License | Project |
| --- | --- | --- |
| React and React DOM | MIT | <https://react.dev/> |
| Zustand | MIT | <https://github.com/pmndrs/zustand> |
| pinyin-pro | MIT | <https://pinyin-pro.cn/> |
| Lucide React | ISC | <https://lucide.dev/> |
| PDF.js (`pdfjs-dist`) | Apache-2.0 | <https://mozilla.github.io/pdf.js/> |
| Tauri JavaScript API and plugins | MIT or Apache-2.0 | <https://github.com/tauri-apps/> |
| Fastify (ADO notification bridge) | MIT | <https://fastify.dev/> |

Build-time packages such as TypeScript, Vite, Tailwind CSS, pnpm, and their transitive dependencies are governed by their respective licenses and pinned by the lockfile.

To regenerate the Node dependency license inventory from an installed checkout:

```bash
pnpm install --frozen-lockfile
pnpm licenses list --prod
```

## Desktop components

The desktop application uses Tauri and Rust crates including Serde, BLAKE3, Ed25519, encoding_rs, mdns-sd, socket2, keyring, `oar-ocr`, `ort`, and platform integration crates. Exact crate versions and checksums are recorded in `apps/desktop/src-tauri/Cargo.lock`; license metadata is supplied by each crate and its source distribution.

Tauri and most listed Rust ecosystem components use MIT, Apache-2.0, or dual MIT/Apache-2.0 terms. Consumers who redistribute desktop binaries must audit the complete locked dependency graph for their target platform rather than relying only on this summary.

### Bundled Codex Skill

RocketX desktop redistributes the `azure-devops-server` Codex Skill from
<https://github.com/lusipad/azure-devops-server-skill> at commit
`293b09774cf9d1ef880a889baf212a9b661e0a75` under the MIT License. The license
text is packaged as
`apps/desktop/src-tauri/resources/codex-skills/LICENSE.azure-devops-server.txt`.

### Bundled local OCR runtime and models

RocketX desktop now bundles a local PP-OCRv5 inference path for image OCR. The build script downloads, verifies, and repackages the following upstream assets into the application resources; runtime never downloads them:

| Component | License | Project |
| --- | --- | --- |
| OAR OCR (`oar-ocr`, `oar-ocr-core`) | Apache-2.0 | <https://github.com/GreatV/oar-ocr> |
| ONNX Runtime 1.23.2 CPU runtime | MIT | <https://github.com/microsoft/onnxruntime> |
| PP-OCRv5 model files (`pp-ocrv5_mobile_det`, `pp-ocrv5_mobile_rec`, `pp-lcnet_x1_0_textline_ori`, `ppocrv5_dict.txt`) | Apache-2.0 | <https://github.com/GreatV/oar-ocr/releases/tag/v0.3.0> |

The exact upstream URLs and SHA-256 digests are pinned in `apps/desktop/src-tauri/build.rs`. Build output also preserves ONNX Runtime's upstream `LICENSE` and `ThirdPartyNotices.txt` alongside the extracted runtime library files for the packaged app.

## Container images

`docker/docker-compose.yml` pulls separately distributed Rocket.Chat and MongoDB images and builds RocketX Web using pinned Node and Nginx images. Those images are not relicensed by RocketX:

- Rocket.Chat: <https://github.com/RocketChat/Rocket.Chat>
- MongoDB: <https://www.mongodb.com/legal/licensing/server-side-public-license>
- Node.js: <https://github.com/nodejs/node>
- Nginx: <https://nginx.org/LICENSE>

Review the image publisher's license and deployment terms before redistribution or production use.

## Fonts, icons, and generated data

RocketX uses Lucide icons through `lucide-react`. Emoji names and rendering data are produced from the dependencies recorded in `pnpm-lock.yaml`; upstream artwork, fonts, or custom Rocket.Chat emoji remain governed by their respective owners and are not granted additional rights by the RocketX license.

If a dependency is added, removed, or upgraded, update this notice when its license family or redistributed assets change.
