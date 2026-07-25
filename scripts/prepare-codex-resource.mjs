import { createRequire } from 'node:module';
import { chmod, cp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const codexPackageJson = resolve(root, 'node_modules/@openai/codex/package.json');
const destinationRoot = resolve(
  root,
  'apps/desktop/src-tauri/target/codex-resources/codex',
);

export function codexPlatformSpec(platform, arch) {
  const specs = {
    'darwin-arm64': {
      packageName: '@openai/codex-darwin-arm64',
      targetTriple: 'aarch64-apple-darwin',
      executable: 'codex',
    },
    'darwin-x64': {
      packageName: '@openai/codex-darwin-x64',
      targetTriple: 'x86_64-apple-darwin',
      executable: 'codex',
    },
    'linux-arm64': {
      packageName: '@openai/codex-linux-arm64',
      targetTriple: 'aarch64-unknown-linux-musl',
      executable: 'codex',
    },
    'linux-x64': {
      packageName: '@openai/codex-linux-x64',
      targetTriple: 'x86_64-unknown-linux-musl',
      executable: 'codex',
    },
    'win32-arm64': {
      packageName: '@openai/codex-win32-arm64',
      targetTriple: 'aarch64-pc-windows-msvc',
      executable: 'codex.exe',
    },
    'win32-x64': {
      packageName: '@openai/codex-win32-x64',
      targetTriple: 'x86_64-pc-windows-msvc',
      executable: 'codex.exe',
    },
  };
  const spec = specs[`${platform}-${arch}`];
  if (!spec) throw new Error(`不支持的 Codex 桌面目标：${platform}/${arch}`);
  return spec;
}

async function prepareCodexResource(platform = process.platform, arch = process.arch) {
  const spec = codexPlatformSpec(platform, arch);
  const codexPackage = JSON.parse(await readFile(codexPackageJson, 'utf8'));
  const requireFromCodex = createRequire(await realpath(codexPackageJson));
  let platformPackageJson;
  try {
    platformPackageJson = requireFromCodex.resolve(`${spec.packageName}/package.json`);
  } catch {
    throw new Error(
      `缺少 ${spec.packageName}（@openai/codex@${codexPackage.version} 的平台可选依赖），请重新运行 pnpm install`,
    );
  }
  const sourceRoot = join(dirname(platformPackageJson), 'vendor', spec.targetTriple);
  const sourceExecutable = join(sourceRoot, 'bin', spec.executable);
  const destinationExecutable = join(destinationRoot, 'bin', spec.executable);
  const sourceManifest = join(sourceRoot, 'codex-package.json');
  const destinationManifest = join(destinationRoot, 'codex-package.json');

  const sourceExecutableStat = await stat(sourceExecutable).catch(() => null);
  if (!sourceExecutableStat?.isFile()) {
    throw new Error(`Codex 平台包缺少原生二进制：${sourceExecutable}`);
  }
  const [sourceManifestText, destinationManifestText, preparedExecutable] = await Promise.all([
    readFile(sourceManifest, 'utf8'),
    readFile(destinationManifest, 'utf8').catch(() => ''),
    stat(destinationExecutable).catch(() => null),
  ]);
  if (
    sourceManifestText === destinationManifestText &&
    preparedExecutable?.isFile() &&
    preparedExecutable.size === sourceExecutableStat.size
  ) {
    console.log(
      `Codex @openai/codex@${codexPackage.version} ${platform}/${arch} 资源已就绪：${destinationRoot}`,
    );
    return;
  }
  await mkdir(dirname(destinationRoot), { recursive: true });
  await rm(destinationRoot, { recursive: true, force: true });
  await cp(sourceRoot, destinationRoot, { recursive: true });
  if (platform !== 'win32') {
    await chmod(destinationExecutable, 0o755);
  }
  console.log(
    `已准备 @openai/codex@${codexPackage.version} ${platform}/${arch} 资源：${destinationRoot}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  prepareCodexResource().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
