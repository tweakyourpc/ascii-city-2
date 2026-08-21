import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['docs/**', 'tools/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js', 'tools/**/*.js', 'dev-server.mjs', 'worker/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest', sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] },
  },
];
