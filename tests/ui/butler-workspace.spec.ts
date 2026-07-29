import { expect, test } from '@playwright/test';
import { bootAuthenticated } from './support/rocket-chat-mock';

async function openWorkspace(page: import('@playwright/test').Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-07-28T14:30:00+08:00'));
  await bootAuthenticated(page);
  await page.getByRole('navigation').getByRole('button', { name: /^管家/ }).click();
  await expect(page.getByRole('navigation', { name: '管家工作视图' })).toBeVisible();
}

async function openButlerSkills(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '我的管家', exact: true }).click();
  const identityPage = page.getByRole('region', { name: '我的管家' });
  await identityPage.getByRole('tab', { name: '记忆与技能' }).click();
  const skills = identityPage.getByRole('region', { name: '会的本事' });
  await expect(skills.getByRole('list')).toBeVisible();
  return skills;
}

async function firstBuiltInSkillName(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    const loadProfile = new Function('return import("/src/lib/butlerProfile.ts")') as () => Promise<{
      listSkills: () => Array<{ name: string }>;
      isButlerBuiltInSkill: (name: string) => boolean;
    }>;
    const { listSkills, isButlerBuiltInSkill } = await loadProfile();
    const skill = listSkills().find((item) => isButlerBuiltInSkill(item.name));
    if (!skill) throw new Error('built-in Butler skill not found');
    return skill.name;
  });
}

async function openSkillDetail(
  page: import('@playwright/test').Page,
  skillName: string,
) {
  await page.getByRole('button', { name: `查看技能 ${skillName}` }).click();
  const dialog = page.getByRole('dialog', { name: skillName });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('桌面壳锁住根视口，只允许内容面板自己滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page);

  const shell = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('#root');
    if (!root) throw new Error('root not found');
    return {
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      bodyOverflow: getComputedStyle(document.body).overflow,
      rootOverflow: getComputedStyle(root).overflow,
      htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehavior,
      bodyOverscroll: getComputedStyle(document.body).overscrollBehavior,
      rootOverscroll: getComputedStyle(root).overscrollBehavior,
      rootTop: root.getBoundingClientRect().top,
      scrollY: window.scrollY,
    };
  });

  expect(shell).toEqual({
    htmlOverflow: 'hidden',
    bodyOverflow: 'hidden',
    rootOverflow: 'hidden',
    htmlOverscroll: 'none',
    bodyOverscroll: 'none',
    rootOverscroll: 'none',
    rootTop: 0,
    scrollY: 0,
  });
});

