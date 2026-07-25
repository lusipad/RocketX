import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseButlerConclusions,
  senderFromSourceLabel,
} from '../../apps/web/src/lib/butlerConclusions';
import type { ButlerSource } from '../../apps/web/src/lib/butlerContext';

const SITE = 'https://chat.example.com';
const ADO = 'https://ado.example/tfs/DefaultCollection';

function messageSource(mid: string, rid: string, label: string): ButlerSource {
  return { kind: 'message', id: mid, mid, rid, label };
}

function permalink(room: string, mid: string): string {
  return `${SITE}/channel/${room}?msg=${mid}`;
}

test('一答三条承诺各自归属到自己的消息，互不串', () => {
  const text = [
    '**明确承诺**',
    `- 张三 · 周五给压测报告 · [原文](${permalink('dev', 'm1')})`,
    `- 李四 · 下版本修登录闪退 · 未给期限 · [原文](${permalink('dev', 'm2')})`,
    `- 王五 · 今晚同步会议纪要 · [原文](${permalink('ops', 'm3')})`,
  ].join('\n');
  const sources = [
    messageSource('m1', 'room-dev', '研发群 · 张三：周五给压测报告'),
    messageSource('m2', 'room-dev', '研发群 · 李四：下版本修登录闪退'),
    messageSource('m3', 'room-ops', '运维群 · 王五：今晚同步会议纪要'),
  ];

  const conclusions = parseButlerConclusions(text, { siteUrl: SITE, adoBase: ADO, sources });
  assert.equal(conclusions.length, 3);
  assert.deepEqual(conclusions.map((item) => item.ref), ['msg:m1', 'msg:m2', 'msg:m3']);
  // 坑 1 的正面证据：第三条的房间与第一条不同，说明不是整轮并集回落
  assert.equal(conclusions[0].source?.rid, 'room-dev');
  assert.notEqual(conclusions[2].source?.rid, conclusions[0].source?.rid);
  assert.equal(conclusions[2].source?.rid, 'room-ops');
  for (const item of conclusions) {
    assert.equal(item.can.todo, true);
    assert.equal(item.can.watch, true);
  }
  // 粗体小标题不算结论
  assert.equal(conclusions.some((item) => item.text.includes('明确承诺')), false);
});

test('幻觉链接被拒：sources 里没有的消息不产出任何按钮', () => {
  const text = `- 张三答应周五给报告 · [原文](${permalink('dev', 'm9')})`;
  const conclusions = parseButlerConclusions(text, {
    siteUrl: SITE,
    adoBase: ADO,
    sources: [messageSource('m1', 'room-dev', '研发群 · 张三：周五给报告')],
  });
  assert.deepEqual(conclusions, []);
});

test('跨站与跨集合链接一律不认', () => {
  const foreignSite = `- 看这条 · [原文](https://evil.example.com/channel/dev?msg=m1)`;
  assert.deepEqual(
    parseButlerConclusions(foreignSite, {
      siteUrl: SITE,
      adoBase: ADO,
      sources: [messageSource('m1', 'room-dev', '研发群 · 张三：x')],
    }),
    [],
  );

  const foreignAdo = '- 先看 [#4821](https://other-ado.example/tfs/X/_workitems/edit/4821)';
  assert.deepEqual(parseButlerConclusions(foreignAdo, { siteUrl: SITE, adoBase: ADO }), []);

  // 没有配置 ADO 时，裸 #编号 不认
  assert.deepEqual(parseButlerConclusions('- 先看 #4821', { siteUrl: SITE, adoBase: null }), []);
});

test('PR 锚点未命中来源时只给「打开」，不给写动作', () => {
  const text = `- 建议先合 [#102](${ADO}/proj/_git/payments/pullrequest/102)，改动小且独立`;
  const conclusions = parseButlerConclusions(text, { siteUrl: SITE, adoBase: ADO });
  assert.equal(conclusions.length, 1);
  assert.equal(conclusions[0].ref, 'pr:102');
  assert.equal(conclusions[0].can.open, true);
  assert.equal(conclusions[0].can.todo, false);
  assert.equal(conclusions[0].can.watch, false);
  assert.match(conclusions[0].fallbackWebUrl ?? '', /pullrequest\/102$/);
});

test('来源被 8 条上限截断时，未命中的结论静默消失而不是回落到第一条', () => {
  const text = [
    `- 第一条 · [原文](${permalink('dev', 'm1')})`,
    `- 第二条 · [原文](${permalink('dev', 'm2')})`,
  ].join('\n');
  const conclusions = parseButlerConclusions(text, {
    siteUrl: SITE,
    adoBase: ADO,
    sources: [messageSource('m1', 'room-dev', '研发群 · 张三：第一条')],
  });
  assert.equal(conclusions.length, 1);
  assert.equal(conclusions[0].ref, 'msg:m1');
});

test('没有列表项或没有锚点时返回空数组，既有回答零影响', () => {
  assert.deepEqual(parseButlerConclusions('好的，我查到了三条消息。', { siteUrl: SITE, adoBase: ADO }), []);
  assert.deepEqual(parseButlerConclusions('- 张三答应周五给报告', { siteUrl: SITE, adoBase: ADO }), []);
  assert.deepEqual(parseButlerConclusions('', { siteUrl: SITE, adoBase: ADO }), []);
});

test('有序列表与任务列表同样识别，label 去掉链接并截断', () => {
  const long = '这是一条很长的承诺描述'.repeat(4);
  const text = [
    `1. 张三 · 周五给报告 · [原文](${permalink('dev', 'm1')})`,
    `- [ ] 李四 · ${long} · [原文](${permalink('dev', 'm2')})`,
  ].join('\n');
  const conclusions = parseButlerConclusions(text, {
    siteUrl: SITE,
    adoBase: ADO,
    sources: [
      messageSource('m1', 'room-dev', '研发群 · 张三：周五给报告'),
      messageSource('m2', 'room-dev', '研发群 · 李四：长描述'),
    ],
  });
  assert.equal(conclusions.length, 2);
  assert.doesNotMatch(conclusions[0].label, /https?:|\[|\]/);
  assert.ok(conclusions[1].label.length <= 25);
  assert.match(conclusions[1].label, /…$/);
});

test('senderFromSourceLabel 从机器生成的 label 里取发言人', () => {
  assert.equal(senderFromSourceLabel('研发群 · 张三：周五给压测报告'), '张三');
  assert.equal(senderFromSourceLabel('研发群：没有发言人'), undefined);
  assert.equal(senderFromSourceLabel(undefined), undefined);
  assert.equal(senderFromSourceLabel(''), undefined);
});
