import { withRetry } from './retry';

function recorder() {
  const slept: number[] = [];
  const logged: string[] = [];
  return {
    slept,
    logged,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    log: (line: string) => logged.push(line),
  };
}

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const { sleep, slept } = recorder();

    await expect(withRetry('call', async () => 'ok', { sleep })).resolves.toBe('ok');
    expect(slept).toEqual([]);
  });

  it('retries until the call succeeds', async () => {
    const { sleep } = recorder();
    let attempts = 0;

    const result = await withRetry(
      'call',
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('flaky');
        }
        return 'ok';
      },
      { sleep },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('backs off exponentially from the base delay', async () => {
    const { sleep, slept } = recorder();

    await withRetry(
      'call',
      async () => {
        throw new Error('down');
      },
      { sleep, baseMs: 100, maxRetries: 3 },
    ).catch(() => undefined);

    expect(slept).toEqual([100, 200, 400]);
  });

  it('makes maxRetries + 1 attempts in total', async () => {
    const { sleep } = recorder();
    let attempts = 0;

    await withRetry(
      'call',
      async () => {
        attempts++;
        throw new Error('down');
      },
      { sleep, maxRetries: 2 },
    ).catch(() => undefined);

    expect(attempts).toBe(3);
  });

  it('does not sleep after the final attempt', async () => {
    // Sleeping then giving up wastes the caller's time for nothing.
    const { sleep, slept } = recorder();

    await withRetry(
      'call',
      async () => {
        throw new Error('down');
      },
      { sleep, maxRetries: 2 },
    ).catch(() => undefined);

    expect(slept).toHaveLength(2);
  });

  it('names the call, the attempt count and the last error when it gives up', async () => {
    // "It failed" without any of the three is unactionable at 3am.
    const { sleep } = recorder();

    await expect(
      withRetry(
        'placeLimitOrder',
        async () => {
          throw new Error('insufficient balance');
        },
        { sleep, maxRetries: 2 },
      ),
    ).rejects.toThrow('placeLimitOrder failed after 3 attempts: insufficient balance');
  });

  it('logs each retry with its delay', async () => {
    const { sleep, log, logged } = recorder();

    await withRetry(
      'fetchOrder',
      async () => {
        throw new Error('timeout');
      },
      { sleep, log, baseMs: 50, maxRetries: 1 },
    ).catch(() => undefined);

    expect(logged).toEqual(['fetchOrder failed (timeout); retry in 50 ms']);
  });

  it('works with no options at all, using its own sleep and logger', async () => {
    // The defaults are the production path for anything that does not care
    // about the delay, so they need to be exercised rather than assumed.
    let attempts = 0;

    const result = await withRetry('call', async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error('flaky');
      }
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('can be told not to retry at all', async () => {
    const { sleep } = recorder();
    let attempts = 0;

    await withRetry(
      'call',
      async () => {
        attempts++;
        throw new Error('down');
      },
      { sleep, maxRetries: 0 },
    ).catch(() => undefined);

    expect(attempts).toBe(1);
  });
});