async function seedWorkspace(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const loadTodos = new Function('return import("/src/stores/todos.ts")') as () => Promise<{
      useTodos: { setState: (state: Record<string, unknown>) => void };
    }>;
    const loadRoutines = new Function('return import("/src/stores/routines.ts")') as () => Promise<{
      useRoutines: { setState: (state: Record<string, unknown>) => void };
    }>;
    const loadButler = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: { setState: (state: Record<string, unknown>) => void };
    }>;
    const loadArtifacts = new Function('return import("/src/stores/butlerArtifacts.ts")') as () => Promise<{
      useButlerArtifacts: { setState: (state: Record<string, unknown>) => void };
    }>;
    const loadRounds = new Function('return import("/src/lib/butlerRoundsRunner.ts")') as () => Promise<{
      useButlerRoundsRunner: { setState: (state: Record<string, unknown>) => void };
    }>;
    const [{ useTodos }, { useRoutines }, { useButler }, { useButlerArtifacts }, { useButlerRoundsRunner }] = await Promise.all([
      loadTodos(),
      loadRoutines(),
      loadButler(),
      loadArtifacts(),
      loadRounds(),
    ]);
    const now = new Date(2026, 6, 28, 14, 30).getTime();
    const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
    const tomorrow = new Date(now + 86_400_000).toISOString().slice(0, 10);

    useTodos.setState({
      todos: [
        {
          id: 'workspace-overdue',
          source: 'manual',
          note: '把发布说明发给研发群',
          due: yesterday,
          committedTo: '研发群',
          done: false,
          priority: 2,
          createdAt: now - 172_800_000,
        },
        {
          id: 'workspace-waiting',
          source: 'message',
          title: '确认回滚负责人',
          roomName: '发布协作',
          waitingFor: 'Alice',
          due: tomorrow,
          done: false,
          priority: 1,
          createdAt: now - 7_200_000,
        },
      ],
    });
    useRoutines.setState({
      hydrated: true,
      runningIds: [],
      eventCards: [{
        id: 'workspace-mention',
        kind: 'mention-stale',
        rid: 'room-general',
        title: '@我未回应：General（3小时前）',
        detail: '当前仍有 1 条 @我 未处理。',
        at: now - 10_800_000,
      }],
      routines: [
        {
          id: 'workspace-release-watch',
          name: '发布守护',
          trigger: { kind: 'daily', time: '09:00' },
          delivery: 'today',
          enabled: true,
          createdAt: now - 604_800_000,
          updatedAt: now - 86_400_000,
          contractVersion: 2,
          versions: [{
            version: 1,
            at: now - 604_800_000,
            reason: '由预置方法创建',
            name: '发布守护',
            trigger: { kind: 'daily', time: '09:00' },
          }, {
            version: 2,
            at: now - 86_400_000,
            reason: '补充回滚责任人检查',
            name: '发布守护',
            trigger: { kind: 'daily', time: '09:00' },
          }],
          runs: [{
            id: 'workspace-release-failed',
            at: now - 3_600_000,
            status: 'error',
            text: 'ADO 暂时无法连接。',
          }],
        },
        {
          id: 'workspace-reply-watch',
          name: '待回复守护',
          trigger: { kind: 'interval', everyMinutes: 60 },
          delivery: 'today',
          enabled: true,
          createdAt: now - 604_800_000,
          runs: [{
            id: 'workspace-reply-ok',
            at: now - 1_800_000,
            status: 'ok',
            text: '本轮没有新的待回复事项。',
          }],
        },
      ],
    });
    useButler.setState({
      lines: [{
        id: 'workspace-user-report-request',
        role: 'user',
        text: '整理一份发布风险报告。',
      }, {
        id: 'workspace-release-report',
        role: 'assistant',
        text: `# 发布风险报告\n\n## 结论\nPR #248 缺少明确的回滚责任人，需要在发布前补齐。\n\n## 证据\n${'已核对发布说明、CI 状态与回滚步骤，当前没有发现其他阻断项。'.repeat(16)}`,
        sources: [{
          kind: 'message',
          id: 'workspace-release-source',
          rid: 'room-general',
          label: '发布协作',
        }],
      }],
      errands: [{
        id: 'workspace-errand',
        title: '比较 PR #247 与 #248 的发布风险',
        threadId: 'workspace-thread',
        workspaceRoot: 'D:\\Repos\\rocketchatx',
        workspaceName: 'RocketX',
        readOnly: true,
        startedAt: now - 600_000,
        status: 'running',
        activity: '正在核对 CI 与回滚步骤',
        approvals: [],
        traces: [],
      }],
    });
    useButlerArtifacts.setState({
      hydrated: true,
      artifacts: [{
        id: 'workspace-release-artifact',
        sourceLineId: 'workspace-release-report',
        title: '发布风险报告',
        kind: 'report',
        status: 'working',
        createdAt: now,
        updatedAt: now,
        versions: [{
          id: 'workspace-release-artifact-v1',
          number: 1,
          content: `# 发布风险报告\n\n## 结论\nPR #248 缺少明确的回滚责任人，需要在发布前补齐。`,
          sources: [{
            kind: 'message',
            id: 'workspace-release-source',
            rid: 'room-general',
            label: '发布协作',
          }],
          createdAt: now,
        }],
      }],
    });
    useButlerRoundsRunner.setState({
      running: false,
      error: null,
      lastResult: {
        generatedAt: new Date(now).toISOString(),
        checkedCount: 6,
        refTitles: { 'pr:248': 'PR #248 可能缺少回滚说明' },
        result: {
          summary: '发现一项值得处理的风险。',
          log: [],
          proposals: [],
          items: [{
            ref: 'pr:248',
            why: '发布窗口在今天，而描述里没有明确回滚负责人。',
            suggestedAction: '核对回滚步骤并补一份可审阅草稿。',
          }],
        },
      },
    });
  });
}

