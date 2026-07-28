import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ob4hFvg15mStrategy } from '@bot/core/strategies';
import { ReportService } from './report.service';
import {
  BUILT_IN_STRATEGIES,
  STRATEGY_DESCRIPTORS,
  StrategyRegistryService,
} from './strategy-registry.service';

describe('StrategyRegistryService', () => {
  let registry: StrategyRegistryService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: STRATEGY_DESCRIPTORS, useValue: BUILT_IN_STRATEGIES },
        StrategyRegistryService,
      ],
    }).compile();
    registry = moduleRef.get(StrategyRegistryService);
  });

  it('lists every built-in strategy', () => {
    expect(registry.ids()).toEqual(['OB_4h_FVG_15m', 'frankfurt_ib_50', '1h3m_classic']);
  });

  it('describes a strategy well enough to call it from a string id', () => {
    const descriptor = registry.describe('OB_4h_FVG_15m');
    expect(descriptor.requiredTimeframes).toEqual(['4h', '15m']);
    expect(descriptor.defaultParams.minRr).toBe(2);
    expect(descriptor.description).toEqual(expect.any(String));
  });

  it('rejects an unknown id with the known ones', () => {
    expect(() => registry.describe('nope')).toThrow(/Unknown strategy: nope\. Known:/);
  });

  it('builds a strategy on its defaults', () => {
    const strategy = registry.create('OB_4h_FVG_15m');
    expect(strategy).toBeInstanceOf(Ob4hFvg15mStrategy);
    expect(strategy.name).toBe('OB_4h_FVG_15m');
    expect((strategy as Ob4hFvg15mStrategy).minRr).toBe(2);
  });

  it('overrides only the parameters it is given', () => {
    const strategy = registry.create('OB_4h_FVG_15m', { minRr: 5 }) as Ob4hFvg15mStrategy;
    expect(strategy.minRr).toBe(5);
    expect(strategy.obLookback).toBe(5); // still the default
  });

  it('reports a version for every strategy that matches the class', () => {
    for (const descriptor of registry.list()) {
      expect(registry.create(descriptor.id).version).toBe(descriptor.version);
    }
  });
});

describe('ReportService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reports-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('pnlTag', () => {
    it('encodes a profit with p and an underscore', () => {
      expect(ReportService.pnlTag(0.025, 2)).toBe('p2_50pct');
    });

    it('encodes a loss with m', () => {
      expect(ReportService.pnlTag(-0.0175, 2)).toBe('m1_75pct');
    });

    it('honours the digit count the runners used', () => {
      expect(ReportService.pnlTag(0.025, 1)).toBe('p2_5pct');
    });

    it('treats an open trade as flat', () => {
      expect(ReportService.pnlTag(null, 2)).toBe('p0_00pct');
    });
  });

  it('numbers trade files so they sort', () => {
    const trade = { pnlPct: -0.0175 } as { pnlPct: number };
    expect(ReportService.tradeFilename('frankfurt_ib_50', 3, trade as never, 2)).toBe(
      'frankfurt_ib_50_trade_03_m1_75pct.html',
    );
  });

  describe('path handling', () => {
    it('lists html and txt reports, newest first', () => {
      const service = new ReportService(dir);
      writeFileSync(join(dir, 'a.html'), 'a');
      writeFileSync(join(dir, 'b.txt'), 'b');
      writeFileSync(join(dir, 'ignored.json'), '{}');

      expect(
        service
          .list()
          .map((file) => file.filename)
          .sort(),
      ).toEqual(['a.html', 'b.txt']);
    });

    it('is empty when the directory does not exist yet', () => {
      expect(new ReportService(join(dir, 'missing')).list()).toEqual([]);
    });

    it.each(['../secrets.txt', 'nested/file.html', '/etc/passwd', '..', ''])(
      'refuses to resolve %p',
      (filename) => {
        expect(() => new ReportService(dir).pathFor(filename)).toThrow(/Invalid report filename/);
      },
    );

    it('resolves a plain filename inside the directory', () => {
      expect(new ReportService(dir).pathFor('chart.html')).toBe(join(dir, 'chart.html'));
    });
  });
});
