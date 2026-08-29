# Compatibility matrix and upgrade policy

> Status: current compatibility reference. User-visible platform behavior is defined by the [capability matrix](specs/capability-matrix.md).

RocketX is a separate client built on Rocket.Chat's public REST (`/api/v1/*`) and realtime (`/websocket`) interfaces. It does not patch the Rocket.Chat server, create private Rocket.Chat tables, or require a RocketX server plugin.

## Verified Rocket.Chat versions

| Rocket.Chat server | Evidence level | Status | Notes |
| --- | --- | --- | --- |
| 8.6.1 | Full repository baseline | Supported | Pinned by `docker/docker-compose.yml`; real-server smoke and classification suites are run against this version. |
| Other 8.6.x releases | Family-level expectation only | Not individually verified | Patch compatibility is expected, but a result on 8.6.1 is not evidence for every 8.6.x patch. Run the full upgrade checks before use. |
| Other 8.x releases | None in this repository | Unverified | API or server-setting changes may require client work. |
| 7.x and earlier | None in this repository | Unverified | No compatibility commitment. |

The matrix describes tested RocketX behavior, not the support lifecycle or security status of Rocket.Chat itself. Check Rocket.Chat's upstream documentation before choosing a server release.

## Deployment matrix

| Surface | Baseline | Notes |
| --- | --- | --- |
| Web | Production Vite build behind the pinned Nginx image | Nginx serves the SPA and proxies Rocket.Chat API, file, avatar, emoji, and WebSocket routes on the same origin. |
| Windows desktop | Tauri 2 / WebView2 | Official x64 NSIS slim, MSI, and optional full installers. Slim only probes installed Codex/DSH runtimes; Windows full additionally carries private Codex/DSH payloads. Windows-specific integrated authentication and native notifications are platform-gated. |
| macOS desktop | Tauri 2 / system WebView | Official universal DMG and updater archive. The app uses an ad-hoc macOS signature and RocketX updater signature, but is not Apple-notarized; users may need to allow it in Privacy & Security. |
| Linux desktop | Tauri 2 / WebKitGTK | Official x64 AppImage, DEB, and RPM packages. Distribution-specific behavior beyond the CI baseline remains unverified. |

Repository configuration is not proof that an installer has been published. Use tagged GitHub Release assets as the publication record.

Releases `v0.29.1` through the cancelled `v0.34.4` candidates were never promoted as a new cross-platform Latest. `v0.34.5` restored the official macOS and Linux packages, and `v0.40.2` continued that complete updater manifest. The `v0.42.0`, `v0.42.1`, and `v0.42.2` build candidates were not published after their desktop matrices exposed DSH preparation, raw-resource packaging, and full-asset upload limits. `v0.42.4` was also withheld after a Butler streaming regression was found before publication, while `v0.42.5` resumed verified GitHub Latest delivery. The `v0.43.7` candidate was withheld after the release gate caught a stale compatibility-matrix version line before any artifact was built; its immutable tag remains an unpublished candidate. Starting with `v0.43.0`, the current target continues that policy with default slim artifacts that only probe installed runtimes and a Windows full installer that adds the private bundled payloads.

## Codex runtime compatibility

Default slim, macOS, and Linux installers do not bundle Codex. Desktop AI features use a compatible, signed-in local Codex discovered from the manual path, `PATH`, or a supported standard installation location; the Windows full installer additionally provides the fixed private Codex `0.144.4` candidate under the same capability and login gates.

| Codex condition | RocketX behavior |
| --- | --- |
| Version `0.144.4` | Current verified protocol baseline |
| Newer than `0.144.4` | Allowed only after binary, `app-server --help`, and login probes pass; shown as untested newer |
| Older than `0.144.4` | Blocked; user-facing diagnostics only promise the `0.144.4` protocol baseline |
| Missing or signed out | Messaging and deterministic work surfaces remain usable; local AI features are unavailable |
| Web client | No local Codex transport; messaging and deterministic work surfaces remain usable |

See [Codex Runtime](specs/codex-runtime.md) for discovery, failure, recovery, and release evidence.

## DeepSeek Harness runtime compatibility

