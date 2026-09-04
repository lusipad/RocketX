import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  RcMessage,
  RcSlashCommand,
  RcUiKitServerInteraction,
  RcUiKitView,
} from '../../packages/rc-client/src/index';
import {
  applyUiKitServerInteraction,
  beginUiKitInteraction,
  buildUiKitViewSubmitPayload,
  type UiKitStateSnapshot,
} from '../../apps/web/src/lib/uikit';
import { isPollMessage } from '../../apps/web/src/lib/poll';
import { PollMessage } from '../../apps/web/src/components/PollMessage';

(globalThis as Record<string, unknown>).React = React;

function baseState(): UiKitStateSnapshot {
  return { triggerAppIds: {}, activeModal: null };
}

function modalView(blocks: RcUiKitView['blocks']): RcUiKitView {
  return {
    id: 'poll-view',
    appId: 'poll-app-id',
    title: { type: 'plain_text', text: 'poll_modal_title', i18n: { key: 'poll_modal_title' } },
    submit: { text: { type: 'plain_text', text: 'poll_submit', i18n: { key: 'poll_submit' } } },
    close: { text: { type: 'plain_text', text: 'poll_dismiss', i18n: { key: 'poll_dismiss' } } },
    blocks,
  };
}

function openModalInteraction(view: RcUiKitView): RcUiKitServerInteraction {
  return {
    type: 'modal.open',
    triggerId: 'trigger-open',
    appId: 'poll-app-id',
    view,
  };
}

function pollMessage(): RcMessage {
  return {
    _id: 'message-1',
    rid: 'GENERAL',
    msg: '今天吃什么？',
    ts: '2026-09-05T09:00:00.000Z',
    u: { _id: 'user-1', username: 'alice', name: 'Alice' },
    blocks: [
      {
        type: 'section',
        blockId: 'question',
        text: { type: 'plain_text', text: '今天吃什么？' },
      },
      {
        type: 'context',
        blockId: 'close',
        elements: [
          {
            type: 'mrkdwn',
            text: 'poll_closes_at',
            i18n: { key: 'poll_closes_at', args: { time: '5 Sep 2026, 18:00' } },
          },
        ],
      },
      { type: 'divider', blockId: 'divider' },
      {
        type: 'section',
        appId: 'poll-app-id',
        blockId: 'option-0',
        text: { type: 'plain_text', text: '火锅' },
        accessory: {
          type: 'button',
          actionId: 'vote',
          text: { type: 'plain_text', text: 'poll_vote', i18n: { key: 'poll_vote' } },
          value: '0',
        },
      },
      {
        type: 'context',
        blockId: 'option-0-graph',
        elements: [{ type: 'mrkdwn', text: '`█████-----` 50% (2)' }],
      },
      {
        type: 'context',
        blockId: 'option-0-voters',
        elements: [
          {
            type: 'mrkdwn',
            text: 'poll_voters_plural',
            i18n: { key: 'poll_voters_plural', args: { count: 2, voters: 'alice bob' } },
          },
        ],
      },
      {
        type: 'section',
        appId: 'poll-app-id',
        blockId: 'option-1',
        text: { type: 'plain_text', text: '烧烤' },
        accessory: {
          type: 'button',
          actionId: 'vote',
          text: { type: 'plain_text', text: 'poll_vote', i18n: { key: 'poll_vote' } },
          value: '1',
        },
      },
      {
        type: 'context',
        blockId: 'option-1-graph',
        elements: [{ type: 'mrkdwn', text: '`█████-----` 50% (2)' }],
      },
    ],
  };
}

test('UI Kit trigger 绑定 appId，modal.update 保留已填写状态（issue #384）', () => {
  const command: RcSlashCommand = { command: 'poll', appId: 'poll-app-id' };
  const begun = beginUiKitInteraction(baseState(), command.appId, () => 'trigger-1');
  assert.equal(begun.triggerId, 'trigger-1');
  assert.equal(begun.state.triggerAppIds['trigger-1'], 'poll-app-id');

  const opened = applyUiKitServerInteraction(
    begun.state,
    openModalInteraction(modalView([
      {
        type: 'input',
        blockId: 'poll',
        label: { type: 'plain_text', text: 'poll_question_label', i18n: { key: 'poll_question_label' } },
        element: { type: 'plain_text_input', actionId: 'question', initialValue: '' },
      },
      {
        type: 'input',
        blockId: 'poll',
        label: { type: 'plain_text', text: '' },
        element: { type: 'plain_text_input', actionId: 'option-0', initialValue: '' },
      },
      {
        type: 'input',
        blockId: 'poll',
        label: { type: 'plain_text', text: '' },
        element: { type: 'plain_text_input', actionId: 'option-1', initialValue: '' },
      },
    ])),
  );

  assert.equal(opened.activeModal?.view.id, 'poll-view');
  opened.activeModal!.values.poll.question = '今天吃什么';
  opened.activeModal!.values.poll['option-0'] = '火锅';
  opened.activeModal!.values.poll['option-1'] = '烧烤';

  const updated = applyUiKitServerInteraction(opened, {
    type: 'modal.update',
    triggerId: 'trigger-2',
    appId: 'poll-app-id',
    view: modalView([
      {
        type: 'input',
        blockId: 'poll',
        label: { type: 'plain_text', text: 'poll_question_label', i18n: { key: 'poll_question_label' } },
        element: { type: 'plain_text_input', actionId: 'question', initialValue: '' },
      },
      {
        type: 'input',
        blockId: 'poll',
        label: { type: 'plain_text', text: '' },
        element: { type: 'plain_text_input', actionId: 'option-0', initialValue: '' },
      },
      {
        type: 'input',
        blockId: 'poll',
        label: { type: 'plain_text', text: '' },
        element: { type: 'plain_text_input', actionId: 'option-1', initialValue: '' },
      },
      {
        type: 'input',
        blockId: 'poll',
        label: { type: 'plain_text', text: '' },
        element: { type: 'plain_text_input', actionId: 'option-2', initialValue: '' },
      },
    ]),
  });

  assert.equal(updated.activeModal?.values.poll.question, '今天吃什么');
  assert.equal(updated.activeModal?.values.poll['option-0'], '火锅');
  assert.equal(updated.activeModal?.values.poll['option-1'], '烧烤');
  assert.equal(updated.activeModal?.values.poll['option-2'], '');
});

