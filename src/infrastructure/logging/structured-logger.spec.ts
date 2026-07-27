import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { redact, StructuredLogger } from './structured-logger';

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

const AT = Date.UTC(2024, 0, 1, 12, 0, 0);

describe('StructuredLogger', () => {
  it('emits one JSON object per record', () => {
    const sink = capture();
    new StructuredLogger({ write: sink.write, clock: () => AT }).info('entry placed', {
      symbol: 'BTC/USDT',
      price: 100,
    });

    expect(JSON.parse(sink.lines[0])).toEqual({
      time: '2024-01-01T12:00:00.000Z',
      level: 'info',
      message: 'entry placed',
      symbol: 'BTC/USDT',
      price: 100,
    });
  });

  it('drops records below the configured level', () => {
    const sink = capture();
    const log = new StructuredLogger({ write: sink.write, level: 'warn' });

    log.debug('noise');
    log.info('noise');
    log.warn('kept');
    log.error('kept');

    expect(sink.lines).toHaveLength(2);
  });

  it('carries base fields into children', () => {
    const sink = capture();
    const log = new StructuredLogger({ write: sink.write, base: { run: 'r1' } });

    log.child({ symbol: 'BTC/USDT' }).info('tick');

    expect(JSON.parse(sink.lines[0])).toMatchObject({ run: 'r1', symbol: 'BTC/USDT' });
  });

  describe('redaction', () => {
    it('never writes a credential, however it is nested', () => {
      const sink = capture();
      new StructuredLogger({ write: sink.write }).info('config', {
        exchange: {
          apiKey: 'AKIAREAL',
          secret: 'super-secret',
          nested: [{ token: 'tok-123' }],
        },
        symbol: 'BTC/USDT',
      });

      const line = sink.lines[0];
      expect(line).not.toContain('AKIAREAL');
      expect(line).not.toContain('super-secret');
      expect(line).not.toContain('tok-123');
      expect(line).toContain('BTC/USDT');
      expect(JSON.parse(line).exchange.apiKey).toBe('[redacted]');
      expect(JSON.parse(line).exchange.nested[0].token).toBe('[redacted]');
    });

    it('matches credential keys case-insensitively and in snake case', () => {
      expect(redact({ API_KEY: 'x', api_secret: 'y', Signature: 'z' })).toEqual({
        API_KEY: '[redacted]',
        api_secret: '[redacted]',
        Signature: '[redacted]',
      });
    });

    it('leaves ordinary values alone', () => {
      expect(redact({ price: 100, side: 'buy', tags: ['a', 'b'] })).toEqual({
        price: 100,
        side: 'buy',
        tags: ['a', 'b'],
      });
    });
  });

  describe('file output', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'logs-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('appends the same records to disk', () => {
      const path = join(dir, 'nested', 'bot.ndjson');
      const log = new StructuredLogger({ write: () => undefined, filePath: path });

      log.info('one');
      log.warn('two');

      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]).message).toBe('two');
    });
  });
});
