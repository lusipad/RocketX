export async function applyScopedResult<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
  isCurrent: () => boolean,
): Promise<T> {
  const value = await load();
  if (isCurrent()) apply(value);
  return value;
}
