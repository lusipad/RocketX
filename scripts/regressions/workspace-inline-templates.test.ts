import assert from 'node:assert/strict';
import test from 'node:test';
import { useWiTemplates } from '../../apps/web/src/stores/wiTemplates';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});

test('内联工作项模板替换远程 URL 并持久化到现有模板缓存（issue #154）', () => {
  values.set('rcx-wi-template-url', 'https://git.example.com/templates.json');
  const inline = {
    defaultProject: 'Alpha',
    templates: [{ name: '单个工作项', items: [{ type: '{type}', title: '{title}' }] }],
  };

  useWiTemplates.getState().setInline(inline);

  const state = useWiTemplates.getState();
  assert.equal(state.url, '');
  assert.deepEqual(state.remote, inline);
  assert.deepEqual(state.templates, inline.templates);
  assert.equal(state.defaultProject, 'Alpha');
  assert.equal(values.has('rcx-wi-template-url'), false);
  assert.deepEqual(JSON.parse(values.get('rcx-wi-template-cache') ?? ''), inline);
});
