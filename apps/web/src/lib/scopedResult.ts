export async function applyScopedResult<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
  isCurrent: () => boolean,
): Promise<T> {
  const value = await load();
  if (isCurrent()) apply(value);
  return value;
}

export async function settleScopedResult<T>(
  load: () => Promise<T>,
  handlers: {
    success: (value: T) => void;
    error?: (error: unknown) => void;
    complete?: () => void;
  },
  isCurrent: () => boolean,
): Promise<void> {
  try {
    const value = await load();
    if (isCurrent()) handlers.success(value);
  } catch (error) {
    if (isCurrent()) handlers.error?.(error);
  } finally {
    if (isCurrent()) handlers.complete?.();
  }
}
