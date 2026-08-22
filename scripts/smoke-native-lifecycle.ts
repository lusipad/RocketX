import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const manifest = join(root, 'apps', 'desktop', 'src-tauri', 'Cargo.toml');

function run(filter: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', ['test', '--locked', '--manifest-path', manifest, filter], {
      cwd: root,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`cargo lifecycle smoke failed: ${filter} (${code ?? signal})`));
    });
  });
}

async function main(): Promise<void> {
  await run('native::process::tests');
  await run('native::lan::tests');
  console.log('[native-lifecycle] fake-child stop/join and LAN thread cleanup passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
