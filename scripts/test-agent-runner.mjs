import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runnerDir = join(root, 'apps', 'desktop', 'agent-runner');
const image = 'rocketx/codex-runner:0.144.4';
const temporary = mkdtempSync(join(tmpdir(), 'rocketx-agent-runner-'));
const workspace = join(temporary, 'workspace');
const home = join(temporary, 'codex-home');
const attachments = join(temporary, 'attachments');
const auth = join(temporary, 'auth.json');
const nestedDocker = process.env.ROCKETX_RUNNER_TEST_NESTED_DOCKER === '1';

function docker(args, options = {}) {
  return execFileSync('docker', args, { cwd: root, encoding: 'utf8', ...options });
}

function mount(source, target, readOnly = false) {
  return `type=bind,source=${source},target=${target}${readOnly ? ',readonly' : ''}`;
}

function sandbox(profile, command) {
  const args = [
    'run',
    '--rm',
  ];
  if (nestedDocker) args.push('--privileged');
  args.push(
    '--workdir',
    '/workspace',
    '--read-only',
  );
  if (!nestedDocker) args.push('--cap-drop', 'ALL');
  args.push(
    '--security-opt',
    'no-new-privileges',
    '--security-opt',
    'seccomp=unconfined',
    '--network',
    'none',
    '--pids-limit',
    '64',
    '--memory',
    '512m',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=32m',
    '--tmpfs',
    '/run:rw,noexec,nosuid,size=8m',
    '--mount',
    mount(workspace, '/workspace'),
    '--mount',
    mount(attachments, '/workspace/.rocketx-agent/attachments', true),
    '--mount',
    mount(home, '/home/node/.codex'),
    '--mount',
    mount(auth, '/home/node/.codex/auth.json', true),
    image,
    'sandbox',
    '-P',
    profile,
    '-C',
    '/workspace',
    '/bin/sh',
    '-lc',
    command,
  );
  return docker(args).trim();
}

try {
  mkdirSync(join(workspace, 'nested'), { recursive: true });
  mkdirSync(join(workspace, '.rocketx-agent', 'attachments'), { recursive: true });
  mkdirSync(attachments, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(workspace, 'allowed.txt'), 'ROCKETX_ALLOWED_FILE\n');
  writeFileSync(join(workspace, '.env'), 'ROOT_ENV_MUST_NOT_BE_READABLE\n');
  writeFileSync(join(workspace, 'nested', '.env'), 'NESTED_ENV_MUST_NOT_BE_READABLE\n');
  writeFileSync(join(workspace, 'nested', 'credentials.json'), 'CREDENTIALS_MUST_NOT_BE_READABLE\n');
  writeFileSync(join(workspace, 'nested', 'private.pem'), 'PRIVATE_KEY_MUST_NOT_BE_READABLE\n');
  writeFileSync(join(attachments, 'context.log'), 'ROCKETX_CONTEXT_FILE\n');
  writeFileSync(auth, '{"fixture":"AUTH_MUST_NOT_BE_READABLE"}\n');
  copyFileSync(join(runnerDir, 'runner.config.toml'), join(home, 'config.toml'));

  docker(['build', '--tag', image, runnerDir], { stdio: 'inherit' });
  const version = docker(['run', '--rm', image, '--version']).trim();
  if (version !== 'codex-cli 0.144.4') throw new Error(`Runner 版本不匹配：${version}`);

  const readOnly = sandbox(
    'rocketx_read',
    [
      'set -eu',
      'test "$(cat /workspace/allowed.txt)" = ROCKETX_ALLOWED_FILE',
      'test "$(cat /workspace/.rocketx-agent/attachments/context.log)" = ROCKETX_CONTEXT_FILE',
      'if cat /workspace/.env >/dev/null 2>&1; then exit 21; fi',
      'if cat /workspace/nested/.env >/dev/null 2>&1; then exit 22; fi',
      'if cat /workspace/nested/credentials.json >/dev/null 2>&1; then exit 27; fi',
      'if cat /workspace/nested/private.pem >/dev/null 2>&1; then exit 30; fi',
      'if cat /home/node/.codex/auth.json >/dev/null 2>&1; then exit 23; fi',
      'if touch /workspace/read-only-write >/dev/null 2>&1; then exit 24; fi',
      'echo READ_PROFILE_OK',
    ].join('; '),
  );
  if (readOnly !== 'READ_PROFILE_OK') throw new Error(`只读隔离探针失败：${readOnly}`);

  const writable = sandbox(
    'rocketx_write',
    [
      'set -eu',
      'printf ok > /workspace/write-probe',
      'test "$(cat /workspace/write-probe)" = ok',
      'if (printf changed > /workspace/.rocketx-agent/attachments/context.log) 2>/dev/null; then exit 29; fi',
      'if cat /workspace/nested/.env >/dev/null 2>&1; then exit 25; fi',
      'if cat /workspace/nested/credentials.json >/dev/null 2>&1; then exit 28; fi',
      'if cat /workspace/nested/private.pem >/dev/null 2>&1; then exit 31; fi',
      'if cat /home/node/.codex/auth.json >/dev/null 2>&1; then exit 26; fi',
      'echo WRITE_PROFILE_OK',
    ].join('; '),
  );
  if (writable !== 'WRITE_PROFILE_OK') throw new Error(`可写隔离探针失败：${writable}`);

  console.log('Agent Runner 隔离通过：固定版本、读写边界、只读上下文附件、.env、credentials 与认证文件拒绝');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
