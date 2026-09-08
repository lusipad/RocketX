import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  shouldCloseLightbox,
  stagePointerDown,
  stagePointerIdle,
  stagePointerMove,
} from '../../apps/web/src/lib/lightboxInteraction';

test('灯箱：点击图片周围的空白即关闭（issue #388）', () => {
  assert.equal(
    shouldCloseLightbox({ hitStageItself: true, pointerMoved: false }),
    true,
    '承载区自身被点中且没有拖动，等同于点击空白',
  );
});

test('灯箱：点在图片或 OCR 文字层上不关闭', () => {
  assert.equal(shouldCloseLightbox({ hitStageItself: false, pointerMoved: false }), false);
  assert.equal(shouldCloseLightbox({ hitStageItself: false, pointerMoved: true }), false);
});

test('灯箱：拖拽平移松手带出的 click 不误关', () => {
  // 放大后按住空白拖动画面，松手时浏览器仍会派发一次 click，目标就是承载区本身。
  let pointer = stagePointerDown();
  pointer = stagePointerMove(pointer);
  assert.equal(pointer.moved, true);
  assert.equal(shouldCloseLightbox({ hitStageItself: true, pointerMoved: pointer.moved }), false);
});

test('灯箱：拖拽之后再点一下空白仍然能关闭', () => {
  // 上一轮拖拽的状态必须在下一次按下时清掉，否则拖过一次就再也点不关了。
  const dragged = stagePointerMove(stagePointerDown());
  const pressedAgain = stagePointerDown();
  assert.equal(dragged.moved, true);
  assert.equal(pressedAgain.moved, false);
  assert.equal(shouldCloseLightbox({ hitStageItself: true, pointerMoved: pressedAgain.moved }), true);
});

test('灯箱：初始状态未按下时不算拖拽', () => {
  assert.equal(stagePointerIdle.moved, false);
  assert.equal(stagePointerMove(stagePointerMove(stagePointerDown())).moved, true);
});

test('灯箱承载区按判定结果放行冒泡，而不是无条件吞掉 click（issue #388）', () => {
  const lightbox = readFileSync('apps/web/src/components/ImageLightbox.tsx', 'utf8');

  // 遮罩根节点仍然负责关闭。
  assert.match(lightbox, /className="fixed inset-0[^"]*"\s*onClick=\{onClose\}/);
  // 承载区不再无条件 stopPropagation，改为按 shouldCloseLightbox 的结果决定。
  assert.doesNotMatch(lightbox, /onClick=\{\(e\) => e\.stopPropagation\(\)\}\s*onMouseDown=/);
  assert.match(lightbox, /shouldCloseLightbox\(\{\s*hitStageItself: e\.target === e\.currentTarget/);
  assert.match(lightbox, /if \(!close\) e\.stopPropagation\(\);/);
  // 拖拽计量必须在按下时复位、在移动时置位，否则拖过一次就再也点不关。
  assert.match(lightbox, /stagePointerRef\.current = stagePointerDown\(\);/);
  assert.match(lightbox, /stagePointerRef\.current = stagePointerMove\(stagePointerRef\.current\);/);
  // 工具栏仍要吞掉自己的 click，否则点缩放按钮会顺手关掉灯箱。
  assert.match(lightbox, /absolute top-4 right-4[^"]*"\s*onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
});
