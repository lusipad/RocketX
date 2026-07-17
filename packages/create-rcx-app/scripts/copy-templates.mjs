import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '../..');
const output = path.join(packageRoot, 'dist', 'templates');
const templates = {
  hello: 'hello-app',
  kanban: 'kanban-app',
  poll: 'poll-app',
  oncall: 'oncall-app',
};

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const [name, source] of Object.entries(templates)) {
  await cp(path.join(repoRoot, 'examples', source), path.join(output, name), { recursive: true });
}