RocketX `v0.43.19` desktop line is split. Default slim installers do not bundle DSH and only probe already-installed runtimes; when a system DSH is found, any `@deepseek-ai/dsh` version at or above the minimum verified line `0.1.0-rc.6` is accepted (non-hyphenated prerelease spellings such as `1.0.0rcalpha07` are normalized before comparison). Versions newer than `0.1.0-rc.6` are not blocked, but they have not completed full verification and are only warned about in diagnostics until RocketX validates and updates its own support line. The Windows full installer additionally ships the verified private runtime for exactly `@deepseek-ai/dsh@0.1.0-rc.6` plus a private Node payload into the application data directory. When DSH is selected, RocketX embeds the official DSH Web for private conversations and reuses one native Host/controller path for room AI and shared hosting. Provider, model, Agent, permission, and credential configuration remain owned by DSH rather than being duplicated in RocketX. A separate `deepseek-harness` source checkout is never a release prerequisite. The Web client cannot start the local DSH process.

| DSH condition | RocketX behavior |
| --- | --- |
| Installed compatible DSH `0.1.0-rc.6` or Windows full private runtime, selected provider credentials configured | DSH sessions, model/provider and reasoning selection, Agent presets, permissions, approvals, questions, and DSH AI hosting are available |
| DSH missing or unavailable | DSH backend is unavailable in slim mode; Codex and deterministic surfaces keep their own availability |
| Selected provider credentials missing or invalid | DSH configuration and history remain visible; sending fails closed with the provider's diagnostic until credentials are corrected in DSH |
| Private full DSH runtime missing or incomplete | RocketX refuses to start that backend, then uses a verified available Codex runtime or no AI instead of downloading an unpinned runtime |
| Web client | No local DSH transport or hosting; messaging and deterministic work surfaces remain usable, and an active desktop-hosted lease stays visible and reachable through `@ai` |

An upstream DSH upgrade is a full runtime upgrade for the Windows full package: change the exact version in `apps/dsh-runtime/package.json`, update `pnpm-lock.yaml`, run `pnpm prepare:dsh-runtime`, and repeat bridge, Host API, native dependency, session/configuration, approval, and packaging checks. Slim builds only track external installation discovery and do not carry the private runtime. RocketX does not maintain a compatibility shim for multiple DSH wire contracts: system DSH builds below `0.1.0-rc.6` are refused, builds at or above it are accepted on the semver range, and only builds newer than the verified `0.1.0-rc.6` line carry the not-fully-verified warning until this exact upgrade path lands.

## Required and optional server settings

The Compose baseline applies these settings for reproducible local testing:

- `UTF8_Channel_Names_Validation` allows CJK channel and group names.
- `Message_AlwaysSearchRegExp=true` enables substring behavior needed by Chinese message search.
- `Search.defaultProvider.GlobalSearchEnabled=true` enables cross-room global search.
- CORS is enabled for direct desktop connections. Web deployment through the bundled Nginx proxy is same-origin and does not require permissive CORS.

Read receipts depend on Rocket.Chat edition and server capability. RocketX hides or degrades the feature when the server rejects the corresponding API; a configured setting does not turn an upstream commercial capability into a community feature.

## Upgrade procedure

Do not replace the pinned Rocket.Chat image with `latest`.

1. Back up MongoDB and test restore before changing the server image.
2. Record the current RocketX commit, Rocket.Chat image tag, MongoDB image tag, and relevant server settings.
3. Change the Rocket.Chat image to one exact version in a staging copy of `docker/docker-compose.yml`.
4. Start the staging stack and wait for all health checks.
5. Install dependencies from the lockfile and run:

   ```bash
   pnpm typecheck
   pnpm test:pure
   pnpm test:regression
   RC_BASE_URL=http://localhost:3300 pnpm smoke
   RC_BASE_URL=http://localhost:3300 pnpm test:classify
   ```

6. Manually verify login, realtime reconnect, message send/edit/delete, upload/download, Chinese search, threads, directory/member pagination, and an official Rocket.Chat client against the same server.
7. Add the exact server version and evidence to this matrix only after the checks pass.

`pnpm smoke` performs real writes and attempts to restore its test data. Use an isolated staging server and confirm cleanup before discarding the environment.

## Known boundaries

- Azure DevOps Server 2022 integration is optional and does not change Rocket.Chat compatibility.
- M9 trusted LAN transfer is a RocketX-to-RocketX transport with separate device identity and trust state.
- M10 IP Messenger compatibility is an opt-in Windows plugin with its own native Sidecar. Standard peers use UDP/TCP 2425 for messages and ordinary files; original Intranet Link peers are limited to 2425 discovery and text. It never inherits M9 trust.
- Official Rocket.Chat clients can continue to connect to the same server; RocketX-only local features may not appear in those clients.
