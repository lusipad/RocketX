import { create } from 'zustand';
import type {
  RcMessage,
  RcSlashCommand,
  RcUiKitBlock,
  RcUiKitElement,
  RcUiKitServerInteraction,
  RcUiKitText,
  RcUiKitUserInteraction,
  RcUiKitView,
  RcUiKitViewSubmitInteraction,
} from '@rcx/rc-client';
import { rest } from './client';

const UI_KIT_ZH: Record<string, string> = {
  poll_modal_title: '创建投票',
  poll_submit: '创建',
  poll_dismiss: '取消',
  poll_question_label: '问题',
  poll_option_placeholder: '选项',
  poll_mode_multiple: '多选',
  poll_mode_single: '单选',
  poll_add_choice: '添加选项',
  poll_visibility_open: '公开投票',
  poll_visibility_confidential: '匿名投票',
  poll_show_results_always: '始终显示结果',
  poll_show_results_finished: '结束后显示结果',
  poll_close_automatically: '自动关闭',
  poll_duration_off: '不自动关闭',
  poll_duration_1h: '1 小时后',
  poll_duration_6h: '6 小时后',
  poll_duration_1d: '1 天后',
  poll_duration_3d: '3 天后',
  poll_duration_1w: '1 周后',
  poll_duration_custom: '自定义',
  poll_custom_placeholder: 'YYYY-MM-DD HH:mm',
  poll_custom_label: '关闭时间（UTC）',
  poll_vote: '投票',
  poll_finish: '结束投票',
  poll_closes_at: '截止于 {time}',
  poll_finished_at: '已结束于 {date}',
  poll_voters_plural: '{count} 票 - {voters}',
};

export function uiKitText(value: RcUiKitText | RcUiKitElement | undefined): string {
  if (!value) return '';
  if (typeof value.text !== 'string') return uiKitText(value.text);
  const textValue = value as RcUiKitText;
  const key = textValue.i18n?.key;
  let text = (key && UI_KIT_ZH[key]) || textValue.text || key || '';
  for (const [name, replacement] of Object.entries(textValue.i18n?.args ?? {})) {
    text = text.replaceAll(`{${name}}`, String(replacement));
  }
  return text;
}

export interface UiKitActiveModal {
  appId: string;
  triggerId: string;
  view: RcUiKitView;
  values: Record<string, Record<string, string>>;
  errors: Record<string, string>;
  busy: boolean;
}

export interface UiKitStateSnapshot {
  triggerAppIds: Record<string, string>;
  activeModal: UiKitActiveModal | null;
}

