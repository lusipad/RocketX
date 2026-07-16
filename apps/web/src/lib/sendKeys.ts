export type SendOnEnterMode = 'normal' | 'alternative' | 'desktop';

export function shouldSendMessage(
  mode: SendOnEnterMode,
  modifiers: {
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  },
): boolean {
  if (mode === 'alternative') return modifiers.ctrlKey || modifiers.metaKey;
  return !modifiers.altKey && !modifiers.ctrlKey && !modifiers.metaKey && !modifiers.shiftKey;
}

export function shouldInsertNewline(
  mode: SendOnEnterMode,
  modifiers: {
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  },
): boolean {
  return (
    mode !== 'alternative' &&
    modifiers.altKey &&
    !modifiers.ctrlKey &&
    !modifiers.metaKey &&
    !modifiers.shiftKey
  );
}
