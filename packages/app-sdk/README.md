# @lusipad/rocketx

Typed manifest validation and JSON-RPC Bridge access for RocketX applications.

```ts
import { createBridgeClient, parseManifest } from '@lusipad/rocketx';

const manifest = parseManifest({
  id: 'com.example.hello',
  version: '1.0.0',
  name: 'Hello',
  publisher: 'Example',
  runtime: 'iframe',
  entry: 'index.html',
  permissions: ['chat:read', 'app:info', 'config:read'],
  config: { env: ['ROCKETX_API_URL'] },
});

const bridge = createBridgeClient();
const current = await bridge.chat.current();
const apiUrl = await bridge.config.get('ROCKETX_API_URL');
console.log(manifest.id, current);
console.log(apiUrl.value);
bridge.destroy();
```

The typed client exposes the host capabilities as namespaces:

```ts
const info = await bridge.app.info();
const history = await bridge.chat.history({ rid: 'room-id', count: 20 });
await bridge.chat.postMessage({ rid: 'room-id', text: 'Hello' });
const rooms = await bridge.rooms.list();
const members = await bridge.users.read('room-id');
const files = await bridge.files.list({ rid: 'room-id' });
const file = await bridge.files.read(files[0].path!);
const picked = await bridge.files.pick();
const peers = await bridge.lan.listPeers();
const saved = await bridge.storage.get<{ enabled: boolean }>('settings');
await bridge.storage.set('settings', { enabled: true });
const response = await bridge.net.fetch({ url: 'https://api.example.com/health' });
await bridge.ui.notify({ message: '完成', level: 'success' });
```

`bridge.call()` remains available for capabilities added before the typed SDK surface.

See the [application development guide](https://github.com/lusipad/RocketX/blob/main/docs/app-development.md)
for capabilities, permissions, configuration, installation, and complete examples.
