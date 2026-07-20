# RocketX

[简体中文](README.zh-CN.md)

RocketX is an independent team collaboration client built on the public Rocket.Chat REST and realtime APIs. It keeps the Rocket.Chat server unchanged while adding a focused desktop and web experience for messaging, GTD-style inbox processing, local AI stewardship, shared Codex agent sessions, and LAN continuity.

> RocketX is an independent project and is not affiliated with or endorsed by Rocket.Chat Technologies Corp. A feature described in this repository is not necessarily a published release; use the tags and [GitHub Releases](https://github.com/lusipad/RocketX/releases) as the publication record.

```text
┌──────────────────────────────────────────┐
│ RocketX Web / Desktop                    │
│ Messages · Butler · Tasks · Calendar · Workbench │
└──────────────┬───────────────────────────┘
               │ public REST + WebSocket APIs
        ┌──────▼──────┐       ┌──────────────────┐
        │ Rocket.Chat │◄──────│ optional bridges │
        │ unchanged   │       │ ADO · LAN · IPMSG│
        └─────────────┘       └──────────────────┘
```

## What is in the repository

- `apps/web`: React and Vite client.
- `apps/desktop`: Tauri 2 desktop shell and native integrations.
- `packages/rc-client`: dependency-free Rocket.Chat REST and realtime client.
- `packages/app-sdk`: typed JSON-RPC bridge and application manifest contract.
- `packages/create-rcx-app`: application scaffolding, validation, and local preview CLI.
- `services/ado-bridge`: optional Azure DevOps Server 2022 event bridge.
- `examples`: RocketX application examples.
- `docker`: reproducible RocketX Web, Rocket.Chat, and MongoDB stack.

The detailed product and technical scope lives in the [blueprint](docs/blueprint.md). See the [architecture notes](docs/architecture.md), [compatibility matrix](docs/compatibility.md), and [changelog](CHANGELOG.md) for evidence and constraints.

## Optional self-host with Docker

Prerequisite: Docker Engine or Docker Desktop with Compose v2.

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml ps
```

Open RocketX at <http://localhost:8080>. The reproducible local stack creates the development account `admin` / `rcxdev123`; change all credentials before exposing it outside localhost. Rocket.Chat remains available directly at <http://localhost:3300> for administration and official-client interoperability.

The Compose file pins Rocket.Chat, MongoDB, Node, pnpm, and Nginx versions. It is a local or evaluation baseline, not a production TLS or backup configuration. See [compatibility and upgrades](docs/compatibility.md) before changing the Rocket.Chat image.

To stop the stack without deleting MongoDB data:

```bash
docker compose -f docker/docker-compose.yml down
```

## Develop locally

Prerequisites: Node.js 22 and pnpm 11.12.0. Docker is only needed when using the bundled Rocket.Chat self-host stack. Rust stable plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) are required for desktop work, and Codex features require the compatible Codex CLI on `PATH`.

```bash
corepack enable
pnpm install --frozen-lockfile
# Optional: start the bundled Rocket.Chat development server.
docker compose -f docker/docker-compose.yml up -d
pnpm dev
```

Open <http://localhost:5173>. Vite proxies Rocket.Chat requests to <http://localhost:3300> by default; set `RC_URL` when starting Vite to use another development server.

Desktop development:

```bash
pnpm --filter @rcx/desktop dev
```

After signing in, open **Butler** to search messages and work data, query Azure DevOps work items, pull requests, and builds, prepare work-item drafts, or run recurring reviews. On desktop, Butler can use a local Codex CLI as its brain, and Butler or shared-agent conversations can open a new Codex App chat with the workspace and full context prefilled for the user to confirm and send. Butler and AI Hosting have independent Codex model and reasoning-effort settings under **Settings → AI**. Images referenced by an `@ai` request in a hosted conversation are downloaded into an isolated session cache and passed to Codex as image input. Every write still requires confirmation in the existing creation dialog. DeepSeek and other providers remain optional; API keys stay in the operating-system credential store.

## Verify changes

```bash
pnpm typecheck
pnpm test:pure
pnpm test:regression
pnpm test:ui
pnpm test:ecosystem
pnpm smoke
pnpm test:classify
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

`pnpm test:ui` runs the automated browser flows. `pnpm smoke` and `pnpm test:classify` use a real Rocket.Chat server; the smoke suite performs writes and restores its test data when it finishes. UI changes still require an interaction pass when the automated flows do not cover the affected surface.

## Build applications

RocketX applications run behind a manifest, permission gate, and JSON-RPC bridge. Start with the [application development guide](docs/app-development.md) and the examples under `examples/`. Do not grant an application a capability that it does not need.

## Security and compatibility

- RocketX uses public `/api/v1/*` and `/websocket` interfaces and does not patch the Rocket.Chat server.
- Rocket.Chat `8.6.1` is the pinned, fully tested server in the repository. Other versions are not implied by that result.
- IP Messenger compatibility mode is unauthenticated legacy interoperability and is disabled by default; its optional IPv4 discovery ranges target both Intranet Link port 9011 and IP Messenger port 2425, separately from the authenticated RocketX LAN channel.
- Secrets for native integrations are expected to stay in the operating-system credential store.

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Third-party licenses are summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md), keep changes narrowly scoped, and include verification evidence. The project is licensed under the [MIT License](LICENSE).
