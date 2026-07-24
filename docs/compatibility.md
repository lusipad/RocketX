# Compatibility matrix and upgrade policy

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
| Windows desktop | Tauri 2 / WebView2 | The current official desktop Release target. Windows-specific integrated authentication and native notifications are platform-gated. |
| macOS desktop | Tauri 2 / system WebView | Source target only during stabilization; official installers and updater entries are deferred pending macOS acceptance evidence. |
| Linux desktop | Tauri 2 / WebKitGTK | Source target only during stabilization; official installers and updater entries are deferred pending distribution-level acceptance evidence. |

Repository configuration is not proof that an installer has been published. Use tagged GitHub Release assets as the publication record.

Starting with `v0.29.1`, official desktop Releases are temporarily Windows x64 only. Windows users install the current `v0.31.0` release manually after it is public, while `v0.28.0` remains GitHub's Latest release and the last public cross-platform artifact set. macOS and Linux delivery, together with normal Latest-based auto-update promotion, resumes only after platform-specific validation is stable.

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
