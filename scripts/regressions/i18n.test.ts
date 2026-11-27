import assert from 'node:assert/strict';
import test from 'node:test';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import {
  LOCALE_STORAGE_KEY,
  buildUiLanguageInstruction,
  getLocale,
  loadLocalePreference,
  normalizeLocalePreference,
  resolveLocale,
  resolveSystemLocale,
  saveLocalePreference,
  setLocalePreference,
  t,
  tp,
} from '../../apps/web/src/i18n';
import { fmtConvTime, fmtDayDivider, systemMessageText } from '../../apps/web/src/lib/format';
import { formatTrayTooltip } from '../../apps/web/src/lib/tray';
import { humanError } from '../../apps/web/src/stores/toast';
import { COMMAND_INFO, clientCommandList } from '../../apps/web/src/lib/clientCommands';
import { ACP_PRESET_TEMPLATES } from '../../apps/web/src/stores/acpAgents';
import { localVoiceError, selectLocalVoiceEngine } from '../../apps/web/src/lib/localVoiceAudio';
import { buildAgentDeveloperInstructions } from '../../apps/web/src/agent/context';

const CJK_RE = /[\u4e00-\u9fff]/;

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
    .map((m) => m[1])
    .sort();
}

test('i18n catalogs have 1:1 key parity, non-empty strings, matching placeholders, and no stray CJK in en-US', () => {
  const zhKeys = Object.keys(zhCN).sort();
  const enKeys = Object.keys(enUS).sort();

  assert.deepEqual(enKeys, zhKeys, 'zh-CN and en-US must share the exact same key set');
  assert.ok(zhKeys.length > 2000, `expected full catalog coverage, got ${zhKeys.length} keys`);

  for (const key of zhKeys as Array<keyof typeof zhCN>) {
    const zhVal = zhCN[key];
    const enVal = enUS[key];
    assert.ok(zhVal.trim().length > 0, `zh-CN key "${key}" must not be empty`);
    assert.ok(enVal.trim().length > 0, `en-US key "${key}" must not be empty`);
    assert.deepEqual(
      placeholdersOf(enVal),
      placeholdersOf(zhVal),
      `placeholder mismatch for key "${key}"`,
    );
    if (key !== 'locale.zhCN') {
      assert.equal(
        CJK_RE.test(enVal),
        false,
        `en-US key "${key}" contains unexpected CJK text: ${enVal}`,
      );
    }
  }
});

test('locale preference normalization, system resolution, and storage persistence handle invalid/throwing inputs', () => {
  assert.equal(normalizeLocalePreference('zh-CN'), 'zh-CN');
  assert.equal(normalizeLocalePreference('en-US'), 'en-US');
  assert.equal(normalizeLocalePreference('system'), 'system');
  assert.equal(normalizeLocalePreference('fr-FR'), 'system');
  assert.equal(normalizeLocalePreference(null), 'system');

  assert.equal(resolveSystemLocale(['zh-CN', 'en-US']), 'zh-CN');
  assert.equal(resolveSystemLocale(['zh-TW']), 'zh-CN');
  assert.equal(resolveSystemLocale(['zh']), 'zh-CN');
  assert.equal(resolveSystemLocale(['en-US', 'zh-CN']), 'en-US');
  assert.equal(resolveSystemLocale(['en-GB']), 'en-US');
  assert.equal(resolveSystemLocale(['ja-JP']), 'en-US');
  assert.equal(resolveSystemLocale(['fr-FR']), 'en-US');
  assert.equal(resolveSystemLocale([]), 'en-US');

  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveLocale('en-US', ['zh-CN']), 'en-US');
  assert.equal(resolveLocale('system', ['zh-HK']), 'zh-CN');
  assert.equal(resolveLocale('system', ['en-US']), 'en-US');

  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
  saveLocalePreference('en-US', mockStorage);
  assert.equal(store.get(LOCALE_STORAGE_KEY), 'en-US');
  assert.equal(loadLocalePreference(mockStorage), 'en-US');

  const throwingStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  assert.equal(loadLocalePreference(throwingStorage), 'system');
  assert.doesNotThrow(() => saveLocalePreference('zh-CN', throwingStorage));
});

