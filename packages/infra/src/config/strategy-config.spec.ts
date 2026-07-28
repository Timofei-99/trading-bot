import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadStrategyConfigs, mergeParams, StrategyConfigError } from './strategy-config';

const VALID = `
id: my_strategy
version: "1.0"
description: A strategy defined entirely in YAML
implementation: OB_4h_FVG_15m
timeframes: ["4h", "15m"]
params:
  htf: "4h"
  ltf: "15m"
  minRr: 2.5
`;

describe('loadStrategyConfigs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strategy-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string) => writeFileSync(join(dir, name), body, 'utf8');

  it('returns nothing when the directory does not exist', () => {
    // A repo with no config/strategies/ is a valid repo — the built-ins stand
    // on their own. This must not throw.
    expect(loadStrategyConfigs(join(dir, 'missing'))).toEqual([]);
  });

  it('returns nothing for an empty directory', () => {
    expect(loadStrategyConfigs(dir)).toEqual([]);
  });

  it('reads a well-formed file', () => {
    write('my.yaml', VALID);

    const [config] = loadStrategyConfigs(dir);

    expect(config).toEqual({
      id: 'my_strategy',
      version: '1.0',
      description: 'A strategy defined entirely in YAML',
      implementation: 'OB_4h_FVG_15m',
      timeframes: ['4h', '15m'],
      params: { htf: '4h', ltf: '15m', minRr: 2.5 },
      source: join(dir, 'my.yaml'),
    });
  });

  it('reads .yml as well as .yaml, in a stable order', () => {
    write('b.yml', VALID.replace('my_strategy', 'b_strategy'));
    write('a.yaml', VALID.replace('my_strategy', 'a_strategy'));

    // Sorted by filename: two runs of the same repo must register strategies
    // in the same order, or `strategies` output and precedence become
    // filesystem-dependent.
    expect(loadStrategyConfigs(dir).map((config) => config.id)).toEqual([
      'a_strategy',
      'b_strategy',
    ]);
  });

  it('ignores files that are not YAML', () => {
    write('notes.md', '# not a strategy');
    write('my.yaml', VALID);

    expect(loadStrategyConfigs(dir)).toHaveLength(1);
  });

  it('names the file when the YAML will not parse', () => {
    write('broken.yaml', 'id: [unclosed');

    expect(() => loadStrategyConfigs(dir)).toThrow(StrategyConfigError);
    expect(() => loadStrategyConfigs(dir)).toThrow(/broken\.yaml/);
  });

  describe('validation', () => {
    it.each([
      ['id', 'id: my_strategy\n'],
      ['version', 'version: "1.0"\n'],
      ['implementation', 'implementation: OB_4h_FVG_15m\n'],
      ['timeframes', 'timeframes: ["4h", "15m"]\n'],
    ])('rejects a file missing %s', (field, line) => {
      write('bad.yaml', VALID.replace(line, ''));

      expect(() => loadStrategyConfigs(dir)).toThrow(new RegExp(field));
    });

    it('rejects a document that is not a mapping', () => {
      write('bad.yaml', '- just\n- a list\n');

      expect(() => loadStrategyConfigs(dir)).toThrow(/mapping/);
    });

    it('rejects an empty document', () => {
      write('bad.yaml', '\n');

      expect(() => loadStrategyConfigs(dir)).toThrow(/empty/);
    });

    it('rejects timeframes that is not a non-empty list of strings', () => {
      write('bad.yaml', VALID.replace('timeframes: ["4h", "15m"]', 'timeframes: []'));

      expect(() => loadStrategyConfigs(dir)).toThrow(/timeframes/);
    });

    it('rejects params that is not a mapping', () => {
      write('bad.yaml', VALID.replace(/params:[\s\S]*$/, 'params: 5\n'));

      expect(() => loadStrategyConfigs(dir)).toThrow(/params/);
    });

    it('rejects two files claiming the same id', () => {
      // Otherwise one silently shadows the other depending on read order.
      write('one.yaml', VALID);
      write('two.yaml', VALID);

      expect(() => loadStrategyConfigs(dir)).toThrow(/duplicate.*my_strategy/i);
    });

    it('names the offending file in every validation error', () => {
      write('culprit.yaml', VALID.replace('id: my_strategy\n', ''));

      expect(() => loadStrategyConfigs(dir)).toThrow(/culprit\.yaml/);
    });
  });

  it('defaults params to empty when the key is absent', () => {
    write('my.yaml', VALID.replace(/params:[\s\S]*$/, ''));

    expect(loadStrategyConfigs(dir)[0].params).toEqual({});
  });
});

describe('mergeParams', () => {
  it('layers defaults, then YAML, then explicit overrides', () => {
    expect(mergeParams({ a: 1, b: 2, c: 3 }, { b: 20, c: 30 }, { c: 300 })).toEqual({
      a: 1,
      b: 20,
      c: 300,
    });
  });

  it('treats an absent layer as contributing nothing', () => {
    expect(mergeParams({ a: 1 }, undefined, undefined)).toEqual({ a: 1 });
  });

  it('lets an override set a value the defaults do not mention', () => {
    expect(mergeParams({ a: 1 }, {}, { z: 9 })).toEqual({ a: 1, z: 9 });
  });

  it('does not mutate any layer it was given', () => {
    const defaults = { a: 1 };
    const yaml = { b: 2 };

    mergeParams(defaults, yaml, { c: 3 });

    expect(defaults).toEqual({ a: 1 });
    expect(yaml).toEqual({ b: 2 });
  });
});
