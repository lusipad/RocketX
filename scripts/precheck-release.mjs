import { readFile } from 'node:fs/promises';
import { verifyRelease } from './verify-release.mjs';

try {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await verifyRelease(`v${version}`);
  console.log(`Release contract verified for v${version}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
