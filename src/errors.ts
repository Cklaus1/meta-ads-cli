/**
 * Wraps an async command action with consistent error handling.
 * Catches errors and prints user-friendly messages instead of stack traces.
 */
export function handleErrors<T extends (...args: never[]) => Promise<void>>(fn: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  }) as T;
}
