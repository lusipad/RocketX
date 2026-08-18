/**
 * 连接真实 Rocket.Chat 服务器的 live 端到端验证：issue #349 / #350 / #351 / #353、
 * 「右键菜单自滚瞬关」与「自动离开」。
 *
 * 运行方式（默认不进 pnpm test:ui 套件——独立的 playwright.live.config.ts + RC_LIVE 门禁双保险）：
 *   1. pnpm --filter @rcx/web build          # 必须先构建，vite preview 服务的是 dist 发布构建
 *   2. RC_LIVE=1 pnpm exec playwright test --config playwright.live.config.ts
 *
 * 环境变量：
 *   RC_LIVE=1             必须，否则整个文件跳过
 *   RC_BASE_URL           默认 http://127.0.0.1:3300
 *   RC_ADMIN_USER         默认 admin
 *   RC_ADMIN_PASSWORD     默认 rcxdev123
 *
 * 副作用与清理：在服务器上临时创建 rcx-live-* 频道、rcx-live-* 测试用户与 DM，
 * 并临时改动 admin 的 sidebarShowUnread / rcxAliases / enableAutoAway / idleTimeLimit
 * 偏好；afterAll 里全部还原/删除。
 * 注意：日志禁止输出 authToken、密码等凭据。
 */
import { expect, test, type Page } from '@playwright/test';

const LIVE = process.env.RC_LIVE === '1';
const RC = (process.env.RC_BASE_URL ?? 'http://127.0.0.1:3300').replace(/\/+$/, '');
const ADMIN_USER = process.env.RC_ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.RC_ADMIN_PASSWORD ?? 'rcxdev123';

test.skip(!LIVE, 'live 验证需要 RC_LIVE=1 与真实 Rocket.Chat 服务器（见文件头注释）');

interface AdminSession {
  authToken: string;
  userId: string;
}

let session: AdminSession;
/** afterAll 要还原的 admin 偏好原始值 */
let originalSidebarShowUnread: unknown;
let originalRcxAliases: unknown;
let originalRcxNameFormat: unknown;
let originalEnableAutoAway: unknown;
let originalIdleTimeLimit: unknown;

const createdChannelIds: string[] = [];
const createdDmIds: string[] = [];
const createdUserIds: string[] = [];

/** 管理态 REST 调用；错误信息只带服务端响应，绝不带凭据。 */
async function rcApi<T = Record<string, unknown>>(
  endpoint: string,
  opts: { method?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(`${RC}/api/v1/${endpoint}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: {
      'X-Auth-Token': session.authToken,
      'X-User-Id': session.userId,
      'Content-Type': 'application/json',
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { success?: boolean };
  if (!res.ok || data.success === false) {
    throw new Error(`${endpoint} 失败: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data as T;
}

async function rcLogin(): Promise<AdminSession> {
  const res = await fetch(`${RC}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  const data = (await res.json()) as {
    status?: string;
    data?: { authToken?: string; userId?: string };
  };
  if (!res.ok || data.status !== 'success' || !data.data?.authToken || !data.data.userId) {
    throw new Error(`登录 ${RC} 失败（${ADMIN_USER}）：HTTP ${res.status}`);
  }
  return { authToken: data.data.authToken, userId: data.data.userId };
}

/**
 * 读 admin 显式保存过的偏好。
 * 注意：Rocket.Chat 8.6 的 users.info 不返回 settings.preferences（getFullUserData
 * 的字段表里根本没有 settings），显式偏好只能走 users.getPreferences 拿。
 */
async function readAdminPreferences(): Promise<Record<string, unknown>> {
  const data = await rcApi<{ preferences?: Record<string, unknown> }>('users.getPreferences', {
    query: { userId: session.userId },
  });
  return data.preferences ?? {};
}

/** 读 admin 当前在线状态（users.info 的 user.status 是标准字段，不受 8.6 偏好裁剪影响） */
async function readAdminStatus(): Promise<string | null> {
  const data = await rcApi<{ user?: { status?: string } }>('users.info', {
    query: { userId: session.userId },
  });
  return data.user?.status ?? null;
}

/** 创建测试用户并与 admin 建 DM，返回基本信息；资源登记到清理列表。 */
async function createDmUser(tag: string): Promise<{ username: string; name: string; userId: string; dmRid: string }> {
  const suffix = Date.now().toString(36);
  const username = `rcx-live-${tag}-${suffix}`;
  const name = `Live测试${tag}${suffix}`;
  const created = await rcApi<{ user?: { _id?: string } }>('users.create', {
    body: {
      username,
      name,
      email: `${username}@rcx-live.example.com`,
      password: `Rcx-live#${suffix}Aa`,
      verified: true,
      joinDefaultChannels: false,
    },
  });
  const userId = created.user?._id;
  if (!userId) throw new Error('users.create 未返回用户 id');
  createdUserIds.push(userId);
  const dm = await rcApi<{ room?: { _id?: string } }>('im.create', { body: { username } });
  const dmRid = dm.room?._id;
  if (!dmRid) throw new Error('im.create 未返回房间 id');
  createdDmIds.push(dmRid);
  return { username, name, userId, dmRid };
}