async function seedConversationHistory(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const loadButler = new Function('return import("/src/stores/butler.ts")') as () => Promise<{
      useButler: {
        getState: () => {
          activeSessionId: string;
          sessions: Array<{ id: string; title: string }>;
          newConversation: () => Promise<void>;
          renameSession: (sessionId: string, title: string) => Promise<void>;
          switchSession: (sessionId: string) => Promise<void>;
        };
        setState: (state: Record<string, unknown>) => void;
      };
    }>;
    const { useButler } = await loadButler();
    let state = useButler.getState();
    await state.renameSession(state.activeSessionId, '发布风险报告');
    await useButler.getState().newConversation();
    state = useButler.getState();
    await state.renameSession(state.activeSessionId, '每日工作盘点');
    useButler.setState({
      lines: [
        { id: 'history-daily-ask', role: 'user', text: '今天还有哪些工作没有闭环？' },
        { id: 'history-daily-reply', role: 'assistant', text: '还有两项发布责任需要继续跟进。' },
      ],
    });
    await useButler.getState().newConversation();
    state = useButler.getState();
    await state.renameSession(state.activeSessionId, '待回复整理');
    useButler.setState({
      lines: [
        { id: 'history-reply-ask', role: 'user', text: '有哪些消息还在等我回复？' },
        { id: 'history-reply-reply', role: 'assistant', text: '发布协作里有一条确认消息需要回复。' },
      ],
    });
    const original = useButler.getState().sessions.find((session) => session.title === '发布风险报告');
    if (!original) throw new Error('original Butler session not found');
    await useButler.getState().switchSession(original.id);
  });
}

test('管家六视图共享真实责任投影并可端到端切换', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  await seedWorkspace(page);

  await expect(page.getByRole('heading', { name: /件事值得你先看/ })).toBeVisible();
  await expect(page.getByRole('region', { name: '需要知道' })).toContainText('发布守护没有完成');
  await expect(page.getByRole('region', { name: '我主动发现' })).toContainText('PR #248');
  await page.getByRole('region', { name: '需要知道' })
    .getByRole('article')
    .filter({ hasText: '发布守护没有完成' })
    .getByRole('button', { name: '知道了' })
    .click();
  await expect(page.getByRole('region', { name: '需要知道' })).not.toContainText('发布守护没有完成');
  await page.getByRole('button', { name: '转为待办', exact: true }).click();
  await expect(page.getByRole('region', { name: '我主动发现' })).toBeHidden();

  await page.getByRole('button', { name: '任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '任务', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '管家任务' })).toContainText('比较 PR #247');
  await expect(page.getByRole('region', { name: '管家任务' })).toContainText('PR #248 可能缺少回滚说明');

  await page.getByRole('navigation', { name: '管家工作视图' })
    .getByRole('button', { name: /例行照看/ })
    .click();
  await seedWorkspace(page);
  await expect(page.getByRole('region', { name: '例行照看' })).toContainText('发布守护');
  await page.getByRole('button', { name: '查看发布守护详情' }).click();
  const routineDetail = page.getByRole('region', { name: '发布守护详情' });
  await expect(routineDetail).toContainText('需要修复');
  await routineDetail.getByRole('tab', { name: '运行记录' }).click();
  await expect(routineDetail).toContainText('ADO 暂时无法连接');
  await routineDetail.getByRole('tab', { name: '配置' }).click();
  await expect(routineDetail).toContainText('外部动作仍需要你决定');
  await routineDetail.getByRole('tab', { name: '版本' }).click();
  await expect(routineDetail).toContainText('v2 · 当前版本');

  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.getByRole('region', { name: '完整对话' })).toBeVisible();
  const artifacts = page.getByRole('region', { name: '管家成果' });
  await expect(artifacts).toContainText('发布风险报告');
  await artifacts.getByRole('button', { name: '继续编辑' }).click();
  await expect(page.getByRole('textbox', { name: '给管家发消息' })).toHaveValue(/继续编辑成果/);
  await artifacts.getByRole('button', { name: '收下成果' }).click();
  await expect(artifacts).toContainText('已验收');

  await page.getByRole('button', { name: '我的管家', exact: true }).click();
  await expect(page.getByRole('region', { name: '我的管家' })).toBeVisible();

  await page.getByRole('button', { name: '连接与权限', exact: true }).click();
  await expect(page.getByRole('region', { name: '连接与权限' })).toContainText('Rocket.Chat');
});

test('全新账号无需配置即可从第一件真实责任激活管家', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page);
  const activation = page.getByRole('region', { name: '管家首次启用' });
  await expect(activation).toContainText('不用搭建');
  await activation.getByRole('button', { name: '开启待回复守护' }).click();
  await expect(activation).toBeHidden();
  await page.getByRole('navigation', { name: '管家工作视图' })
    .getByRole('button', { name: /例行照看/ })
    .click();
  await expect(page.getByRole('region', { name: '例行照看' })).toContainText('有人 @ 我，先帮我看');
});

