/**
 * Small async helpers. Pure and dependency-free so they can be unit-tested
 * without the hap-controller runtime.
 */

/**
 * Race a promise against a hard timeout. If `work` doesn't settle within
 * `timeoutMs`, the returned promise rejects with a descriptive Error; otherwise
 * it settles exactly as `work` does. The timer is always cleared, and because
 * Promise.race keeps a reaction attached to `work`, a late settlement from an
 * abandoned (timed-out) call is absorbed rather than surfacing as an unhandled
 * rejection.
 */
export function raceWithTimeout<T>(label: string, work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