test('tp pluralizes English singular/plural cleanly while preserving zh-CN format', () => {
  assert.equal(tp(1, 'pages.todos.countOne', 'pages.todos.countOther', undefined, 'en-US'), '1 item');
  assert.equal(tp(3, 'pages.todos.countOne', 'pages.todos.countOther', undefined, 'en-US'), '3 items');
  assert.equal(tp(1, 'pages.todos.countOne', 'pages.todos.countOther', undefined, 'zh-CN'), '1 项');
  assert.equal(tp(3, 'pages.todos.countOne', 'pages.todos.countOther', undefined, 'zh-CN'), '3 项');
});

test('runtime helpers react dynamically when switching between zh-CN and en-US', () => {
  const previous = getLocale();
  try {
    const now = Date.now();
    const yesterday = now - 24 * 60 * 60 * 1000;

    setLocalePreference('zh-CN');
    assert.equal(getLocale(), 'zh-CN');
    assert.equal(fmtDayDivider(now), '今天');
    assert.equal(fmtConvTime(yesterday), '昨天');
    assert.equal(systemMessageText('uj', 'Alice', ''), 'Alice 加入了会话');
    assert.match(formatTrayTooltip([{ name: '项目群', unread: 3, alert: false, muted: false }]), /3 条未读/);
    assert.equal(humanError(new Error('Failed to fetch')), zhCN['nav.error.network']);
    assert.equal(COMMAND_INFO.shrug.desc, zhCN['chat.command.shrug.desc']);
    assert.ok(clientCommandList().some((c) => c.command === 'shrug' && c.description === zhCN['chat.command.shrug.desc']));
    assert.equal(ACP_PRESET_TEMPLATES[0].transportLabel, zhCN['agent.acpPreset.transport.bridge']);
    assert.match(buildUiLanguageInstruction(), /简体中文/);
    assert.match(buildAgentDeveloperInstructions({ workItem: { id: 42, title: 'Fix' } }), /简体中文/);

    setLocalePreference('en-US');
    assert.equal(getLocale(), 'en-US');
    assert.equal(fmtDayDivider(now), 'Today');
    assert.equal(fmtConvTime(yesterday), 'Yesterday');
    assert.equal(systemMessageText('uj', 'Alice', ''), 'Alice joined the conversation');
    assert.match(formatTrayTooltip([{ name: 'Alpha', unread: 3, alert: false, muted: false }]), /3 unread/);
    assert.equal(humanError(new Error('Failed to fetch')), enUS['nav.error.network']);
    assert.equal(COMMAND_INFO.shrug.desc, enUS['chat.command.shrug.desc']);
    assert.ok(clientCommandList().some((c) => c.command === 'shrug' && c.description === enUS['chat.command.shrug.desc']));
    assert.equal(ACP_PRESET_TEMPLATES[0].transportLabel, enUS['agent.acpPreset.transport.bridge']);
    assert.match(buildUiLanguageInstruction(), /English/);
    assert.match(buildAgentDeveloperInstructions({ workItem: { id: 42, title: 'Fix' } }), /English/);
    assert.equal(t('common.save'), 'Save');
  } finally {
    setLocalePreference(previous === 'en-US' ? 'en-US' : 'system');
  }
});

test('local voice engine selection and error localization match active locale with safe fallback', () => {
  const engines = [
    { id: 'zh', language: 'zh-CN', name: 'Chinese' },
    { id: 'en', language: 'en-US', name: 'English' },
  ];
  assert.equal(selectLocalVoiceEngine(engines, 'zh-CN')?.id, 'zh');
  assert.equal(selectLocalVoiceEngine(engines, 'en-US')?.id, 'en');
  assert.equal(selectLocalVoiceEngine([{ id: 'en-gb', language: 'en-GB', name: 'UK' }], 'en-US')?.id, 'en-gb');
  assert.equal(selectLocalVoiceEngine([{ id: 'zh', language: 'zh-CN', name: 'ZH' }], 'en-US')?.id, 'zh');
  assert.equal(selectLocalVoiceEngine([], 'en-US'), undefined);

  const previous = getLocale();
  try {
    setLocalePreference('zh-CN');
    assert.equal(localVoiceError(new Error('LOCAL_VOICE_BUSY: busy')), zhCN['voice.error.busy']);
    assert.match(localVoiceError(new DOMException('denied', 'NotAllowedError')), /麦克风/);

    setLocalePreference('en-US');
    assert.equal(localVoiceError(new Error('LOCAL_VOICE_BUSY: busy')), enUS['voice.error.busy']);
    assert.match(localVoiceError(new DOMException('denied', 'NotAllowedError')), /Microphone permission/);
  } finally {
    setLocalePreference(previous === 'en-US' ? 'en-US' : 'system');
  }
});
