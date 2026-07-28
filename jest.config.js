/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/scripts/**/*.spec.ts',
    '<rootDir>/test/**/*.spec.ts',
    '<rootDir>/test/**/*.e2e-spec.ts',
  ],
  transform: {
    '^.+\\.(t|j)s$': '@swc/jest',
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  collectCoverageFrom: [
    'src/**/*.ts',
    'scripts/**/*.ts',
    // Entry points: argument wiring and a bootstrap call, nothing to assert
    // that an integration test would not cover better.
    '!src/main.ts',
    '!src/cli.ts',
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
    global: { statements: 58, branches: 40, functions: 56, lines: 58 },
    './src/domain/': { statements: 97, branches: 90, functions: 94, lines: 97 },
    './src/detectors/': { statements: 98, branches: 95, functions: 92, lines: 98 },
    './src/engine/': { statements: 86, branches: 77, functions: 76, lines: 86 },
    './src/execution/': { statements: 95, branches: 85, functions: 100, lines: 95 },
  },
  // Parity specs replay a year of bars through the engine; the default 5s
  // timeout is not enough for those.
  testTimeout: 120_000,
};
