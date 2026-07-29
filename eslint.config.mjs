import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * The second line of defence on the layer boundary.
 *
 * The first is the compiler: each package's tsconfig maps only the aliases it
 * is allowed to use, so `tsc -b` rejects `@bot/infra` inside `@bot/core`
 * outright. What project references CANNOT catch is a package reaching for the
 * outside world directly — `ccxt`, `node:fs` — because those are ordinary
 * resolvable modules. That is what the rules below are for.
 *
 * `packages/core` is plain TypeScript: no Nest DI, no exchange clients, no
 * filesystem. Everything that talks to the outside world lives behind a port
 * implemented in `packages/infra`, which is what lets the same strategy run
 * under backtest, paper and live execution without edits.
 */
const FORBIDDEN_IN_CORE = [
  {
    group: ['@nestjs/*', '@nestjs/**'],
    message: 'Домен остаётся чистым TS. Nest DI живёт только в app, infra, api и cli.',
  },
  {
    group: ['ccxt', 'yahoo-finance2'],
    message: 'Источники котировок скрыты за MarketDataPort — импортируйте порт, а не клиент биржи.',
  },
  {
    group: ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'path', 'node:path'],
    message: 'Файловый ввод-вывод — задача infra, домен не должен знать о диске.',
  },
  {
    group: ['@bot/infra/**', '@bot/app/**', '@bot/api/**', '@bot/cli/**'],
    message: 'Зависимости направлены внутрь: core не импортирует внешние слои.',
  },
];

/** infra may touch the outside world, but still must not depend on app or up. */
const FORBIDDEN_IN_INFRA = [
  {
    group: ['@bot/app/**', '@bot/api/**', '@bot/cli/**'],
    message: 'infra ниже app: зависимости направлены внутрь.',
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', 'coverage/**', 'node_modules/**', 'reports/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Complexity ceilings, enforced rather than reviewed.
    //
    // `max-depth` measures real nesting and is the one to trust. `complexity`
    // is cyclomatic and counts every `??` and `?.`, so option-defaulting code
    // scores high without being hard to read — which is why the ceiling is set
    // where it is rather than at a textbook number.
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'no-lonely-if': 'error',
    },
  },
  {
    /**
     * Named exemptions, not a blanket raise. Everything here is over the
     * ceiling today and is listed so the debt stays countable; adding a file
     * to this list is a decision someone has to make on purpose.
     *
     *  - h1-3m-classic, mt5-csv.loader: dense, parity-pinned code. Every
     *    branch is compared bit-for-bit against the Python original, so
     *    restructuring them trades a real risk of drift for a cosmetic gain.
     *    They move when the parity requirement does, not before.
     *  - the CLI `run` methods and backtest-runner: long chains of `??`
     *    defaults. Cyclomatically expensive, plainly readable, and already
     *    slated for the argument-handling work left over from S4.
     *  - bybit sync, loadExchangeCredentials: genuinely branchy, and the
     *    branches are the safety checks. Splitting them would spread a
     *    decision that is easier to audit in one place.
     */
    files: [
      'packages/core/src/strategies/h1-3m-classic.strategy.ts',
      'packages/infra/src/market-data/mt5-csv.loader.ts',
      'packages/infra/src/config/exchange-config.ts',
      'packages/infra/src/execution/bybit.adapter.ts',
      'packages/app/src/backtest-runner.service.ts',
      'apps/cli/src/*.command.ts',
      'scripts/download-ger40-oanda.ts',
    ],
    rules: {
      complexity: ['error', 22],
      'max-depth': ['error', 5],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: FORBIDDEN_IN_CORE }],
    },
  },
  {
    files: ['packages/infra/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: FORBIDDEN_IN_INFRA }],
    },
  },
);
