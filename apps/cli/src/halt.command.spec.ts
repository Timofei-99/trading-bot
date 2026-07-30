import { JournalEvent } from '@bot/core/domain/order';
import { NdjsonTradeJournal } from '@bot/infra/journal/ndjson-trade-journal';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HaltCommand, ResumeCommand } from './halt.command';
import { capture, captureError } from './testing';

/**
 * The manual stop, which works through the journal rather than through the
 * process — so it stops a bot that is running, stays in force across a
 * restart, and can be applied to a bot that is not running at all.
 *
 * These use a real journal file on disk, because the file IS the mechanism.
 */
describe('halt / resume', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halt-'));
    path = join(dir, 'paper.ndjson');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const events = (): JournalEvent[] => new NdjsonTradeJournal(path).readAll();
  const halt = (options = {}) => new HaltCommand().run([], { journal: path, ...options });
  const resume = (options = {}) => new ResumeCommand().run([], { journal: path, ...options });

  describe('halt', () => {
    it('writes a halt the bot will replay', async () => {
      await capture(() => halt({ reason: 'testing' }));

      expect(events()).toEqual([{ type: 'halted', at: expect.any(Number), reason: 'testing' }]);
    });

    it('records a reason even when none was given', async () => {
      // The journal is the audit trail; an unexplained halt is worse than a
      // vaguely explained one.
      await capture(() => halt());

      expect((events()[0] as { reason: string }).reason).toBe('halted manually');
    });

    it('says out loud that an open position is left alone', async () => {
      // The single most dangerous misreading of this command: halting stops
      // NEW entries, it does not flatten the book.
      const out = await capture(() => halt({ reason: 'testing' }));

      expect(out.text()).toContain('OPEN POSITION IS LEFT ALONE');
      expect(out.text()).toContain('next tick');
    });

    it('appends rather than replacing, so the history survives', async () => {
      await capture(() => halt({ reason: 'first' }));
      await capture(() => resume());
      await capture(() => halt({ reason: 'second' }));

      expect(events().map((event) => event.type)).toEqual(['halted', 'resumed', 'halted']);
    });

    it('creates the journal when the bot has never run', async () => {
      // Halting a bot before its first start is legitimate — it is how you
      // stop one that is scheduled but not yet up.
      await capture(() => halt({ reason: 'pre-emptive' }));

      expect(events()).toHaveLength(1);
    });
  });

  describe('resume', () => {
    it('clears a halt', async () => {
      await capture(() => halt({ reason: 'testing' }));

      await capture(() => resume({ note: 'all clear' }));

      expect(events()[1]).toEqual({ type: 'resumed', at: expect.any(Number), note: 'all clear' });
    });

    it('does nothing when the bot was never halted', async () => {
      const out = await capture(() => resume());

      expect(out.text()).toContain('not halted; nothing to resume');
      expect(events()).toEqual([]);
    });

    it('does nothing when the last word was already a resume', async () => {
      // Otherwise a double resume writes a second event that means nothing and
      // makes the trail harder to read.
      await capture(() => halt());
      await capture(() => resume());

      const out = await capture(() => resume());

      expect(out.text()).toContain('nothing to resume');
      expect(events()).toHaveLength(2);
    });

    it('resumes again after a second halt', async () => {
      await capture(() => halt());
      await capture(() => resume());
      await capture(() => halt({ reason: 'again' }));

      await capture(() => resume());

      expect(events().map((event) => event.type)).toEqual([
        'halted',
        'resumed',
        'halted',
        'resumed',
      ]);
    });

    it('reads past events that are neither halt nor resume', async () => {
      // A real journal is mostly orders; the halt state has to be read out of
      // the noise rather than assuming the file contains only halts.
      new NdjsonTradeJournal(path).append({
        type: 'session',
        at: Date.now(),
        note: 'start',
        balance: 10_000,
      });
      await capture(() => halt({ reason: 'testing' }));

      const out = await capture(() => resume());

      expect(out.text()).toContain('may open positions again');
      expect(events()).toHaveLength(3);
    });
  });

  describe('the journal argument', () => {
    it.each([
      ['halt', () => new HaltCommand().run([], {})],
      ['resume', () => new ResumeCommand().run([], {})],
    ])('%s refuses to guess which bot to act on', async (_name, run) => {
      // Guessing a default here would mean halting the wrong bot, silently.
      const { error } = await captureError(run);

      expect(error?.message).toMatch(/--journal is required/);
    });

    it('is passed through verbatim by the option parser', () => {
      expect(new HaltCommand().parseJournal('data/journal/x.ndjson')).toBe('data/journal/x.ndjson');
      expect(new ResumeCommand().parseJournal('other.ndjson')).toBe('other.ndjson');
    });

    it('carries the reason and note through their parsers', () => {
      expect(new HaltCommand().parseReason('drawdown')).toBe('drawdown');
      expect(new ResumeCommand().parseNote('all clear')).toBe('all clear');
    });
  });
});
