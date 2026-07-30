/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/packages/*/src/**/*.spec.ts',
    '<rootDir>/apps/*/src/**/*.spec.ts',
    '<rootDir>/scripts/**/*.spec.ts',
    '<rootDir>/test/**/*.spec.ts',
    '<rootDir>/test/**/*.e2e-spec.ts',
  ],
  // Tests run against package SOURCE, not built output, so `npm test` never
  // depends on `npm run build` being current. The package boundary is enforced
  // by `tsc -b`, not here.
  moduleNameMapper: {
    '^@bot/core/(.*)$': '<rootDir>/packages/core/src/$1',
    '^@bot/infra/(.*)$': '<rootDir>/packages/infra/src/$1',
    '^@bot/app/(.*)$': '<rootDir>/packages/app/src/$1',
    '^@bot/api/(.*)$': '<rootDir>/apps/api/src/$1',
    '^@bot/cli/(.*)$': '<rootDir>/apps/cli/src/$1',
  },
  transform: {
    '^.+\\.(t|j)s$': '@swc/jest',
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '/dist/'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    'apps/*/src/**/*.ts',
    'scripts/**/*.ts',
    // Entry points: argument wiring and a bootstrap call, nothing to assert
    // that an integration test would not cover better.
    '!apps/api/src/main.ts',
    '!apps/cli/src/cli.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
  // A ratchet, not a target. Every number below is the coverage actually
  // measured when it was introduced, rounded down a point or two: the build is
  // green today and goes red the moment coverage slips. Raise the floors when
  // you raise the coverage; never lower one to make a build pass.
  //
  // Jest SUBTRACTS glob-matched files from the global pool, so `global` here
  // describes everything except the four carved-out layers — which is why it
  // reads lower than the headline number. The pure core is held to a much
  // higher bar than the shells around it, deliberately: a wrong detector is
  // silent and expensive, a wrong CLI flag is loud and cheap.
  coverageThreshold: {
    global: { statements: 75, branches: 55, functions: 75, lines: 75 },
    './packages/core/src/domain/': { statements: 97, branches: 90, functions: 95, lines: 97 },
    './packages/core/src/detectors/': { statements: 98, branches: 95, functions: 92, lines: 98 },
    './packages/core/src/engine/': { statements: 88, branches: 80, functions: 80, lines: 88 },
    './packages/core/src/execution/': { statements: 97, branches: 88, functions: 100, lines: 97 },
    // The commands, tested through their run() methods against stub services
    // and a temp-dir journal. `visualize` and cli.module are still uncovered;
    // everything else is real.
    './apps/cli/src/': { statements: 74, branches: 53, functions: 77, lines: 75 },
    // The layer that actually talks to the venue. Was 0% on both clients
    // before the restart-safety work; holding the line matters more here than
    // anywhere except the domain.
    './packages/infra/src/execution/': { statements: 96, branches: 83, functions: 96, lines: 97 },
  },
  // Parity specs replay a year of bars through the engine; the default 5s
  // timeout is not enough for those.
  testTimeout: 120_000,
};
