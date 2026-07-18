export function shouldExpandRun(
  run: { at: number; status: 'ok' | 'error' } | undefined,
  now: number,
): boolean {
  if (!run || run.status !== 'ok') return false;

  const runDate = new Date(run.at);
  const nowDate = new Date(now);
  return runDate.getFullYear() === nowDate.getFullYear() &&
    runDate.getMonth() === nowDate.getMonth() &&
    runDate.getDate() === nowDate.getDate();
}