test('view submit payload 还原 blockId/actionId 嵌套 state', () => {
  const opened = applyUiKitServerInteraction(
    baseState(),
    openModalInteraction(modalView([
      {
        type: 'input',
        blockId: 'poll',
        label: { type: 'plain_text', text: 'poll_question_label', i18n: { key: 'poll_question_label' } },
        element: { type: 'plain_text_input', actionId: 'question', initialValue: '' },
      },
      {
        type: 'actions',
        blockId: 'config',
        elements: [
          {
            type: 'static_select',
            actionId: 'mode',
            initialValue: 'single',
            placeholder: { type: 'plain_text', text: 'poll_mode_single', i18n: { key: 'poll_mode_single' } },
            options: [
              { text: { type: 'plain_text', text: 'poll_mode_single', i18n: { key: 'poll_mode_single' } }, value: 'single' },
              { text: { type: 'plain_text', text: 'poll_mode_multiple', i18n: { key: 'poll_mode_multiple' } }, value: 'multiple' },
            ],
          },
          {
            type: 'button',
            actionId: 'addChoice',
            text: { type: 'plain_text', text: 'poll_add_choice', i18n: { key: 'poll_add_choice' } },
            value: '3',
          },
        ],
      },
    ])),
  );
  opened.activeModal!.values.poll.question = '今天吃什么';
  opened.activeModal!.values.config.mode = 'multiple';

  const payload = buildUiKitViewSubmitPayload(opened.activeModal!, 'trigger-submit');

  assert.equal(payload.type, 'viewSubmit');
  assert.equal(payload.triggerId, 'trigger-submit');
  assert.equal(payload.viewId, 'poll-view');
  assert.equal(payload.payload.view.id, 'poll-view');
  assert.equal(payload.payload.view.appId, 'poll-app-id');
  assert.deepEqual(payload.payload.view.blocks, opened.activeModal!.view.blocks);
  assert.deepEqual(payload.payload.view.state, {
    poll: { question: '今天吃什么' },
    config: { mode: 'multiple' },
  });
});

test('PollMessage 按官方 Poll blocks 渲染并识别为可交互投票消息', () => {
  const message = pollMessage();
  assert.equal(isPollMessage(message), true);
  const html = renderToStaticMarkup(React.createElement(PollMessage, {
    message,
    onVote: () => undefined,
  }));
  assert.match(html, /今天吃什么？/);
  assert.match(html, /火锅/);
  assert.match(html, /烧烤/);
  assert.match(html, /投票/);
  assert.match(html, /截止于 5 Sep 2026, 18:00/);
  assert.match(html, /2 票 - alice bob/);
});

test('Issue #384 wiring：slash trigger、uiInteraction 订阅、modal host 与 Poll 渲染已接入', () => {
  const chat = readFileSync('apps/web/src/stores/chat.ts', 'utf8');
  const app = readFileSync('apps/web/src/App.tsx', 'utf8');
  const item = readFileSync('apps/web/src/components/MessageItem.tsx', 'utf8');

  assert.match(chat, /rest\.runCommand\(command, rid, params, tmid, triggerId\)/);
  assert.match(chat, /realtime\.subscribe\('stream-notify-user', `\$\{auth\.userId\}\/uiInteraction`\)/);
  assert.match(chat, /consumeServerInteraction/);
  assert.match(app, /UiKitModalHost/);
  assert.match(item, /PollMessage/);
  assert.match(item, /sendUiKitMessageAction/);
  assert.match(
    readFileSync('apps/web/src/lib/uikit.ts', 'utf8'),
    /const appId = block\.appId \?\? element\.appId/,
  );
});
