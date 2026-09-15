/**
 * One rule, on purpose.
 *
 * `no-undef` is the check the test suite cannot make: a name used but never
 * declared parses, bundles and passes every source-reading test, and throws
 * only when a browser draws that branch. Two reached main that way — the Late
 * Fees panel's `check` (dead on every visit) and the home board's `nextMonth`
 * (dead the first time a month was fully paid).
 *
 * Style rules are not here. A lint that fails on taste gets switched off, and
 * this one has to stay on.
 */
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', '.wrangler/**', 'pages/dist/**', 'public/js/vendor/**',
              'staging/**', 'guides/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'no-undef': 'error' },
  },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } },
  {
    files: ['functions/**/*.js'],
    languageOptions: { globals: { ...globals.worker, __RELEASE__: 'readonly' } },
  },
  { files: ['scripts/**', 'test/**', '*.config.js'], languageOptions: { globals: globals.node } },
];
