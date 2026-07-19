/**
 * 管家轮询调度器。
 *
 * 客户端开着就轮询 ADO（默认 10 分钟），检测变化并运行规则引擎。
 * 关了就停——没有后台服务。
 */

import {
  evaluateRules,
  isWorkItemDone,
  type ButlerAlert,
  type ButlerAlertLevel,
  type RuleInput,
} from './butlerRules';

export type { ButlerAlert, ButlerAlertLevel };
import { useWorkbench, type WorkItem } from '../stores/workbench';
import { useTodos } from '../stores/todos';
import { loadWorkbenchConfig } from './ado';
import { isTauri } from './http';

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟
const SEEN_ALERTS_KEY = 'rcx-butler-seen-alerts';
const LAST_POLL_AT_KEY = 'rcx-butler-last-poll-at';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let generation = 0;

// 已通知过的 alert id（持久化到 localStorage，防止重启后重复通知）
let seenAlertIds: Set<string> = loadSeenAlerts();
let lastPollAt = loadLastPollAt();

function loadSeenAlerts(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_ALERTS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function persistSeenAlerts(): void {
  try {
    // 只保留最近 500 条，防止无限增长
    const arr = [...seenAlertIds].slice(-500);
    localStorage.setItem(SEEN_ALERTS_KEY, JSON.stringify(arr));
  } catch { /* 满了就不存 */ }
}

function loadLastPollAt(): number | null {
  try {
    const raw = localStorage.getItem(LAST_POLL_AT_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function persistLastPollAt(): void {
  try {
    if (lastPollAt === null) localStorage.removeItem(LAST_POLL_AT_KEY);
    else localStorage.setItem(LAST_POLL_AT_KEY, String(lastPollAt));
  } catch {
    /* 满了就不存 */
  }
}

// ─── 迭代日期获取 ───

export function resolveIterationProject(workItems: WorkItem[]): string | null {
  const projects = [...new Set(
    workItems
      .filter((wi) => !isWorkItemDone(wi.state))
      .map((wi) => wi.project?.trim())
      .filter((project): project is string => !!project),
  )];
  return projects.length === 1 ? projects[0] : null;
}

async function fetchIterationEndDate(workItems: WorkItem[]): Promise<string | null> {
  const config = loadWorkbenchConfig();
  if (!config || config.mode !== 'direct' || !config.adoBase) return null;

  try {
    const project = resolveIterationProject(workItems);
    if (!project) return null;
    const { adoBase, pat = '', auth } = config;
    const { ensureHttpOrigin, httpFetch } = await import('./http');
    const url = `${adoBase.replace(/\/+$/, '')}/${encodeURIComponent(project)}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.0`;

    await ensureHttpOrigin(url);

    let text: string;
    if (auth === 'ntlm') {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<{ status: number; body: string }>('win_auth_request', {
        url,
        method: 'GET',
        body: undefined,
        contentType: 'application/json',
      });
      if (res.status !== 200) return null;
      text = res.body;
    } else {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...(pat ? { Authorization: `Basic ${btoa(`:${pat}`)}` } : {}),
      };
      const res = await httpFetch(url, { method: 'GET', headers });
      if (!res.ok) return null;
      text = await res.text();
    }

    const data = JSON.parse(text) as {
      value: Array<{
        attributes?: { startDate?: string; finishDate?: string; timeFrame?: string };
      }>;
    };
    const current = data.value?.find((it) => it.attributes?.timeFrame === 'current');
    const finishDate = current?.attributes?.finishDate;
    if (!finishDate) return null;

    const d = new Date(finishDate);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return null;
  }
}

// ─── 通知派发 ───

async function dispatchNotification(alert: ButlerAlert): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('show_message_notification', {
      title: alert.title,
      body: alert.detail,
      rid: 'butler',
      mid: alert.id,
    });
  } catch {
    // 通知失败不阻断轮询
  }
}

export function filterActiveAlertsForView(
  alerts: ButlerAlert[],
  persistedSeenAlertIds: ReadonlySet<string>,
): ButlerAlert[] {
  return alerts.filter(
    (alert) => alert.kind !== 'new-high-priority' || persistedSeenAlertIds.has(alert.id),
  );
}

// ─── 轮询核心 ───

async function pollOnce(): Promise<ButlerAlert[]> {
  if (running) return [];
  running = true;
  const gen = generation;
  const previousPollAt = lastPollAt;
  const pollStartedAt = Date.now();

  try {
    // 1. 刷新 ADO 数据
    await useWorkbench.getState().refresh();

    // 2. 收集规则输入（在最后一个 await 之后读 store，避免过期快照）
    const { workItems, prs: pullRequests, builds, config } = useWorkbench.getState();
    const { todos } = useTodos.getState();
    const adoAccount = config?.account ?? '';
    const iterationEndDate = await fetchIterationEndDate(workItems);

    // 已停止——丢弃本轮结果
    if (gen !== generation) return [];

    const input: RuleInput = {
      todos,
      workItems,
      pullRequests,
      builds,
      adoAccount,
      iterationEndDate,
      lastPollAt: previousPollAt,
      seenAlertIds,
    };

    // 3. 运行规则引擎
    const alerts = evaluateRules(input);

    // 4. 派发通知（只对 immediate 级别且未被作废）
    if (gen !== generation) return [];
    const newAlerts = alerts.filter((a) => !seenAlertIds.has(a.id));
    for (const alert of newAlerts) {
      if (alert.level === 'immediate') {
        await dispatchNotification(alert);
      }
      seenAlertIds.add(alert.id);
    }

    // 5. 持久化已见与基线
    if (newAlerts.length > 0) persistSeenAlerts();
    lastPollAt = pollStartedAt;
    persistLastPollAt();

    return alerts;
  } finally {
    running = false;
  }
}

// ─── 公开 API ───

export function startButlerPoller(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (pollTimer) return;
  // 启动后立即执行一次
  void pollOnce();
  pollTimer = setInterval(() => void pollOnce(), intervalMs);
}

export function stopButlerPoller(): void {
  generation++;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function isPollerRunning(): boolean {
  return pollTimer !== null;
}

/** 手动触发一次轮询并返回本轮活跃集合（用于用户点"刷新"） */
export async function pollNow(): Promise<ButlerAlert[]> {
  await pollOnce();
  return getActiveAlerts();
}

/** 获取当前所有活跃 alert——用于咖啡时间视图 */
export async function getActiveAlerts(): Promise<ButlerAlert[]> {
  const { workItems, prs: pullRequests, builds, config } = useWorkbench.getState();
  const { todos } = useTodos.getState();
  const iterationEndDate = await fetchIterationEndDate(workItems);
  return filterActiveAlertsForView(evaluateRules({
    todos,
    workItems,
    pullRequests,
    builds,
    adoAccount: config?.account ?? '',
    iterationEndDate,
    lastPollAt: 0,
    seenAlertIds: new Set(), // 视图里要展示本轮活跃事实，不按历史已见过滤
  }), seenAlertIds);
}
