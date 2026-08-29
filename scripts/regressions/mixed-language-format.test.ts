import assert from 'node:assert/strict';
import test from 'node:test';

test('中英文和数字相邻时补空格，但不重复已有空格', async () => {
  const { formatMixedLanguageText } = await import('../../apps/web/src/lib/mixedLanguageFormat');
  assert.equal(formatMixedLanguageText('你好World'), '你好 World');
  assert.equal(formatMixedLanguageText('Hello世界'), 'Hello 世界');
  assert.equal(formatMixedLanguageText('版本v1.2发布'), '版本 v1.2 发布');
  assert.equal(formatMixedLanguageText('你好 World 123 世界'), '你好 World 123 世界');
});

test('不改变 URL、代码块和行内代码内容', async () => {
  const { formatMixedLanguageText } = await import('../../apps/web/src/lib/mixedLanguageFormat');
  const text = '链接https://example.com/a?x=中文，代码`const value="世界"`，\n```ts\nconst 世界 = "Hello";\n```';
  assert.equal(
    formatMixedLanguageText(text),
    '链接 https://example.com/a?x=中文，代码`const value="世界"`，\n```ts\nconst 世界 = "Hello";\n```',
  );
});

test('只处理汉字与英文或数字的直接边界，不影响标点', async () => {
  const { formatMixedLanguageText } = await import('../../apps/web/src/lib/mixedLanguageFormat');
  assert.equal(formatMixedLanguageText('你好，World！Hello。世界'), '你好，World！Hello。世界');
  assert.equal(formatMixedLanguageText('你好-world'), '你好-world');
  assert.equal(formatMixedLanguageText('中文\nEnglish'), '中文\nEnglish');
});
