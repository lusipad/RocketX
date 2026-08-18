# RocketX

[简体中文](README.md)

RocketX is an independent team collaboration client built on the public Rocket.Chat REST and realtime APIs. It keeps the Rocket.Chat server unchanged while adding a focused desktop and web experience for messaging, GTD-style inbox processing, a startup-selected local AI runtime, shared agent hosting, and LAN continuity.

> RocketX is an independent project and is not affiliated with or endorsed by Rocket.Chat Technologies Corp. A feature described in this repository is not necessarily a published release; use the tags and [GitHub Releases](https://github.com/lusipad/RocketX/releases) as the publication record.

```text
┌──────────────────────────────────────────┐
│ RocketX Web / Desktop                    │
│ Messages · Butler · Tasks · Calendar · Workbench │
└──────────────┬───────────────────────────┘
               │ public REST + WebSocket APIs
        ┌──────▼──────┐       ┌──────────────────┐
        │ Rocket.Chat │◄──────│ event / LAN links│
        │ unchanged   │       │ ADO · LAN · IPMSG│
        └─────────────┘       └──────────────────┘
```

## What is RocketX

- **Team messaging** over your existing Rocket.Chat server, with a Lark-style three-pane layout, threads, reactions, mentions, file sharing, and discussion cards.
- **GTD-style work surfaces**: Inbox, Todos, Calendar, Contacts, and a Workbench that talks to Azure DevOps Server 2022.
- **Local AI runtime**: pick one startup AI backend — OpenAI Codex, DeepSeek Harness (DSH), or no AI. The choice is global, persists across restarts, and never runs two backends at once.
- **Shared agent hosting** in rooms and discussions, backed by the same startup runtime. Web and no-AI clients can view an active host and use `@ai`; only a desktop client with the matching runtime can start or resume one.
- **LAN continuity** through authenticated peer links and an optional IPMSG/Intranet Link Sidecar plugin on Windows.

Current behavior is defined by the [functional specifications](docs/specs/README.md). Product choices follow the [product principles](docs/specs/product-principles.md); the [vision](docs/vision.md) and [blueprint](docs/blueprint.md) are directional and historical context, not current delivery commitments. See [architecture notes](docs/architecture.md), [compatibility matrix](docs/compatibility.md), and [CHANGELOG.md](CHANGELOG.md) for supporting context and release history.

## Quick start

Prerequisites: Node.js **22.19+** and **pnpm 11.12.0**. Docker is only needed for the bundled Rocket.Chat development stack. Rust stable plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) are required for desktop work.

```bash
# 1. Install dependencies
corepack enable
pnpm install --frozen-lockfile

# 2. (Optional) start the bundled Rocket.Chat development server.
docker compose -f docker/docker-compose.yml up -d

# 3. Start the web client.
pnpm dev
```

Open <http://127.0.0.1:1420>. Vite proxies Rocket.Chat requests to <http://localhost:3300> by default; set `RC_URL` when starting Vite to use another development server.

Desktop development:

