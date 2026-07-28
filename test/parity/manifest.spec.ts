import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { GOLDEN_ROOT, goldenPath, loadGolden } from '../fixtures/helpers';

interface GoldenManifest {
  generatedBy: string;
  python: string;
  files: string[];
}

/**
 * The manifest is the inventory of the parity fixtures; this suite is the
 * check that the inventory and the disk agree.
 *
 * It exists because they silently disagreed. `.gitignore` carried an
 * unanchored `reports/` rule that also matched
 * `test/fixtures/golden/reports/`, so four golden reports listed here never
 * reached the repo. The end-to-end parity suite — the gate for the whole
 * migration — could not even load its fixtures, and a `Test suite failed to
 * run` line is easy to skim past when the other forty are green.
 *
 * A missing fixture must therefore fail as a plain, named assertion.
 */
describe('golden fixture manifest', () => {
  const manifest = loadGolden<GoldenManifest>('manifest.json');

  it('lists at least one file', () => {
    expect(manifest.files.length).toBeGreaterThan(0);
  });

  it.each(manifest.files)('has %s on disk', (file) => {
    expect(existsSync(goldenPath(...file.split('/')))).toBe(true);
  });

  it('lists every file that is on disk', () => {
    const listed = new Set(manifest.files);
    const onDisk = walk(GOLDEN_ROOT)
      .map((path) => relative(GOLDEN_ROOT, path).split(sep).join('/'))
      .filter((path) => path !== 'manifest.json');

    // An unlisted fixture is either a stale leftover or something a future
    // exporter forgot to record — both worth surfacing, in either direction.
    expect(onDisk.filter((path) => !listed.has(path))).toEqual([]);
  });

  it('pins the interpreter the exporters refuse to run without', () => {
    expect(manifest.python.startsWith('3.11.')).toBe(true);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