test('我的管家统一名字、头像、性格与运行身份', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openWorkspace(page);
  await page.getByRole('button', { name: '我的管家', exact: true }).click();

  const identityPage = page.getByRole('region', { name: '我的管家' });
  await expect(identityPage.getByRole('heading', { name: '管家', exact: true })).toBeVisible();
  await expect(identityPage).toContainText('你的长期工作伙伴');
  await expect(page.getByText('Butler', { exact: true })).toHaveCount(0);
  await expect(identityPage.getByRole('tab', { name: '相处设定' })).toHaveAttribute('aria-selected', 'true');
  await expect(identityPage.getByRole('tab', { name: '了解你' })).toBeVisible();
  await expect(identityPage.getByRole('tab', { name: '分析与改进' })).toBeVisible();
  await expect(identityPage.getByRole('tab', { name: '记忆与技能' })).toBeVisible();
  await expect(identityPage.getByRole('tab', { name: '最近动作' })).toBeVisible();

  await identityPage.getByRole('textbox', { name: '管家名字' }).fill('小布');
  await identityPage.getByRole('textbox', { name: '管家角色' }).fill('可靠的长期工作搭档');
  await identityPage.getByRole('button', { name: '选择轨道头像' }).click();
  await identityPage.getByRole('button', { name: /直接.*坦率/ }).click();
  await identityPage.getByRole('button', { name: /适度.*重要变化/ }).click();
  await identityPage.getByRole('button', { name: /详尽.*完整说明/ }).click();
  await identityPage.getByRole('textbox', { name: '管家性格补充' })
    .fill('遇到风险先说事实，再给建议；平常不要为了存在感打扰我。');
  await identityPage.getByRole('button', { name: '保存设定' }).click();

  await expect(identityPage.getByRole('heading', { name: '小布', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '管家工作视图' })).toContainText('小布');

  await page.getByRole('button', { name: '现在', exact: true }).click();
  await expect(page.getByRole('button', { name: '交给小布', exact: true })).toBeVisible();

  const prompt = await page.evaluate(async () => {
    const loadProfile = new Function('return import("/src/lib/butlerProfile.ts")') as () => Promise<{
      buildButlerApiSystemPrompt: () => string;
    }>;
    return (await loadProfile()).buildButlerApiSystemPrompt();
  });
  expect(prompt).toContain('你的名字是“小布”');
  expect(prompt).toContain('遇到风险先说事实');

  await page.getByRole('button', { name: '我的管家', exact: true }).click();
  await expect(page).toHaveScreenshot('butler-identity-wide.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

test('我的管家在暗色主题与窄屏下保持身份层级和可用性', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.getByRole('button', { name: '我的管家', exact: true }).click();
  const identityPage = page.getByRole('region', { name: '我的管家' });
  await expect(identityPage.getByRole('heading', { name: '管家', exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot('butler-identity-dark-wide.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });

  await identityPage.getByRole('tab', { name: '记忆与技能' }).click();
  const skills = identityPage.getByRole('region', { name: '会的本事' });
  await expect(skills.getByRole('list')).toBeVisible();
  await expect(skills.getByRole('listitem').first()).toContainText('内置');
  await expect(page).toHaveScreenshot('butler-identity-skills-dark-wide.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });

  const skillDialog = await openSkillDetail(page, 'morning-brief');
  await expect(page).toHaveScreenshot('butler-skill-detail-dark-wide.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot('butler-skill-detail-dark-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
  await skillDialog.getByRole('button', { name: '关闭', exact: true }).click();

  await expect(page.getByRole('combobox', { name: '切换管家视图' })).toHaveValue('memory');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot('butler-identity-skills-dark-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });

  await identityPage.getByRole('tab', { name: '相处设定' }).click();
  await expect(identityPage.getByRole('button', { name: '保存设定' })).toBeVisible();
  await expect(page).toHaveScreenshot('butler-identity-dark-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

test('内置技能可查看完整详情但不可直接编辑或卸载', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  await openButlerSkills(page);
  const skillName = await firstBuiltInSkillName(page);

  const dialog = await openSkillDetail(page, skillName);
  await expect(dialog).toContainText('内置技能');
  await expect(dialog).toContainText('方法论正文');
  await expect(dialog).toContainText('内置原件会随 RocketX 更新，因此保持只读');
  await expect(dialog.getByRole('button', { name: '复制并定制' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '编辑技能' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '卸载技能' })).toHaveCount(0);
});

test('内置技能可停用并在重新打开后启用', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  const skills = await openButlerSkills(page);
  const skillName = await firstBuiltInSkillName(page);

  let dialog = await openSkillDetail(page, skillName);
  const disableToggle = dialog.getByRole('switch', { name: `停用技能 ${skillName}` });
  await expect(disableToggle).toHaveAttribute('aria-checked', 'true');
  await disableToggle.click();
  await expect(dialog).toContainText('已停用');
  await expect(dialog.getByRole('switch', { name: `启用技能 ${skillName}` })).toHaveAttribute('aria-checked', 'false');
  await expect(skills.getByRole('listitem').filter({ hasText: skillName })).toContainText('已停用');

  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '例行照看', exact: true }).click();
  const routines = page.getByRole('region', { name: '正在照看' });
  await expect(routines.getByRole('checkbox', { name: '启用晨报' })).toBeDisabled();
  await expect(routines).toContainText('对应技能已停用');
  await expect(page).toHaveScreenshot('butler-routine-disabled-skill-dark-wide.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });

  const refreshedSkills = await openButlerSkills(page);
  dialog = await openSkillDetail(page, skillName);
  const enableToggle = dialog.getByRole('switch', { name: `启用技能 ${skillName}` });
  await enableToggle.click();
  await expect(dialog).toContainText('正在使用');
  await expect(dialog.getByRole('switch', { name: `停用技能 ${skillName}` })).toHaveAttribute('aria-checked', 'true');
  await expect(refreshedSkills.getByRole('listitem').filter({ hasText: skillName })).not.toContainText('已停用');
});

test('内置技能复制为自装副本后可编辑并卸载', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  const skills = await openButlerSkills(page);
  const builtInSkillName = await firstBuiltInSkillName(page);
  const clonedSkillName = `${builtInSkillName}-custom`;

  let dialog = await openSkillDetail(page, builtInSkillName);
  await dialog.getByRole('button', { name: '复制并定制' }).click();

  let editor = page.getByRole('dialog', { name: '复制并定制技能' });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('textbox', { name: '技能名称' })).toHaveValue(clonedSkillName);
  await editor.getByRole('button', { name: '保存副本' }).click();

  dialog = page.getByRole('dialog', { name: clonedSkillName });
  await expect(dialog).toBeVisible();
  await expect(skills.getByRole('listitem').filter({ hasText: clonedSkillName })).toContainText('自装');
  await expect(dialog.getByRole('button', { name: '编辑技能' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '卸载技能' })).toBeVisible();

  await dialog.getByRole('button', { name: '编辑技能' }).click();
  editor = page.getByRole('dialog', { name: '编辑技能' });
  await editor.getByRole('textbox', { name: '一句话简介' }).fill('这是一个复制后改过的技能简介。');
  await editor.getByRole('button', { name: '保存修改' }).click();

  dialog = page.getByRole('dialog', { name: clonedSkillName });
  await expect(dialog).toContainText('这是一个复制后改过的技能简介。');
  await dialog.getByRole('button', { name: '卸载技能' }).click();

  const confirm = page.getByRole('dialog', { name: '卸载技能' });
  await expect(confirm).toContainText(clonedSkillName);
  await confirm.getByRole('button', { name: '卸载', exact: true }).click();
  await expect(skills.getByRole('listitem').filter({ hasText: clonedSkillName })).toHaveCount(0);
});

test('Profile、工作分析与重复模式形成 Skill 的闭环可在工作台完成', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 960 });
  await openWorkspace(page);
  await page.evaluate(async () => {
    const loadLearning = new Function('return import("/src/butler/extensions/learning/runtime.ts")') as () => Promise<{
      butlerProfile: { store: { setState: (state: Record<string, unknown>) => void } };
      butlerOperationJournal: { store: { setState: (state: Record<string, unknown>) => void } };
      butlerWorkAnalysis: { store: { setState: (state: Record<string, unknown>) => void } };
      butlerEfficiency: { store: { setState: (state: Record<string, unknown>) => void } };
    }>;
    const {
      butlerProfile,
      butlerOperationJournal,
      butlerWorkAnalysis,
      butlerEfficiency,
    } = await loadLearning();
    const now = Date.now();
    const day = 86_400_000;
    butlerProfile.store.setState({
      rejectedLines: [],
      facts: [{
        id: 'profile-confirmed-style',
        kind: 'working-style',
        subject: '回复方式',
        value: '先给结论，再补证据',
        status: 'confirmed',
        origin: 'explicit',
        createdAt: now - day,
        updatedAt: now - day,
      }, {
        id: 'profile-candidate-focus',
        kind: 'preference',
        subject: '风险排序',
        value: '发布风险优先于进度汇总',
        status: 'candidate',
        origin: 'observed',
        createdAt: now,
        updatedAt: now,
      }],
    });
    butlerOperationJournal.store.setState({
      enabled: true,
      receipts: [
        {
          id: 'learning-operation-1',
          action: 'ask-butler',
          intentKey: 'workflow:release-risk-check',
          surface: 'now',
          outcome: 'completed',
          at: now - day,
        },
        {
          id: 'learning-operation-2',
          action: 'ask-butler',
          intentKey: 'workflow:release-risk-check',
          surface: 'now',
          outcome: 'completed',
          at: now - day + 1_000,
        },
        {
          id: 'learning-operation-3',
          action: 'ask-butler',
          intentKey: 'workflow:release-risk-check',
          surface: 'now',
          outcome: 'completed',
          at: now,
        },
      ],
    });
    butlerWorkAnalysis.store.setState({ insights: [] });
    butlerEfficiency.store.setState({ candidates: [], proposals: [] });
  });

  await page.getByRole('button', { name: '我的管家', exact: true }).click();
  await page.getByRole('tab', { name: '了解你' }).click();
  const profile = page.getByRole('region', { name: '用户 Profile' });
  await expect(profile).toContainText('回复方式 = 先给结论，再补证据');
  await expect(profile).toContainText('风险排序：发布风险优先于进度汇总');
  await profile.getByRole('button', { name: '确认风险排序' }).click();
  await expect(profile).toContainText('风险排序 = 发布风险优先于进度汇总');

  await page.getByRole('tab', { name: '分析与改进' }).click();
  await page.getByRole('region', { name: '工作分析' })
    .getByRole('button', { name: '重新分析' })
    .click();
  const opportunities = page.getByRole('region', { name: '效率机会' });
  await expect(opportunities).toContainText('形成一个小 Skill');
  await opportunities.getByRole('button', { name: '先看预演' }).click();
  await expect(opportunities).toContainText('识别意图：workflow:release-risk-check');
  await opportunities.getByRole('button', { name: '确认形成 Skill' }).click();
  await expect(opportunities).toContainText('已启用');

  const installed = await page.evaluate(async () => {
    const loadProfile = new Function('return import("/src/lib/butlerProfile.ts")') as () => Promise<{
      listSkills: () => Array<{ name: string }>;
    }>;
    const { listSkills } = await loadProfile();
    return listSkills().some((skill) => skill.name === 'release-risk-check');
  });
  expect(installed).toBe(true);
});

test('了解你支持从当前连接与显式粘贴资料初始化候选画像', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  await page.evaluate(async () => {
    const loadWorkbench = new Function('return import("/src/stores/workbench.ts")') as () => Promise<{
      useWorkbench: { setState: (state: Record<string, unknown>) => void };
    }>;
    const { useWorkbench } = await loadWorkbench();
    useWorkbench.setState({
      config: {
        adoBase: 'http://ado.example/tfs/DefaultCollection',
        auth: 'ntlm',
        account: 'lus',
      },
      workItems: [{
        id: 128,
        title: '补齐回滚说明',
        type: 'Task',
        state: 'Active',
        project: 'RocketX',
        webUrl: 'http://ado.example/RocketX/_workitems/edit/128',
      }],
      prs: [{
        id: 42,
        title: '统一 Butler 会话布局',
        repo: 'RocketX',
        project: 'RocketX',
        creator: 'lus',
        creatorUnique: 'lus',
        reviewers: [],
        sourceBranch: 'feature/butler',
        targetBranch: 'main',
        webUrl: 'http://ado.example/RocketX/_git/RocketX/pullrequest/42',
      }],
      builds: [],
    });
  });

  await page.getByRole('button', { name: '我的管家', exact: true }).click();
  const profile = page.getByRole('region', { name: '用户 Profile' });
  await page.getByRole('tab', { name: '了解你' }).click();
  await profile.getByRole('button', { name: '初始化了解' }).click();
  await expect(profile).toContainText('Rocket.Chat');
  await expect(profile).toContainText('Codex、Claude 等外部资料只会通过你粘贴或导入的文本进入待确认');
  await profile.getByRole('textbox', { name: '初始化资料' })
    .fill('工作方式 · 回复方式：先给结论，再补证据');
  await profile.getByRole('button', { name: '生成候选' }).click();

  await expect(profile).toContainText('Rocket.Chat 身份');
  await expect(profile).toContainText('Azure DevOps 账号：lus');
  await expect(profile).toContainText('当前工作项目：RocketX');
  await expect(profile).toContainText('回复方式：先给结论，再补证据');
  await expect(profile).toContainText('来自当前连接');
  await expect(profile).toContainText('来自导入/粘贴资料');
});

test('晨报人格与技能要求真实链接、标题和判断优先', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWorkspace(page);

  const snapshot = await page.evaluate(async () => {
    const loadProfile = new Function('return import("/src/lib/butlerProfile.ts")') as () => Promise<{
      DEFAULT_PERSONA: string;
      BUILT_IN_BUTLER_SKILLS: Array<{ name: string; body: string }>;
    }>;
    const { DEFAULT_PERSONA, BUILT_IN_BUTLER_SKILLS } = await loadProfile();
    return {
      persona: DEFAULT_PERSONA,
      morningBrief: BUILT_IN_BUTLER_SKILLS.find((skill) => skill.name === 'morning-brief')?.body ?? '',
    };
  });

  expect(snapshot.persona).toContain('[工作项 #编号 · 标题](webUrl)');
  expect(snapshot.persona).toContain('禁止只写孤立 #数字');
  expect(snapshot.morningBrief).toContain('今天先处理什么');
  expect(snapshot.morningBrief).toContain('先归纳 2-3 条判断');
  expect(snapshot.morningBrief).toContain('工作项、PR、构建都必须带标题和工具返回的真实 `webUrl`');
  expect(snapshot.morningBrief).toContain('禁止裸写 #编号');
});

test('超宽窗口填满工作区，非现在视图不显示日期或重复入口', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1200 });
  await openWorkspace(page);
  await seedWorkspace(page);

  const shellBox = await page.locator('.main-page-butler').boundingBox();
  const workspaceBox = await page.locator('.butler-workspace').boundingBox();
  expect(shellBox).not.toBeNull();
  expect(workspaceBox).not.toBeNull();
  expect(Math.abs(
    (shellBox?.x ?? 0) + (shellBox?.width ?? 0)
      - (workspaceBox?.x ?? 0) - (workspaceBox?.width ?? 0),
  )).toBeLessThanOrEqual(1);

  await expect(page.getByRole('button', { name: '前一天' })).toBeVisible();
  await page
    .getByRole('navigation', { name: '管家工作视图' })
    .getByRole('button', { name: '对话', exact: true })
    .click();
  await seedConversationHistory(page);

  await expect(page.getByText('完整对话', { exact: true })).toBeVisible();
  await expect(
    page.locator('.butler-conversation-header').getByRole('heading', { name: '发布风险报告', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('complementary', { name: '对话历史' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '管家对话历史' })).toContainText('每日工作盘点');
  const composer = page.getByRole('form', { name: '发送消息给管家' });
  await expect(composer).toBeVisible();
  const workspaceNavBox = await page.getByRole('navigation', { name: '管家工作视图' }).boundingBox();
  const historyBox = await page.getByRole('complementary', { name: '对话历史' }).boundingBox();
  const conversationPaneBox = await page.locator('.butler-conversation-pane').boundingBox();
  expect(workspaceNavBox).not.toBeNull();
  expect(historyBox).not.toBeNull();
  expect(conversationPaneBox).not.toBeNull();
  expect(workspaceNavBox!.width).toBeLessThanOrEqual(60);
  expect(conversationPaneBox!.width).toBeGreaterThan(historyBox!.width * 3);
  const composerBox = await composer.boundingBox();
  expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(1200);
  await expect(page.getByRole('button', { name: '前一天' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '后一天' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看完整对话' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开管家管理' })).toHaveCount(0);
  const lightPaneColor = await page.locator('.butler-conversation-pane').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await expect.poll(
    () => page.locator('.butler-conversation-pane').evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).not.toBe(lightPaneColor);
  await expect(composer).toBeVisible();
});

