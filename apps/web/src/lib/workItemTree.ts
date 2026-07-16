import type { WorkItem } from '../stores/workbench';

export interface WorkItemTreeRow {
  item: WorkItem;
  depth: number;
  hasChildren: boolean;
}

/**
 * 只在当前查询结果中建立父子关系，避免为了补齐祖先而扩大“我的工作项”或自定义查询范围。
 * 筛选时保留命中项的祖先路径，并临时展开路径，确保命中结果不会藏在折叠节点下。
 */
export function workItemTreeRows(
  items: WorkItem[],
  matches: ReadonlySet<number>,
  collapsed: ReadonlySet<number>,
  filtering: boolean,
): WorkItemTreeRow[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const included = new Set(matches);

  for (const id of matches) {
    let current = byId.get(id);
    const visited = new Set<number>();
    while (current?.parentId && byId.has(current.parentId) && !visited.has(current.parentId)) {
      visited.add(current.parentId);
      included.add(current.parentId);
      current = byId.get(current.parentId);
    }
  }

  const children = new Map<number, WorkItem[]>();
  const roots: WorkItem[] = [];
  for (const item of items) {
    if (!included.has(item.id)) continue;
    if (item.parentId && included.has(item.parentId) && item.parentId !== item.id) {
      const siblings = children.get(item.parentId) ?? [];
      siblings.push(item);
      children.set(item.parentId, siblings);
    } else {
      roots.push(item);
    }
  }

  const rows: WorkItemTreeRow[] = [];
  const append = (item: WorkItem, depth: number) => {
    const nested = children.get(item.id) ?? [];
    rows.push({ item, depth, hasChildren: nested.length > 0 });
    if (!filtering && collapsed.has(item.id)) return;
    for (const child of nested) append(child, depth + 1);
  };
  for (const root of roots) append(root, 0);
  return rows;
}
