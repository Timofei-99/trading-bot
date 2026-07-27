import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * The layer boundary is enforced here rather than described in a README.
 *
 * `domain/`, `detectors/`, `strategies/`, `engine/` and `execution/` are plain
 * TypeScript: no Nest DI, no exchange clients, no filesystem. Everything that
 * talks to the outside world lives behind a port implemented in
 * `infrastructure/`, so the same strategy code can run under backtest, paper
 * and live execution without edits.
 */
const PURE_LAYERS = [
  'src/domain/**/*.ts',
  'src/detectors/**/*.ts',
  'src/strategies/**/*.ts',
  'src/engine/**/*.ts',
  'src/execution/**/*.ts',
];

const FORBIDDEN_IN_PURE_LAYERS = [
  {
    group: ['@nestjs/*', '@nestjs/**'],
    message:
      'Домен остаётся чистым TS. Nest DI живёт только в application/, infrastructure/, api/ и cli/.',
  },
  {
    group: ['ccxt', 'yahoo-finance2'],
    message: 'Источники котировок скрыты за MarketDataPort — импортируйте порт, а не клиент биржи.',
  },
  {
    group: ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'path', 'node:path'],
    message: 'Файловый ввод-вывод — задача infrastructure/, домен не должен знать о диске.',
  },
  {
    group: ['**/infrastructure/**', '**/application/**', '**/api/**', '**/cli/**'],
    message: 'Зависимости направлены внутрь: внутренние слои не импортируют внешние.',
  },
];

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'reports/**'] },
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
    files: PURE_LAYERS,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: FORBIDDEN_IN_PURE_LAYERS },
      ],
    },
  },
);
