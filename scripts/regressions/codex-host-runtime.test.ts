import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

test('Codex sessions use the selected host workspace without an Agent Runner image', async () => {
  const [proc, localCodex, sharedAgent, tauri, ci, pkg] = await Promise.all([
    readFile(new URL('apps/desktop/src-tauri/src/proc.rs', root), 'utf8'),
    readFile(new URL('apps/web/src/stores/localCodex.ts', root), 'utf8'),
    readFile(new URL('apps/web/src/stores/sharedAgent.ts', root), 'utf8'),
    readFile(new URL('apps/desktop/src-tauri/tauri.conf.json', root), 'utf8'),
    readFile(new URL('.github/workflows/ci.yml', root), 'utf8'),
    readFile(new URL('package.json', root), 'utf8'),
  ]);

  assert.match(proc, /hidden_command\("codex"\)/);
  assert.match(proc, /args\(\["app-server", "--stdio"\]\)/);
  assert.match(proc, /current_dir\(&workspace\)/);
  assert.doesNotMatch(proc, /CODEX_RUNNER_IMAGE|hidden_command\("docker"\)/);
  assert.doesNotMatch(localCodex, /RUNNER_WORKSPACE|rocketx_(?:read|write)/);
  assert.doesNotMatch(sharedAgent, /RUNNER_WORKSPACE|rocketx_(?:read|write)/);
  assert.doesNotMatch(tauri, /agent-runner\/Dockerfile/);
  assert.doesNotMatch(ci, /agent:runner:test/);
  assert.doesNotMatch(pkg, /agent:runner:(?:build|test)/);
});