/** seed 真实登录态进 localStorage，再让 app 连真服务器启动。 */
async function bootLive(page: Page): Promise<void> {
  await page.addInitScript(({ server, userId, authToken }) => {
    localStorage.setItem('rcx-server', server);
    localStorage.setItem('rcx-auth', JSON.stringify({ authToken, userId }));
    localStorage.setItem('rcx-owner', `${userId}@${server}`);
    localStorage.setItem(
      `rcx-onboarding-v1:${encodeURIComponent(server)}:${encodeURIComponent(userId)}`,
      JSON.stringify({
        version: 1,
        ado: 'skipped',
        checklist: {
          startedConversation: true,
          sentMessage: true,
          notificationsEnabled: true,
          dismissed: true,
        },
      }),
    );
  }, { server: RC, userId: session.userId, authToken: session.authToken });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'RocketX 主导航' }).waitFor({ timeout: 30_000 });
  // 等 init 拉完真实订阅列表，避免会话还没出来就去找
  await expect(page.getByText('加载会话中…')).toHaveCount(0, { timeout: 30_000 });
}

/**
 * 经 DDP saveUserPreferences 写偏好。REST users.setPreferences 在 RC 8.6 上是 AJV
 * 校验端点（additionalProperties:false），自定义键 rcxAliases/rcxNameFormat 会被
 * invalid-params 拒绝；Meteor 方法是 Match.ObjectIncluding，放行额外键。
 * 仅 afterAll 还原本次改动时用。
 */
