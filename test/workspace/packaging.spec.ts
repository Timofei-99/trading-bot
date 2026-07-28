import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..');

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  exports?: Record<string, string>;
}

const PACKAGES: { dir: string; name: string; mayDependOn: string[] }[] = [
  { dir: 'packages/core', name: '@bot/core', mayDependOn: [] },
  { dir: 'packages/infra', name: '@bot/infra', mayDependOn: ['@bot/core'] },
  { dir: 'packages/app', name: '@bot/app', mayDependOn: ['@bot/core', '@bot/infra'] },
  { dir: 'apps/api', name: '@bot/api', mayDependOn: ['@bot/core', '@bot/app'] },
  { dir: 'apps/cli', name: '@bot/cli', mayDependOn: ['@bot/core', '@bot/infra', '@bot/app'] },
];

const manifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(REPO, dir, 'package.json'), 'utf8')) as Manifest;

/**
 * The workspace's own wiring, checked.
 *
 * `tsc -b` already rejects an illegal import, and eslint already rejects a
 * direct `ccxt` or `node:fs` inside core. What neither notices is a manifest
 * drifting away from the source: a dependency declared that nothing uses, a
 * barrel added without a matching `exports` entry. Both are silent until
 * something fails at runtime in a built artefact, which is the worst place to
 * find out.
 */
describe('workspace packaging', () => {
  describe.each(PACKAGES)('$name', ({ dir, mayDependOn }) => {
    it('declares only the workspace packages its layer is allowed to use', () => {
      const declared = Object.keys(manifest(dir).dependencies ?? {}).filter((dep) =>
        dep.startsWith('@bot/'),
      );

      expect(declared.sort()).toEqual([...mayDependOn].sort());
    });

    it('maps every barrel explicitly in exports', () => {
      // `exports` switches OFF Node's directory resolution, so a bare
      // `@bot/core/strategies` looks for dist/strategies.js and misses
      // dist/strategies/index.js. Every index.ts therefore needs its own key.
      const src = join(REPO, dir, 'src');
      const barrels = findBarrels(src, src);
      const exports = manifest(dir).exports ?? {};

      for (const barrel of barrels) {
        expect(exports[`./${barrel}`]).toBe(`./dist/${barrel}/index.js`);
      }
    });

    it('has a wildcard export for the non-barrel subpaths', () => {
      expect(manifest(dir).exports?.['./*']).toBe('./dist/*.js');
    });
  });

  it('keeps @bot/core free of any runtime dependency but luxon', () => {
    // The whole point of the split: the strategy code that a backtest, a paper
    // run and a live run all share must not drag a framework or an exchange
    // client behind it.
    expect(Object.keys(manifest('packages/core').dependencies ?? {})).toEqual(['luxon']);
  });

  it('declares the packages as npm workspaces', () => {
    const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      workspaces?: string[];
    };

    expect(root.workspaces).toEqual(['packages/*', 'apps/*']);
    for (const { dir } of PACKAGES) {
      expect(existsSync(join(REPO, dir, 'tsconfig.json'))).toBe(true);
    }
  });
});

function findBarrels(dir: string, root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (existsSync(join(path, 'index.ts'))) {
        found.push(
          path
            .slice(root.length + 1)
            .split(/[\\/]/)
            .join('/'),
        );
      }
      found.push(...findBarrels(path, root));
    }
  }
  return found;
}
