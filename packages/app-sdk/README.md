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
  permissions: ['chat:read'],
});

const bridge = createBridgeClient();
const current = await bridge.call('chat.current');
console.log(manifest.id, current);
bridge.destroy();
```

See the [application development guide](https://github.com/lusipad/RocketX/blob/main/docs/app-development.md)
for capabilities, permissions, installation, and complete examples.
