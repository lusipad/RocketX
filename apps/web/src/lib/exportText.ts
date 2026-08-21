import { isTauri } from './http';

export interface SaveTextFileOptions {
  /** Tauri 保存对话框里的过滤器名与扩展名 */
  filterName?: string;
  extension?: string;
  mimeType?: string;
}

export async function saveTextFile(
  text: string,
  fileName: string,
  options: SaveTextFileOptions = {},
): Promise<boolean> {
  const { filterName = 'Markdown', extension = 'md', mimeType = 'text/markdown' } = options;
  const bytes = new TextEncoder().encode(text);
  if (isTauri) {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const target = await save({
      defaultPath: fileName,
      filters: [{ name: filterName, extensions: [extension] }],
    });
    if (!target) return false;
    await writeFile(target, bytes);
    return true;
  }

  const url = URL.createObjectURL(new Blob([bytes], { type: `${mimeType};charset=utf-8` }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
