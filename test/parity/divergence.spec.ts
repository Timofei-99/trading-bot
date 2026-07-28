import { FrankfurtIb50Strategy } from '../../src/strategies';
import { GoldenTradesFile, loadGolden } from '../fixtures/helpers';

/**
 * Divergences from the Python stack, pinned.
 *
 * Every bundled strategy is parity-gated end to end except `frankfurt_ib_50`,
 * which was deliberately re-specified as v2.0 (see docs/DIVERGENCE.md). That
 * exemption is the dangerous kind of fact: it lives in the absence of a test,
 * and absences do not fail.
 *
 * So the absence is asserted here. The golden fixtures for the run stay in the
 * repo as the historical Python baseline, and this suite states out loud that
 * they describe a different strategy than the one that ships — which stops
 * anyone from wiring them back into the e2e harness expecting green, and
 * stops the exemption from outliving the reason for it.
 */
describe('deliberate divergences from Python', () => {
  describe('frankfurt_ib_50', () => {
    const golden = loadGolden<GoldenTradesFile>('trades', 'frankfurt_ib50_synth.json');

    it('has a golden fixture pinned to the superseded v1.0', () => {
      expect(golden.strategyName).toBe('frankfurt_ib_50');
      expect(golden.strategyVersion).toBe('1.0');
    });

    it('ships v2.0, which is not the version the fixture describes', () => {
      const strategy = new FrankfurtIb50Strategy();
      expect(strategy.name).toBe(golden.strategyName);
      expect(strategy.version).toBe('2.0');
      expect(strategy.version).not.toBe(golden.strategyVersion);
    });

    it('no longer accepts the v1.0 parameters the fixture was run with', () => {
      // The rewrite dropped the midpoint trigger, the swing-based stop and the
      // local-session framing. If these ever come back, the divergence is over
      // and the run belongs in strategies-e2e.parity.spec.ts again.
      expect(Object.keys(golden.strategyParams).sort()).toEqual([
        'ib_duration_minutes',
        'session_end',
        'session_start',
        'session_tz',
        'swing_length',
        'timeframe',
      ]);

      const strategy = new FrankfurtIb50Strategy();
      expect(strategy).not.toHaveProperty('swingLength');
      expect(strategy).not.toHaveProperty('ibDurationMinutes');
      expect(strategy.sessionTz).toBe('UTC');
    });
  });
});
