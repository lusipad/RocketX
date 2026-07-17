import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runnerDir = join(root, 'apps', 'desktop', 'agent-runner');
const image = 'rocketx/codex-runner:0.144.4';
const hostSandbox = process.env.ROCKETX_RUNNER_TEST_HOST === '1';
const temporary = mkdtempSync(join(tmpdir(), 'rocketx-agent-runner-'));
const workspace = join(temporary, 'workspace');
const home = join(temporary, 'codex-home');
const attachments = join(temporary, 'attachments');
const auth = join(temporary, 'auth.json');
const hostBin = join(temporary, 'host-bin');
const hostRunner = join(hostBin, 'rocketx-codex');
const sandboxWorkspace = hostSandbox ? workspace : '/workspace';
const sandboxAttachments = hostSandbox
  ? join(workspace, '.rocketx-agent', 'attachments')
  : '/workspace/.rocketx-agent/attachments';
const sandboxAuth = hostSandbox ? auth : '/home/node/.codex/auth.json';

if (hostSandbox && process.platform !== 'linux') {
  throw new Error('ROCKETX_RUNNER_TEST_HOST 仅支持 Linux CI 宿主');
}

function docker(args, options = {}) {
  return execFileSync('docker', args, { cwd: root, encoding: 'utf8', ...options });
}

function mount(source, target, readOnly = false) {
  return `type=bind,source=${source},target=${target}${readOnly ? ',readonly' : ''}`;
}

function sandbox(profile, command) {
  if (hostSandbox) {
    return execFileSync(
      hostRunner,
      ['sandbox', '-P', profile, '-C', workspace, '/bin/sh', '-lc', command],
      {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, CODEX_HOME: home },
      },
    ).trim();
  }
  const args = [
    'run',
    '--rm',
  ];
  args.push(
    '--workdir',
    '/workspace',
    '--read-only',
  );
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  args.push(
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
  );
  args.push(
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
  mkdirSync(hostBin, { recursive: true });
  writeFileSync(join(workspace, 'allowed.txt'), 'ROCKETX_ALLOWED_FILE\n');
  writeFileSync(join(workspace, '.env'), 'ROOT_ENV_MUST_NOT_BE_READABLE\n');
  writeFileSync(join(workspace, 'nested', '.env'), 'NESTED_ENV_MUST_NOT_BE_READABLE\n');
  writeFileSync(join(workspace, 'nested', 'credentials.json'), 'CREDENTIALS_MUST_NOT_BE_READABLE\n');
  writeFileSync(join(workspace, 'nested', 'private.pem'), 'PRIVATE_KEY_MUST_NOT_BE_READABLE\n');
  const contextFile = hostSandbox
    ? join(workspace, '.rocketx-agent', 'attachments', 'context.log')
    : join(attachments, 'context.log');
  writeFileSync(contextFile, 'ROCKETX_CONTEXT_FILE\n');
  if (hostSandbox) chmodSync(contextFile, 0o444);
  writeFileSync(auth, '{"fixture":"AUTH_MUST_NOT_BE_READABLE"}\n');
  let config = readFileSync(join(runnerDir, 'runner.config.toml'), 'utf8')
    .replaceAll('/workspace', sandboxWorkspace)
    .replaceAll('/home/node/.codex/auth.json', sandboxAuth);
  if (hostSandbox) {
    config = config.replaceAll(
      '":minimal" = "read"',
      `${JSON.stringify(hostBin)} = "read"\n":minimal" = "read"`,
    );
  }
  writeFileSync(join(home, 'config.toml'), config);

  const buildArgs = ['build', '--quiet', '--tag', image];
  buildArgs.push(runnerDir);
  docker(buildArgs, { stdio: 'inherit' });
  const version = docker(['run', '--rm', image, '--version']).trim();
  if (version !== 'codex-cli 0.144.4') throw new Error(`Runner 版本不匹配：${version}`);
  if (hostSandbox) {
    const container = docker(['create', image]).trim();
    try {
      docker(['cp', `${container}:/usr/local/bin/rocketx-codex`, hostRunner]);
      docker(['cp', `${container}:/usr/local/bin/codex-linux-sandbox`, join(hostBin, 'codex-linux-sandbox')]);
      docker(['cp', `${container}:/usr/local/bin/codex-resources`, hostBin]);
    } finally {
      docker(['rm', container]);
    }
    chmodSync(hostRunner, 0o755);
    chmodSync(join(hostBin, 'codex-linux-sandbox'), 0o755);
    const bundledBwrap = join(hostBin, 'codex-resources', 'bwrap');
    if (!existsSync(bundledBwrap)) throw new Error('Runner 镜像缺少匹配版本的 codex-resources/bwrap');
    const hostVersion = execFileSync(hostRunner, ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: home },
    }).trim();
    if (hostVersion !== 'codex-cli 0.144.4') {
      throw new Error(`宿主 Runner 版本不匹配：${hostVersion}`);
    }
  }

  const readOnly = sandbox(
    'rocketx_read',
    [
      'set -eu',
      `test "$(cat ${sandboxWorkspace}/allowed.txt)" = ROCKETX_ALLOWED_FILE`,
      `test "$(cat ${sandboxAttachments}/context.log)" = ROCKETX_CONTEXT_FILE`,
      `if cat ${sandboxWorkspace}/.env >/dev/null 2>&1; then exit 21; fi`,
      `if cat ${sandboxWorkspace}/nested/.env >/dev/null 2>&1; then exit 22; fi`,
      `if cat ${sandboxWorkspace}/nested/credentials.json >/dev/null 2>&1; then exit 27; fi`,
      `if cat ${sandboxWorkspace}/nested/private.pem >/dev/null 2>&1; then exit 30; fi`,
      `if cat ${sandboxAuth} >/dev/null 2>&1; then exit 23; fi`,
      `if touch ${sandboxWorkspace}/read-only-write >/dev/null 2>&1; then exit 24; fi`,
      'echo READ_PROFILE_OK',
    ].join('; '),
  );
  if (readOnly !== 'READ_PROFILE_OK') throw new Error(`只读隔离探针失败：${readOnly}`);

  const writable = sandbox(
    'rocketx_write',
    [
      'set -eu',
      `printf ok > ${sandboxWorkspace}/write-probe`,
      `test "$(cat ${sandboxWorkspace}/write-probe)" = ok`,
      `if (printf changed > ${sandboxAttachments}/context.log) 2>/dev/null; then exit 29; fi`,
      `if cat ${sandboxWorkspace}/nested/.env >/dev/null 2>&1; then exit 25; fi`,
      `if cat ${sandboxWorkspace}/nested/credentials.json >/dev/null 2>&1; then exit 28; fi`,
      `if cat ${sandboxWorkspace}/nested/private.pem >/dev/null 2>&1; then exit 31; fi`,
      `if cat ${sandboxAuth} >/dev/null 2>&1; then exit 26; fi`,
      ...(hostSandbox
        ? [`if touch ${hostBin}/agent-write-probe >/dev/null 2>&1; then exit 32; fi`]
        : []),
      'echo WRITE_PROFILE_OK',
    ].join('; '),
  );
  if (writable !== 'WRITE_PROFILE_OK') throw new Error(`可写隔离探针失败：${writable}`);

  console.log('Agent Runner 隔离通过：固定版本、读写边界、只读上下文附件、.env、credentials 与认证文件拒绝');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
