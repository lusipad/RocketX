import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { agentDeviceId } from '../agent/device';
import { workContextPathKey } from '../lib/workContext';
import { captureButlerAccountGeneration, captureButlerRuntimeAccountContext } from '../platform/butlerAccountReady';
import { startNativeWork, type AcpAgentProfile, type NativeWorkCard } from '../platform/desktopCommands';
import type { NativeWorkStartInput } from '../platform/nativeWorkRuntime';
import { resolveButlerAccountScope } from './butlerMemory';
import { useAcpAgents } from './acpAgents';
import { useWorkLedger } from './workLedger';

type StartIdentity = Omit<NativeWorkStartInput, 'account'>;
interface Trial { input: StartIdentity; error?: string; notStarted?: boolean }
interface Starts { trials: Record<string, Trial> }

// After a document reload a pending IPC is unknown. Only an explicit retry of
// its original immutable identity may ask the native journal to reconcile it.
export const useNativeWorkStarts = create<Starts>()(persist(() => ({ trials: {} }), { name: 'rcx-native-work-starts-v1' }));
const inFlight = new Set<string>();
export const workStartKey = (scope: string, id: string) => JSON.stringify([scope, id]);
export const absoluteWorkspace = (path: string) => /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(path.trim());
export const eligibleCodexProfiles = (agents: AcpAgentProfile[]) => agents.filter(agent => agent.enabled && agent.sourceScope
  && agent.args.includes('--rocketx-acp-bridge=codex'));

export function chooseStartProfile(profiles: AcpAgentProfile[], workspace: string, chosen: string) {
  if (chosen) return profiles.find(profile => profile.id === chosen);
  if (profiles.length === 1) return profiles[0];
  const matching = workspace.trim() ? profiles.filter(profile => profile.cwd && workContextPathKey(profile.cwd) === workContextPathKey(workspace)) : [];
  return matching.length === 1 ? matching[0] : undefined;
}

export async function beginWorkInvestigation(card: NativeWorkCard, workspace: string, profileId: string) {
  const account = captureButlerRuntimeAccountContext();
  const assertAccount = captureButlerAccountGeneration();
  if (account.accountScope !== resolveButlerAccountScope()) throw new Error('当前账号尚未就绪，请稍后重试。');
  const key = workStartKey(account.accountScope, card.id);
  if (inFlight.has(key)) return;
  const previous = useNativeWorkStarts.getState().trials[key];
  if (previous && (previous.input.todoId !== card.id || previous.input.requestId !== `native-start:${card.id}` || previous.input.hostDeviceId !== agentDeviceId())) {
    throw new Error('原启动请求不属于当前工作或设备，请核对原记录。');
  }
  const binding = () => useWorkLedger.getState().links.find(link => link.todoId === card.id && link.kind === 'kanban_card' && link.stateSnapshot === 'workspace');
  const bound = binding();
  const fresh = !previous || previous.notStarted;
  if (fresh) {
    if (!absoluteWorkspace(workspace)) throw new Error('请输入完整的本地项目目录。');
    if (!bound?.repo || (!previous?.notStarted && workContextPathKey(bound.repo) !== workContextPathKey(workspace))) throw new Error('这项工作的目录已变化，请重新核对。');
    if (!eligibleCodexProfiles(useAcpAgents.getState().agents).some(profile => profile.id === profileId)) throw new Error('原 Codex 配置已不可用，请重新选择。');
  }
  inFlight.add(key);
  let submitted: StartIdentity | undefined;
  let confirmedNotStarted = false;
  try {
    if (fresh && bound?.repo && workContextPathKey(bound.repo) !== workContextPathKey(workspace)) {
      if (useWorkLedger.getState().sessions.some(s => s.todoId === card.id) || workContextPathKey(bound.repo) !== workContextPathKey(previous!.input.workspaceRoot)) {
        throw new Error('工作已有会话或目录已变更，请核对当前绑定。');
      }
      await useWorkLedger.getState().upsertLink({ ...bound, repo: workspace });
      assertAccount();
    }
    const current = useWorkLedger.getState().cards.find(c => c.id === card.id);
    if (!current || fresh && (useWorkLedger.getState().sessions.some(s => s.todoId === card.id)
      || workContextPathKey(binding()?.repo ?? '') !== workContextPathKey(workspace))) throw new Error('工作或目录已变化，请核对当前绑定。');
    const input: StartIdentity = fresh ? { todoId: card.id, requestId: `native-start:${card.id}`, workspaceRoot: workspace,
      executionProfileId: profileId, expectedRequirementsVersion: current.state.requirementsVersion ?? 0,
      expectedContentVersion: current.state.contentVersion ?? 0, hostDeviceId: agentDeviceId() } : previous!.input;
    useNativeWorkStarts.setState(state => ({ trials: { ...state.trials, [key]: { input } } }));
    submitted = input;
    const view = await startNativeWork({ account, ...input }).catch(cause => {
      const message = cause instanceof Error ? cause.message : String(cause);
      const prefix = 'rocketx.native-start.not-started.v1:';
      if (message.startsWith(prefix)) { assertAccount(); confirmedNotStarted = true; throw new Error(message.slice(prefix.length).trim() || '调查未开始'); }
      throw cause;
    });
    assertAccount();
    if (view.todoId !== card.id || view.executionProfileId !== input.executionProfileId || !view.sessionId || !view.nativeThreadId) throw new Error('返回的执行会话与启动请求不匹配。');
    await useWorkLedger.getState().hydrate();
    assertAccount();
    const saved = useWorkLedger.getState().sessions.find(s => s.todoId === card.id && s.id === view.sessionId && s.nativeSessionId === view.nativeThreadId
      && s.sourceScope === view.sourceScope && s.accountScope === account.accountScope && workContextPathKey(s.workspaceRoot) === workContextPathKey(input.workspaceRoot));
    if (!saved) throw new Error('启动请求已提交，正在等待工作记录更新。');
    useNativeWorkStarts.setState(state => {
      const trials = { ...state.trials }; delete trials[key]; return { trials };
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    inFlight.delete(key);
    if (submitted) {
      const input = submitted;
      useNativeWorkStarts.setState(state => ({ trials: { ...state.trials, [key]: { input, error, notStarted: confirmedNotStarted } } }));
    }
    throw cause;
  } finally { inFlight.delete(key); }
}

export function isWorkStartPending(key: string) { return inFlight.has(key); }
