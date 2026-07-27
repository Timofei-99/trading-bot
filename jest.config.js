/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/test/**/*.spec.ts',
    '<rootDir>/test/**/*.e2e-spec.ts',
  ],
  transform: {
    '^.+\\.(t|j)s$': '@swc/jest',
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  // `.venv` still holds the Python toolchain (it goes away in Phase 11) and
  // ships two package.json files with the same name, which trips jest-haste-map.
  modulePathIgnorePatterns: ['<rootDir>/.venv/', '<rootDir>/dist/'],
  testPathIgnorePatterns: ['/node_modules/', '/\\.venv/', '/dist/'],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/cli.ts'],
  coverageDirectory: '<rootDir>/coverage',
  // Parity specs replay a year of bars through the engine; the default 5s
  // timeout is not enough for those.
  testTimeout: 120_000,
};
