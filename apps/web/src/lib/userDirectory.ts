import type { RcUser } from '@rcx/rc-client';
import { t } from '../i18n';

export interface UserDirectoryPage {
  users: RcUser[];
  total: number;
  via: string;
}

interface CollectOptions {
  pageSize?: number;
  maxUsers?: number;
  maxPages?: number;
  isCurrent?: () => boolean;
}

export interface UserDirectoryResult {
  users: RcUser[];
  total: number;
  warning?: string;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_USERS = 5_000;

const positiveInteger = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;

/**
 * 在有限请求预算内收集用户目录。
 * 重复页、空页和数据源切换都返回已有数据与警告，避免请求风暴或静默残缺。
 */
export async function collectUserDirectory(
  first: UserDirectoryPage,
  fetchPage: (offset: number) => Promise<UserDirectoryPage>,
  options: CollectOptions = {},
): Promise<UserDirectoryResult> {
  const pageSize = positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE);
  const maxUsers = positiveInteger(options.maxUsers, DEFAULT_MAX_USERS);
  const maxPages = positiveInteger(options.maxPages, Math.ceil(maxUsers / pageSize));
  const isCurrent = options.isCurrent ?? (() => true);
  const total = Math.max(first.users.length, positiveInteger(first.total, first.users.length));
  const users = new Map<string, RcUser>();
  for (const user of first.users) {
    if (users.size >= maxUsers) break;
    users.set(user._id, user);
  }

  if (users.size >= maxUsers && total > users.size) {
    return {
      users: [...users.values()],
      total,
      warning: t('chat.userDirectory.maxUsers', { total, maxUsers }),
    };
  }
  if (first.via !== 'directory' && first.via !== 'users.list') {
    return { users: [...users.values()], total };
  }

  let offset = first.users.length;
  let pages = 1;
  let warning: string | undefined;
  while (offset < total && users.size < maxUsers && pages < maxPages && isCurrent()) {
    let page: UserDirectoryPage;
    try {
      page = await fetchPage(offset);
    } catch (error) {
      warning = t('chat.userDirectory.pageFailed', {
        loaded: users.size,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
    pages++;
    if (!isCurrent()) break;
    if (page.via !== first.via) {
      warning = t('chat.userDirectory.sourceChanged', {
        loaded: users.size,
        from: first.via,
        to: page.via,
      });
      break;
    }
    if (page.users.length === 0) {
      warning = t('chat.userDirectory.emptyPage', { total, loaded: users.size });
      break;
    }

    const before = users.size;
    for (const user of page.users) {
      if (users.size >= maxUsers) break;
      users.set(user._id, user);
    }
    if (users.size === before) {
      warning = t('chat.userDirectory.noNewUsers', { loaded: users.size });
      break;
    }
    offset += page.users.length;
  }

  if (!warning && users.size >= maxUsers && total > users.size) {
    warning = t('chat.userDirectory.maxUsers', { total, maxUsers });
  } else if (!warning && offset >= total && users.size < Math.min(total, maxUsers)) {
    warning = t('chat.userDirectory.dedupShort', { total, loaded: users.size });
  } else if (!warning && pages >= maxPages && offset < total) {
    warning = t('chat.userDirectory.maxPages', { total, maxPages, loaded: users.size });
  }

  return { users: [...users.values()], total, warning };
}