```bash
pnpm --filter @rcx/desktop dev
```

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/web` | React + Vite web client shared by the web deployment and the desktop shell. |
| `apps/desktop` | Tauri 2 desktop shell, native integrations, and Rust sidecar hosting. |
| `apps/dsh-runtime` | Private, exactly pinned DeepSeek Harness runtime package used by Windows full builds and release validation. |
| `packages/rc-client` | Dependency-free Rocket.Chat REST and realtime client. |
| `packages/app-sdk` | Public `@lusipad/rocketx` JSON-RPC bridge and application manifest contract. |
| `packages/create-rcx-app` | Application scaffolding, validation, and local preview CLI. |
| `services/ado-bridge` | Optional Azure DevOps Server 2022 event bridge. |
| `examples/` | RocketX application examples (`hello`, `kanban`, `poll`, `oncall`). |
| `docker/` | Reproducible RocketX Web, Rocket.Chat, and MongoDB stack. |
| `docs/` | Functional specs, architecture decisions, and release evidence. |

## Development

On a new desktop installation, RocketX first explains its GTD flow — how it captures work, clarifies the next action, and protects attention — before opening team or personal setup.

### Join a team

**Join a team** imports a non-secret `rcx.workspace.json` from:

- a local file,
- a UNC share,
- an anonymously reachable HTTP(S) / Git Raw URL, or
- an Azure DevOps Git file link that reuses the current PAT or Windows identity.

The file supplies defaults for Rocket.Chat, Azure DevOps, work-item templates, hierarchy layout, and update source. Credentials are never stored in the workspace file or source record. URL- and ADO-based team configuration checks for changes every 24 hours and asks before applying them. Start from the [workspace configuration example](docs/examples/rcx.workspace.sample.json); field and security rules are in the [configuration guide](docs/proposal-config-provisioning.md).

### AI runtime selection

In **Settings → AI** you choose exactly one startup AI runtime: **Codex**, **DSH**, or **no AI**. The choice is saved and takes effect after restart. The same runtime is used for Butler local execution, private room AI, starting or resuming AI hosting, `/ai`, and message handoff.

- **Codex** requires a compatible, signed-in local Codex runtime discoverable on `PATH`, in a standard installation location, or through RocketX's manual runtime path setting. It reuses native threads, models, permissions, Skills, Plugins, Apps, local Memory, and Codex-only routines / runtime probes through `app-server`.
- **DSH** requires a RocketX-verified system DSH in slim installations, or the private DSH and Node runtimes supplied by the Windows full installer. It opens the official DSH Web inside Butler; RocketX owns the desktop shell, the controller/host path for room sidebar AI and hosting, and the process lifecycle. The official DSH Web remains the source of truth for model, Agent, permission, approval, question, and credential configuration.
- **No AI** starts no local executor. Butler and existing shared-hosting records remain visible, and room members can still use `@ai` with an active host on another device, while local start, resume, and execution actions stay disabled.

Slim installers probe compatible system Codex and DSH runtimes without bundling either. The Windows full installer additionally supplies exactly pinned private Codex, DSH, Node, and OCR resources. Scheduled tasks remain Codex-backed, device-local, and execute only while RocketX is running. See the [capability matrix](docs/specs/capability-matrix.md) for exact platform and degradation behavior.

### Optional self-host with Docker

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

## Testing

```bash
pnpm typecheck        # Type-check the whole workspace.
pnpm test:pure        # 237+ pure-function tests (pinyin, dates, grouping, todos, markdown, calendar, ADO, slash commands, ...).
pnpm test:regression  # 736+ regression tests covering search concurrency, ADO, Butler/Codex, workspace config, update source, shared agent, and LAN/outbox.
pnpm test:ui          # 83+ browser flows: login, messaging, Butler, first-run, AI settings, and plugin bridge.
pnpm test:ecosystem   # SDK, CLI clean-room scaffolding, and official examples.
pnpm smoke            # 54 integration tests against a real Rocket.Chat server (writes data and restores it afterwards).
pnpm test:classify    # 5 integration tests against a real Rocket.Chat server for conversation classification and sorting.
```

`pnpm smoke` and `pnpm test:classify` need a real Rocket.Chat server. By default they use `http://localhost:3300` with `admin` / `rcxdev123`; set `RC_BASE_URL` to target another server.

Desktop Rust tests:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

UI changes still require an interaction pass when the automated flows do not cover the affected surface.

## Desktop client and releases

The current release target is **v0.43.5**. `v0.34.5` restored official Windows x64, macOS universal, and Linux x64 desktop releases. Starting with `v0.35.0`, the protected workflow publishes verified three-platform releases as GitHub Latest.

- **Release candidate**: push `release/vX.Y.Z` at a verified `main` commit → the `Tag Version` workflow creates the tag and the `Desktop Build` workflow produces a draft Release.
- **Prepare Release**: after `build` succeeds, this job packages plugins, verifies artifacts, generates `SHA256SUMS.txt`, and writes release notes from `CHANGELOG.md`.
- **Publish GitHub Release**: a protected workflow that rechecks artifacts and checksums, publishes the Release as Latest, and asserts the latest tag.
- **Publish npm packages** (optional): a protected workflow that publishes `@lusipad/rocketx` then `create-rcx-app`; npm delivery does not block the desktop Release.
- **Manual build**: run the `Desktop Build` workflow from the Actions tab and download artifacts.

The macOS bundle uses Tauri's supported ad-hoc signing identity because this repository does not yet have Apple Developer signing and notarization credentials. The DMG is not Apple-notarized and may require manual approval in macOS Privacy & Security.

Full release evidence and irreversible steps are documented in [`docs/release/README.md`](docs/release/README.md).

## Build applications

RocketX applications run behind a manifest, permission gate, and JSON-RPC bridge. Start with the [application development guide](docs/app-development.md) and the examples under `examples/`. Do not grant an application a capability that it does not need.

## Security and compatibility

- RocketX uses public `/api/v1/*` and `/websocket` interfaces and does not patch the Rocket.Chat server.
- Rocket.Chat **8.6.1** is the pinned, fully tested server in the repository. Other versions are not implied by that result. See [docs/compatibility.md](docs/compatibility.md) for the verified version matrix.
- The optional Windows "Feiq / IPMSG" plugin owns its protocol Sidecar and uses UDP/TCP 2425. Standard IPMSG supports messages and ordinary files; original Intranet Link peers are limited to `1@shiyeline` discovery and text on 2425. Private port 9011 is not implemented, and legacy peers never inherit RocketX LAN trust.
- Secrets for native integrations stay in their documented local secret boundary. RocketX uses the operating-system credential store where its native integration supports it; DSH `0.1.0-rc.6` instead owns a private `DSH_HOME/.credentials.yaml`, and the official DSH Web flow keeps the secret in that local store rather than echoing it back to RocketX.

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Third-party licenses are summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md), keep changes narrowly scoped, and include verification evidence. The project is licensed under the [MIT License](LICENSE).
