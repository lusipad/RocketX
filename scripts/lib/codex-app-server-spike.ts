import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type {
  CodexProcessInfo,
  CodexTransport,
  CodexTransportHandlers,
} from '../../apps/web/src/agent/protocol/client';

export interface CodexInvocation {
  command: string;
  args: string[];
  appServerArgs: string[];
  version: string;
}

export interface CodexTimelineEntry {
  direction: 'in' | 'out';
  method: string;
}

function invocationResult(command: string, args: string[]): CodexInvocation {
  const version = spawnSync(command, [...args, '--version'], { encoding: 'utf8' });
  const parsed = /^codex-cli (\S+)$/m.exec(version.stdout.trim())?.[1];
  if (version.status !== 0 || !parsed) throw new Error('无法识别 PATH 中的 Codex CLI');
  const help = spawnSync(command, [...args, 'app-server', '--help'], { encoding: 'utf8' });
  const helpText = `${help.stdout}\n${help.stderr}`;
  return {
    command,
    args,
    appServerArgs: helpText.includes('--stdio') ? ['app-server', '--stdio'] : ['app-server'],
    version: parsed,
  };
}

export function codexInvocation(): CodexInvocation {
  const entry = resolve(import.meta.dirname, '../../node_modules/@openai/codex/bin/codex.js');
  if (!existsSync(entry)) throw new Error('缺少仓库锁定的 @openai/codex，请先运行 pnpm install');
  return invocationResult(process.execPath, [entry]);
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
  ) {}

  async start(handlers: CodexTransportHandlers): Promise<CodexProcessInfo> {
    const child = spawn(
      this.invocation.command,
      [...this.invocation.args, ...this.invocation.appServerArgs],
      { cwd: this.workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'] },
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
    return { processId: String(child.pid ?? 'unknown'), version: this.invocation.version };
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
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

export function turnInputs(transport: NodeCodexTransport): Array<Record<string, unknown>> {
  const request = transport.outbound.find((message) => message.method === 'turn/start');
  const params = request?.params as Record<string, unknown> | undefined;
  return Array.isArray(params?.input) ? params.input as Array<Record<string, unknown>> : [];
}
