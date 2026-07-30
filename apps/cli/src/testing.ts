/**
 * Shared helpers for the command specs.
 *
 * Commands talk to the operator through `console.log`, so testing what they
 * say means capturing it. Kept here rather than repeated per spec because the
 * restore-on-failure detail is easy to get wrong once and then debug for an
 * hour in an unrelated suite.
 */

export interface Captured {
  readonly lines: string[];
  /** Everything printed, joined — for looser `toContain` assertions. */
  text(): string;
}

/**
 * Run `body` with `console.log` captured.
 *
 * Restores the real console even when `body` throws, which matters: a command
 * that is supposed to reject bad input will throw, and swallowing the console
 * from that point on would silently blind every later test in the file.
 */
export async function capture(body: () => Promise<void> | void): Promise<Captured> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await body();
  } finally {
    console.log = original;
  }
  return { lines, text: () => lines.join('\n') };
}

/** Capture output from a call that is expected to throw, and return both. */
export async function captureError(
  body: () => Promise<void> | void,
): Promise<{ captured: Captured; error: Error | null }> {
  let error: Error | null = null;
  const captured = await capture(async () => {
    try {
      await body();
    } catch (thrown) {
      error = thrown as Error;
    }
  });
  return { captured, error };
}
