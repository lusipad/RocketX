const KEY = 'rcx-butler-personality';

export interface PersonalityAxes {
  /** 话量：1=标记/红点，5=主动说一句话 */
  verbosity: number;
  /** 介入深度：1=只标记问题，5=标记+给出方案选项 */
  depth: number;
  /** 语气：1=正式克制，5=轻松随意 */
  tone: number;
  /** 催促感：1=纯信息陈列，5=带轻微紧迫感 */
  urgency: number;
}

export const AXIS_META: {
  key: keyof PersonalityAxes;
  label: string;
  low: string;
  high: string;
}[] = [
  { key: 'verbosity', label: '话量', low: '标记为主', high: '主动开口' },
  { key: 'depth', label: '介入深度', low: '只标记问题', high: '附带方案' },
  { key: 'tone', label: '语气', low: '正式克制', high: '轻松随意' },
  { key: 'urgency', label: '催促感', low: '信息陈列', high: '紧迫提示' },
];

export const DEFAULT_AXES: PersonalityAxes = {
  verbosity: 2,
  depth: 3,
  tone: 2,
  urgency: 2,
};

export function loadPersonality(): PersonalityAxes {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_AXES, ...(JSON.parse(raw) as Partial<PersonalityAxes>) } : DEFAULT_AXES;
  } catch {
    return DEFAULT_AXES;
  }
}

export function savePersonality(axes: PersonalityAxes): void {
  localStorage.setItem(KEY, JSON.stringify(axes));
}
