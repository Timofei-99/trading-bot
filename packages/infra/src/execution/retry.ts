export interface RetryOptions {
  /** Attempts AFTER the first, so 2 means up to three calls in total. */
  readonly maxRetries?: number;
  /** First backoff step; each further attempt doubles it. */
  readonly baseMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

/**
 * Retry a call that is safe to repeat, with exponential backoff.
 *
 * "Safe to repeat" is the whole precondition, and it is not a property of this
 * function — it is a property of the call. Every mutating exchange call routed
 * through here carries a client order id derived from the signal, so a repeat
 * after a lost reply is deduplicated by the venue rather than doubling a
 * position. Do not wrap a mutating call that lacks one.
 *
 * The final failure names the label and the attempt count, because "it failed"
 * without either is unactionable at three in the morning.
 */
export async function withRetry<T>(
  label: string,
  call: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const baseMs = options.baseMs ?? 500;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? (() => undefined);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) {
        break;
      }
      const delay = baseMs * 2 ** attempt;
      log(`${label} failed (${(error as Error).message}); retry in ${delay} ms`);
      await sleep(delay);
    }
  }
  throw new Error(
    `${label} failed after ${maxRetries + 1} attempts: ${(lastError as Error).message}`,
  );
}
