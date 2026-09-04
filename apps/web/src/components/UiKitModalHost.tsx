import type { RcUiKitBlock, RcUiKitElement } from '@rcx/rc-client';
import Dialog from './Dialog';
import { uiKitText, useUiKit } from '../lib/uikit';
import { toast } from '../stores/toast';

function FieldError({ error }: { error?: string }) {
  return error ? <div className="mt-1 text-xs text-danger">{error}</div> : null;
}

function InputElement({
  block,
  element,
}: {
  block: RcUiKitBlock;
  element: RcUiKitElement;
}) {
  const modal = useUiKit((state) => state.activeModal);
  const setValue = useUiKit((state) => state.setValue);
  if (!modal || !block.blockId || !element.actionId) return null;
  const value = modal.values[block.blockId]?.[element.actionId] ?? '';
  return (
    <>
      <input
        value={value}
        placeholder={uiKitText(element.placeholder)}
        onChange={(event) => setValue(block.blockId!, element.actionId!, event.target.value)}
        className="h-9 w-full rounded-md border border-line bg-surface-4 px-3 text-sm text-ink outline-none focus:border-primary"
      />
      <FieldError error={modal.errors[element.actionId]} />
    </>
  );
}

function SelectElement({
  block,
  element,
}: {
  block: RcUiKitBlock;
  element: RcUiKitElement;
}) {
  const modal = useUiKit((state) => state.activeModal);
  const setValue = useUiKit((state) => state.setValue);
  const sendViewAction = useUiKit((state) => state.sendViewAction);
  if (!modal || !block.blockId || !element.actionId) return null;
  return (
    <select
      value={modal.values[block.blockId]?.[element.actionId] ?? element.initialValue ?? ''}
      disabled={modal.busy}
      onChange={(event) => {
        setValue(block.blockId!, element.actionId!, event.target.value);
        void sendViewAction(block, element).catch((error) => {
          toast.error(error, '投票选项更新失败');
        });
      }}
      className="h-9 min-w-36 rounded-md border border-line bg-surface-4 px-2 text-sm text-ink outline-none focus:border-primary"
    >
      {(element.options ?? []).map((option) => (
        <option key={option.value} value={option.value}>
          {uiKitText(option.text)}
        </option>
      ))}
    </select>
  );
}

function ActionElement({
  block,
  element,
}: {
  block: RcUiKitBlock;
  element: RcUiKitElement;
}) {
  const busy = useUiKit((state) => state.activeModal?.busy ?? false);
  const sendViewAction = useUiKit((state) => state.sendViewAction);
  if (element.type === 'static_select') {
    return <SelectElement block={block} element={element} />;
  }
  if (element.type === 'button') {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void sendViewAction(block, element).catch((error) => {
            toast.error(error, '投票选项更新失败');
          });
        }}
        className="h-9 rounded-md border border-line px-3 text-sm text-ink-2 transition hover:bg-fill-hover disabled:opacity-50"
      >
        {uiKitText(element.text)}
      </button>
    );
  }
  return null;
}

function ModalBlock({ block }: { block: RcUiKitBlock }) {
  if (block.type === 'divider') return <hr className="border-line" />;
  if (block.type === 'section') {
    return <div className="text-sm text-ink-2">{uiKitText(block.text)}</div>;
  }
  if (block.type === 'input' && block.element) {
    return (
      <label className="block text-sm text-ink-2">
        {uiKitText(block.label)}
        <div className="mt-1">
          <InputElement block={block} element={block.element} />
        </div>
      </label>
    );
  }
  if (block.type === 'actions') {
    return (
      <div className="flex flex-wrap gap-2">
        {(block.elements ?? [])
          .filter((element): element is RcUiKitElement => 'type' in element)
          .map((element, index) => (
            <ActionElement
              key={`${element.actionId ?? element.type}-${index}`}
              block={block}
              element={element}
            />
          ))}
      </div>
    );
  }
  return null;
}

export default function UiKitModalHost() {
  const modal = useUiKit((state) => state.activeModal);
  const close = useUiKit((state) => state.close);
  const submit = useUiKit((state) => state.submit);
  if (!modal) return null;

  return (
    <Dialog
      title={uiKitText(modal.view.title) || '应用操作'}
      width={560}
      onClose={modal.busy ? () => {} : close}
      footer={
        <>
          <button
            type="button"
            disabled={modal.busy}
            onClick={close}
            className="h-9 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover disabled:opacity-50"
          >
            {uiKitText(modal.view.close?.text) || '取消'}
          </button>
          <button
            type="button"
            disabled={modal.busy}
            onClick={() => {
              void submit().catch((error) => toast.error(error, '创建投票失败'));
            }}
            className="h-9 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:opacity-50"
          >
            {modal.busy ? '处理中…' : uiKitText(modal.view.submit?.text) || '提交'}
          </button>
        </>
      }
    >
      <div className="space-y-3 px-5 pb-4">
        {modal.view.blocks.map((block, index) => (
          <ModalBlock key={block.blockId ?? `${block.type}-${index}`} block={block} />
        ))}
      </div>
    </Dialog>
  );
}
