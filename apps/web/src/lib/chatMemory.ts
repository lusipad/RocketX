export function retainRecentRooms(
  order: readonly string[],
  activeRid: string,
  recentInactiveLimit: number,
): { order: string[]; evicted: string[] } {
  const next = [...order.filter((rid) => rid !== activeRid), activeRid];
  const keepCount = Math.max(1, recentInactiveLimit + 1);
  const evictedCount = Math.max(0, next.length - keepCount);
  return {
    order: next.slice(evictedCount),
    evicted: next.slice(0, evictedCount),
  };
}

export function canApplyRetainedRoomResult(
  requestGeneration: number,
  currentGeneration: number,
  retainedOrder: readonly string[],
  rid: string,
): boolean {
  return requestGeneration === currentGeneration && retainedOrder.includes(rid);
}

export function omitRoomEntries<T>(
  record: Readonly<Record<string, T>>,
  evictedRids: readonly string[],
): Record<string, T> {
  const next = { ...record };
  for (const rid of evictedRids) delete next[rid];
  return next;
}

export function trimRoomMessages<T>(
  messages: Readonly<Record<string, T[]>>,
  evictedRids: readonly string[],
  limit: number,
): Record<string, T[]> {
  const next = { ...messages };
  for (const rid of evictedRids) {
    const roomMessages = next[rid];
    if (roomMessages && roomMessages.length > limit) next[rid] = roomMessages.slice(-limit);
  }
  return next;
}
