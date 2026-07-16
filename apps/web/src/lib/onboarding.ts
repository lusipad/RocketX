import type { WorkbenchConfig } from './ado';

export const ONBOARDING_VERSION = 1 as const;

export type OnboardingAdoState = 'configured' | 'skipped' | 'pending';
export type OnboardingChecklistKey =
  | 'startedConversation'
  | 'sentMessage'
  | 'notificationsEnabled';

export interface OnboardingStateV1 {
  version: typeof ONBOARDING_VERSION;
  ado: OnboardingAdoState;
  checklist: Record<OnboardingChecklistKey, boolean> & { dismissed: boolean };
}

export function defaultOnboardingState(
  existingWorkbench?: WorkbenchConfig | null,
): OnboardingStateV1 {
  const configured = !!(
    existingWorkbench &&
    (existingWorkbench.mode === 'direct' ? existingWorkbench.adoBase : existingWorkbench.bridge)
  );
  return {
    version: ONBOARDING_VERSION,
    ado: configured ? 'configured' : 'pending',
    checklist: {
      startedConversation: false,
      sentMessage: false,
      notificationsEnabled: false,
      dismissed: false,
    },
  };
}

export function onboardingStorageKey(server: string, userId: string): string {
  const normalizedServer = server.trim().replace(/\/+$/, '').toLocaleLowerCase() || 'same-origin';
  return `rcx-onboarding-v${ONBOARDING_VERSION}:${encodeURIComponent(normalizedServer)}:${encodeURIComponent(userId)}`;
}

export function parseOnboardingState(raw: string | null): OnboardingStateV1 | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OnboardingStateV1>;
    if (value.version !== ONBOARDING_VERSION || !value.checklist) return null;
    if (!['configured', 'skipped', 'pending'].includes(value.ado ?? '')) return null;
    return {
      version: ONBOARDING_VERSION,
      ado: value.ado!,
      checklist: {
        startedConversation: value.checklist.startedConversation === true,
        sentMessage: value.checklist.sentMessage === true,
        notificationsEnabled: value.checklist.notificationsEnabled === true,
        dismissed: value.checklist.dismissed === true,
      },
    };
  } catch {
    return null;
  }
}

export function updateChecklist(
  state: OnboardingStateV1,
  key: OnboardingChecklistKey,
): OnboardingStateV1 {
  if (state.checklist[key]) return state;
  return { ...state, checklist: { ...state.checklist, [key]: true } };
}

export function skipChecklist(state: OnboardingStateV1): OnboardingStateV1 {
  if (state.checklist.dismissed) return state;
  return { ...state, checklist: { ...state.checklist, dismissed: true } };
}

export function checklistComplete(state: OnboardingStateV1): boolean {
  const { checklist } = state;
  return (
    checklist.startedConversation &&
    checklist.sentMessage &&
    checklist.notificationsEnabled
  );
}
