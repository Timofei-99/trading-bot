import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..');

const git = (...args: string[]): string[] =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .filter((line) => line !== '');

/**
 * `.gitignore` and the index, checked against each other.
 *
 * This repository has now been bitten in both directions by the two
 * disagreeing, and neither showed up as a failure at the time:
 *
 *  - An unanchored `reports/` rule silently swallowed the golden backtest
 *    reports, so the end-to-end parity suite could not load its fixtures.
 *  - `data/journal/paper_*.ndjson` sat in the index despite `data/journal/`
 *    being ignored, so one machine's runtime output was versioned while
 *    everybody else's was not.
 *
 * Both are cheap to detect and expensive to notice by eye, which is exactly
 * what a test is for.
 */
describe('gitignore and the index agree', () => {
  it('tracks no file that an ignore rule also matches', () => {
    const tracked = git('ls-files');

    // `check-ignore` skips tracked paths unless told not to — which is
    // precisely why this contradiction can persist unnoticed.
    let offenders: string[] = [];
    try {
      offenders = git('check-ignore', '--no-index', ...tracked);
    } catch {
      // Exit code 1 means nothing matched, which is the outcome we want.
      offenders = [];
    }

    expect(offenders).toEqual([]);
  });

  it('does not ignore the golden fixtures the parity suites need', () => {
    // The S0 failure, pinned from the other side: these files must stay
    // committable no matter how the ignore rules evolve.
    const fixtures = [
      'test/fixtures/golden/reports/ob4h_fvg15m_btc_2023.json',
      'test/fixtures/golden/trades/ob4h_fvg15m_btc_2023.json',
      'test/fixtures/golden/manifest.json',
    ];

    let ignored: string[] = [];
    try {
      ignored = git('check-ignore', '--no-index', ...fixtures);
    } catch {
      ignored = [];
    }

    expect(ignored).toEqual([]);
  });

  it('still ignores generated output', () => {
    // The rules have to keep doing their job, not just stop over-reaching.
    const generated = ['reports/chart.html', 'coverage/index.html', 'packages/core/dist/x.js'];

    const ignored = git('check-ignore', '--no-index', ...generated);

    expect(ignored.sort()).toEqual(generated.sort());
  });
});
