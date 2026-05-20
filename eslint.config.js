const js = require('@eslint/js');
const html = require('eslint-plugin-html');
const globals = require('globals');

module.exports = [
  {
    ignores: ['coverage/**', 'dist/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.jest,
        Vue: 'readonly',
        marked: 'readonly',
        parseServiceLog: 'readonly',
        validateParams: 'readonly',
        parseSSE: 'readonly',
        formatCurrentTime: 'readonly',
        LZString: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.html'],
    plugins: { html },
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.jest,
        Vue: 'readonly',
        marked: 'readonly',
        parseServiceLog: 'readonly',
        validateParams: 'readonly',
        parseSSE: 'readonly',
        formatCurrentTime: 'readonly',
        LZString: 'readonly',
      },
    },
    settings: {
      'html/html-extensions': ['.html'],
    },
    rules: {
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
        },
      ],
    },
  },
];
