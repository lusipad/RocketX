# RocketX application development

> Document status: **current application-development reference**. User-visible installation and platform availability are defined by the [Skills, Plugins, and Apps specification](specs/skills-and-plugins.md).

RocketX applications are static iframe or worker bundles described by `rcx.app.json`. The host validates the manifest, grants only declared permissions, and exposes capabilities through a JSON-RPC Bridge. An application must not depend on Tauri internals or RocketX private modules.

The package and CLI sources are in this repository. Do not assume they are available from npm until the npm registry confirms a published version.

## Create an application from this checkout

Prerequisites: Node.js 20 or newer and pnpm 11.12.0. The repository CI baseline uses Node.js 22.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @lusipad/rocketx build
pnpm --filter create-rcx-app build

node packages/create-rcx-app/dist/create-cli.js my-app --template hello
node packages/create-rcx-app/dist/rcx-cli.js validate my-app
node packages/create-rcx-app/dist/rcx-cli.js dev my-app
```

The available templates are `hello`, `kanban`, `poll`, and `oncall`. The development server binds to `127.0.0.1`, defaults to port `4174`, supplies a mock Bridge for preview, and reloads after source changes. It does not replace validation inside the real RocketX sandbox. The mock Bridge covers `app.info`, chat, rooms, users, files, LAN discovery, config reads, storage, deterministic `net.fetch`, and `ui.notify`; `native.call` remains unsupported because local preview cannot provide a signed native service.

To choose another local port:

```bash
node packages/create-rcx-app/dist/rcx-cli.js dev my-app --port 4180
```

## Manifest

A minimal iframe application uses this shape:

```json
{
  "id": "com.example.hello",
  "version": "1.0.0",
  "name": "Hello",
  "publisher": "Example",
  "runtime": "iframe",
  "entry": "index.html",
  "permissions": ["ui:notify"],
  "contributes": {
    "nav.module": [{ "id": "hello", "label": "Hello" }]
  }
}
```

Important rules enforced by `@lusipad/rocketx`:

- `id` uses reverse-domain form and lowercase letters, digits, dots, or hyphens.
- `version` is a SemVer subset: `MAJOR.MINOR.PATCH` with an optional pre-release suffix (`-...`); build metadata (`+...`) is not accepted.
- `iframe` and `worker` entries are strings; directory iframe applications use a local HTML entry.
- Unknown and duplicate permissions are rejected.
- `net:fetch` requires an explicit `netAllow` list of HTTP(S) origins.
- A remote entry cannot request `agent:spawn` or `process:spawn`.
- Unknown extension points are rejected.
- `config.env` declares ordinary host environment variables that the app may read with `bridge.config.get(name)`.
- `config.secrets` declares host environment variables that are explicitly injected into a signed bundled native service; they are never returned to iframe or worker code. Native services remain trusted components and retain the existing process-environment inheritance behavior.
- Environment names must be explicit POSIX-style names and are limited to 128 characters.

An app that reads ordinary host configuration declares the names and permission explicitly:

```json
{
  "permissions": ["config:read"],
  "config": {
    "env": ["ROCKETX_API_URL"]
  }
}
```

```ts
import { createBridgeClient } from '@lusipad/rocketx';

const bridge = createBridgeClient();
const apiUrl = await bridge.config.get('ROCKETX_API_URL');
```

An iframe can additionally declare a bundled native service:

```json
{
  "runtime": "iframe",
  "entry": "index.html",
  "service": {
    "runtime": "native",
    "command": "rcx-plugin-example",
    "platforms": ["windows"],
    "protocol": "jsonrpc-stdio"
  },
  "permissions": ["native:service", "secrets:use"],
  "config": {
    "secrets": ["ROCKETX_INTRANET_TOKEN"]
  }
}
```

This is not a sideloading API. `native:service` is accepted only for applications bundled into a signed RocketX desktop build. Commands are resolved from the bundled plugin resource directory, never from `PATH`; directory and URL installations are rejected. The iframe calls the generic `native.call` capability and receives Sidecar events as `native.event` Bridge events.
The service receives the declared `config.env` and `config.secrets` values from the desktop process environment. Missing variables are omitted. A web application cannot read `config.secrets`.

Use `parseManifest` or `parseManifestJson` from `@lusipad/rocketx` when tooling needs to read a manifest. Do not copy the permission or extension-point lists into another parser.

## Bridge API

For TypeScript applications, import `createBridgeClient` from `@lusipad/rocketx` after the package is installed or linked:

```ts
import { createBridgeClient } from '@lusipad/rocketx';