test('主动工作驾驶舱匹配确认的宽屏视觉方向', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  await seedWorkspace(page);
  await expect(page.getByRole('heading', { name: /件事值得你先看/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加上下文' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '引用文件或消息' })).toHaveCount(0);
  await expect(page).toHaveScreenshot('butler-workspace-wide.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
    mask: [
      page.getByText(/最近一次运行失败于/),
      page.getByText(/正在核对 CI 与回滚步骤/),
      page.getByText(/^\d+ 分钟$/),
    ],
  });
});

test('例行照看详情把健康、运行、配置与版本放在同一工作面', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  await page.getByRole('navigation', { name: '管家工作视图' })
    .getByRole('button', { name: /例行照看/ })
    .click();
  await seedWorkspace(page);
  await page.getByRole('button', { name: '查看发布守护详情' }).click();
  const detail = page.getByRole('region', { name: '发布守护详情' });
  await detail.getByRole('tab', { name: '运行记录' }).click();
  await expect(detail).toContainText('ADO 暂时无法连接');
  await detail.getByRole('tab', { name: '版本' }).click();
  await expect(detail).toContainText('v2 · 当前版本');
  await expect(detail).toContainText('回退到此版本');
  await expect(page).toHaveScreenshot('butler-routine-detail-wide.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

test('对话中的长结果在中屏仍保留完整对话内容', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await openWorkspace(page);
  await seedWorkspace(page);
  await page.evaluate(async () => {
    const loadArtifacts = new Function('return import("/src/stores/butlerArtifacts.ts")') as () => Promise<{
      useButlerArtifacts: { setState: (state: Record<string, unknown>) => void };
    }>;
    const { useButlerArtifacts } = await loadArtifacts();
    localStorage.removeItem('rcx-butler-artifacts');
    useButlerArtifacts.setState({ hydrated: true, artifacts: [] });
  });
  await page.getByRole('combobox', { name: '切换管家视图' }).selectOption('conversation');
  const artifacts = page.getByRole('region', { name: '管家成果' });
  const conversationSelector = page.getByRole('combobox', { name: '管家会话' });
  await expect(conversationSelector).toBeVisible();
  await expect(conversationSelector).toContainText('整理一份发布风险报告');
  const mediumComposer = page.getByRole('form', { name: '发送消息给管家' });
  await expect(mediumComposer).toBeVisible();
  const mediumComposerBox = await mediumComposer.boundingBox();
  expect((mediumComposerBox?.y ?? 0) + (mediumComposerBox?.height ?? 0)).toBeLessThanOrEqual(900);
  await expect(artifacts).toHaveCount(0);
  await expect(page.getByText('完整内容、来源和版本已放在上方成果工作面。')).toHaveCount(0);
  await expect(page.getByLabel('回答引用').getByText('PR #248 缺少明确的回滚责任人，需要在发布前补齐。')).toBeVisible();
});

test('窄屏用单一视图切换器保持 Composer 与责任状态可用', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await seedWorkspace(page);

  const switcher = page.getByRole('combobox', { name: '切换管家视图' });
  await expect(switcher).toBeVisible();
  expect((await switcher.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('region', { name: '统一 Composer' })).toBeVisible();
  await switcher.selectOption('tasks');
  await expect(page.getByRole('region', { name: '管家任务' })).toBeVisible();
  await expect(page).toHaveScreenshot('butler-workspace-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });

  await switcher.selectOption('conversation');
  const mobileConversationSelector = page.getByRole('combobox', { name: '管家会话' });
  await expect(mobileConversationSelector).toBeVisible();
  await expect(mobileConversationSelector).toContainText('整理一份发布风险报告');
  await expect(page.getByRole('textbox', { name: '给管家发消息' })).toBeVisible();
  const mobileComposerBox = await page.getByRole('form', { name: '发送消息给管家' }).boundingBox();
  expect((mobileComposerBox?.y ?? 0) + (mobileComposerBox?.height ?? 0)).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByText('完整内容、来源和版本已放在上方成果工作面。')).toHaveCount(0);
  await expect(page.getByLabel('回答引用')).toContainText('PR #248 缺少明确的回滚责任人');
});
