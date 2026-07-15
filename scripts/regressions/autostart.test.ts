import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readAutostartEnabled,
  updateAutostartEnabled,
} from '../../apps/web/src/lib/autostart';

test('Web 端不读取或修改操作系统开机自启', async () => {
  assert.equal(await readAutostartEnabled(), null);
  await assert.rejects(updateAutostartEnabled(true), /仅桌面端可用/);
});
