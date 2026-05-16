import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'
import noCatchAll from 'eslint-plugin-no-catch-all'

export default [
  {
    ignores: [
      'node_modules/',
      'dist/',
      'container/',
      'groups/',
      '**/lib/python*/**',
      '**/venv/**',
      '**/.venv/**',
      'scripts/paperpile-wiki/lib/**',
      'data/',
      '**/dist/**',
      '**/*.min.js',
      '**/widgetbundle.js',
      '**/labextension/**',
      'cockpit-pwa/',
      'mini-app/',
      '.claude/',
      '.worktrees/',
      '.remember/',
    ],
  },
  { files: ['src/**/*.{js,ts}'] },
  { languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'no-catch-all': noCatchAll },
    rules: {
      'preserve-caught-error': ['error', { requireCatchParameter: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-catch-all/no-catch-all': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
]
