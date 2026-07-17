import { access, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifestJson, type RcxAppManifest } from '@rcx/app-sdk';

export const TEMPLATE_NAMES = ['hello', 'kanban', 'poll', 'oncall'] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export interface ValidatedProject {
  root: string;
  manifestPath: string;
  entryPath: string;
  manifest: RcxAppManifest;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function validateProject(directory = '.'): Promise<ValidatedProject> {
  const root = path.resolve(directory);
  const manifestPath = path.join(root, 'rcx.app.json');
  const manifest = parseManifestJson(await readFile(manifestPath, 'utf8'));
  if (typeof manifest.entry !== 'string' || /^https?:\/\//i.test(manifest.entry)) {
    throw new Error('A local RocketX app entry must be a relative file path');
  }
  const entryPath = path.resolve(root, manifest.entry);
  if (!inside(root, entryPath)) throw new Error('App entry must stay inside the project directory');
  if (!(await stat(entryPath)).isFile()) throw new Error(`App entry is not a file: ${manifest.entry}`);
  return { root, manifestPath, entryPath, manifest };
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized || 'app';
}

export async function createProject(
  directory: string,
  template: TemplateName = 'hello',
): Promise<ValidatedProject> {
  if (!TEMPLATE_NAMES.includes(template)) throw new Error(`Unknown template: ${template}`);
  const root = path.resolve(directory);
  let created = false;
  try {
    const existing = await readdir(root);
    if (existing.length) throw new Error(`Target directory is not empty: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(root, { recursive: true });
    created = true;
  }

  let templateRoot = fileURLToPath(new URL(`./templates/${template}/`, import.meta.url));
  try {
    await access(templateRoot);
  } catch {
    const examples = { hello: 'hello-app', kanban: 'kanban-app', poll: 'poll-app', oncall: 'oncall-app' };
    templateRoot = fileURLToPath(new URL(`../../../examples/${examples[template]}/`, import.meta.url));
  }
  for (const entry of await readdir(templateRoot)) {
    await cp(path.join(templateRoot, entry), path.join(root, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  const manifestPath = path.join(root, 'rcx.app.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RcxAppManifest;
  const projectSlug = slug(path.basename(root));
  manifest.id = `dev.local.${projectSlug}`;
  manifest.name = path.basename(root).replace(/[-_]+/g, ' ');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  try {
    return await validateProject(root);
  } catch (error) {
    if (created) {
      throw new Error(`Created ${root}, but the generated project is invalid: ${String(error)}`);
    }
    throw error;
  }
}
