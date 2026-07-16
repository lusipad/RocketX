import { isTauri } from './http';

export async function saveTextFile(text: string, fileName: string): Promise<boolean> {
  const bytes = new TextEncoder().encode(text);
  if (isTauri) {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const target = await save({
      defaultPath: fileName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (!target) return false;
    await writeFile(target, bytes);
    return true;
  }

  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/markdown;charset=utf-8' }));
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
