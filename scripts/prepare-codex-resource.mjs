import { createRequire } from 'node:module';
import { cp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const codexPackageJson = resolve(root, 'node_modules/@openai/codex/package.json');
const destinationRoot = resolve(
  root,
  'apps/desktop/src-tauri/target/codex-resources/codex',
);

async function prepareCodexResource() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`Windows full 仅支持 win32/x64，当前为 ${process.platform}/${process.arch}`);
  }
  const packageName = '@openai/codex-win32-x64';
  const targetTriple = 'x86_64-pc-windows-msvc';
  const executable = 'codex.exe';
  const codexPackage = JSON.parse(await readFile(codexPackageJson, 'utf8'));
  const requireFromCodex = createRequire(await realpath(codexPackageJson));
  let platformPackageJson;
  try {
    platformPackageJson = requireFromCodex.resolve(`${packageName}/package.json`);
  } catch {
    throw new Error(
      `缺少 ${packageName}（@openai/codex@${codexPackage.version} 的平台可选依赖），请重新运行 pnpm install`,
    );
  }
  const sourceRoot = join(dirname(platformPackageJson), 'vendor', targetTriple);
  const sourceExecutable = join(sourceRoot, 'bin', executable);
  const destinationExecutable = join(destinationRoot, 'bin', executable);
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
      `Codex @openai/codex@${codexPackage.version} win32/x64 资源已就绪：${destinationRoot}`,
    );
    return;
  }
  await mkdir(dirname(destinationRoot), { recursive: true });
  await rm(destinationRoot, { recursive: true, force: true });
  await cp(sourceRoot, destinationRoot, { recursive: true });
  console.log(
    `已准备 @openai/codex@${codexPackage.version} win32/x64 资源：${destinationRoot}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  prepareCodexResource().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
