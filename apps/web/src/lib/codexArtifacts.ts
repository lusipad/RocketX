export type CodexArtifactKind = 'html' | 'markdown' | 'image' | 'pdf' | 'text' | 'file';

export interface CodexArtifact {
  path: string;
  name: string;
  kind: CodexArtifactKind;
  mimeType: string;
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf',
  'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp',
  'cs', 'sh', 'bat', 'ps1', 'sql', 'vue', 'svelte', 'env', 'gitignore',
]);

function decoded(value: string): string {
  const unwrapped = value.trim().replace(/^<|>$/g, '');
  try {
    return decodeURIComponent(unwrapped);
  } catch {
    return unwrapped;
  }
}

function normalizeSegments(parts: string[], absolute: boolean): string[] | null {
  const result: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (result.length === 0) return absolute ? [] : null;
      result.pop();
      continue;
    }
    result.push(part);
  }
  return result;
}

function normalizeWindowsPath(value: string): string | null {
  let path = value.replaceAll('/', '\\');
  if (/^\\[A-Za-z]:\\/.test(path)) path = path.slice(1);
  if (!/^[A-Za-z]:\\/.test(path)) return null;
  const drive = path.slice(0, 3);
  const parts = normalizeSegments(path.slice(3).split('\\'), true);
  return parts ? `${drive}${parts.join('\\')}` : null;
}

function normalizePosixPath(value: string): string | null {
  if (!value.startsWith('/')) return null;
  const parts = normalizeSegments(value.split('/'), true);
  return parts ? `/${parts.join('/')}` : null;
}

function resolveRelativePath(value: string, workspaceRoot: string): string | null {
  if (!workspaceRoot || workspaceRoot === '~') return null;
  if (/^[A-Za-z]:[\\/]/.test(workspaceRoot)) {
    return normalizeWindowsPath(`${workspaceRoot.replace(/[\\/]+$/, '')}\\${value}`);
  }
  if (workspaceRoot.startsWith('/')) {
    return normalizePosixPath(`${workspaceRoot.replace(/\/+$/, '')}/${value.replaceAll('\\', '/')}`);
  }
  return null;
}

function localPathFromHref(href: string, workspaceRoot: string): string | null {
  let value = decoded(href);
  if (/^(?:https?|javascript|data):/i.test(value)) return null;

  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\//i, '');
    if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
    else if (!/^[A-Za-z]:\//.test(value)) value = `/${value.replace(/^\/+/, '')}`;
  }

  const windows = normalizeWindowsPath(value);
  if (windows) return windows;

  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('.\\') || value.startsWith('..\\')) {
    return resolveRelativePath(value, workspaceRoot);
  }

  return normalizePosixPath(value);
}

function artifactType(name: string): Pick<CodexArtifact, 'kind' | 'mimeType'> {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (extension === 'html' || extension === 'htm') return { kind: 'html', mimeType: 'text/html' };
  if (extension === 'md' || extension === 'markdown') return { kind: 'markdown', mimeType: 'text/markdown' };
  if (extension === 'pdf') return { kind: 'pdf', mimeType: 'application/pdf' };
  if (extension === 'png') return { kind: 'image', mimeType: 'image/png' };
  if (extension === 'jpg' || extension === 'jpeg') return { kind: 'image', mimeType: 'image/jpeg' };
  if (extension === 'gif') return { kind: 'image', mimeType: 'image/gif' };
  if (extension === 'webp') return { kind: 'image', mimeType: 'image/webp' };
  if (extension === 'svg') return { kind: 'image', mimeType: 'image/svg+xml' };
  if (TEXT_EXTENSIONS.has(extension)) return { kind: 'text', mimeType: 'text/plain' };
  return { kind: 'file', mimeType: 'application/octet-stream' };
}

export function codexArtifactFromLink(
  _label: string,
  href: string,
  workspaceRoot: string,
): CodexArtifact | null {
  const path = localPathFromHref(href, workspaceRoot);
  if (!path) return null;
  const name = path.split(/[\\/]/).filter(Boolean).at(-1);
  if (!name) return null;
  return { path, name, ...artifactType(name) };
}

export function codexArtifactsFromMarkdown(
  text: string,
  workspaceRoot: string,
): CodexArtifact[] {
  const artifacts: CodexArtifact[] = [];
  const seen = new Set<string>();
  const links = text.matchAll(/\[([^\]\n]+)\]\(((?:file:\/\/\/|\/?[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)[^)\n]+)\)/g);
  for (const link of links) {
    const artifact = codexArtifactFromLink(link[1], link[2], workspaceRoot);
    if (!artifact || seen.has(artifact.path)) continue;
    seen.add(artifact.path);
    artifacts.push(artifact);
  }
  return artifacts;
}

export function sandboxArtifactHtml(html: string): string {
  const policy = "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:;";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${meta}`)
    : `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}
