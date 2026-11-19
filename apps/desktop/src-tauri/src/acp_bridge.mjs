#!/usr/bin/env node
/**
 * RocketX Universal ACP (Agent Client Protocol v1) Stdio Bridge
 *
 * Translates ACP JSON-RPC 2.0 NDJSON over stdin/stdout into native CLI turns
 * for local tools that do not yet speak ACP natively:
 *   - codex       (OpenAI Codex CLI: `codex exec --json`)
 *   - claude      (Claude Code CLI: `claude -p --output-format stream-json`)
 *   - antigravity (Google Antigravity `language_server.exe agentapi`)
 *   - dsh         (DeepSeek Harness: `dsh headless --json`)
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export function parseBridgeArgs(argv) {
  let adapter = 'codex';
  let binPath = '';
  let defaultCwd = process.cwd();
  let resumeSessionId = null;
  let probe = false;
  const extraArgs = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      extraArgs.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--adapter' && i + 1 < argv.length) {
      adapter = String(argv[++i]).trim().toLowerCase();
    } else if (arg === '--bin' && i + 1 < argv.length) {
      binPath = String(argv[++i]).trim();
    } else if (arg === '--cwd' && i + 1 < argv.length) {
      defaultCwd = String(argv[++i]).trim();
    } else if (arg === '--resume-session' && i + 1 < argv.length) {
      resumeSessionId = String(argv[++i]).trim();
    } else if (arg === '--probe') {
      probe = true;
    } else {
      extraArgs.push(arg);
    }
    i += 1;
  }

  return { adapter, binPath, defaultCwd, extraArgs, resumeSessionId, probe };
}

const ANTIGRAVITY_PROBE_ID = '00000000-0000-0000-0000-000000000000';
const ANTIGRAVITY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANTIGRAVITY_UNAVAILABLE = '尚未连接到 Antigravity：请先打开并登录 Antigravity，再在 RocketX 中重新连接。';

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}

function validCsrfToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/\s/.test(value);
}

export function validateAntigravityHubCandidate(hub, { filename, mtimeMs, processInfo, serverPath, nowMs = Date.now() }) {
  if (!hub || !validPid(hub.pid) || !validPort(hub.httpPort) || !validPort(hub.httpsPort)
      || typeof hub.lsVersion !== 'string' || !hub.lsVersion.trim() || !validCsrfToken(hub.csrfToken)) return null;
  if (path.win32.basename(filename) !== `hub_${hub.httpPort}.json` || !processInfo || processInfo.pid !== hub.pid) return null;
  if (!path.win32.isAbsolute(serverPath) || !path.win32.isAbsolute(processInfo.path || '')
      || path.win32.normalize(processInfo.path).toLowerCase() !== path.win32.normalize(serverPath).toLowerCase()) return null;
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(processInfo.startedAtMs)
      || processInfo.startedAtMs > nowMs + 2000 || mtimeMs < processInfo.startedAtMs - 2000 || mtimeMs > nowMs + 2000) return null;
  return { address: `127.0.0.1:${hub.httpPort}`, csrfToken: hub.csrfToken, pid: hub.pid, serverPath, startedAtMs: processInfo.startedAtMs };
}

async function readAntigravityProcess(pid) {
  if (!validPid(pid)) return null;
  const script = `$ErrorActionPreference='Stop'; try { $p=Get-Process -Id ${pid} -ErrorAction Stop; @{pid=$p.Id;path=$p.Path;startedAtMs=([DateTimeOffset]::new($p.StartTime.ToUniversalTime())).ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress } catch { exit 1 }`;
  return new Promise((resolve) => {
    let output = '';
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { killChildTree(child); resolve(null); }, 3000);
    child.stdout.on('data', (chunk) => { if (output.length < 16384) output += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { resolve(code === 0 ? JSON.parse(output) : null); } catch { resolve(null); }
    });
  });
}

function antigravityServerPath(binPath, env, platform) {
  const paths = platform === 'win32' ? path.win32 : path;
  if (/^language_server(?:[._-].*)?$/i.test(paths.basename(binPath)) && paths.isAbsolute(binPath)) return binPath;
  if (/^agentapi(?:\.(?:bat|cmd|exe))?$/i.test(paths.basename(binPath))) {
    const candidates = [env.ANTIGRAVITY_AGENTAPI_EXE, paths.join(paths.dirname(binPath), 'language_server.exe'), paths.join(paths.dirname(binPath), '..', 'resources', 'bin', 'language_server.exe')];
    for (const candidate of candidates) {
      if (candidate && paths.isAbsolute(candidate) && /^language_server(?:[._-].*)?$/i.test(paths.basename(candidate)) && fs.existsSync(candidate)) return paths.normalize(candidate);
    }
  }
  throw new Error('Antigravity 执行入口不可用：请重新扫描本机并选择 Antigravity 的 language_server 执行器。');
}

export async function resolveAntigravityConnection(config, { env = process.env, platform = process.platform, homeDir = os.homedir(), readProcess = readAntigravityProcess } = {}) {
  const address = env.ANTIGRAVITY_LS_ADDRESS;
  const csrfToken = env.ANTIGRAVITY_CSRF_TOKEN;
  const binPath = antigravityServerPath(config.binPath, env, platform);
  if (address || csrfToken) {
    const match = typeof address === 'string' && /^(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$/.exec(address);
    if (!match || !validPort(Number(match[1])) || !validCsrfToken(csrfToken)) {
      throw new Error('Antigravity 的本地连接配置不完整或无效，请在 Antigravity 启动环境中重新连接。');
    }
    return { binPath, prefixArgs: ['agentapi'], env: { ...env }, source: 'environment' };
  }
  if (platform !== 'win32') throw new Error(ANTIGRAVITY_UNAVAILABLE);
  const directory = path.join(homeDir, '.gemini', 'antigravity', 'daemon');
  let files;
  try { files = fs.readdirSync(directory).filter((name) => /^hub_[0-9]{1,5}\.json$/.test(name)); } catch { throw new Error(ANTIGRAVITY_UNAVAILABLE); }
  if (files.length > 64) throw new Error('Antigravity 的本地连接记录过多，无法可靠确认服务，请重启 Antigravity 后重新连接。');
  const candidates = (await Promise.all(files.map(async (filename) => {
    try {
      const hubPath = path.join(directory, filename);
      const stat = fs.lstatSync(hubPath);
      if (!stat.isFile() || stat.size > 16384) return null;
      const hub = JSON.parse(fs.readFileSync(hubPath, 'utf8'));
      if (!validPid(hub.pid)) return null;
      const processInfo = await readProcess(hub.pid);
      return validateAntigravityHubCandidate(hub, { filename, mtimeMs: stat.mtimeMs, processInfo, serverPath: binPath });
    } catch { return null; }
  }))).filter(Boolean);
  if (candidates.length === 0) throw new Error(ANTIGRAVITY_UNAVAILABLE);
  if (candidates.length !== 1) throw new Error('检测到多个 Antigravity 本地服务，无法确定会话归属。请关闭多余的 Antigravity 实例后重新连接。');
  const candidate = candidates[0];
  return { binPath, prefixArgs: ['agentapi'], env: { ...env, ANTIGRAVITY_LS_ADDRESS: candidate.address, ANTIGRAVITY_CSRF_TOKEN: candidate.csrfToken }, source: 'hub', pid: candidate.pid, startedAtMs: candidate.startedAtMs };
}

function adapterTitle(adapter) {
  switch (adapter) {
    case 'codex':
      return 'OpenAI Codex CLI';
    case 'claude':
      return 'Claude Code';
    case 'antigravity':
      return 'Google Antigravity';
    case 'dsh':
      return 'DeepSeek Harness';
    default:
      return `ACP Bridge (${adapter})`;
  }
}

function quoteCmdToken(token) {
  const s = String(token ?? '');
  if (s.length === 0) return '""';
  if (!/[\s"&|<>^()%!]/.test(s)) {
    return s;
  }
  return `"${s.replace(/"/g, '\\"')}"`;
}

function quoteCmdCommandLine(parts) {
  return parts.map(quoteCmdToken).join(' ');
}

function spawnCli(binPath, args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: options.stdio || ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binPath)) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const cmdLine = quoteCmdCommandLine([binPath, ...args]);
    return spawn(comspec, ['/d', '/s', '/c', `"${cmdLine}"`], {
      ...spawnOptions,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(binPath, args, spawnOptions);
}

function killChildTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.unref();
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

function extractPromptText(promptBlocks) {
  if (!Array.isArray(promptBlocks)) {
    return typeof promptBlocks === 'string' ? promptBlocks : '';
  }
  const chunks = [];
  for (const block of promptBlocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      chunks.push(block.text);
    } else if (block.type === 'resource' && block.resource && typeof block.resource.text === 'string') {
      const uri = block.resource.uri ? ` (${block.resource.uri})` : '';
      chunks.push(`[上下文资源${uri}]\n${block.resource.text}`);
    } else if (block.type === 'resource_link' && typeof block.uri === 'string') {
      chunks.push(`[引用资源: ${block.name || block.uri} -> ${block.uri}]`);
    }
  }
  return chunks.join('\n\n').trim();
}

function createModeState(currentModeId = 'confirm') {
  return {
    currentModeId,
    availableModes: [
      {
        id: 'confirm',
        name: '确认后执行',
        description: '写入文件或执行命令前请求确认',
      },
      {
        id: 'auto',
        name: '自动执行',
        description: '在当前工作区内自动执行工具与变更',
      },
      {
        id: 'plan',
        name: '仅规划只读',
        description: '只读分析与规划，不修改工作区文件',
      },
    ],
  };
}

export class AcpBridgeServer {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.nextHostReqId = 1;
    this.pendingHostRequests = new Map();
    this.rl = null;
  }

  sendJson(obj) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  sendResult(id, result) {
    this.sendJson({ jsonrpc: '2.0', id, result: result ?? {} });
  }

  sendError(id, code, message, data) {
    this.sendJson({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message: String(message || 'Internal bridge error'),
        ...(data !== undefined ? { data } : {}),
      },
    });
  }

  sendNotify(method, params) {
    this.sendJson({ jsonrpc: '2.0', method, params });
  }

  sendSessionUpdate(sessionId, update) {
    this.sendNotify('session/update', { sessionId, update });
  }

  emitAgentText(sessionId, text) {
    if (!text) return;
    this.sendSessionUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
  }

  emitAgentThought(sessionId, text) {
    if (!text) return;
    this.sendSessionUpdate(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text },
    });
  }

  requestHost(method, params) {
    const id = `bridge-host-${this.nextHostReqId++}`;
    return new Promise((resolve, reject) => {
      this.pendingHostRequests.set(id, { resolve, reject });
      this.sendJson({ jsonrpc: '2.0', id, method, params });
    });
  }

  async ensureTurnPermission(session, promptText) {
    if (session.mode !== 'confirm' || session.alwaysAllowed) {
      return { allowed: true, forceReadonly: session.mode === 'plan' };
    }
    const preview = promptText.replace(/\s+/g, ' ').slice(0, 80);
    const title = `允许 ${adapterTitle(this.config.adapter)} 在工作区执行任务${preview ? `：${preview}` : ''}`;
    try {
      const response = await this.requestHost('session/request_permission', {
        sessionId: session.id,
        toolCall: {
          toolCallId: `turn-perm-${Date.now()}`,
          title,
          kind: 'execute',
          status: 'pending',
        },
        options: [
          { optionId: 'allow_once', name: '允许本次执行', kind: 'allow_once' },
          { optionId: 'allow_always', name: '本会话始终允许', kind: 'allow_always' },
          { optionId: 'reject_once', name: '仅规划只读', kind: 'reject_once' },
          { optionId: 'reject_always', name: '拒绝执行', kind: 'reject_always' },
        ],
      });
      const outcome = response && response.outcome;
      if (!outcome || outcome.outcome !== 'selected') {
        return { allowed: false, forceReadonly: false };
      }
      if (outcome.optionId === 'allow_always') {
        session.alwaysAllowed = true;
        return { allowed: true, forceReadonly: false };
      }
      if (outcome.optionId === 'allow_once') {
        return { allowed: true, forceReadonly: false };
      }
      if (outcome.optionId === 'reject_once') {
        return { allowed: true, forceReadonly: true };
      }
      return { allowed: false, forceReadonly: false };
    } catch {
      return { allowed: false, forceReadonly: false };
    }
  }

  start() {
    this.rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (error) {
        process.stderr.write(`[acp_bridge] invalid JSON line: ${error.message}\n`);
        return;
      }
      this.handleMessage(msg).catch((error) => {
        process.stderr.write(`[acp_bridge] unhandled error: ${error?.stack || error}\n`);
      });
    });
    this.rl.on('close', () => {
      for (const session of this.sessions.values()) {
        if (session.activeChild) {
          killChildTree(session.activeChild);
          session.activeChild = null;
        }
      }
      process.exit(0);
    });
  }

  async handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const hasMethod = typeof msg.method === 'string';
    const hasId = msg.id !== undefined && msg.id !== null;

    if (!hasMethod && hasId) {
      const pending = this.pendingHostRequests.get(String(msg.id));
      if (!pending) return;
      this.pendingHostRequests.delete(String(msg.id));
      if (msg.error) {
        pending.reject(new Error(msg.error.message || 'Host RPC error'));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (hasMethod && !hasId) {
      if (msg.method === 'session/cancel') {
        const sid = msg.params?.sessionId;
        const session = sid ? this.sessions.get(sid) : null;
        if (session) {
          session.cancelled = true;
          if (session.activeChild) {
            killChildTree(session.activeChild);
          }
        }
      }
      return;
    }

    if (hasMethod && hasId) {
      try {
        const result = await this.dispatchRequest(msg.method, msg.params || {});
        this.sendResult(msg.id, result);
      } catch (error) {
        this.sendError(msg.id, error.code || -32000, error.message || String(error));
      }
    }
  }

  async dispatchRequest(method, params) {
    switch (method) {
      case 'initialize': {
        if (this.config.adapter === 'antigravity') await this.ensureAntigravityConnection();
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: false,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              http: false,
              sse: false,
            },
          },
          agentInfo: {
            name: `rocketx-acp-bridge-${this.config.adapter}`,
            title: adapterTitle(this.config.adapter),
            version: '1.0.0',
          },
          authMethods: [],
        };
      }
      case 'session/new': {
        if (this.config.adapter === 'antigravity') {
          throw new Error('Antigravity 尚不能从这里新建会话：请先在 Antigravity 中创建并选择项目，再从“添加已有会话”接入原会话。');
        }
        const id = `acp-bridge-${crypto.randomUUID()}`;
        const cwd =
          typeof params.cwd === 'string' && params.cwd.trim()
            ? params.cwd.trim()
            : this.config.defaultCwd;
        this.sessions.set(id, {
          id,
          cwd,
          mode: 'confirm',
          alwaysAllowed: false,
          backendSessionId: null,
          activeChild: null,
          cancelled: false,
        });
        return {
          sessionId: id,
          modes: createModeState('confirm'),
        };
      }
      case 'session/load': {
        const requestedId =
          typeof params.sessionId === 'string' && params.sessionId.trim()
            ? params.sessionId.trim()
            : null;
        if (!requestedId) throw new Error('恢复需要原生会话 ID，禁止新建会话代替恢复');
        if (this.config.adapter === 'antigravity') {
          const antigravityConnection = await this.ensureAntigravityConnection();
          await this.verifyAntigravitySession(antigravityConnection, requestedId);
        }
        let session = this.sessions.get(requestedId);
        if (!session) {
          if (this.config.adapter === 'codex' && this.config.resumeSessionId !== requestedId) {
            throw new Error('原生 Codex 会话需要来源匹配的明确交接，禁止直接接管或新建代替恢复');
          }
          if (this.config.adapter === 'codex' && path.resolve(params.cwd || this.config.defaultCwd) !== path.resolve(this.config.defaultCwd)) {
            throw new Error('恢复工作目录与交接目录不一致');
          }
          const cwd =
            typeof params.cwd === 'string' && params.cwd.trim()
              ? params.cwd.trim()
              : this.config.defaultCwd;
          session = {
            id: requestedId,
            cwd,
            mode: 'confirm',
            alwaysAllowed: false,
            backendSessionId: requestedId.startsWith('acp-bridge-') ? null : requestedId,
            activeChild: null,
            cancelled: false,
          };
          this.sessions.set(requestedId, session);
        }
        return {
          modes: createModeState(session.mode),
        };
      }
      case 'session/set_mode': {
        const session = this.sessions.get(params.sessionId);
        if (!session) {
          const err = new Error(`Unknown ACP session: ${params.sessionId}`);
          err.code = -32602;
          throw err;
        }
        const nextMode = String(params.modeId || 'confirm');
        session.mode = nextMode;
        this.sendSessionUpdate(session.id, {
          sessionUpdate: 'current_mode_update',
          currentModeId: nextMode,
        });
        return {};
      }
      case 'session/prompt': {
        const session = this.sessions.get(params.sessionId);
        if (!session) {
          const err = new Error(`Unknown ACP session: ${params.sessionId}`);
          err.code = -32602;
          throw err;
        }
        session.cancelled = false;
        const promptText = extractPromptText(params.prompt);
        if (!promptText) {
          return { stopReason: 'end_turn' };
        }

        const permission = await this.ensureTurnPermission(session, promptText);
        if (!permission.allowed) {
          this.emitAgentText(session.id, '已按安全策略拒绝本次执行请求。');
          return { stopReason: 'refusal' };
        }
        if (session.cancelled) {
          return { stopReason: 'cancelled' };
        }

        const effectiveMode = permission.forceReadonly ? 'plan' : session.mode;
        return this.runAdapterTurn(session, promptText, effectiveMode);
      }
      default: {
        const err = new Error(`Method not supported by ACP bridge: ${method}`);
        err.code = -32601;
        throw err;
      }
    }
  }

  async runAdapterTurn(session, promptText, effectiveMode) {
    switch (this.config.adapter) {
      case 'codex':
        return this.runCodexTurn(session, promptText, effectiveMode);
      case 'claude':
        return this.runClaudeTurn(session, promptText, effectiveMode);
      case 'antigravity':
        return this.runAntigravityTurn(session, promptText, effectiveMode);
      case 'dsh':
        return this.runDshTurn(session, promptText, effectiveMode);
      default:
        this.emitAgentText(
          session.id,
          `不支持的桥接适配器 "${this.config.adapter}"，请在配置中使用原生 ACP 命令。`,
        );
        return { stopReason: 'refusal' };
    }
  }

  runCodexTurn(session, promptText, effectiveMode) {
    const extraArgs = [];
    const rootArgs = [];
    for (let index = 0; index < this.config.extraArgs.length; index += 1) {
      const arg = this.config.extraArgs[index];
      if (arg === '--profile' || arg === '-p') {
        const profile = this.config.extraArgs[++index];
        if (!profile) throw new Error('Codex profile 参数缺少值');
        rootArgs.push(arg, profile);
      } else if (arg.startsWith('--profile=')) {
        rootArgs.push(arg);
      } else {
        if (session.backendSessionId && ['--last', '--all', '--worktree', '-C', '--cd', '--ephemeral'].some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
          throw new Error(`原生恢复禁止改变会话身份、目录或存储方式的参数：${arg}`);
        }
        extraArgs.push(arg);
      }
    }
    const args = [...rootArgs, 'exec'];
    if (session.backendSessionId) {
      args.push('resume', '--json', '--skip-git-repo-check');
      if (effectiveMode === 'plan') {
        args.push('-c', 'sandbox_mode="read-only"');
      }
      args.push(...extraArgs, session.backendSessionId, '-');
    } else {
      args.push(
        '--json',
        '--skip-git-repo-check',
        '-C',
        session.cwd,
        '-s',
        effectiveMode === 'plan' ? 'read-only' : 'workspace-write',
        ...extraArgs,
        '-',
      );
    }

    return new Promise((resolve, reject) => {
      let emittedText = false;
      const expectedSessionId = session.backendSessionId;
      let identityMismatch = false;
      const stderrLines = [];
      const child = spawnCli(this.config.binPath, args, { cwd: session.cwd });
      session.activeChild = child;

      if (child.stdin) {
        child.stdin.write(promptText, 'utf8');
        child.stdin.end();
      }

      const outRl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      outRl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (identityMismatch) return;
        let evt;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
          if (expectedSessionId && evt.thread_id !== expectedSessionId) {
            identityMismatch = true;
            killChildTree(child);
            reject(new Error('Codex 返回了不同会话 ID，已停止，禁止静默创建新会话'));
            return;
          }
          session.backendSessionId = evt.thread_id;
          const root = fs.realpathSync(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
          const sourcePath = root.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/+$/, '');
          this.sendSessionUpdate(session.id, {
            sessionUpdate: 'rocketx_native_session',
            provider: 'codex',
            nativeSessionId: evt.thread_id,
            workspaceRoot: session.cwd,
            sourceScope: `codex:${process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath}`,
          });
          return;
        }
        if (evt.type === 'error' && evt.message) {
          this.emitAgentText(session.id, `\n[Codex 错误] ${evt.message}\n`);
          emittedText = true;
          return;
        }
        if (evt.type === 'turn.failed' && evt.error?.message) {
          this.emitAgentText(session.id, `\n[Codex 执行失败] ${evt.error.message}\n`);
          emittedText = true;
          return;
        }
        const item = evt.item;
        if (!item || typeof item !== 'object') return;
        const itemId = String(item.id || `codex-item-${Date.now()}`);

        if (item.type === 'agent_message' && evt.type === 'item.completed' && item.text) {
          this.emitAgentText(session.id, String(item.text));
          emittedText = true;
        } else if (item.type === 'reasoning' && evt.type === 'item.completed' && item.text) {
          this.emitAgentThought(session.id, `${item.text}\n`);
        } else if (item.type === 'command_execution') {
          if (evt.type === 'item.started') {
            this.sendSessionUpdate(session.id, {
              sessionUpdate: 'tool_call',
              toolCallId: itemId,
              title: item.command ? `执行命令: ${item.command}` : '执行终端命令',
              kind: 'execute',
              status: 'in_progress',
            });
          } else if (evt.type === 'item.completed') {
            const outText = [item.aggregated_output, item.exit_code != null ? `(exit ${item.exit_code})` : '']
              .filter(Boolean)
              .join('\n');
            this.sendSessionUpdate(session.id, {
              sessionUpdate: 'tool_call_update',
              toolCallId: itemId,
              status: item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0) ? 'failed' : 'completed',
              ...(outText
                ? {
                    content: [
                      {
                        type: 'content',
                        content: { type: 'text', text: outText },
                      },
                    ],
                  }
                : {}),
            });
          }
        } else if (item.type === 'file_change' && evt.type === 'item.completed') {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          this.sendSessionUpdate(session.id, {
            sessionUpdate: 'tool_call',
            toolCallId: itemId,
            title: `文件变更 (${changes.length} 项)`,
            kind: 'edit',
            status: item.status === 'failed' ? 'failed' : 'completed',
            locations: changes
              .filter((c) => typeof c?.path === 'string')
              .map((c) => ({ path: c.path })),
          });
        } else if (item.type === 'mcp_tool_call') {
          const title = `MCP 工具: ${item.server || ''}/${item.tool || 'call'}`;
          if (evt.type === 'item.started') {
            this.sendSessionUpdate(session.id, {
              sessionUpdate: 'tool_call',
              toolCallId: itemId,
              title,
              kind: 'other',
              status: 'in_progress',
            });
          } else if (evt.type === 'item.completed') {
            this.sendSessionUpdate(session.id, {
              sessionUpdate: 'tool_call_update',
              toolCallId: itemId,
              status: item.status === 'failed' || item.error ? 'failed' : 'completed',
            });
          }
        } else if (item.type === 'todo_list' && Array.isArray(item.items)) {
          this.sendSessionUpdate(session.id, {
            sessionUpdate: 'plan',
            entries: item.items.map((todo) => ({
              content: String(todo.text || ''),
              priority: 'medium',
              status: todo.completed ? 'completed' : 'pending',
            })),
          });
        }
      });

      const errRl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
      errRl.on('line', (line) => {
        if (stderrLines.length < 30) stderrLines.push(line);
        process.stderr.write(`[codex] ${line}\n`);
      });

      child.on('error', (error) => {
        session.activeChild = null;
        reject(new Error(`启动 Codex 失败：${error.message}`));
      });

      child.on('close', (code) => {
        session.activeChild = null;
        if (identityMismatch) return;
        if (session.cancelled) {
          resolve({ stopReason: 'cancelled' });
          return;
        }
        if (code !== 0) {
          const detail = stderrLines.join('\n').trim() || `退出码 ${code}`;
          reject(new Error(`Codex 执行异常（退出码 ${code}）：\n${detail}`));
          return;
        }
        resolve({ stopReason: 'end_turn' });
      });
    });
  }

  runClaudeTurn(session, promptText, effectiveMode) {
    const permissionMode = effectiveMode === 'plan' ? 'plan' : 'acceptEdits';
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      permissionMode,
    ];
    if (session.backendSessionId) {
      args.push('--resume', session.backendSessionId);
    }
    args.push(...this.config.extraArgs);

    return new Promise((resolve) => {
      let emittedText = false;
      let streamedDelta = false;
      const stderrLines = [];
      const child = spawnCli(this.config.binPath, args, { cwd: session.cwd });
      session.activeChild = child;

      if (child.stdin) {
        child.stdin.write(promptText, 'utf8');
        child.stdin.end();
      }

      const outRl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      outRl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (typeof evt.session_id === 'string' && evt.session_id) {
          session.backendSessionId = evt.session_id;
        }

        if (evt.type === 'stream_event' && evt.event) {
          const inner = evt.event;
          if (inner.type === 'content_block_delta' && inner.delta) {
            if (inner.delta.type === 'text_delta' && inner.delta.text) {
              this.emitAgentText(session.id, String(inner.delta.text));
              emittedText = true;
              streamedDelta = true;
            } else if (inner.delta.type === 'thinking_delta' && inner.delta.thinking) {
              this.emitAgentThought(session.id, String(inner.delta.thinking));
            }
          }
          return;
        }

        if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
          for (const block of evt.message.content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text' && block.text && !streamedDelta) {
              this.emitAgentText(session.id, String(block.text));
              emittedText = true;
            } else if (block.type === 'thinking' && block.thinking && !streamedDelta) {
              this.emitAgentThought(session.id, String(block.thinking));
            } else if (block.type === 'tool_use') {
              this.sendSessionUpdate(session.id, {
                sessionUpdate: 'tool_call',
                toolCallId: String(block.id || `claude-tool-${Date.now()}`),
                title: `工具调用: ${block.name || 'tool'}`,
                kind: mapClaudeToolKind(block.name),
                status: 'in_progress',
                rawInput: block.input,
              });
            }
          }
          streamedDelta = false;
          return;
        }

        if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
          for (const block of evt.message.content) {
            if (block && block.type === 'tool_result' && block.tool_use_id) {
              const resultText =
                typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content
                        .map((c) => (typeof c?.text === 'string' ? c.text : ''))
                        .filter(Boolean)
                        .join('\n')
                    : '';
              this.sendSessionUpdate(session.id, {
                sessionUpdate: 'tool_call_update',
                toolCallId: String(block.tool_use_id),
                status: block.is_error ? 'failed' : 'completed',
                ...(resultText
                  ? {
                      content: [
                        {
                          type: 'content',
                          content: { type: 'text', text: resultText.slice(0, 4000) },
                        },
                      ],
                    }
                  : {}),
              });
            }
          }
          return;
        }

        if (evt.type === 'result') {
          if (!emittedText && typeof evt.result === 'string' && evt.result) {
            this.emitAgentText(session.id, evt.result);
            emittedText = true;
          }
          streamedDelta = false;
        }
      });

      const errRl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
      errRl.on('line', (line) => {
        if (stderrLines.length < 30) stderrLines.push(line);
        process.stderr.write(`[claude] ${line}\n`);
      });

      child.on('error', (error) => {
        session.activeChild = null;
        this.emitAgentText(session.id, `启动 Claude Code 失败：${error.message}`);
        resolve({ stopReason: 'end_turn' });
      });

      child.on('close', (code) => {
        session.activeChild = null;
        if (session.cancelled) {
          resolve({ stopReason: 'cancelled' });
          return;
        }
        if (!emittedText && code !== 0) {
          const detail = stderrLines.join('\n').trim() || `退出码 ${code}`;
          this.emitAgentText(session.id, `Claude Code 执行异常（退出码 ${code}）：\n${detail}`);
        }
        resolve({ stopReason: 'end_turn' });
      });
    });
  }

  async runAntigravityCommand(connection, args, { cwd, session } = {}) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let finished = false;
      const child = spawnCli(connection.binPath, [...connection.prefixArgs, ...args], {
        cwd: cwd || this.config.defaultCwd,
        env: connection.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (session) session.activeChild = child;
      const timer = setTimeout(() => { timedOut = true; killChildTree(child); finish(-1); }, 7000);
      const collect = (chunk, isError) => {
        if (stdout.length + stderr.length > 1024 * 1024) { timedOut = true; killChildTree(child); return; }
        if (isError) stderr += chunk.toString('utf8');
        else stdout += chunk.toString('utf8');
      };
      child.stdout.on('data', (chunk) => collect(chunk, false));
      child.stderr.on('data', (chunk) => collect(chunk, true));
      const finish = (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (session?.activeChild === child) session.activeChild = null;
        resolve({ code, stdout, stderr, timedOut });
      };
      child.on('error', () => finish(-1));
      child.on('close', (code) => finish(code ?? -1));
    });
  }

  antigravityResponse(result) {
    try { return JSON.parse(result.stdout.trim()); } catch { return null; }
  }

  async ensureAntigravityConnection() {
    const connection = await resolveAntigravityConnection(this.config);
    const result = await this.runAntigravityCommand(connection, ['get-conversation-metadata', ANTIGRAVITY_PROBE_ID]);
    const body = this.antigravityResponse(result);
    // A structured NotFound for this sentinel proves that the official agentapi service answered.
    if (result.timedOut || result.code !== 1 || typeof body?.error !== 'string'
        || !body.error.includes('code = NotFound') || !body.error.includes(`trajectory not found: ${ANTIGRAVITY_PROBE_ID}`)) {
      throw new Error(`${ANTIGRAVITY_UNAVAILABLE} 本地服务未通过连接检查。`);
    }
    return connection;
  }

  async verifyAntigravitySession(connection, sessionId, session) {
    if (!ANTIGRAVITY_UUID.test(sessionId) || sessionId === ANTIGRAVITY_PROBE_ID) {
      throw new Error('Antigravity 原会话 ID 无效，请从“添加已有会话”重新选择会话。');
    }
    const result = await this.runAntigravityCommand(connection, ['get-conversation-metadata', sessionId], { session });
    const body = this.antigravityResponse(result);
    const metadata = body?.response?.conversationMetadata?.metadata;
    if (result.code !== 0 || result.timedOut || body?.error || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('无法在当前 Antigravity 中确认这条原会话。请打开原会话后重新连接；未发送指令，也未创建替代会话。');
    }
    for (const id of [metadata.id, metadata.conversationId]) {
      if (id !== undefined && id !== sessionId) throw new Error('Antigravity 返回的会话身份不匹配，已停止发送。请重新接入原会话。');
    }
  }

  async runAntigravityTurn(session, promptText, effectiveMode) {
    if (effectiveMode === 'plan') {
      throw new Error('Antigravity 的当前连接不支持强制只读，未发送指令。请在原应用中查看或规划，或明确允许执行后重试。');
    }
    if (!session.backendSessionId) {
      throw new Error('请先从“添加已有会话”接入 Antigravity 原会话，再继续工作。');
    }
    const connection = await this.ensureAntigravityConnection();
    await this.verifyAntigravitySession(connection, session.backendSessionId, session);
    if (session.cancelled) return { stopReason: 'cancelled' };
    const result = await this.runAntigravityCommand(connection, ['send-message', session.backendSessionId, promptText], { cwd: session.cwd, session });
    const body = this.antigravityResponse(result);
    if (session.cancelled || result.timedOut || result.code !== 0 || body?.error
        || body?.response?.sendMessage?.recipientId !== session.backendSessionId) {
      throw new Error('未收到 Antigravity 原会话的有效发送回执，已停止等待且未自动重发。请到 Antigravity 检查是否已收到指令；这里停止等待不会取消原应用中的任务。');
    }
    this.emitAgentText(session.id, '指令已提交到这条 Antigravity 原会话。尚未确认任务完成，请在 Antigravity 中查看执行进度和结果。');
    return { stopReason: 'end_turn' };
  }

  runDshTurn(session, promptText, _effectiveMode) {
    const args = ['headless', '--json'];
    if (session.backendSessionId) {
      args.push('--session-id', session.backendSessionId);
    }
    args.push(...this.config.extraArgs, '-');

    return new Promise((resolve) => {
      let emittedText = false;
      const stderrLines = [];
      const child = spawnCli(this.config.binPath, args, { cwd: session.cwd });
      session.activeChild = child;

      if (child.stdin) {
        child.stdin.write(promptText, 'utf8');
        child.stdin.end();
      }

      const outRl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      outRl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          this.emitAgentText(session.id, `${line}\n`);
          emittedText = true;
          return;
        }
        if (evt.type === 'session' && typeof evt.sessionId === 'string') {
          session.backendSessionId = evt.sessionId;
          return;
        }
        if (typeof evt.sessionId === 'string') {
          session.backendSessionId = evt.sessionId;
        } else if (typeof evt.session_id === 'string') {
          session.backendSessionId = evt.session_id;
        }
        if (evt.type === 'thinking' && typeof evt.text === 'string' && evt.text) {
          this.emitAgentThought(session.id, evt.text);
        } else if (evt.type === 'text' && typeof evt.text === 'string' && evt.text) {
          this.emitAgentText(session.id, evt.text);
          emittedText = true;
        } else if (evt.type === 'tool_call') {
          this.sendSessionUpdate(session.id, {
            sessionUpdate: 'tool_call',
            toolCallId: String(evt.callId || `dsh-tool-${Date.now()}`),
            title: `工具调用: ${evt.tool || 'tool'}`,
            kind: mapClaudeToolKind(evt.tool),
            status: 'in_progress',
            rawInput: evt.input,
          });
        } else if (evt.type === 'tool_result') {
          this.sendSessionUpdate(session.id, {
            sessionUpdate: 'tool_call_update',
            toolCallId: String(evt.callId || ''),
            status: evt.status === 'error' ? 'failed' : 'completed',
            ...(typeof evt.result === 'string' && evt.result
              ? {
                  content: [
                    {
                      type: 'content',
                      content: { type: 'text', text: evt.result.slice(0, 4000) },
                    },
                  ],
                }
              : {}),
          });
        } else if (evt.type === 'final' && typeof evt.text === 'string' && evt.text) {
          if (!emittedText) {
            this.emitAgentText(session.id, evt.text);
            emittedText = true;
          }
        } else if (typeof evt.text === 'string' && evt.text) {
          this.emitAgentText(session.id, evt.text);
          emittedText = true;
        } else if (typeof evt.delta === 'string' && evt.delta) {
          this.emitAgentText(session.id, evt.delta);
          emittedText = true;
        } else if (evt.message && typeof evt.message.content === 'string') {
          this.emitAgentText(session.id, evt.message.content);
          emittedText = true;
        }
      });

      const errRl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
      errRl.on('line', (line) => {
        if (stderrLines.length < 30) stderrLines.push(line);
        process.stderr.write(`[dsh] ${line}\n`);
      });

      child.on('error', (error) => {
        session.activeChild = null;
        this.emitAgentText(session.id, `启动 DeepSeek Harness 失败：${error.message}`);
        resolve({ stopReason: 'end_turn' });
      });

      child.on('close', (code) => {
        session.activeChild = null;
        if (session.cancelled) {
          resolve({ stopReason: 'cancelled' });
          return;
        }
        if (!emittedText && code !== 0) {
          const detail = stderrLines.join('\n').trim() || `退出码 ${code}`;
          this.emitAgentText(session.id, `DSH 执行异常（退出码 ${code}）：\n${detail}`);
        }
        resolve({ stopReason: 'end_turn' });
      });
    });
  }
}

function mapClaudeToolKind(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('read') || lower === 'ls' || lower === 'view_file') return 'read';
  if (lower.includes('edit') || lower.includes('write') || lower.includes('patch')) return 'edit';
  if (lower.includes('grep') || lower.includes('glob') || lower.includes('search')) return 'search';
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec')) return 'execute';
  if (lower.includes('fetch') || lower.includes('web')) return 'fetch';
  return 'other';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = parseBridgeArgs(process.argv.slice(2));
  const server = new AcpBridgeServer(config);
  if (config.probe) {
    try {
      if (config.adapter !== 'antigravity') throw new Error('此连接检查仅支持 Antigravity。');
      await server.ensureAntigravityConnection();
      process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  } else {
    server.start();
  }
}
