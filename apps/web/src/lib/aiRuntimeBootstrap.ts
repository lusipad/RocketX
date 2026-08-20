import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './http';
import {
  activateAiRuntimeProvider,
  getAiRuntimeProvider,
  getRuntimeMode,
  readConfiguredAiRuntimeProvider,
  selectStartupAiRuntimeProvider,
  type AiRuntimeProvider,
  type RuntimeModeStorage,
} from './runtimeMode';

interface RuntimeReadinessProbe {
  ready: boolean;
  reason?: string;
}

export type DesktopDistributionProfile = 'full' | 'slim' | 'unknown' | 'web';
export type AiRuntimeStartupSource =
  | 'automatic'
  | 'explicit'
  | 'explicit-unavailable'
  | 'full-default'
  | 'mode-disabled'
  | 'web';

export interface AiRuntimeStartupResolution {
  active: AiRuntimeProvider;
  configured?: AiRuntimeProvider;
  profile: DesktopDistributionProfile;
  reason?: string;
  source: AiRuntimeStartupSource;
}

let startupResolution: AiRuntimeStartupResolution = {
  active: getAiRuntimeProvider(),
  profile: isTauri ? 'unknown' : 'web',
  source: isTauri ? 'automatic' : 'web',
};

export type AiRuntimeBootstrapInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface AiRuntimeBootstrapOptions {
  desktop?: boolean;
  invokeRuntime?: AiRuntimeBootstrapInvoker;
  manualCodexPath?: string | null;
  storage?: RuntimeModeStorage;
}

async function probeRuntime(
  invokeRuntime: AiRuntimeBootstrapInvoker,
  command: string,
  args: Record<string, unknown>,
): Promise<RuntimeReadinessProbe> {
  try {
    const probe = await invokeRuntime<RuntimeReadinessProbe>(command, args);
    return { ready: probe.ready === true, reason: probe.reason };
  } catch (error) {
    return { ready: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function applyStartupResolution(resolution: AiRuntimeStartupResolution): AiRuntimeProvider {
  startupResolution = resolution;
  return activateAiRuntimeProvider(resolution.active);
}

export function getAiRuntimeStartupResolution(): AiRuntimeStartupResolution {
  return { ...startupResolution };
}

export async function initializeStartupAiRuntimeProvider({
  desktop = isTauri,
  invokeRuntime = invoke,
  manualCodexPath = null,
  storage,
}: AiRuntimeBootstrapOptions = {}): Promise<AiRuntimeProvider> {
  const configured = readConfiguredAiRuntimeProvider(storage);
  if (!desktop) {
    return applyStartupResolution({
      active: 'none',
      configured,
      profile: 'web',
      source: 'web',
    });
  }
  if (getRuntimeMode() === 'performance') {
    return applyStartupResolution({
      active: 'none',
      configured,
      profile: 'unknown',
      source: 'mode-disabled',
    });
  }
  if (configured === 'none') {
    return applyStartupResolution({
      active: 'none',
      configured,
      profile: 'unknown',
      source: 'explicit',
    });
  }
  if (configured) {
    const command = configured === 'deepseek' ? 'dsh_runtime_probe' : 'codex_runtime_probe';
    const args = configured === 'deepseek'
      ? { sourcePath: null }
      : { manualPath: manualCodexPath };
    const probe = await probeRuntime(invokeRuntime, command, args);
    const active = selectStartupAiRuntimeProvider(configured, {
      deepseek: configured === 'deepseek' && probe.ready,
      codex: configured === 'codex' && probe.ready,
    });
    return applyStartupResolution({
      active,
      configured,
      profile: 'unknown',
      ...(probe.ready ? {} : { reason: probe.reason }),
      source: probe.ready ? 'explicit' : 'explicit-unavailable',
    });
  }

  let profile: DesktopDistributionProfile = 'unknown';
  try {
    const detectedProfile = await invokeRuntime<string>('desktop_distribution_profile');
    if (detectedProfile === 'full' || detectedProfile === 'slim') profile = detectedProfile;
  } catch {
    // 旧版或损坏的包形态命令按 slim 处理，由实际运行时探测决定是否启用 AI。
  }
  if (profile === 'full') {
    // full 版的探测包含归档校验与外部进程 spawn，两个探测必须并行，
    // 串行会把首屏延迟翻倍（slim 路径早已并行）。
    const [deepseekProbe, codexProbe] = await Promise.all([
      probeRuntime(invokeRuntime, 'dsh_runtime_probe', { sourcePath: null }),
      probeRuntime(invokeRuntime, 'codex_runtime_probe', { manualPath: manualCodexPath }),
    ]);
    if (deepseekProbe.ready) {
      return applyStartupResolution({
        active: 'deepseek',
        profile,
        source: 'full-default',
      });
    }
    const active = selectStartupAiRuntimeProvider(undefined, {
      deepseek: false,
      codex: codexProbe.ready,
    });
    return applyStartupResolution({
      active,
      profile,
      source: 'automatic',
      reason: deepseekProbe.reason ?? codexProbe.reason,
    });
  }

  const [deepseekProbe, codexProbe] = await Promise.all([
    probeRuntime(invokeRuntime, 'dsh_runtime_probe', { sourcePath: null }),
    probeRuntime(invokeRuntime, 'codex_runtime_probe', { manualPath: manualCodexPath }),
  ]);
  const active = selectStartupAiRuntimeProvider(undefined, {
    deepseek: deepseekProbe.ready,
    codex: codexProbe.ready,
  });
  return applyStartupResolution({ active, profile, source: 'automatic' });
}
