import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { expect, test } from '@playwright/test';

const LIVE_API_KEY = process.env.RCX_LIVE_TEST_KEY?.trim() || '';
const TEST_SERVER = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';
const ARTIFACT_SCRATCH_DIR =
  'C:/Users/lus/.gemini/antigravity/brain/846aa217-5a0d-4d8a-80d2-ba883d503839/scratch';

const ME = {
  _id: 'user-me',
  username: 'tester',
  name: 'Test User',
  status: 'online',
  roles: ['admin'],
};
const ALICE = { _id: 'user-alice', username: 'alice', name: 'Alice', status: 'online' };

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test.describe('Real Scenario E2E: AI Roundtable -> Approve -> Code & Test -> Contrarian Verify -> Drag to Group', () => {
  test.skip(!LIVE_API_KEY, 'Requires RCX_LIVE_TEST_KEY environment variable for live Pi runtime verification');

  test('真实场景全流程：建 AI 圆桌讨论真实代码 -> 点击拍板改代码跑单测 -> 挑刺官独立验收 -> 拖入普通群 @追问', async ({
    page,
  }) => {
    test.setTimeout(360_000);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-real-scene-e2e-'));
    const repoDir = path.join(tempRoot, 'order-pricing-service');
    const sharedAgentDir = path.join(tempRoot, 'pi-agent');
    const skillsDir = path.join(tempRoot, 'skills');
    const piConfigFile = path.join(tempRoot, 'pi-config.json');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'test'), { recursive: true });
    fs.mkdirSync(sharedAgentDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(ARTIFACT_SCRATCH_DIR, { recursive: true });

    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ name: 'order-pricing-service', version: '1.0.0', type: 'module' }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(repoDir, 'src', 'checkout.mjs'),
      [
        'export function calculateCheckout(items, coupon = null) {',
        '  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);',
        '  let discount = 0;',
        "  if (coupon?.type === 'AMOUNT_OFF') {",
        '    discount = coupon.value;',
        "  } else if (coupon?.type === 'PERCENT_OFF') {",
        '    discount = subtotal * (coupon.value / 100);',
        '  }',
        '  return {',
        '    subtotal,',
        '    tierDiscount: 0,',
        '    couponDiscount: discount,',
        '    total: Math.max(0, subtotal - discount),',
        '  };',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(repoDir, 'test', 'checkout.test.mjs'),
      [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import { calculateCheckout } from '../src/checkout.mjs';",
        '',
        "test('calculates base subtotal without coupon', () => {",
        '  const res = calculateCheckout([{ price: 40, qty: 2 }]);',
        '  assert.equal(res.subtotal, 80);',
        '  assert.equal(res.total, 80);',
        '});',
        '',
        "test('clamps total at zero when AMOUNT_OFF exceeds subtotal', () => {",
        "  const res = calculateCheckout([{ price: 30, qty: 1 }], { type: 'AMOUNT_OFF', value: 50 });",
        '  assert.equal(res.total, 0);',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );

    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'e2e@rocketx.local']);
    runGit(repoDir, ['config', 'user.name', 'RocketX E2E']);
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', 'chore: baseline order pricing service']);

    fs.writeFileSync(
      piConfigFile,
      JSON.stringify({
        provider: 'custom-openai',
        apiProtocol: 'openai-completions',
        baseUrl: 'https://api.shuaiapi.com',
        defaultModel: 'deepseek-v4.1-flash-1017',
        extraModels: ['deepseek-flash'],
      }),
      'utf8',
    );

    const serverScript = path.resolve('apps/desktop/src-tauri/src/pi_app_server.mjs');
    const piPackageDir = path.resolve('apps/pi-runtime/node_modules/@earendil-works/pi-coding-agent');
    const childProcesses = new Map<string, { child: ChildProcess; rl: readline.Interface }>();

    // Node <-> Browser Pi process bridge & real Git command bridge
    await page.exposeFunction('__rcxNodePiSpawn', async (sessionId: string, workspaceRoot: string) => {
      const child = spawn(
        process.execPath,
        [
          serverScript,
          '--pi-package-dir',
          piPackageDir,
          '--agent-dir',
          sharedAgentDir,
          '--config-file',
          piConfigFile,
          '--workspace-root',
          workspaceRoot,
        ],
        {
          cwd: workspaceRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ROCKETX_PI_API_KEY: LIVE_API_KEY },
        },
      );
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        void page.evaluate(
          ({ sid, text }) => {
            (window as any).__rcxPiBrowserHandlers?.get(sid)?.onLine(text);
          },
          { sid: sessionId, text: line },
        ).catch(() => undefined);
      });
      child.on('close', (code) => {
        void page.evaluate(
          ({ sid, exitCode }) => {
            (window as any).__rcxPiBrowserHandlers?.get(sid)?.onExit(exitCode, 'closed');
          },
          { sid: sessionId, exitCode: code },
        ).catch(() => undefined);
      });
      childProcesses.set(sessionId, { child, rl });
      return {
        processId: String(child.pid ?? 1),
        version: '1.5.0',
        runtimeSource: 'bundled' as const,
        managedSkillRoots: [skillsDir],
      };
    });

    await page.exposeFunction('__rcxNodePiWrite', async (sessionId: string, jsonLine: string) => {
      const entry = childProcesses.get(sessionId);
      if (entry?.child.stdin && !entry.child.stdin.destroyed) {
        entry.child.stdin.write(`${jsonLine}\n`);
      }
    });

    await page.exposeFunction('__rcxNodePiStop', async (sessionId: string) => {
      const entry = childProcesses.get(sessionId);
      if (!entry) return;
      entry.rl.close();
      entry.child.stdout?.resume();
      entry.child.stderr?.resume();
      if (entry.child.exitCode === null) entry.child.kill();
      childProcesses.delete(sessionId);
    });

    await page.exposeFunction('__rcxGitInspect', async (root: string) => {
      const rawStatus = runGit(root, ['status', '--porcelain']);
      const dirtyFiles = rawStatus ? rawStatus.split(/\r?\n/).filter(Boolean) : [];
      return {
        isGitRepo: true,
        repoTopLevel: root,
        branch: runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
        headSha: runGit(root, ['rev-parse', '--short', 'HEAD']),
        hasOrigin: false,
        hasGh: false,
        isWorktree: false,
        dirtyFiles,
        diffStat: null,
        recentCommits: [],
      };
    });

    await page.exposeFunction('__rcxGitCheckpoint', async (root: string, label: string) => {
      const safeTag = `cp-${label.replace(/[^A-Za-z0-9_-]/g, '-')}-${Date.now()}`;
      const sha = runGit(root, ['rev-parse', 'HEAD']);
      runGit(root, ['tag', safeTag, sha]);
      return { id: safeTag };
    });

    // Stateful Rocket.Chat mock supporting discussion creation, live room messages, and DDP events
    const NOW = new Date().toISOString();
    const subscriptions: Array<Record<string, any>> = [
      {
        _id: 'sub-general',
        rid: 'room-general',
        t: 'c',
        name: 'general',
        fname: 'General',
        open: true,
        unread: 0,
        alert: false,
        ls: NOW,
      },
    ];
    const rooms: Array<Record<string, any>> = [
      {
        _id: 'room-general',
        t: 'c',
        name: 'general',
        fname: 'General',
        usersCount: 2,
        lm: NOW,
        lastMessage: {
          _id: 'general-init',
          rid: 'room-general',
          msg: 'Welcome to General',
          ts: NOW,
          u: ALICE,
        },
      },
    ];
    const messagesByRid: Record<string, Array<Record<string, any>>> = {
      'room-general': [
        {
          _id: 'general-init',
          rid: 'room-general',
          msg: 'Welcome to General',
          ts: NOW,
          u: ALICE,
        },
      ],
    };
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[BROWSER CONSOLE ERROR]', msg.text());
    });

    let emitRoomMessage: (rid: string, msg: Record<string, any>) => void = () => {};

    await page.route('**/avatar/**', (route) => route.fulfill({ status: 204 }));
    await page.route('**/api/info', (route) => route.fulfill({ json: { version: '8.6.1' } }));
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const endpoint = url.pathname.split('/api/v1/')[1] ?? '';

      if (endpoint === 'login') {
        return route.fulfill({
          json: {
            status: 'success',
            data: { authToken: 'test-token', userId: ME._id, me: ME },
          },
        });
      }
      if (endpoint === 'settings.public') {
        const id = url.searchParams.get('_id');
        if (id === 'Site_Url') {
          return route.fulfill({ json: { settings: [{ _id: id, value: TEST_SERVER }] } });
        }
        if (id === 'Discussion_enabled') {
          return route.fulfill({ json: { settings: [{ _id: id, value: true }] } });
        }
        return route.fulfill({ json: { settings: [{ _id: id, value: false }] } });
      }
      if (endpoint === 'subscriptions.get') {
        return route.fulfill({ json: { update: subscriptions, remove: [] } });
      }
      if (endpoint === 'rooms.get') {
        return route.fulfill({ json: { update: rooms, remove: [] } });
      }
      if (endpoint === 'commands.list') {
        return route.fulfill({ json: { commands: [] } });
      }
      if (endpoint === 'users.info') {
        return route.fulfill({ json: { user: { ...ME, settings: { preferences: {} } } } });
      }
      if (endpoint === 'users.presence') {
        return route.fulfill({ json: { users: [ME, ALICE] } });
      }
      if (endpoint === 'channels.members' || endpoint === 'groups.members') {
        return route.fulfill({ json: { members: [ME, ALICE], total: 2 } });
      }
      if (endpoint === 'channels.history' || endpoint === 'groups.history') {
        const rid = url.searchParams.get('roomId') || 'room-general';
        return route.fulfill({ json: { messages: [...(messagesByRid[rid] ?? [])].reverse() } });
      }
      if (endpoint === 'rooms.createDiscussion') {
        const body = request.postDataJSON() as { prid: string; t_name: string };
        const discId = `disc-live-${subscriptions.length}`;
        const ts = new Date().toISOString();
        const discRoom = {
          _id: discId,
          t: 'p',
          prid: body.prid,
          name: body.t_name,
          fname: body.t_name,
          usersCount: 2,
          lm: ts,
        };
        const discSub = {
          _id: `sub-${discId}`,
          rid: discId,
          t: 'p',
          prid: body.prid,
          name: body.t_name,
          fname: body.t_name,
          open: true,
          unread: 0,
          alert: false,
          ls: ts,
        };
        rooms.push(discRoom);
        subscriptions.push(discSub);
        messagesByRid[discId] = [];
        return route.fulfill({ json: { discussion: discRoom } });
      }
      if (endpoint === 'rooms.info') {
        const rid = url.searchParams.get('roomId');
        const found = rooms.find((r) => r._id === rid);
        return route.fulfill({ json: { room: found ?? rooms[0] } });
      }
      if (endpoint === 'chat.sendMessage') {
        const body = request.postDataJSON() as { message: Record<string, any> };
        const rid = String(body.message.rid || 'room-general');
        const created = {
          _id: String(body.message._id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
          rid,
          msg: String(body.message.msg ?? ''),
          tmid: body.message.tmid,
          ts: new Date().toISOString(),
          u: ME,
        };
        if (!messagesByRid[rid]) messagesByRid[rid] = [];
        messagesByRid[rid].push(created);
        emitRoomMessage(rid, created);
        return route.fulfill({ json: { success: true, message: created } });
      }
      if (endpoint === 'chat.getMessage') {
        const msgId = url.searchParams.get('msgId');
        const foundMsg = Object.values(messagesByRid).flat().find((m) => m._id === msgId);
        return foundMsg
          ? route.fulfill({ json: { message: foundMsg } })
          : route.fulfill({ status: 404, json: { message: null } });
      }
      if (endpoint.endsWith('.roles')) {
        return route.fulfill({ json: { roles: [] } });
      }
      return route.fulfill({ json: { success: true } });
    });

    await page.routeWebSocket('**/websocket', (socket) => {
      const subscribed = new Map<string, string>();
      emitRoomMessage = (rid, msg) => {
        for (const key of [`stream-room-messages:${rid}`, 'stream-room-messages:__my_messages__']) {
          if ([...subscribed.values()].includes(key)) {
            socket.send(
              JSON.stringify({
                msg: 'changed',
                collection: 'stream-room-messages',
                fields: { eventName: rid, args: [msg] },
              }),
            );
          }
        }
      };
      socket.onMessage((raw) => {
        const msg = JSON.parse(String(raw)) as { msg?: string; id?: string; name?: string; params?: string[] };
        if (msg.msg === 'sub' && msg.id) subscribed.set(msg.id, `${msg.name}:${msg.params?.[0]}`);
        if (msg.msg === 'unsub' && msg.id) subscribed.delete(msg.id);
        if (msg.msg === 'connect') socket.send(JSON.stringify({ msg: 'connected', session: 'live-e2e' }));
        if (msg.msg === 'method' && msg.id) {
          socket.send(JSON.stringify({ msg: 'result', id: msg.id, result: {} }));
        }
      });
    });

    await page.addInitScript(({ server, userId }) => {
      localStorage.setItem('rcx-server', server);
      localStorage.setItem('rcx-auth', JSON.stringify({ authToken: 'test-token', userId }));
      localStorage.setItem('rcx-owner', `${userId}@${server}`);
      localStorage.setItem(
        `rcx-onboarding-v1:${encodeURIComponent(server)}:${userId}`,
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
    }, { server: TEST_SERVER, userId: ME._id });

    try {
      await page.goto('/');
      await page.getByRole('navigation', { name: 'RocketX 主导航' }).waitFor();
      await page.waitForFunction(async () => {
        const load = new Function('return import("/src/stores/ui.ts")');
        const { useUI } = await load();
        return useUI.getState().startupStage === 'background-ready';
      });

      // Install live Node Pi bridge + real Git lifecycle drivers inside Chromium app modules
      await page.evaluate(async (projectRepoPath) => {
        const load = (p: string) => new Function(`return import(${JSON.stringify(p)})`)();
        const [
          { AppServerClient },
          { AppServerController },
          { setCodexAutomationControllerFactory },
          { setWorktreeLifecycleDriversForTests },
          { useAgentEnvironments },
          { useCodexWorkspace },
        ] = await Promise.all([
          load('/src/agent/protocol/client.ts'),
          load('/src/agent/AppServerController.ts'),
          load('/src/agent/codexAutomation.ts'),
          load('/src/agent/worktreeLifecycle.ts'),
          load('/src/stores/agentEnvironments.ts'),
          load('/src/stores/codexWorkspace.ts'),
        ]);

        const env = useAgentEnvironments.getState().ensureEnvironment({
          path: projectRepoPath,
          name: 'order-pricing-service',
        });
        useAgentEnvironments.getState().rememberDispatchEnvironment(env.id);
        useCodexWorkspace.setState({
          workspaceRoot: projectRepoPath,
          defaultWorkspaceRoot: projectRepoPath,
          status: 'idle',
        });

        (window as any).__rcxPiBrowserHandlers = new Map();
        setCodexAutomationControllerFactory((opts: any) =>
          new AppServerController({
            ...opts,
            transportFactory: (sessionId: string, workspaceRoot: string) => ({
              async start(handlers: any) {
                (window as any).__rcxPiBrowserHandlers.set(sessionId, handlers);
                return (window as any).__rcxNodePiSpawn(sessionId, workspaceRoot);
              },
              async write(msg: unknown) {
                await (window as any).__rcxNodePiWrite(sessionId, JSON.stringify(msg));
              },
              async stop() {
                await (window as any).__rcxNodePiStop(sessionId);
                (window as any).__rcxPiBrowserHandlers.delete(sessionId);
              },
            }),
          }),
        );

        setWorktreeLifecycleDriversForTests({
          isDesktop: () => true,
          inspectGit: (root: string) => (window as any).__rcxGitInspect(root),
          createCheckpoint: (root: string, label: string) => (window as any).__rcxGitCheckpoint(root, label),
          listWorktrees: async () => [],
          removeWorktree: async () => undefined,
        });
      }, repoDir);

      // ACT 1: UI Create AI Roundtable Discussion Group
      await page.getByRole('button', { name: '发起聊天 / 创建群组', exact: true }).click();
      await page.getByRole('button', { name: '创建 AI 讨论组', exact: true }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('button', { hasText: '产品设计' }).first()).toBeVisible();
      await expect(dialog.locator('button', { hasText: '架构工程' }).first()).toBeVisible();
      await expect(dialog.locator('button', { hasText: '挑刺官' }).first()).toBeVisible();
      await expect(dialog.locator('button', { hasText: '主理人' }).first()).toBeVisible();

      await dialog.locator('input[maxlength="40"]').fill('结账满减与折扣方案圆桌');
      await dialog
        .locator('textarea')
        .fill(
          '给 src/checkout.mjs 增加阶梯满减（满 100 减 10，满 200 减 30），明确先算满减还是先算折扣券（PERCENT_OFF / AMOUNT_OFF），保证金额两位小数精度和总价不小于 0 边界，并补齐 test/checkout.test.mjs 的 node --test 单测。',
        );
      await dialog.getByRole('button', { name: '创建 AI 讨论组', exact: true }).click();

      // ACT 2: Watch real 4-role Roundtable relay in DOM + clickable Decision Card
      await expect(page.locator('.rocketx-agent-answer-provider', { hasText: '产品设计' })).toBeVisible({ timeout: 90_000 });
      await expect(page.locator('.rocketx-agent-answer-provider', { hasText: '架构工程' })).toBeVisible({ timeout: 90_000 });
      await expect(page.locator('.rocketx-agent-answer-provider', { hasText: '挑刺官' })).toBeVisible({ timeout: 90_000 });
      await expect(page.locator('.rocketx-agent-answer-provider', { hasText: '主理人' })).toBeVisible({ timeout: 90_000 });

      const approveBtn = page.getByRole('button', { name: '拍板并交付执行' });
      await expect(approveBtn).toBeVisible({ timeout: 15_000 });
      await page.screenshot({
        path: path.join(ARTIFACT_SCRATCH_DIR, '01-roundtable-decision-card.png'),
        animations: 'disabled',
      });

      // Discussion phase must stay 100% read-only on disk
      expect(runGit(repoDir, ['status', '--porcelain'])).toBe('');

      // ACT 3: Click Approve & Execute -> Real coding -> Tests -> Contrarian independent verification
      await approveBtn.click();

      await expect(page.locator('.rocketx-agent-answer-note', { hasText: '施工交付' })).toBeVisible({
        timeout: 120_000,
      });
      await expect(page.locator('.rocketx-agent-answer-note', { hasText: /独立验收/ })).toBeVisible({
        timeout: 120_000,
      });
      await page.screenshot({
        path: path.join(ARTIFACT_SCRATCH_DIR, '02-execution-and-verification.png'),
        animations: 'disabled',
      });

      // Verify on real disk: code was genuinely edited, unit tests pass, zero worktree explosion!
      const modifiedFiles = runGit(repoDir, ['status', '--porcelain']);
      expect(modifiedFiles).toContain('checkout.mjs');
      const testRunOut = execFileSync(process.execPath, ['--test', 'test/checkout.test.mjs'], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      console.log('[REAL NODE TEST OUTPUT ON DISK]\n' + testRunOut);
      const worktreeLines = runGit(repoDir, ['worktree', 'list', '--porcelain'])
        .split(/\r?\n/)
        .filter((l) => l.startsWith('worktree '));
      expect(worktreeLines).toHaveLength(1);

      // ACT 4: Drag the AI Discussion Group onto General (with Shift) + @ mention Q&A
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button[draggable="true"]'));
        const sourceBtn = buttons.find((b) => b.textContent?.includes('结账满减与折扣方案圆桌'));
        const targetBtn = buttons.find((b) => b.textContent?.includes('General'));
        if (!sourceBtn || !targetBtn) {
          throw new Error('Could not locate draggable discussion or General row in sidebar');
        }
        const dt = new DataTransfer();
        const startEvt = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
        sourceBtn.dispatchEvent(startEvt);
        const overEvt = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
        targetBtn.dispatchEvent(overEvt);
        const dropEvt = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          shiftKey: true,
        });
        targetBtn.dispatchEvent(dropEvt);
      });

      // Composer in General should receive distilled decision handoff draft
      const composerBox = page.locator('textarea');
      await expect(composerBox).toHaveValue(/圆桌决议摘要/, { timeout: 10_000 });
      await page.screenshot({
        path: path.join(ARTIFACT_SCRATCH_DIR, '03-dragged-into-general.png'),
        animations: 'disabled',
      });

      // Verify @ autocomplete lists role seats cleanly in General
      await composerBox.click();
      await composerBox.fill('');
      await composerBox.pressSequentially('@');
      await expect(page.getByText('@架构工程', { exact: false }).first()).toBeVisible({ timeout: 5_000 });

      // Clear draft & ask @架构工程 about the code it just modified
      await composerBox.fill('@架构工程 一句话说明刚修改的 src/checkout.mjs 里满减与优惠券的计算顺序是什么？');
      await composerBox.press('Enter');

      await expect(
        page.locator('.rocketx-agent-answer-provider', { hasText: '架构工程' }),
      ).toBeVisible({ timeout: 60_000 });
      await page.screenshot({
        path: path.join(ARTIFACT_SCRATCH_DIR, '04-group-followup-architect.png'),
        animations: 'disabled',
      });

      expect(pageErrors).toEqual([]);
    } finally {
      for (const { child, rl } of childProcesses.values()) {
        rl.close();
        if (child.exitCode === null) child.kill();
      }
      childProcesses.clear();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
