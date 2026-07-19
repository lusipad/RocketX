export interface ButlerBuildIdentity {
  definition: string;
  project?: string;
  finishTime?: string;
}

/** 历史失败不能盖过同一流水线后来已经成立的当前状态。 */
export function latestBuildsByDefinitionProject<T extends ButlerBuildIdentity>(
  builds: readonly T[],
): T[] {
  const latest = new Map<string, { build: T; finishTime: number }>();
  for (const build of builds) {
    const key = `${build.definition}\0${build.project ?? ''}`;
    const finishTime = Date.parse(build.finishTime ?? '');
    const current = latest.get(key);
    if (!current) {
      latest.set(key, { build, finishTime });
      continue;
    }
    if (
      (Number.isFinite(finishTime) && !Number.isFinite(current.finishTime))
      || (Number.isFinite(finishTime) && finishTime >= current.finishTime)
    ) {
      latest.set(key, { build, finishTime });
    }
  }
  return [...latest.values()].map(({ build }) => build);
}