function randomTriggerId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `rocketx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function elementInitialValue(element: RcUiKitElement): string {
  return element.initialValue ?? '';
}

function viewValues(
  view: RcUiKitView,
  previous: Record<string, Record<string, string>> = {},
): Record<string, Record<string, string>> {
  const values: Record<string, Record<string, string>> = {};
  for (const block of view.blocks) {
    if (!block.blockId) continue;
    const elements = [
      ...(block.element ? [block.element] : []),
      ...(block.elements ?? []).filter((element): element is RcUiKitElement => 'type' in element),
    ];
    for (const element of elements) {
      if (
        !element.actionId
        || !['plain_text_input', 'static_select'].includes(element.type)
      ) continue;
      values[block.blockId] ??= {};
      values[block.blockId][element.actionId] =
        previous[block.blockId]?.[element.actionId] ?? elementInitialValue(element);
    }
  }
  return values;
}

function errorMap(
  errors: Record<string, string> | Array<Record<string, string>>,
): Record<string, string> {
  return Array.isArray(errors) ? Object.assign({}, ...errors) : errors;
}

export function beginUiKitInteraction(
  state: UiKitStateSnapshot,
  appId: RcSlashCommand['appId'],
  createTriggerId: () => string = randomTriggerId,
): { state: UiKitStateSnapshot; triggerId: string } {
  const triggerId = createTriggerId();
  return {
    triggerId,
    state: {
      ...state,
      triggerAppIds: appId
        ? { ...state.triggerAppIds, [triggerId]: appId }
        : { ...state.triggerAppIds },
    },
  };
}

export function applyUiKitServerInteraction(
  state: UiKitStateSnapshot,
  interaction: RcUiKitServerInteraction,
): UiKitStateSnapshot {
  const expectedAppId = state.triggerAppIds[interaction.triggerId];
  if (expectedAppId && expectedAppId !== interaction.appId) return state;
  const triggerAppIds = { ...state.triggerAppIds };
  delete triggerAppIds[interaction.triggerId];

  if (interaction.type === 'modal.close') {
    return { triggerAppIds, activeModal: null };
  }
  if (interaction.type === 'errors') {
    if (!state.activeModal || state.activeModal.view.id !== interaction.viewId) {
      return { ...state, triggerAppIds };
    }
    return {
      triggerAppIds,
      activeModal: {
        ...state.activeModal,
        errors: errorMap(interaction.errors),
        busy: false,
      },
    };
  }

  const previousValues =
    interaction.type === 'modal.update' ? state.activeModal?.values : undefined;
  return {
    triggerAppIds,
    activeModal: {
      appId: interaction.appId,
      triggerId: interaction.triggerId,
      view: { ...interaction.view, appId: interaction.view.appId ?? interaction.appId },
      values: viewValues(interaction.view, previousValues),
      errors: {},
      busy: false,
    },
  };
}

export function buildUiKitViewSubmitPayload(
  modal: UiKitActiveModal,
  triggerId: string,
): RcUiKitViewSubmitInteraction {
  return {
    type: 'viewSubmit',
    triggerId,
    viewId: modal.view.id,
    payload: {
      view: {
        ...modal.view,
        appId: modal.appId,
        state: modal.values,
      },
    },
  };
}

export function isUiKitServerInteraction(value: unknown): value is RcUiKitServerInteraction {
  if (!value || typeof value !== 'object') return false;
  const interaction = value as Partial<RcUiKitServerInteraction>;
  if (typeof interaction.triggerId !== 'string' || typeof interaction.appId !== 'string') {
    return false;
  }
  if (interaction.type === 'modal.close') return true;
  if (interaction.type === 'errors') {
    return typeof interaction.viewId === 'string' && interaction.errors != null;
  }
  return (
    (interaction.type === 'modal.open' || interaction.type === 'modal.update')
    && interaction.view != null
  );
}

interface UiKitRuntimeState extends UiKitStateSnapshot {
  begin: (appId?: string) => string;
  forgetTrigger: (triggerId: string) => void;
  consumeServerInteraction: (interaction: unknown) => void;
  setValue: (blockId: string, actionId: string, value: string) => void;
  sendViewAction: (block: RcUiKitBlock, element: RcUiKitElement) => Promise<void>;
  submit: () => Promise<void>;
  close: () => void;
}

export const useUiKit = create<UiKitRuntimeState>((set, get) => ({
  triggerAppIds: {},
  activeModal: null,

  begin: (appId) => {
    const begun = beginUiKitInteraction(get(), appId);
    set(begun.state);
    const timer = setTimeout(() => get().forgetTrigger(begun.triggerId), 5_000);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    return begun.triggerId;
  },

  forgetTrigger: (triggerId) => {
    set((state) => {
      if (!(triggerId in state.triggerAppIds)) return state;
      const triggerAppIds = { ...state.triggerAppIds };
      delete triggerAppIds[triggerId];
      return { triggerAppIds };
    });
  },

  consumeServerInteraction: (interaction) => {
    if (!isUiKitServerInteraction(interaction)) return;
    set((state) => applyUiKitServerInteraction(state, interaction));
  },

  setValue: (blockId, actionId, value) => {
    set((state) => {
      if (!state.activeModal) return state;
      return {
        activeModal: {
          ...state.activeModal,
          values: {
            ...state.activeModal.values,
            [blockId]: {
              ...state.activeModal.values[blockId],
              [actionId]: value,
            },
          },
        },
      };
    });
  },

  sendViewAction: async (block, element) => {
    const modal = get().activeModal;
    if (!modal || !block.blockId || !element.actionId) return;
    const triggerId = get().begin(modal.appId);
    const value = element.type === 'button'
      ? element.value ?? ''
      : modal.values[block.blockId]?.[element.actionId] ?? element.value ?? '';
    const interaction: RcUiKitUserInteraction = {
      type: 'blockAction',
      triggerId,
      actionId: element.actionId,
      payload: { blockId: block.blockId, value },
      container: { type: 'view', id: modal.view.id },
    };
    set({ activeModal: { ...modal, busy: true } });
    try {
      const response = await rest.sendUiKitInteraction(modal.appId, interaction);
      if (isUiKitServerInteraction(response)) {
        get().consumeServerInteraction(response);
      } else {
        get().forgetTrigger(triggerId);
        set((state) => state.activeModal?.view.id === modal.view.id
          ? { activeModal: { ...state.activeModal, busy: false } }
          : state);
      }
    } catch (error) {
      get().forgetTrigger(triggerId);
      set((state) => state.activeModal?.view.id === modal.view.id
        ? { activeModal: { ...state.activeModal, busy: false } }
        : state);
      throw error;
    }
  },

  submit: async () => {
    const modal = get().activeModal;
    if (!modal) return;
    const triggerId = get().begin(modal.appId);
    const interaction = buildUiKitViewSubmitPayload(modal, triggerId);
    set({ activeModal: { ...modal, errors: {}, busy: true } });
    try {
      const response = await rest.sendUiKitInteraction(modal.appId, interaction);
      if (isUiKitServerInteraction(response)) {
        get().consumeServerInteraction(response);
        return;
      }
      get().forgetTrigger(triggerId);
      set((state) => state.activeModal?.view.id === modal.view.id
        ? { activeModal: null }
        : state);
    } catch (error) {
      get().forgetTrigger(triggerId);
      set((state) => state.activeModal?.view.id === modal.view.id
        ? { activeModal: { ...state.activeModal, busy: false } }
        : state);
      throw error;
    }
  },

  close: () => set({ activeModal: null }),
}));

export async function sendUiKitMessageAction(
  message: RcMessage,
  block: RcUiKitBlock,
  element: RcUiKitElement,
): Promise<void> {
  const appId = block.appId ?? element.appId;
  if (!appId || !block.blockId || !element.actionId) {
    throw new Error('投票消息缺少应用交互信息');
  }
  const triggerId = useUiKit.getState().begin(appId);
  try {
    const response = await rest.sendUiKitInteraction(appId, {
      type: 'blockAction',
      triggerId,
      actionId: element.actionId,
      payload: { blockId: block.blockId, value: element.value ?? '' },
      container: { type: 'message', id: message._id },
      mid: message._id,
      ...(message.tmid ? { tmid: message.tmid } : {}),
      rid: message.rid,
    });
    if (isUiKitServerInteraction(response)) {
      useUiKit.getState().consumeServerInteraction(response);
    }
  } finally {
    useUiKit.getState().forgetTrigger(triggerId);
  }
}
