import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type {
  CodexProcessInfo,
  CodexTransport,
  CodexTransportHandlers,
} from '../../apps/web/src/agent/protocol/client';

export type SpikeCodexRuntimeSource = 'pinned' | 'system';

export interface CodexInvocation {
  command: string;
  args: string[];
  appServerArgs: string[];
  version: string;
  source: SpikeCodexRuntimeSource;
  displayPath: string;
}

export interface CodexTimelineEntry {
  direction: 'in' | 'out';
  method: string;
}

export interface NodeCodexTransportOptions {
  codexHome?: string;
}

function invocationResult(
  command: string,
  args: string[],
  source: SpikeCodexRuntimeSource,
  displayPath: string,
): CodexInvocation {
  const version = spawnSync(command, [...args, '--version'], { encoding: 'utf8' });
  const stdout = typeof version.stdout === 'string' ? version.stdout : '';
  const stderr = typeof version.stderr === 'string' ? version.stderr : '';
  const parsed = /^codex-cli (\S+)$/m.exec(stdout.trim())?.[1];
  if (version.status !== 0 || !parsed) {
    const detail = version.error?.message || stderr.trim();
    throw new Error(
      `无法识别 ${source === 'system' ? '系统' : '仓库固定'} Codex CLI`
      + (detail ? `：${detail}` : ''),
    );
  }
  const help = spawnSync(command, [...args, 'app-server', '--help'], { encoding: 'utf8' });
  const helpText = `${help.stdout}\n${help.stderr}`;
  return {
    command,
    args,
    appServerArgs: helpText.includes('--stdio') ? ['app-server', '--stdio'] : ['app-server'],
    version: parsed,
    source,
    displayPath,
  };
}

function pinnedCodexInvocation(): CodexInvocation {
  const entry = resolve(import.meta.dirname, '../../node_modules/@openai/codex/bin/codex.js');
  if (!existsSync(entry)) throw new Error('缺少仓库锁定的 @openai/codex，请先运行 pnpm install');
  return invocationResult(process.execPath, [entry], 'pinned', entry);
}

function windowsSystemCodexInvocation(): CodexInvocation {
  const lookup = spawnSync('where.exe', ['codex'], { encoding: 'utf8' });
  const fallback = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-Command -Name codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)',
    ],
    { encoding: 'utf8' },
  );
  const candidates = [
    ...new Set(
      `${lookup.stdout ?? ''}\n${fallback.stdout ?? ''}`
        .split(/\r?\n/)
        .filter(Boolean)
        .map((path) => path.trim()),
    ),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      if (!candidate.toLowerCase().endsWith('.cmd')) {
        return invocationResult(candidate, [], 'system', candidate);
      }
      const entry = join(
        dirname(candidate),
        'node_modules',
        '@openai',
        'codex',
        'bin',
        'codex.js',
      );
      if (existsSync(entry)) {
        return invocationResult(process.execPath, [entry], 'system', entry);
      }
    } catch {
      continue;
    }
  }
  throw new Error('找不到 PATH 中可执行的 Codex CLI');
}

function systemCodexInvocation(): CodexInvocation {
  if (process.platform === 'win32') return windowsSystemCodexInvocation();
  return invocationResult('codex', [], 'system', 'PATH:codex');
}

export function codexInvocation(source: SpikeCodexRuntimeSource = 'pinned'): CodexInvocation {
  return source === 'system' ? systemCodexInvocation() : pinnedCodexInvocation();
}

export function codexRuntimeSourceFromArgs(
  argv: readonly string[] = process.argv.slice(2),
  fallback: SpikeCodexRuntimeSource = 'pinned',
): SpikeCodexRuntimeSource {
  const index = argv.indexOf('--runtime');
  if (index < 0) return fallback;
  const source = argv[index + 1];
  if (source === 'pinned' || source === 'system') return source;
  throw new Error('--runtime 必须是 pinned 或 system');
}

export async function removeSpikeTempRoot(path: string, prefix: string): Promise<void> {
  const resolved = resolve(path);
  const tempRoot = resolve(tmpdir());
  if (
    !resolved.startsWith(`${tempRoot}${sep}`)
    || !basename(resolved).startsWith(prefix)
  ) {
    throw new Error(`拒绝清理非探针临时目录：${resolved}`);
  }
  await rm(resolved, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

export class NodeCodexTransport implements CodexTransport {
  readonly timeline: CodexTimelineEntry[] = [];
  readonly outbound: Record<string, unknown>[] = [];
  readonly stderr: string[] = [];
  private child?: ChildProcessWithoutNullStreams;
  private output?: Interface;
  private stopping = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly invocation: CodexInvocation,
    private readonly options: NodeCodexTransportOptions = {},
  ) {}

  async start(handlers: CodexTransportHandlers): Promise<CodexProcessInfo> {
    this.stopping = false;
    const child = spawn(
      this.invocation.command,
      [...this.invocation.args, ...this.invocation.appServerArgs],
      {
        cwd: this.workspaceRoot,
        env: this.options.codexHome
          ? { ...process.env, CODEX_HOME: this.options.codexHome }
          : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    this.output = createInterface({ input: child.stdout });
    this.output.on('line', (line) => {
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        this.timeline.push({
          direction: 'in',
          method: typeof message.method === 'string' ? message.method : 'response',
        });
      } catch {
        this.timeline.push({ direction: 'in', method: '<invalid-json>' });
      }
      handlers.onLine(line);
    });
    child.stderr.on('data', (value) => {
      if (this.stderr.length < 100) this.stderr.push(String(value));
    });
    child.on('close', (code) => {
      if (!this.stopping) handlers.onExit(code);
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return {
      processId: String(child.pid ?? 'unknown'),
      version: this.invocation.version,
      runtimeSource: this.invocation.source === 'system' ? 'system' : 'bundled',
      managedSkillRoots: [],
    };
  }

  async terminateUnexpectedly(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.stopping = false;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGKILL');
    }
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        timer.unref();
      }),
    ]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          timer.unref();
        }),
      ]);
    }
    this.child = undefined;
    this.output?.close();
    this.output = undefined;
  }

  async write(message: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) throw new Error('Codex app-server process is not active');
    this.outbound.push(structuredClone(message));
    this.timeline.push({
      direction: 'out',
      method: typeof message.method === 'string' ? message.method : 'response',
    });
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.output?.close();
    this.output = undefined;
    if (!child || child.exitCode !== null) return;
    this.stopping = true;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill();
    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([
        closed,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }
}

export function turnInputs(transport: NodeCodexTransport): Array<Record<string, unknown>> {
  const request = transport.outbound.find((message) => message.method === 'turn/start');
  const params = request?.params as Record<string, unknown> | undefined;
  return Array.isArray(params?.input) ? params.input as Array<Record<string, unknown>> : [];
}