const bridge = createBridgeClient();

const current = await bridge.chat.current();
await bridge.ui.notify({
  message: current.rid ? `Current room: ${current.rid}` : 'No room selected',
  level: 'success',
});

const unsubscribe = bridge.on('app.activated', () => {
  // Refresh application state if needed.
});

// On application teardown:
unsubscribe();
bridge.destroy();
```

The host wraps calls as JSON-RPC and checks the manifest permission before invoking a capability. A permission declaration is necessary but not sufficient: the host can still reject an operation that targets an unjoined room, an unapproved origin, an oversized payload, or another protected resource.

Common capability mappings include:

| Capability | Required permission | Boundary |
| --- | --- | --- |
| `chat.current` | `chat:read` | Current room and a bounded recent-message view. |
| `chat.history` | `chat:history` | Joined rooms only; count is bounded. |
| `chat.postMessage` | `chat:write` | Joined rooms only; text length is bounded. |
| `rooms.list` | `rooms:list` | Joined subscriptions. |
| `users.read` | `users:read` | Members of the active room. |
| `app.info` | `app:info` | Current app's public metadata and granted permissions. |
| `files.list/read/pick` | `files:read` | Room files, bounded server file reads, and one desktop file picker result. |
| `lan.peers` | `lan:discover` | Redacted nearby-device discovery; no addresses or keys. |
| `storage.get/set/delete/list` | `storage:local` | Storage is scoped to the application and signed-in account. |
| `net.fetch` | `net:fetch` | Only origins declared by `netAllow`; credential headers are stripped. |
| `ui.notify` | `ui:notify` | Notification text is bounded by the host. |
| `app.config.get` | `config:read` | Reads one explicitly declared ordinary desktop environment variable; unavailable in browser builds. |
| `files.pick` | `files:read` | Desktop file picker; returns one user-selected local path. |
| `native.call` | `native:service` | Signed bundled Sidecar only; bounded JSON-RPC over stdio. |

The SDK also provides typed namespace helpers for these capabilities:

```ts
const info = await bridge.app.info();
const current = await bridge.chat.current();
const history = await bridge.chat.history({ rid: current.rid ?? undefined, count: 20 });
await bridge.chat.postMessage({ rid: current.rid ?? undefined, text: 'Hello' });
const rooms = await bridge.rooms.list();
const members = await bridge.users.read(current.rid ?? undefined);
const files = await bridge.files.list({ rid: current.rid ?? undefined });
const picked = await bridge.files.pick();
const peers = await bridge.lan.listPeers();
const value = await bridge.storage.get<{ enabled: boolean }>('settings');
await bridge.storage.set('settings', { enabled: true });
const response = await bridge.net.fetch({ url: 'https://api.example.com/health' });
await bridge.ui.notify({ message: '完成', level: 'success' });
```

Stable events are typed by the SDK: `app.activated`, `room.changed`, `message.received`,
`theme.changed`, and `native.event`. Custom event names remain available through `bridge.on(name, listener)`.
`app.info` never exposes the app entry path, configuration names, installation source, or other apps' metadata.

Treat the examples as executable references rather than a complete promise of every future capability.

## Install and test in RocketX

1. Run `rcx-app validate` (or the repository command above).
2. Open RocketX and sign in.
3. Open **Settings → Apps → Install local app**.
4. Select the directory containing `rcx.app.json` and its entry file.
5. Review requested permissions, grant only those required, and install.
6. Exercise every contribution and denied-permission path in the real host.

Worker applications are accepted only from local directories. URL installation requires the publisher-provided SHA-256 hash and remains subject to runtime and permission restrictions.

## Release checklist for an application

- `rcx-app validate` passes from a clean checkout or package extraction.
- The manifest requests no unused permission and contains no secret.
- Configuration names are explicit; secrets use `config.secrets` and never enter iframe/worker code.
- Entry paths are relative and remain inside the application directory.
- Network origins are exact, HTTPS where applicable, and minimal.
- The application handles Bridge rejection and timeout without losing user data.
- Local preview and real RocketX sandbox behavior have both been tested.
- The application includes its own license and third-party notices.
