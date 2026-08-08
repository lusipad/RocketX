import { RotateCcw, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  parseButlerMemoryState,
  type ButlerMemoryRecord,
} from '../lib/butlerMemory';
import {
  DEFAULT_BUTLER_IDENTITY,
  type ButlerDetail,
  type ButlerIdentity,
  type ButlerInitiative,
  type ButlerWarmth,
} from '../lib/butlerIdentity';
import {
  listSkills,
  readButlerActiveMemoryV2RawJson,
} from '../lib/butlerProfile';
import { useButlerIdentity } from '../stores/butlerIdentity';
import { toast } from '../stores/toast';
import ButlerAuditTrail from './ButlerAuditTrail';
import ButlerAvatar, { BUTLER_AVATAR_OPTIONS } from './ButlerAvatar';
import ButlerLearnedPanel from './ButlerLearnedPanel';
import {
  ButlerAnalysisPanel,
  ButlerProfilePanel,
} from './ButlerLearningPanel';

type IdentityTab = 'settings' | 'profile' | 'analysis' | 'memory' | 'audit';

const IDENTITY_TABS: Array<{ id: IdentityTab; label: string; shortLabel: string }> = [
  { id: 'settings', label: '相处设定', shortLabel: '设定' },
  { id: 'profile', label: '了解你', shortLabel: '了解' },
  { id: 'analysis', label: '分析与改进', shortLabel: '分析' },
  { id: 'memory', label: '技能中心', shortLabel: '技能' },
  { id: 'audit', label: '最近动作', shortLabel: '动作' },
];

const WARMTH_OPTIONS: Array<{ value: ButlerWarmth; label: string; hint: string }> = [
  { value: 'warm', label: '温和', hint: '有共情，但不说空话' },
  { value: 'balanced', label: '自然', hint: '根据事情调整语气' },
  { value: 'direct', label: '直接', hint: '坦率，不绕弯子' },
];

const INITIATIVE_OPTIONS: Array<{ value: ButlerInitiative; label: string; hint: string }> = [
  { value: 'restrained', label: '安静', hint: '只在被问或明确有风险时开口' },
  { value: 'balanced', label: '适度', hint: '重要变化主动提醒' },
  { value: 'proactive', label: '主动', hint: '主动发现机会与未闭环责任' },
];

const DETAIL_OPTIONS: Array<{ value: ButlerDetail; label: string; hint: string }> = [
  { value: 'concise', label: '简洁', hint: '先给结论，再按需展开' },
  { value: 'balanced', label: '平衡', hint: '结论和必要依据并重' },
  { value: 'thorough', label: '详尽', hint: '完整说明背景、依据与边界' },
];

function activeMemories(): ButlerMemoryRecord[] {
  return parseButlerMemoryState(readButlerActiveMemoryV2RawJson() ?? '')
    .records
    .filter((record) => record.status === 'active');
}

function ChoiceRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; hint: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="butler-identity-choice-row" role="group" aria-label={label}>
      <span className="butler-identity-choice-label">{label}</span>
      <div>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            <small>{option.hint}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ButlerIdentityPage({
  initialTab = 'settings',
}: {
  initialTab?: IdentityTab;
}) {
  const identity = useButlerIdentity((state) => state.identity);
  const saveIdentity = useButlerIdentity((state) => state.save);
  const resetIdentity = useButlerIdentity((state) => state.reset);
  const [draft, setDraft] = useState<ButlerIdentity>(identity);
  const [activeTab, setActiveTab] = useState<IdentityTab>(initialTab);
  const memoryCount = activeMemories().length;
  const skillCount = listSkills().length;

  useEffect(() => {
    setDraft(identity);
  }, [identity]);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(identity),
    [draft, identity],
  );

  const patchDraft = <K extends keyof ButlerIdentity>(
    key: K,
    value: ButlerIdentity[K],
  ): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = (): void => {
    saveIdentity(draft);
    toast.success(`已保存 ${draft.displayName} 的设定`);
  };

  const reset = (): void => {
    resetIdentity();
    setDraft(DEFAULT_BUTLER_IDENTITY);
    toast.success('已恢复默认管家设定');
  };

  return (
    <section aria-label="我的管家" className="butler-identity-page">
      <header className="butler-identity-hero">
        <ButlerAvatar avatar={identity.avatar} name={identity.displayName} />
        <div className="min-w-0 flex-1">
          <span className="butler-eyebrow">我的管家</span>
          <h1>{identity.displayName}</h1>
          <p>{identity.role}</p>
          <div className="butler-identity-presence">
            <span aria-hidden="true" />
            正在持续工作
          </div>
        </div>
      </header>

      <div className="butler-identity-tabs" role="tablist" aria-label="我的管家分类">
        {IDENTITY_TABS.map((tab) => (
          <button
            key={tab.id}
            id={`butler-identity-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-label={tab.label}
            aria-selected={activeTab === tab.id}
            aria-controls="butler-identity-panel"
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="butler-identity-tab-label">{tab.label}</span>
            <span className="butler-identity-tab-label-short" aria-hidden="true">
              {tab.shortLabel}
            </span>
            {tab.id === 'memory' ? (
              <b aria-hidden="true">{memoryCount + skillCount}</b>
            ) : null}
          </button>
        ))}
      </div>

      <div
        id="butler-identity-panel"
        className="butler-identity-panel"
        role="tabpanel"
        aria-labelledby={`butler-identity-tab-${activeTab}`}
      >
      {activeTab === 'settings' ? (
        <section aria-labelledby="butler-identity-settings-title" className="butler-identity-settings">
        <div className="butler-section-heading">
          <div>
            <h2 id="butler-identity-settings-title">相处设定</h2>
            <p>保存后，管家会按这些方式与你交流和主动工作。</p>
          </div>
        </div>

        <div className="butler-identity-basics">
          <label>
            <span>名字</span>
            <input
              value={draft.displayName}
              maxLength={24}
              onChange={(event) => patchDraft('displayName', event.target.value)}
              aria-label="管家名字"
            />
          </label>
          <label>
            <span>你们的关系</span>
            <input
              value={draft.role}
              maxLength={48}
              onChange={(event) => patchDraft('role', event.target.value)}
              aria-label="管家角色"
            />
          </label>
        </div>

        <fieldset className="butler-identity-avatars">
          <legend>头像</legend>
          <div>
            {BUTLER_AVATAR_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-label={`选择${option.label}头像`}
                aria-pressed={draft.avatar === option.id}
                onClick={() => patchDraft('avatar', option.id)}
              >
                <ButlerAvatar avatar={option.id} name={draft.displayName || '管家'} />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="butler-identity-choices">
          <ChoiceRow
            label="相处语气"
            value={draft.warmth}
            options={WARMTH_OPTIONS}
            onChange={(value) => patchDraft('warmth', value)}
          />
          <ChoiceRow
            label="主动程度"
            value={draft.initiative}
            options={INITIATIVE_OPTIONS}
            onChange={(value) => patchDraft('initiative', value)}
          />
          <ChoiceRow
            label="表达详略"
            value={draft.detail}
            options={DETAIL_OPTIONS}
            onChange={(value) => patchDraft('detail', value)}
          />
        </div>

        <label className="butler-identity-traits">
          <span>还有什么希望它一直记得</span>
          <textarea
            value={draft.traits}
            maxLength={240}
            rows={3}
            onChange={(event) => patchDraft('traits', event.target.value)}
            aria-label="管家性格补充"
          />
          <small>{draft.traits.length}/240</small>
        </label>

        <div className="butler-identity-actions">
          <button type="button" onClick={reset} className="butler-identity-reset">
            <RotateCcw size={14} aria-hidden="true" />
            恢复默认
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || !draft.displayName.trim() || !draft.role.trim()}
            className="butler-identity-save"
          >
            <Save size={14} aria-hidden="true" />
            保存设定
          </button>
        </div>
        </section>
      ) : null}
      {activeTab === 'profile' ? <ButlerProfilePanel /> : null}
      {activeTab === 'analysis' ? <ButlerAnalysisPanel /> : null}
      {activeTab === 'memory' ? <ButlerLearnedPanel /> : null}
      {activeTab === 'audit' ? <ButlerAuditTrail /> : null}
      </div>
    </section>
  );
}
