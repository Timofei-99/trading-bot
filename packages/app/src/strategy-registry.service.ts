import { Inject, Injectable } from '@nestjs/common';

import { Strategy } from '@bot/core/domain/ports';
import {
  FrankfurtIb50Strategy,
  H1m3mClassicStrategy,
  Ob4hFvg15mStrategy,
} from '@bot/core/strategies';

export interface StrategyDescriptor {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly requiredTimeframes: readonly string[];
  readonly defaultParams: Readonly<Record<string, unknown>>;
  create(params: Record<string, unknown>): Strategy;
}

export const STRATEGY_DESCRIPTORS = Symbol('STRATEGY_DESCRIPTORS');

/**
 * Every strategy the application can run, described well enough for a caller
 * that only knows a string id.
 *
 * Adding one is a single entry here — the CLI commands and the HTTP
 * controllers list and instantiate strategies through the registry and never
 * name a concrete class, so neither has to change.
 */
export const BUILT_IN_STRATEGIES: StrategyDescriptor[] = [
  {
    id: 'OB_4h_FVG_15m',
    version: '1.0',
    description: '4h order block in discount, retested through a 15m FVG after a liquidity sweep',
    requiredTimeframes: ['4h', '15m'],
    defaultParams: {
      htf: '4h',
      ltf: '15m',
      swingLengthHtf: 3,
      swingLengthLtf: 3,
      obLookback: 5,
      liquiditySweepLookback: 20,
      minRr: 2.0,
    },
    create: (params) => new Ob4hFvg15mStrategy(params),
  },
  {
    id: 'frankfurt_ib_50',
    version: '2.0',
    description: 'Frankfurt IB high/low breakout into London session, fixed 1:1 RR',
    requiredTimeframes: ['1m'],
    defaultParams: {
      ibStart: '08:00',
      ibEnd: '09:00',
      sessionEnd: '12:00',
      sessionTz: 'UTC',
      timeframe: '1m',
    },
    create: (params) => new FrankfurtIb50Strategy(params),
  },
  {
    id: '1h3m_classic',
    version: '1.0',
    description: '1h context and fractal sweep confirmed by a 5m break of structure',
    requiredTimeframes: ['1h', '5m'],
    defaultParams: {
      htf: '1h',
      ltf: '5m',
      symbol: 'EURUSD=X',
      minRr: 1.3,
      maxStopPips: 300,
      pipSize: 0.0001,
      fractalLookbackDays: 1,
      contextThresholdPips: 10,
    },
    create: (params) => new H1m3mClassicStrategy(params),
  },
];

@Injectable()
export class StrategyRegistryService {
  private readonly byId: Map<string, StrategyDescriptor>;

  constructor(@Inject(STRATEGY_DESCRIPTORS) descriptors: StrategyDescriptor[]) {
    this.byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  }

  list(): StrategyDescriptor[] {
    return [...this.byId.values()];
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  describe(id: string): StrategyDescriptor {
    const descriptor = this.byId.get(id);
    if (descriptor === undefined) {
      throw new Error(`Unknown strategy: ${id}. Known: ${this.ids().join(', ')}`);
    }
    return descriptor;
  }

  /** Instantiate `id`, overriding only the parameters the caller supplied. */
  create(id: string, params: Record<string, unknown> = {}): Strategy {
    const descriptor = this.describe(id);
    return descriptor.create({ ...descriptor.defaultParams, ...params });
  }
}
