export const UI_SCALE_OPTIONS = [80, 90, 100, 110, 125, 150] as const;

export type UiScale = (typeof UI_SCALE_OPTIONS)[number];

const DEFAULT_UI_SCALE: UiScale = 100;

export function normalizeUiScale(value: unknown): UiScale {
  return UI_SCALE_OPTIONS.find((candidate) => candidate === value) ?? DEFAULT_UI_SCALE;
}

export function stepUiScale(current: unknown, direction: 'in' | 'out'): UiScale {
  const base = normalizeUiScale(current);
  const index = UI_SCALE_OPTIONS.indexOf(base);
  if (direction === 'in') {
    return UI_SCALE_OPTIONS[Math.min(index + 1, UI_SCALE_OPTIONS.length - 1)];
  }
  return UI_SCALE_OPTIONS[Math.max(index - 1, 0)];
}
