/** 会话输入框的定位标记（Composer 的 textarea 上挂着 data-composer-input） */
export const COMPOSER_INPUT_SELECTOR = '[data-composer-input]';

/**
 * 弹窗关闭后是否把焦点还给打开前的元素。
 * 已有组件接管焦点（例如指令中心选中联系人后聚焦输入框）时不能抢回，
 * 否则光标不会停在输入框（issue #87）。
 */
export function shouldRestoreDialogFocus(
  activeElement: Element | null,
  body: Element | null,
): boolean {
  return !activeElement || activeElement === body;
}

/**
 * 把光标送进会话输入框。
 * 延后一拍执行：等选中会话/联系人触发的重渲染先把 Composer 挂出来；
 * 关闭中的弹窗随后在 rAF 里做焦点还原，看到焦点已被接管就不会抢回。
 */
export function focusComposerInput(): void {
  window.setTimeout(() => {
    document.querySelector<HTMLTextAreaElement>(COMPOSER_INPUT_SELECTOR)?.focus();
  });
}
