/**
 * Default timeout for connection tests (30 seconds)
 */
export const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 30_000;

/**
 * Wraps a promise with a timeout, rejecting if the promise doesn't resolve within the timeout period.
 *
 * @param promise - The promise to wrap with a timeout
 * @param timeoutMs - Timeout in milliseconds
 * @param errorMessage - Optional custom error message for timeout
 * @returns A promise that rejects with a timeout error if the original promise doesn't resolve in time
 *
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   fetchData(),
 *   5000,
 *   'Data fetch timed out'
 * );
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage?: string,
): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(errorMessage ?? `Operation timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    return result;
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    throw error;
  }
}
