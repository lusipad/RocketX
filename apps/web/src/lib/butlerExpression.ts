/**
 * 表达层：把规则引擎的结构化 alert 转换成受性格轴影响的最终呈现。
 *
 * 规则引擎（判断层）只产出事实："承诺到期"、"构建失败"。
 * 表达层根据四条轴决定：用什么措辞、给多少细节、语气是正式还是随意、视觉是醒目还是克制。
 */

import type { ButlerAlert, ButlerAlertLevel, AlertContext } from './butlerRules';
import { loadPersonality, type PersonalityAxes } from './butlerPersonality';

export interface StyledAlert {
  id: string;
  level: ButlerAlertLevel;
  kind: string;
  title: string;
  detail: string;
  /** 介入深度 ≥ 4 时附带的行动建议 */
  suggestion?: string;
  /** 催促感映射的视觉强度：'muted' | 'normal' | 'emphatic' */
  emphasis: 'muted' | 'normal' | 'emphatic';
}

// ─── 语气模板 ───

type ToneVariant = 'formal' | 'casual';

function toneKey(axes: PersonalityAxes): ToneVariant {
  return axes.tone >= 4 ? 'casual' : 'formal';
}

const TITLE_TEMPLATES: Record<string, Record<ToneVariant, (c: AlertContext) => string>> = {
  'commitment-overdue': {
    formal: (c) => c.subjectType === 'todo' ? `待办已逾期：${c.name}` : `承诺已逾期：${c.name}`,
    casual: (c) => `${c.name} 过期了，得处理下`,
  },
  'commitment-due': {
    formal: (c) => c.dueRelation === 'tomorrow'
      ? `承诺明天到期：${c.name}`
      : `承诺今天到期：${c.name}`,
    casual: (c) => c.dueRelation === 'tomorrow'
      ? `${c.name} 明天该交了`
      : `${c.name} 今天该交了`,
  },
  'iteration-pressure': {
    formal: (c) => `迭代${c.dueRelation === 'today' ? '今天' : '明天'}结束，${c.count} 项未完成`,
    casual: (c) => `迭代${c.dueRelation === 'today' ? '今天' : '明天'}就截止了，还剩 ${c.count} 项没搞定`,
  },
  'new-high-priority': {
    formal: (c) => `高优先级工作项：${c.name}`,
    casual: (c) => `来了个 P1：${c.name}`,
  },
  'build-failed': {
    formal: (c) => `构建失败：${c.name}`,
    casual: (c) => `构建挂了：${c.name}`,
  },
  'review-timeout': {
    formal: (c) => `PR 等待 review 超过 ${c.hours}h`,
    casual: (c) => `有个 PR 等你看了 ${c.hours} 小时了`,
  },
};

// ─── 行动建议（介入深度 ≥ 4 时附加） ───

const SUGGESTIONS: Record<string, string> = {
  'commitment-overdue': '考虑联系对方说明进度，或调整截止日期',
  'commitment-due': '安排优先处理，或提前沟通延期',
  'iteration-pressure': '检查哪些可以推迟到下个迭代，集中完成剩余项',
  'new-high-priority': '查看详情并评估影响范围，必要时调整当前工作安排',
  'build-failed': '查看构建日志定位失败原因',
  'review-timeout': '抽时间看一下，或回复告知预计时间',
};

// ─── 主函数 ───

export function expressAlerts(alerts: ButlerAlert[]): StyledAlert[] {
  const axes = loadPersonality();
  const tone = toneKey(axes);

  return alerts.map((alert) => {
    // 话量：低话量时压缩 detail
    let detail = alert.detail;
    if (axes.verbosity <= 2 && detail.length > 40) {
      detail = detail.slice(0, 38) + '…';
    }

    // 语气：优先使用结构化 ctx，无 ctx 时回退到原始 title
    const ctx = alert.ctx ?? { name: '' };
    const templateSet = TITLE_TEMPLATES[alert.kind];
    const title = (templateSet && ctx.name) ? templateSet[tone](ctx) : alert.title;

    // 介入深度：≥ 4 附带建议
    const suggestion = axes.depth >= 4 ? SUGGESTIONS[alert.kind] : undefined;

    // 催促感：映射视觉强度
    let emphasis: StyledAlert['emphasis'] = 'normal';
    if (axes.urgency <= 2) {
      emphasis = alert.level === 'immediate' ? 'normal' : 'muted';
    } else if (axes.urgency >= 4) {
      emphasis = alert.level === 'immediate' ? 'emphatic' : 'normal';
    }

    return { id: alert.id, level: alert.level, kind: alert.kind, title, detail, suggestion, emphasis };
  });
}

/** 咖啡时间的整体开场白（话量轴影响） */
export function coffeeGreeting(axes?: PersonalityAxes): string | null {
  const a = axes ?? loadPersonality();
  if (a.verbosity <= 1) return null;
  const tone = toneKey(a);
  if (tone === 'casual') return '坐下来看看今天有啥事。';
  return '以下是当前需要关注的事项。';
}
