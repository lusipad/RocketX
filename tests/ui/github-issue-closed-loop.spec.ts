import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
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

test.describe('GitHub Issue Closed-Loop E2E (Read Issue -> Roundtable -> Code & Verify -> Branch/Commit/Push/PR + Comment)', () => {
  test.skip(
    !LIVE_API_KEY,
    'Requires RCX_LIVE_TEST_KEY environment variable for live Pi runtime verification',
  );

  test('真实 GitHub Issue 闭环：导入 #42 -> 圆桌方案 -> 拍板改码验收 -> 切分支提交推送建 PR 并回写评论', async ({
    page,
  }) => {
    test.setTimeout(360_000);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcx-gh-issue-e2e-'));
    const bareRemoteDir = path.join(tempRoot, 'origin.git');
    const repoDir = path.join(tempRoot, 'price-utils');
    const sharedAgentDir = path.join(tempRoot, 'pi-agent');
    const skillsDir = path.join(tempRoot, 'skills');
    const piConfigFile = path.join(tempRoot, 'pi-config.json');
    fs.mkdirSync(sharedAgentDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(ARTIFACT_SCRATCH_DIR, { recursive: true });

    // Real bare remote + local working clone on branch main
    runGit(tempRoot, ['init', '--bare', bareRemoteDir]);
    runGit(tempRoot, ['clone', bareRemoteDir, repoDir]);
    runGit(repoDir, ['checkout', '-B', 'main']);
    runGit(repoDir, ['config', 'user.email', 'e2e@rocketx.local']);
    runGit(repoDir, ['config', 'user.name', 'RocketX E2E']);

    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ name: 'price-utils', version: '1.0.0', type: 'module' }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(repoDir, 'src', 'price.mjs'),
      [
        'export function parsePrice(raw) {',
        '  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;',
        '  return Number(String(raw ?? "").trim());',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(repoDir, 'test', 'price.test.mjs'),
      [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import { parsePrice } from '../src/price.mjs';",
        '',
        "test('parses plain numeric string', () => {",
        "  assert.equal(parsePrice('125.50'), 125.5);",
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', 'chore: initial price parser']);
    runGit(repoDir, ['push', '-u', 'origin', 'main']);

    // Local GitHub REST API server recording real Issue reads, PR creation, and Issue comment writeback
    const recordedPrPayloads: Array<Record<string, unknown>> = [];
    const recordedCommentPayloads: Array<Record<string, unknown>> = [];
    const ghServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && reqUrl.pathname === '/repos/acme/price-utils/issues/42') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            number: 42,
            title: 'parsePrice returns NaN on currency symbols and thousand separators',
            state: 'open',
            user: { login: 'alice' },
            labels: [{ name: 'bug' }],
            assignees: [],
            html_url: 'https://github.com/acme/price-utils/issues/42',
            created_at: '2026-11-26T10:00:00Z',
            updated_at: '2026-11-27T01:00:00Z',
            body: [
              'Calling `parsePrice("¥1,250.50 ")` or `parsePrice("$1,250.50")` currently returns `NaN`.',
              '',
              'Requirements:',
              '- Support leading/trailing whitespace and currency symbols (`¥`, `￥`, `$`, `€`) plus comma thousand separators.',
              '- Invalid strings (e.g. `""`, `"abc"`, `null`, negative if unsupported or preserve negative sign `-¥12.50` cleanly) must return `NaN` when non-numeric.',
              '- Keep edits minimal in `src/price.mjs` and add `node --test` cases in `test/price.test.mjs`.',
            ].join('\n'),
          }),
        );
        return;
      }
      if (
        req.method === 'GET' &&
        reqUrl.pathname === '/repos/acme/price-utils/issues/42/comments'
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              id: 4201,
              user: { login: 'reviewer-bob' },
              body: 'Make sure negative currency strings like "-$99.50" work too, and guard empty strings returning NaN instead of 0.',
              created_at: '2026-11-27T01:00:00Z',
              updated_at: '2026-11-27T01:00:00Z',
              html_url: 'https://github.com/acme/price-utils/issues/42#issuecomment-4201',
            },
          ]),
        );
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const parsedBody = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        if (req.method === 'POST' && reqUrl.pathname === '/repos/acme/price-utils/pulls') {
          recordedPrPayloads.push(parsedBody);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              number: 99,
              html_url: 'https://github.com/acme/price-utils/pull/99',
              title: parsedBody.title,
              state: 'open',
            }),
          );
          return;
        }
        if (
          req.method === 'POST' &&
          reqUrl.pathname === '/repos/acme/price-utils/issues/42/comments'
        ) {
          recordedCommentPayloads.push(parsedBody);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 9901,
              html_url: 'https://github.com/acme/price-utils/issues/42#issuecomment-9901',
              body: parsedBody.body,
            }),
          );
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
      });
    });

    await new Promise<void>((resolve) => ghServer.listen(0, '127.0.0.1', () => resolve()));
    const ghPort = (ghServer.address() as { port: number }).port;
    const ghApiBase = `http://127.0.0.1:${ghPort}`;

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
    const piPackageDir = path.resolve(
      'apps/pi-runtime/node_modules/@earendil-works/pi-coding-agent',
    );
    const childProcesses = new Map<string, { child: ChildProcess; rl: readline.Interface }>();

    await page.exposeFunction(
      '__rcxNodePiSpawn',
      async (sessionId: string, workspaceRoot: string) => {
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
          void page
            .evaluate(
              ({ sid, text }) => {
                (window as any).__rcxPiBrowserHandlers?.get(sid)?.onLine(text);
              },
              { sid: sessionId, text: line },
            )
            .catch(() => undefined);
        });
        child.on('close', (code) => {
          void page
            .evaluate(
              ({ sid, exitCode }) => {
                (window as any).__rcxPiBrowserHandlers?.get(sid)?.onExit(exitCode, 'closed');
              },
              { sid: sessionId, exitCode: code },
            )
            .catch(() => undefined);
        });
        childProcesses.set(sessionId, { child, rl });
        return {
          processId: String(child.pid ?? 1),
          version: '1.5.0',
          runtimeSource: 'bundled' as const,
          managedSkillRoots: [skillsDir],
        };
      },
    );

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
        hasOrigin: true,
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

    // GitHub Issue delivery host drivers backed by real git CLI + local HTTP GitHub API server
    await page.exposeFunction('__rcxGhDetectRepo', async () => ({
      owner: 'acme',
      repo: 'price-utils',
      remoteUrl: 'https://github.com/acme/price-utils.git',
    }));

    await page.exposeFunction(
      '__rcxGhGetIssue',
      async (input: { owner: string; repo: string; number: number }) => {
        const issueResp = await fetch(
          `${ghApiBase}/repos/${input.owner}/${input.repo}/issues/${input.number}`,
        );
        if (!issueResp.ok) throw new Error(`HTTP ${issueResp.status}`);
        const issue = (await issueResp.json()) as any;
        const commentsResp = await fetch(
          `${ghApiBase}/repos/${input.owner}/${input.repo}/issues/${input.number}/comments`,
        );
        const comments = commentsResp.ok ? ((await commentsResp.json()) as any[]) : [];
        return {
          owner: input.owner,
          repo: input.repo,
          number: issue.number,
          title: issue.title,
          body: issue.body || '',
          bodyTruncated: false,
          state: issue.state || 'open',
          author: issue.user?.login || 'alice',
          labels: (issue.labels || []).map((l: any) => l.name),
          assignees: [],
          htmlUrl: issue.html_url,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          comments: comments.map((c) => ({
            id: c.id,
            author: c.user?.login || 'user',
            body: c.body || '',
            createdAt: c.created_at,
            updatedAt: c.updated_at,
            htmlUrl: c.html_url,
          })),
        };
      },
    );

    await page.exposeFunction('__rcxGhDiffWorkspace', async (root: string) => {
      const rawStatus = runGit(root, ['status', '--porcelain']);
      const files = rawStatus
        ? rawStatus
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => ({
              path: line.slice(3).trim(),
              status: line.slice(0, 2).trim() || 'M',
              staged: false,
              unstaged: true,
              additions: 1,
              deletions: 0,
              binary: false,
              patch: '',
              truncated: false,
            }))
        : [];
      return {
        workspaceRoot: root,
        repoTopLevel: root,
        branch: runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
        headSha: runGit(root, ['rev-parse', '--short', 'HEAD']),
        baseRef: 'main',
        compareRef: 'HEAD',
        ahead: 0,
        behind: 0,
        totalAdditions: files.length,
        totalDeletions: 0,
        files,
        truncatedTotal: false,
      };
    });

    await page.exposeFunction(
      '__rcxGhCheckoutBranch',
      async (root: string, branch: string, create = false) => {
        if (create) {
          runGit(root, ['checkout', '-b', branch]);
        } else {
          runGit(root, ['checkout', branch]);
        }
      },
    );

    await page.exposeFunction(
      '__rcxGhCommitChanges',
      async (root: string, message: string, stageAll = true) => {
        if (stageAll) runGit(root, ['add', '-A']);
        runGit(root, ['commit', '-m', message]);
        const sha = runGit(root, ['rev-parse', 'HEAD']);
        return { commitSha: sha, branch: runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']), summary: message };
      },
    );

    await page.exposeFunction(
      '__rcxGhPushBranch',
      async (input: { workspaceRoot: string; branch?: string | null }) => {
        const branch = input.branch || runGit(input.workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const output = runGit(input.workspaceRoot, ['push', '-u', 'origin', branch]);
        return { remote: 'origin', branch, output };
      },
    );

    await page.exposeFunction(
      '__rcxGhCreatePr',
      async (input: { workspaceRoot: string; title: string; body?: string | null }) => {
        const head = runGit(input.workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const resp = await fetch(`${ghApiBase}/repos/acme/price-utils/pulls`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: input.title,
            body: input.body ?? '',
            head,
            base: 'main',
          }),
        });
        const json = (await resp.json()) as { html_url: string };
        return {
          created: true,
          url: json.html_url,
          fallbackCompareUrl: json.html_url,
          message: '已通过 GitHub API 创建 Pull Request',
        };
      },
    );

    await page.exposeFunction(
      '__rcxGhCreateComment',
      async (input: { owner: string; repo: string; number: number; body: string }) => {
        const resp = await fetch(
          `${ghApiBase}/repos/${input.owner}/${input.repo}/issues/${input.number}/comments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: input.body }),
          },
        );
        return resp.json();
      },
    );

    // Stateful Rocket.Chat mock
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
      },
    ];
    const messagesByRid: Record<string, Array<Record<string, any>>> = {
      'room-general': [
        { _id: 'general-init', rid: 'room-general', msg: 'Welcome to General', ts: NOW, u: ALICE },
      ],
    };
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let emitRoomMessage: (rid: string, msg: Record<string, any>) => void = () => {};

    await page.route('**/avatar/**', (route) => route.fulfill({ status: 204 }));
    await page.route('**/api/info', (route) => route.fulfill({ json: { version: '8.6.1' } }));
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const endpoint = url.pathname.split('/api/v1/')[1] ?? '';

      if (endpoint === 'login') {
        return route.fulfill({
          json: { status: 'success', data: { authToken: 'test-token', userId: ME._id, me: ME } },
        });
      }
      if (endpoint === 'settings.public') {
        const id = url.searchParams.get('_id');
        if (id === 'Site_Url') return route.fulfill({ json: { settings: [{ _id: id, value: TEST_SERVER }] } });
        if (id === 'Discussion_enabled') return route.fulfill({ json: { settings: [{ _id: id, value: true }] } });
        return route.fulfill({ json: { settings: [{ _id: id, value: false }] } });
      }
      if (endpoint === 'subscriptions.get') return route.fulfill({ json: { update: subscriptions, remove: [] } });
      if (endpoint === 'rooms.get') return route.fulfill({ json: { update: rooms, remove: [] } });
      if (endpoint === 'commands.list') return route.fulfill({ json: { commands: [] } });
      if (endpoint === 'users.info') return route.fulfill({ json: { user: { ...ME, settings: { preferences: {} } } } });
      if (endpoint === 'users.presence') return route.fulfill({ json: { users: [ME, ALICE] } });
      if (endpoint === 'channels.members' || endpoint === 'groups.members') {
        return route.fulfill({ json: { members: [ME, ALICE], total: 2 } });
      }
      if (endpoint === 'channels.history' || endpoint === 'groups.history') {
        const rid = url.searchParams.get('roomId') || 'room-general';
        return route.fulfill({ json: { messages: [...(messagesByRid[rid] ?? [])].reverse() } });
      }
      if (endpoint === 'rooms.createDiscussion') {
        const body = request.postDataJSON() as { prid: string; t_name: string };
        const discId = `disc-gh-${subscriptions.length}`;
        const ts = new Date().toISOString();
        const discRoom = { _id: discId, t: 'p', prid: body.prid, name: body.t_name, fname: body.t_name, usersCount: 2, lm: ts };
        const discSub = { _id: `sub-${discId}`, rid: discId, t: 'p', prid: body.prid, name: body.t_name, fname: body.t_name, open: true, unread: 0, alert: false, ls: ts };
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
      if (endpoint.endsWith('.roles')) return route.fulfill({ json: { roles: [] } });
      return route.fulfill({ json: { success: true } });
    });

    await page.routeWebSocket('**/websocket', (socket) => {
      const subscribed = new Map<string, string>();
      emitRoomMessage = (rid, msg) => {
        for (const key of [`stream-room-messages:${rid}`, 'stream-room-messages:__my_messages__']) {
          if ([...subscribed.values()].includes(key)) {
            socket.send(JSON.stringify({ msg: 'changed', collection: 'stream-room-messages', fields: { eventName: rid, args: [msg] } }));
          }
        }
      };
      socket.onMessage((raw) => {
        const msg = JSON.parse(String(raw)) as { msg?: string; id?: string; name?: string; params?: string[] };
        if (msg.msg === 'sub' && msg.id) subscribed.set(msg.id, `${msg.name}:${msg.params?.[0]}`);
        if (msg.msg === 'unsub' && msg.id) subscribed.delete(msg.id);
        if (msg.msg === 'connect') socket.send(JSON.stringify({ msg: 'connected', session: 'gh-issue-e2e' }));
        if (msg.msg === 'method' && msg.id) socket.send(JSON.stringify({ msg: 'result', id: msg.id, result: {} }));
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
          checklist: { startedConversation: true, sentMessage: true, notificationsEnabled: true, dismissed: true },
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

      await page.evaluate(async (projectRepoPath) => {
        const load = (p: string) => new Function(`return import(${JSON.stringify(p)})`)();
        const [
          { AppServerController },
          { setCodexAutomationControllerFactory },
          { setWorktreeLifecycleDriversForTests },
          { setGitHubIssueDeliveryDriversForTests },
          { useAgentEnvironments },
          { useCodexWorkspace },
        ] = await Promise.all([
          load('/src/agent/AppServerController.ts'),
          load('/src/agent/codexAutomation.ts'),
          load('/src/agent/worktreeLifecycle.ts'),
          load('/src/agent/githubIssueDelivery.ts'),
          load('/src/stores/agentEnvironments.ts'),
          load('/src/stores/codexWorkspace.ts'),
        ]);

        const env = useAgentEnvironments.getState().ensureEnvironment({
          path: projectRepoPath,
          name: 'price-utils',
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

        setGitHubIssueDeliveryDriversForTests({
          isAvailable: () => true,
          detectWorkspaceRepo: (root: string) => (window as any).__rcxGhDetectRepo(root),
          getIssueDetail: (input: any) => (window as any).__rcxGhGetIssue(input),
          diffWorkspace: (root: string) => (window as any).__rcxGhDiffWorkspace(root),
          checkoutBranch: (root: string, branch: string, create?: boolean) =>
            (window as any).__rcxGhCheckoutBranch(root, branch, create),
          commitChanges: (root: string, message: string, stageAll?: boolean) =>
            (window as any).__rcxGhCommitChanges(root, message, stageAll),
          pushBranch: (input: any) => (window as any).__rcxGhPushBranch(input),
          createPullRequest: (input: any) => (window as any).__rcxGhCreatePr(input),
          createIssueComment: (input: any) => (window as any).__rcxGhCreateComment(input),
        });
      }, repoDir);

      // 1. UI: Open Create AI Discussion -> Import GitHub Issue #42 by number
      await page.getByRole('button', { name: '发起聊天 / 创建群组', exact: true }).click();
      await page.getByRole('button', { name: '创建 AI 讨论组', exact: true }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('acme/price-utils')).toBeVisible({ timeout: 5_000 });

      await dialog.getByPlaceholder('输入 #42、owner/repo#42 或 Issue URL').fill('#42');
      await dialog.getByRole('button', { name: '读取 Issue' }).click();

      await expect(dialog.locator('textarea')).toHaveValue(/\[GitHub Issue #42\]/, { timeout: 10_000 });
      await expect(dialog.locator('textarea')).toHaveValue(/reviewer-bob/, { timeout: 5_000 });
      await expect(dialog.locator('input[maxlength="40"]')).toHaveValue(/#42 parsePrice/);

      await dialog.getByRole('button', { name: '创建 AI 讨论组', exact: true }).click();

      // 2. Live 4-role Roundtable debates Issue #42 -> renders Decision Card with GitHub #42 pill
      await expect(page.locator('.rocketx-agent-answer-provider', { hasText: '主理人' })).toBeVisible({
        timeout: 120_000,
      });
      await expect(page.getByRole('link', { name: 'GitHub #42' })).toBeVisible({ timeout: 15_000 });
      const approveBtn = page.getByRole('button', { name: '拍板并交付执行' });
      await expect(approveBtn).toBeVisible({ timeout: 15_000 });

      // 3. Approve -> Architect modifies src/price.mjs & test/price.test.mjs -> Contrarian verifies
      await approveBtn.click();
      await expect(page.locator('.rocketx-agent-answer-note', { hasText: '施工交付' })).toBeVisible({
        timeout: 120_000,
      });
      await expect(page.locator('.rocketx-agent-answer-note', { hasText: '独立验收通过' })).toBeVisible({
        timeout: 120_000,
      });

      const testOut = execFileSync(process.execPath, ['--test', 'test/price.test.mjs'], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      console.log('[REAL GITHUB ISSUE NODE TEST OUTPUT]\n' + testOut);

      // 4. Click "提交并创建 PR (Closes #42)" right on the Decision Card -> full Git push + PR + Comment
      const deliverPrBtn = page.getByRole('button', { name: '提交并创建 PR (Closes #42)' });
      await expect(deliverPrBtn).toBeEnabled({ timeout: 15_000 });
      await deliverPrBtn.click();

      await expect(page.getByRole('link', { name: '查看已创建 PR' })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/已回写 Issue 评论/)).toBeVisible({ timeout: 10_000 });
      await page.screenshot({
        path: path.join(ARTIFACT_SCRATCH_DIR, '05-github-issue-closed-loop.png'),
        animations: 'disabled',
      });

      // Assert real git branch created & pushed to bare origin.git, plus HTTP PR & Issue comment payloads
      expect(runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('fix/issue-42');
      expect(runGit(bareRemoteDir, ['rev-parse', '--verify', 'refs/heads/fix/issue-42'])).toBeTruthy();

      expect(recordedPrPayloads).toHaveLength(1);
      expect(String(recordedPrPayloads[0].head)).toBe('fix/issue-42');
      expect(String(recordedPrPayloads[0].base)).toBe('main');
      expect(String(recordedPrPayloads[0].body)).toContain('Closes #42');

      expect(recordedCommentPayloads).toHaveLength(1);
      expect(String(recordedCommentPayloads[0].body)).toContain('https://github.com/acme/price-utils/pull/99');

      expect(pageErrors).toEqual([]);
    } finally {
      for (const { child, rl } of childProcesses.values()) {
        rl.close();
        if (child.exitCode === null) child.kill();
      }
      childProcesses.clear();
      await new Promise<void>((resolve) => ghServer.close(() => resolve()));
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
