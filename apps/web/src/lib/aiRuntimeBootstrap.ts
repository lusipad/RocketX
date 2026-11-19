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
  | 'performance'
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

  const probe = await probeRuntime(invokeRuntime, 'pi_runtime_probe', { manualPath: null });
  const active = selectStartupAiRuntimeProvider(configured, { pi: probe.ready });
  const reason = !probe.ready && probe.reason?.trim() ? probe.reason.trim() : undefined;

  return applyStartupResolution({
    active,
    ...(configured ? { configured } : {}),
    profile: 'unknown',
    ...(reason ? { reason } : {}),
    source: configured === 'pi'
      ? (probe.ready ? 'explicit' : 'explicit-unavailable')
      : 'automatic',
  });
}
