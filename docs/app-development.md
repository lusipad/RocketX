# RocketX application development

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

The available templates are `hello`, `kanban`, `poll`, and `oncall`. The development server binds to `127.0.0.1`, defaults to port `4174`, supplies a mock Bridge for preview, and reloads after source changes. It does not replace validation inside the real RocketX sandbox.

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
- `version` is SemVer.
- `iframe` and `worker` entries are strings; directory iframe applications use a local HTML entry.
- Unknown and duplicate permissions are rejected.
- `net:fetch` requires an explicit `netAllow` list of HTTP(S) origins.
- A remote entry cannot request `agent:spawn` or `process:spawn`.
- Unknown extension points are rejected.

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
  "permissions": ["native:service"]
}
```

This is not a sideloading API. `native:service` is accepted only for applications bundled into a signed RocketX desktop build. Commands are resolved from the bundled plugin resource directory, never from `PATH`; directory and URL installations are rejected. The iframe calls the generic `native.call` capability and receives Sidecar events as `native.event` Bridge events.

Use `parseManifest` or `parseManifestJson` from `@lusipad/rocketx` when tooling needs to read a manifest. Do not copy the permission or extension-point lists into another parser.

## Bridge API

For TypeScript applications, import `createBridgeClient` from `@lusipad/rocketx` after the package is installed or linked:

```ts
import { createBridgeClient } from '@lusipad/rocketx';

const bridge = createBridgeClient();

const current = await bridge.call<{ rid: string | null }>('chat.current');
await bridge.requestUI('notify', {
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
| `storage.get/set/delete/list` | `storage:local` | Storage is scoped to the application and signed-in account. |
| `net.fetch` | `net:fetch` | Only origins declared by `netAllow`; credential headers are stripped. |
| `ui.notify` | `ui:notify` | Notification text is bounded by the host. |
| `files.pick` | `files:read` | Desktop file picker; returns one user-selected local path. |
| `native.call` | `native:service` | Signed bundled Sidecar only; bounded JSON-RPC over stdio. |

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
- Entry paths are relative and remain inside the application directory.
- Network origins are exact, HTTPS where applicable, and minimal.
- The application handles Bridge rejection and timeout without losing user data.
- Local preview and real RocketX sandbox behavior have both been tested.
- The application includes its own license and third-party notices.
