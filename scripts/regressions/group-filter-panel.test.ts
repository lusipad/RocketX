import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialGroupFilterPanelState,
  nextGroupFilterPanelState,
} from '../../apps/web/src/lib/groupFilterPanel';

function isCollapsed(userCollapsed: boolean, panelCollapsed: boolean): boolean {
  return userCollapsed || panelCollapsed;
}

test('打开右侧面板时临时收起分组栏，关闭后恢复用户原来的展开状态', () => {
  let state = initialGroupFilterPanelState;
  const userCollapsed = false;

  state = nextGroupFilterPanelState(state, {
    type: 'panel-open',
    groupCollapsed: isCollapsed(userCollapsed, state.panelCollapsed),
  });
  assert.equal(isCollapsed(userCollapsed, state.panelCollapsed), true);

  state = nextGroupFilterPanelState(state, { type: 'panel-close' });
  assert.equal(isCollapsed(userCollapsed, state.panelCollapsed), false);
});

test('面板打开期间手动展开后，关闭面板不再改变分组栏', () => {
  let state = nextGroupFilterPanelState(initialGroupFilterPanelState, {
    type: 'panel-open',
    groupCollapsed: false,
  });
  assert.equal(state.panelCollapsed, true);

  state = nextGroupFilterPanelState(state, { type: 'manual-change' });
  assert.equal(state.panelCollapsed, false);

  state = nextGroupFilterPanelState(state, { type: 'panel-close' });
  assert.equal(isCollapsed(false, state.panelCollapsed), false);
});

test('面板打开期间用户手动收起后，关闭面板保留收起状态', () => {
  let state = nextGroupFilterPanelState(initialGroupFilterPanelState, {
    type: 'panel-open',
    groupCollapsed: false,
  });

  state = nextGroupFilterPanelState(state, { type: 'manual-change' });
  state = nextGroupFilterPanelState(state, { type: 'panel-close' });
  assert.equal(isCollapsed(true, state.panelCollapsed), true);
});

test('用户原本收起的分组栏不受右侧面板开关影响', () => {
  let state = nextGroupFilterPanelState(initialGroupFilterPanelState, {
    type: 'panel-open',
    groupCollapsed: true,
  });
  assert.equal(state.panelCollapsed, false);

  state = nextGroupFilterPanelState(state, { type: 'panel-close' });
  assert.equal(isCollapsed(true, state.panelCollapsed), true);
});
