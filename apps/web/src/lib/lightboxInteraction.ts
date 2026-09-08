/**
 * 图片灯箱承载区（stage）的指针判定。
 *
 * 灯箱的关闭由遮罩根节点的 onClick 负责，但承载区铺满了 92vw × 86vh，
 * 用户眼里「图片周围的空白」几乎全落在承载区上。承载区又必须吞掉自己的
 * click 才能支撑拖拽平移 —— 两件事撞在一起，就是 issue #388：
 * 点空白毫无反应，只能去点右上角的关闭按钮。
 *
 * 解法是把「这一次 click 到底是点了一下还是拖了一把」变成可判定的状态：
 * 命中承载区自身、且按下之后指针没有移动过，才等同于点击空白。
 */

export type StagePointerState = {
  /** 本次按下之后指针是否真的移动过（移动过就说明是拖拽，不是点击） */
  readonly moved: boolean;
};

export const stagePointerIdle: StagePointerState = { moved: false };

/** 指针按下：无论上一轮是拖拽还是点击，都重新开始计量。 */
export function stagePointerDown(): StagePointerState {
  return stagePointerIdle;
}

/** 指针在按住状态下移动：本轮记为拖拽。 */
export function stagePointerMove(state: StagePointerState): StagePointerState {
  return state.moved ? state : { moved: true };
}

/**
 * 承载区上的这次 click 是否应当关闭灯箱。
 *
 * @param hitStageItself 事件目标就是承载区本身（点在图片、OCR 文字层等子元素上时为 false）
 * @param pointerMoved   本次按下之后指针移动过（拖拽平移松手同样会派发 click）
 */
export function shouldCloseLightbox({
  hitStageItself,
  pointerMoved,
}: {
  hitStageItself: boolean;
  pointerMoved: boolean;
}): boolean {
  return hitStageItself && !pointerMoved;
}