function ddpSavePreferences(prefs: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${RC.replace(/^http/, 'ws')}/websocket`);
    let seq = 0;
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const call = (method: string, params: unknown[]) =>
      new Promise((res, rej) => {
        const id = `m${++seq}`;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ msg: 'method', id, method, params }));
      });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('ddpSavePreferences 超时'));
    }, 10_000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ msg: 'connect', version: '1', support: ['1'] }));
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { msg?: string; id?: string; result?: unknown; error?: { message?: string } };
      if (m.msg === 'ping') ws.send(JSON.stringify({ msg: 'pong' }));
      if (m.msg === 'connected') {
        void call('login', [{ resume: session.authToken }])
          .then(() => call('saveUserPreferences', [prefs]))
          .then(() => {
            clearTimeout(timer);
            ws.close();
            resolve();
          })
          .catch((e: Error) => {
            clearTimeout(timer);
            ws.close();
            reject(e);
          });
      }
      if (m.msg === 'result' && m.id && pending.has(m.id)) {
        const p = pending.get(m.id)!;
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message ?? 'ddp method error'));
        else p.resolve(m.result);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('ddpSavePreferences websocket 错误'));
    };
  });
}

/** 会话列表项（非 avatarOnly 模式下 title 固定） */
function convButton(page: Page, text: string) {
  return page.locator('button[title="拖到左侧分组可归类；右键更多操作"]', { hasText: text });
}

test.describe('live：真实 Rocket.Chat 服务器验证', () => {
  // 用例互相独立（各自造数、各自清理），不串行绑定——一个失败不应跳过其余。
  // workers=1（见 playwright.live.config.ts）保证仍是逐个执行，不会并发抢同一服务器。
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    session = await rcLogin();
    const prefs = await readAdminPreferences();
    originalSidebarShowUnread = prefs.sidebarShowUnread;
    originalRcxAliases = prefs.rcxAliases;
    originalRcxNameFormat = prefs.rcxNameFormat;
    originalEnableAutoAway = prefs.enableAutoAway;
    originalIdleTimeLimit = prefs.idleTimeLimit;
  });

  test.afterAll(async () => {
    if (!session) return;
    // 还原 admin 偏好。标准键走 REST；自定义键（rcxAliases/rcxNameFormat）会被
    // REST 的 AJV 校验整体拒绝（连累同一 payload 里的标准键），必须分开走 DDP。
    await rcApi('users.setPreferences', {
      body: {
        userId: session.userId,
        data: { sidebarShowUnread: originalSidebarShowUnread ?? false },
      },
    }).catch(() => {});
    await ddpSavePreferences({
      rcxAliases: (originalRcxAliases as Record<string, string> | undefined) ?? {},
      rcxNameFormat: (originalRcxNameFormat as string | undefined) ?? 'alias',
      enableAutoAway: (originalEnableAutoAway as boolean | undefined) ?? true,
      idleTimeLimit: (originalIdleTimeLimit as number | undefined) ?? 300,
    }).catch(() => {});
    for (const roomId of createdChannelIds) {
      await rcApi('channels.delete', { body: { roomId } }).catch(() => {});
    }
    for (const roomId of createdDmIds) {
      await rcApi('im.close', { body: { roomId } }).catch(() => {});
    }
    for (const userId of createdUserIds) {
      await rcApi('users.delete', { body: { userId } })
        .catch(() => rcApi('users.delete', { body: { userId, confirmRelinquish: true } }).catch(() => {}));
    }
  });

  test('issue #349：超过 Message_MaxAllowedSize 的消息自动拆分为多条顺序发送', async ({ page }) => {
    // 服务端真实上限（默认 5000），拆分逻辑以它为准
    const setting = await rcApi<{ settings?: { value?: unknown }[] }>('settings.public', {
      query: { _id: 'Message_MaxAllowedSize' },
    });
    const maxSize = Number(setting.settings?.[0]?.value) || 5000;
    expect(maxSize).toBeGreaterThan(0);

    const channelName = `rcx-live-349-${Date.now().toString(36)}`;
    const created = await rcApi<{ channel?: { _id?: string } }>('channels.create', {
      body: { name: channelName },
    });
    const roomId = created.channel?._id;
    if (!roomId) throw new Error('channels.create 未返回房间 id');
    createdChannelIds.push(roomId);

    await bootLive(page);
    await expect(convButton(page, channelName)).toBeVisible({ timeout: 15_000 });
    await convButton(page, channelName).click();

    // 12000+ 字符，含中文与换行、不含代码围栏（围栏会被拆分器补闭合标记，拼接不再等于原文）
    const marker = `live349${Date.now().toString(36)}`;
    const lines: string[] = [];
    let text = '';
    for (let i = 0; text.length < maxSize * 2 + 2000; i += 1) {
      lines.push(`第${String(i).padStart(4, '0')}行 ${marker} 超长消息自动拆分验证内容`.padEnd(50, '、'));
      text = lines.join('\n');
    }
    expect(text.length).toBeGreaterThan(maxSize * 2);

    const textbox = page.locator('[data-composer-input]');
    await expect(textbox).toBeVisible();
    await textbox.click();
    await textbox.fill(text);
    await page.locator('button[title="发送"]').click();
    // 乐观发送：输入框立刻清空
    await expect(textbox).toHaveValue('');

    // REST 断言：服务端落库多条、顺序正确、拼接后与原文一致
    const history = async () => {
      const data = await rcApi<{ messages?: { _id: string; msg: string }[] }>('channels.history', {
        query: { roomId, count: '50' },
      });
      return (data.messages ?? []).slice().reverse(); // history 是新到旧 → 翻回发送顺序
    };
    await expect
      .poll(async () => (await history()).map((m) => m.msg).join(''), {
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
      })
      .toBe(text);

    const messages = await history();
    // 拆成了多条，且每条都不超服务端上限
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages.length).toBeLessThanOrEqual(Math.ceil(text.length / maxSize) + 1);
    for (const m of messages) {
      expect(m.msg.length).toBeLessThanOrEqual(maxSize);
    }
  });

  test('issue #350：备注名同步到服务端 rcxAliases，清本地缓存后登录仍找回', async ({ page }) => {
    const user = await createDmUser('alias');
    const alias = `小陈live${Date.now().toString(36).slice(-4)}`;

    await bootLive(page);
    await expect(convButton(page, user.name)).toBeVisible({ timeout: 15_000 });

    // UI 设置备注名：右键会话 → 设置备注名 → 输入 → 保存。
    // 注意不能用 locator.click({button:'right'})：真实服务器上会话列表会因在线状态/未读
    // 刷新自发滚动，Playwright 滚动到位后还有尾部 scroll 事件（ContextMenu 早年监听 scroll
    // 关闭，菜单刚弹出（~6ms）就被 trailing scroll 关掉；现改为只响应用户滚轮/触摸）。
    // 且 Playwright 的 dispatchEvent 又不会带 clientX/Y（菜单被定位到视口外）。这里手动
    // dispatch 带坐标的 MouseEvent，走的仍是同一个 React onContextMenu 处理器，且不触发任何滚动。
    const conv = convButton(page, user.name);
    await conv.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 480, clientY: 320 }));
    });
    await page.getByRole('button', { name: '设置备注名' }).click();
    const dialog = page.locator('input[placeholder="留空则清除备注"]');
    await expect(dialog).toBeVisible();
    await dialog.fill(alias);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(convButton(page, alias)).toBeVisible({ timeout: 10_000 });

    // REST 断言：服务端 preferences.rcxAliases 已写入 u:<username>
    await expect
      .poll(
        async () => {
          const prefs = await readAdminPreferences();
          const aliases = (prefs.rcxAliases ?? {}) as Record<string, string>;
          return aliases[`u:${user.username}`] ?? null;
        },
        { timeout: 15_000, intervals: [300, 800, 1_500] },
      )
      .toBe(alias);

    // 模拟重装：清掉本地缓存，reload 后登录同步应从服务端把备注名拉回来
    await page.evaluate(() => {
      localStorage.removeItem('rcx-aliases');
      localStorage.removeItem('rcx-name-format');
    });
    await page.reload();
    await page.getByRole('navigation', { name: 'RocketX 主导航' }).waitFor({ timeout: 30_000 });
    await expect(page.getByText('加载会话中…')).toHaveCount(0, { timeout: 30_000 });
    await expect(convButton(page, alias)).toBeVisible({ timeout: 15_000 });
    // 本地缓存也被同步回填
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const raw = localStorage.getItem('rcx-aliases');
          return raw ? (JSON.parse(raw) as Record<string, string>) : null;
        }), { timeout: 10_000 })
      .toMatchObject({ [`u:${user.username}`]: alias });
  });

  test('issue #350 跟进：从设置页导入换服务器地址前被归档的历史备注名', async ({ page }) => {
    const user = await createDmUser('archive');
    const alias = `旧备注${Date.now().toString(36).slice(-4)}`;
    const archiveOwner = `${session.userId}@http://old-ip:3000`;

    await bootLive(page);
    // 种归档：模拟「旧地址 http://old-ip:3000 时期」留下的备注（accountScope 归档格式）
    await page.evaluate(
      ({ owner, username, aliasText }) => {
        localStorage.setItem(`rcx-aliases#${owner}`, JSON.stringify({ [`u:${username}`]: aliasText }));
      },
      { owner: archiveOwner, username: user.username, aliasText: alias },
    );
    await page.reload();
    await page.getByRole('navigation', { name: 'RocketX 主导航' }).waitFor({ timeout: 30_000 });
    await expect(page.getByText('加载会话中…')).toHaveCount(0, { timeout: 30_000 });

    // 设置 → 侧栏 → 导入历史备注
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '侧栏', exact: true }).click();
    await expect(page.getByText('来自旧地址 http://old-ip:3000 的 1 条备注')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: '导入', exact: true }).click();
    await expect(page.getByText('已从 http://old-ip:3000 导入 1 条备注')).toBeVisible();

    // 归档 key 已删
    expect(
      await page.evaluate((owner) => localStorage.getItem(`rcx-aliases#${owner}`), archiveOwner),
    ).toBeNull();

    // 服务端已写回（DDP saveUserPreferences 放行自定义键）
    await expect
      .poll(
        async () => {
          const prefs = await readAdminPreferences();
          const aliases = (prefs.rcxAliases ?? {}) as Record<string, string>;
          return aliases[`u:${user.username}`] ?? null;
        },
        { timeout: 15_000, intervals: [300, 800, 1_500] },
      )
      .toBe(alias);

    // 回到消息列表：DM 会话名已是导入的备注
    // 限定主导航：设置页侧栏里也有同名「消息」分区按钮，全页匹配会撞 strict mode
    await page
      .getByRole('navigation', { name: 'RocketX 主导航' })
      .getByRole('button', { name: '消息', exact: true })
      .click();
    await expect(convButton(page, alias)).toBeVisible({ timeout: 10_000 });
  });

  test('右键菜单不被会话列表自滚瞬关：程序化 scroll 保留，用户滚轮才关闭', async ({ page }) => {
    const user = await createDmUser('menu');

    await bootLive(page);
    await expect(convButton(page, user.name)).toBeVisible({ timeout: 15_000 });

    // 手动 dispatch 带坐标的 contextmenu 弹出菜单（原因同 issue #350 用例）
    const conv = convButton(page, user.name);
    await conv.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 480, clientY: 320 }));
    });
    const menuItem = page.getByRole('button', { name: '设置备注名' });
    await expect(menuItem).toBeVisible();

    // 复现原场景：会话列表因 presence/未读刷新自发滚动。
    // 合成 scroll 事件 + 真实改 scrollTop（浏览器派发 isTrusted 的 scroll 事件）；
    // 旧实现在 document 上 scroll capture 监听「滚动即关闭」，菜单弹出毫秒级就被瞬关。
    await conv.evaluate((el) => {
      el.dispatchEvent(new Event('scroll'));
      const scroller = el.closest('.overflow-y-auto');
      if (scroller) {
        scroller.scrollTop += 1;
        scroller.scrollTop -= 1;
      }
    });
    // 留一拍让潜在的瞬关生效，再断言菜单仍然可见
    await page.waitForTimeout(300);
    await expect(menuItem).toBeVisible();

    // 原语义保留：用户滚轮滚动仍关闭菜单
    await page.mouse.move(120, 400);
    await page.mouse.wheel(0, 120);
    await expect(menuItem).toHaveCount(0);
  });

  test('issue #351：偏好开关写服务端成功后落 rcx-prefs-cache 本地镜像', async ({ page }) => {
    await bootLive(page);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '侧栏', exact: true }).click();

    // 「未读单独置顶」开关（Row inline 布局：label div → min-w-0 → 行容器）
    const row = page
      .getByText('未读单独置顶', { exact: true })
      .locator('xpath=ancestor::div[contains(@class,"justify-between")][1]');
    const toggle = row.getByRole('switch');
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    // 以 UI 实际状态为起点：RC 8.6 的 users.info 不返回 settings.preferences，
    // app 的显式偏好读取在 8.6 上恒为 {}，界面初始值与服务端存量可能不一致，
    // 不能拿服务端值当 UI 预期。
    const before = (await toggle.getAttribute('aria-checked')) === 'true';
    const expected = !before;
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', String(expected));

    // REST 断言：服务端 preferences 已更新
    await expect
      .poll(async () => (await readAdminPreferences()).sidebarShowUnread ?? null, {
        timeout: 15_000,
        intervals: [300, 800, 1_500],
      })
      .toBe(expected);

    // 本地镜像同步写入
    const mirror = await page.evaluate(() => {
      const raw = localStorage.getItem('rcx-prefs-cache');
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    });
    expect(mirror).not.toBeNull();
    expect(mirror?.sidebarShowUnread).toBe(expected);
  });

  test('issue #353：DM 里 @ 出成员候选，无 all/here 广播项、不触发目录搜索', async ({ page }) => {
    const user = await createDmUser('dm');

    await bootLive(page);
    await expect(convButton(page, user.name)).toBeVisible({ timeout: 15_000 });

    // 打开 DM 后再挂网络监听：只统计提及输入期间的目录类请求
    await convButton(page, user.name).click();
    const textbox = page.locator('[data-composer-input]');
    await expect(textbox).toBeVisible();

    const directoryHits: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (
        url.includes('/api/v1/directory') ||
        url.includes('/api/v1/users.list') ||
        url.includes('/api/v1/spotlight')
      ) {
        directoryHits.push(url);
      }
    });

    await textbox.click();
    await textbox.fill(`@${user.username.slice(0, 8)}`);
    const mentionList = page.locator('#composer-mention-list');
    await expect(mentionList).toBeVisible({ timeout: 10_000 });
    // 候选里有 DM 对方
    await expect(mentionList.getByText(`@${user.username}`, { exact: true })).toBeVisible();
    // 没有 all/here 广播项
    await expect(mentionList.getByText('通知所有人', { exact: true })).toHaveCount(0);
    await expect(mentionList.getByText('通知在线成员', { exact: true })).toHaveCount(0);
    await expect(mentionList.getByText('非群成员', { exact: true })).toHaveCount(0);

    // 目录搜索有 250ms 防抖，等足够久确认 DM 不发出目录请求
    await page.waitForTimeout(700);
    expect(directoryHits).toEqual([]);
  });

  test('自动离开：超时自动置 away，活动后恢复 online', async ({ page }) => {
    // idleTimeLimit 调小到服务端允许的最小值缩短等待（RC 校验 idleTimeLimit >= 60s，
    // 更小会被 invalid-idle-time-limit-value 拒绝；执行端 30s 下限只兜直写库的旧数据），
    // enableAutoAway 确保开启；原值由 afterAll 统一还原（DDP saveUserPreferences）
    await ddpSavePreferences({ enableAutoAway: true, idleTimeLimit: 60 });
    await bootLive(page);

    // 之后完全不碰页面，等 60s 无操作超时（轮询放宽到 90s，吃 REST 往返余量）
    await expect
      .poll(async () => readAdminStatus(), { timeout: 90_000, intervals: [2_000, 5_000, 10_000] })
      .toBe('away');

    // 第一次活动 → 自动恢复 online（不写 presencePreference 显式偏好）
    await page.mouse.move(200, 200);
    await expect
      .poll(async () => readAdminStatus(), { timeout: 15_000, intervals: [300, 800, 1_500] })
      .toBe('online');
  });
});
